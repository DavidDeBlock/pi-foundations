import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { loadConfig } from './env.js'
import { createApp } from './app.js'
import { JsonTokenStore } from './token-store.js'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { createStateSigner, createTokenCipher } from './token-encryption.js'
import { EmailSyncWorker } from './email-sync-worker.js'
import { EmailSyncScheduler } from './email-sync-scheduler.js'
import { GmailClient } from './gmail-client.js'

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

  // Graceful shutdown. Best-effort cleanup of the timer so a
  // deployed dashboard doesn't keep ticking after `pm2 stop`.
  const shutdown = (signal: NodeJS.Signals): void => {
    // eslint-disable-next-line no-console
    console.log(`[dashboard] ${signal} received; stopping scheduler and exiting`)
    if (syncScheduler) syncScheduler.stop()
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
        if (!email) {
          logEmailSetupBanner(config.missingEmailEnv, info.port, true)
        }
      },
    )
  } else {
    serve(
      { fetch: app.fetch, port: config.port, hostname: config.hostname },
      (info) => {
        // eslint-disable-next-line no-console
        console.log(`Dashboard listening on http://${info.address}:${info.port}`)
        if (!email) {
          logEmailSetupBanner(config.missingEmailEnv, info.port, false)
        }
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

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  // eslint-disable-next-line no-console
  console.error(`Failed to start dashboard server: ${message}`)
  process.exit(1)
})
