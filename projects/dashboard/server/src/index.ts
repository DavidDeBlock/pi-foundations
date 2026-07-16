import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { loadConfig, type LlmConfig } from './env.js'
import { createApp } from './app.js'
import { JsonTokenStore } from './token-store.js'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { createStateSigner, createTokenCipher } from './token-encryption.js'
import { EmailSyncWorker } from './email-sync-worker.js'
import { EmailSyncScheduler } from './email-sync-scheduler.js'
import { GmailClient } from './gmail-client.js'
import { YouTubeOAuthClient } from './youtube-oauth.js'
import { YouTubeSubscriptionsSync } from './youtube-subscriptions-sync.js'
import {
  YouTubeSubscriptionsScheduler,
  DEFAULT_YOUTUBE_SYNC_INTERVAL_HOURS,
} from './youtube-subscriptions-scheduler.js'
import {
  YouTubeRssPoller,
  DEFAULT_POLL_CONCURRENCY,
} from './youtube-rss-poller.js'
import {
  YouTubeRssScheduler,
  DEFAULT_YOUTUBE_RSS_INTERVAL_MIN,
} from './youtube-rss-scheduler.js'
import { YouTubeTranscriptService } from './youtube-transcripts.js'
import { OpenAiCompatibleLlmClient } from './llm-client.js'
import {
  MiniMaxVideoSummarizer,
  YouTubeVideoSummaryService,
} from './youtube-video-summaries.js'

async function main(): Promise<void> {
  const config = await loadConfig()
  const tokenStore = new JsonTokenStore({ dataDir: config.dataDir })

  const db = new Database(config.dbPath)
  // Migrations live alongside `src/`; resolve relative to cwd which is the
  // server project root when launched via `pnpm start`.
  await runMigrations(db, {
    dir: resolve(process.cwd(), 'migrations'),
  })

  // Email slice is OPTIONAL at boot. When all four env vars are present
  // we wire up the OAuth + sync routes. When any are missing, we mount
  // a setup-only /settings/email route that documents how to configure
  // them — without that, an operator cannot read the instructions
  // because the instructions live behind the same env vars.
  const email = config.email
    ? buildEmailDeps(config.email.emailTokenEncryptionKey, config.email.googleOauthClientId, config.email.googleOauthClientSecret, config.email.emailOauthRedirectUri, db, config.emailSyncHistoryDays)
    : undefined

  // YouTube slice (issue YT-001) is OPTIONAL at boot, same pattern
  // as email above. YT-002 (subscriptions sync + videos) will reuse
  // `youtubeClient` for token refresh.
  const youtube = config.youtube
    ? buildYouTubeDeps(
        config.youtube.youtubeTokenEncryptionKey,
        config.youtube.youtubeOauthClientId,
        config.youtube.youtubeOauthClientSecret,
        config.youtube.youtubeOauthRedirectUri,
        db,
        config.llm,
      )
    : undefined

  // Background poll scheduler (issue #026). Runs `EmailSyncWorker.sync`
  // for every connected account at `config.emailSyncIntervalMin`
  // intervals. Started before `serve()` so the first tick can fire as
  // soon as the HTTP socket is bound. When the operator sets the
  // interval to `0` the scheduler is constructed but inert (manual-
  // only mode — `POST /api/email/sync` is the only path). When email
  // isn't configured at all (`config.email === null`) there's no
  // worker to schedule against, so we skip construction entirely.
  const syncScheduler = email
    ? new EmailSyncScheduler({
        db,
        worker: email.syncWorker,
        intervalMin: config.emailSyncIntervalMin,
      })
    : null
  if (syncScheduler) syncScheduler.start()

  // YouTube subscriptions scheduler (issue YT-002). Mirrors the
  // email scheduler's pattern: intervalHours=0 → manual-only mode,
  // otherwise a daily 24h tick that runs `subscriptionsSync.sync()`.
  // The OAuth callback also fires a one-shot sync on grant
  // (auto-sync), so the operator usually sees results within ~30s
  // of connecting — this scheduler is the steady-state refresh +
  // recovery net (e.g. a sync that crashed during auto-sync will
  // be retried at the next daily tick).
  const youtubeSyncScheduler = youtube
    ? new YouTubeSubscriptionsScheduler({
        sync: youtube.subscriptionsSync,
        intervalHours: DEFAULT_YOUTUBE_SYNC_INTERVAL_HOURS,
      })
    : null
  if (youtubeSyncScheduler) youtubeSyncScheduler.start()

  // YouTube RSS scheduler (issue YT-004). 15-min interval, first
  // poll ~15s after boot. The OAuth callback does NOT auto-trigger
  // an RSS poll (subscriber count is small and the next 15-min
  // tick catches up naturally); the manual endpoint is the only
  // way to force an immediate poll.
  const youtubeRssSched = youtube
    ? new YouTubeRssScheduler({
        poller: youtube.rssPoller,
        intervalMin: DEFAULT_YOUTUBE_RSS_INTERVAL_MIN,
      })
    : null
  if (youtubeRssSched) youtubeRssSched.start()

  // Graceful shutdown. Best-effort cleanup of the timer so a
  // deployed dashboard doesn't keep ticking after `pm2 stop`.
  const shutdown = (signal: NodeJS.Signals): void => {
    // eslint-disable-next-line no-console
    console.log(`[dashboard] ${signal} received; stopping scheduler and exiting`)
    if (syncScheduler) syncScheduler.stop()
    if (youtubeSyncScheduler) youtubeSyncScheduler.stop()
    if (youtubeRssSched) youtubeRssSched.stop()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  const app = createApp({
    passwordHash: config.passwordHash,
    tokenStore,
    db,
    email,
    youtube,
  })

  // HTTPS when DASHBOARD_TLS_CERT + DASHBOARD_TLS_KEY are set;
  // otherwise plain HTTP. The Hono `serve()` helper accepts a
  // pre-built `createServer` from `node:http(s)` — we pass our own
  // so the TLS handshake uses the operator's cert + key directly,
  // with no reverse proxy in front.
  if (config.tls) {
    // Hono's `serve()` accepts an explicit `createServer` from
    // `node:https` to wrap the listener with TLS. Using it here
    // (instead of `https.createServer` + a Web Request shim) keeps
    // streaming bodies, headers, and Hono's internal optimizations
    // intact. The cert + key come from config.tls, which read both
    // files at startup.
    const https = await import('node:https')
    serve(
      {
        fetch: app.fetch,
        port: config.port,
        hostname: config.hostname,
        createServer: https.createServer,
        serverOptions: config.tls,
      },
      (info) => {
        // eslint-disable-next-line no-console
        console.log(`Dashboard listening on https://${info.address}:${info.port}`)
        if (!email) logEmailSetupBanner(config.missingEmailEnv, info.port, true)
        if (!youtube) logYouTubeSetupBanner(config.missingYoutubeEnv, info.port, true)
      },
    )
  } else {
    serve(
      { fetch: app.fetch, port: config.port, hostname: config.hostname },
      (info) => {
        // eslint-disable-next-line no-console
        console.log(`Dashboard listening on http://${info.address}:${info.port}`)
        if (!email) logEmailSetupBanner(config.missingEmailEnv, info.port, false)
        if (!youtube) logYouTubeSetupBanner(config.missingYoutubeEnv, info.port, false)
      },
    )
  }
}

/** Build the email deps from a fully-configured EmailConfig. Kept as a
 *  helper so `main()` reads as plain wiring + a clear null-handling branch. */
function buildEmailDeps(
  emailTokenEncryptionKey: Buffer,
  googleOauthClientId: string,
  googleOauthClientSecret: string,
  emailOauthRedirectUri: string,
  db: Database,
  historyDays: number,
): Parameters<typeof createApp>[0]['email'] {
  // The cipher + state signer share the same 32-byte key. The cipher
  // encrypts OAuth tokens at rest; the state signer HMAC-signs OAuth
  // `state` query parameters for CSRF protection.
  const tokenCipher = createTokenCipher(emailTokenEncryptionKey)
  const stateSigner = createStateSigner(emailTokenEncryptionKey)

  // Sync worker (issue #021) — orchestrator for the Gmail mirror.
  // Builds a GmailClient per sync so OAuth tokens live only as long
  // as the sync does. Returned so `main()` can pass it to the
  // scheduler constructor below.
  const syncWorker = new EmailSyncWorker({
    db,
    cipher: tokenCipher,
    buildGmailClient: (accountId) =>
      new GmailClient({
        db,
        cipher: tokenCipher,
        accountId,
        oauthClientId: googleOauthClientId,
        oauthClientSecret: googleOauthClientSecret,
      }),
    historyDays,
  })

  return {
    tokenCipher,
    stateSigner,
    oauthClientId: googleOauthClientId,
    oauthClientSecret: googleOauthClientSecret,
    redirectUri: emailOauthRedirectUri,
    syncWorker,
  }
}

/** Build the YouTube deps from a fully-configured YouTubeConfig
 *  (issue YT-001). The `YouTubeOAuthClient` deep module is the only
 *  capability YT-001 needs; YT-002 will reuse the same instance for
 *  the subscriptions sync. Kept as a helper so `main()` reads as
 *  plain wiring + a clear null-handling branch. */
function buildYouTubeDeps(
  youtubeTokenEncryptionKey: Buffer,
  youtubeOauthClientId: string,
  youtubeOauthClientSecret: string,
  youtubeOauthRedirectUri: string,
  db: Database,
  llm: LlmConfig | null,
): Parameters<typeof createApp>[0]['youtube'] {
  // The cipher + state signer share the same 32-byte key (same
  // rationale as the email slice above).
  const tokenCipher = createTokenCipher(youtubeTokenEncryptionKey)
  const stateSigner = createStateSigner(youtubeTokenEncryptionKey)

  const client = new YouTubeOAuthClient({
    db,
    cipher: tokenCipher,
    oauthClientId: youtubeOauthClientId,
    oauthClientSecret: youtubeOauthClientSecret,
    redirectUri: youtubeOauthRedirectUri,
  })

  // Subscriptions sync (issue YT-002). Reuses the same `client`
  // for token refresh — no separate OAuth plumbing needed.
  const subscriptionsSync = new YouTubeSubscriptionsSync({
    db,
    cipher: tokenCipher,
    oauthClient: client,
  })

  // RSS poller (issue YT-004). Same DB, no OAuth deps needed
  // (the public RSS endpoint is unauthenticated). Concurrency
  // cap is wired from `YOUTUBE_RSS_CONCURRENCY` env so the
  // operator can tune it.
  const transcriptService = new YouTubeTranscriptService({ db })
  transcriptService.resumePending()

  const summaryService = llm
    ? new YouTubeVideoSummaryService({
        db,
        summarizer: new MiniMaxVideoSummarizer(new OpenAiCompatibleLlmClient({
          apiKey: llm.apiKey,
          baseUrl: llm.baseUrl,
          model: llm.model,
        })),
      })
    : undefined
  summaryService?.resumePending()

  const rssPoller = new YouTubeRssPoller({
    db,
    transcriptService,
    concurrency: process.env.YOUTUBE_RSS_CONCURRENCY
      ? Number.parseInt(process.env.YOUTUBE_RSS_CONCURRENCY, 10)
      : DEFAULT_POLL_CONCURRENCY,
  })

  return {
    tokenCipher,
    stateSigner,
    oauthClientId: youtubeOauthClientId,
    oauthClientSecret: youtubeOauthClientSecret,
    redirectUri: youtubeOauthRedirectUri,
    client,
    subscriptionsSync,
    rssPoller,
    transcriptService,
    ...(summaryService ? { summaryService } : {}),
  }
}

/** Print a single, easily-noticeable banner when email env vars are
 *  missing. The first line tells the operator exactly which vars to
 *  set; the deep link carries the list so /settings/email can render
 *  a tailored banner of its own. */
function logEmailSetupBanner(
  missing: ReadonlyArray<string>,
  port: number,
  isHttps: boolean,
): void {
  const missingParam = encodeURIComponent(missing.join(','))
  const scheme = isHttps ? 'https' : 'http'
  // eslint-disable-next-line no-console
  console.warn(
    [
      '',
      '\u26a0 Email slice is UNCONFIGURED \u2014 the following env vars are missing:',
      ...missing.map((name) => `    \u2022 ${name}`),
      '',
      '  Open the setup page (it shows the same list + a Google Cloud',
      `  Console walkthrough): ${scheme}://localhost:${port}/settings/email?missing=${missingParam}`,
      '',
      '  To generate EMAIL_TOKEN_ENCRYPTION_KEY:',
      '      pnpm keygen',
      '      (or: openssl rand -hex 32)',
      '',
      '  Set the vars, then restart the server. The OAuth + sync routes',
      '  remain unmounted until every required var is present.',
      '',
    ].join('\n'),
  )
}

/** Print a single, easily-noticeable banner when YouTube env vars
 *  are missing (issue YT-001). Mirrors `logEmailSetupBanner` but
 *  points the operator at /settings/youtube and uses the YOUTUBE_*
 *  env var prefix. The two banners print independently when both
 *  slices are unconfigured. */
function logYouTubeSetupBanner(
  missing: ReadonlyArray<string>,
  port: number,
  isHttps: boolean,
): void {
  const missingParam = encodeURIComponent(missing.join(','))
  const scheme = isHttps ? 'https' : 'http'
  // eslint-disable-next-line no-console
  console.warn(
    [
      '',
      '\u26a0 YouTube slice is UNCONFIGURED \u2014 the following env vars are missing:',
      ...missing.map((name) => `    \u2022 ${name}`),
      '',
      '  Open the setup page (it shows the same list + a Google Cloud',
      `  Console walkthrough): ${scheme}://localhost:${port}/settings/youtube?missing=${missingParam}`,
      '',
      '  To generate YOUTUBE_TOKEN_ENCRYPTION_KEY:',
      '      openssl rand -hex 32',
      '',
      '  Set the vars, then restart the server. The OAuth routes remain',
      '  unmounted until every required var is present.',
      '',
    ].join('\n'),
  )
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  // eslint-disable-next-line no-console
  console.error(`Failed to start dashboard server: ${message}`)
  process.exit(1)
})
