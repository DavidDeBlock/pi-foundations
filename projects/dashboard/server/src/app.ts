import { Hono } from 'hono'
import { auth, type AuthVariables } from './auth.js'
import type { Database } from './db.js'
import type { TokenStore } from './token-store.js'
import { tokenApi } from './api-tokens.js'
import { settingsView } from './settings-view.js'
import { foldersApi } from './folders.js'
import { bookmarksApi } from './bookmarks.js'
import { activityFeedApi, bookmarkDetailApi } from './activity-feed.js'
import { tagsApi } from './tags.js'
import { staticAssets } from './static-handler.js'
import { searchApi, searchViewApi } from './search.js'
import { previewV2Page } from './preview.js'
import type { StateSigner, TokenCipher } from './token-encryption.js'
import { emailApi } from './email-oauth.js'
import { emailSettingsView, emailSettingsSetupOnly } from './email-settings.js'
import { emailSyncApi } from './email-sync.js'
import { emailReadApi } from './email-read.js'
import { emailViewApi } from './email-view.js'
import type { EmailSyncWorker } from './email-sync-worker.js'
import { youtubeApi, type YouTubeOAuthClient } from './youtube-oauth.js'
import { youtubeSettingsView, youtubeSettingsSetupOnly } from './youtube-settings.js'
import type { YouTubeSubscriptionsSync } from './youtube-subscriptions-sync.js'
import type { YouTubeRssPoller } from './youtube-rss-poller.js'
import { youtubeSyncApi } from './youtube-subscriptions-api.js'
import { subscriptionsApi } from './youtube-subscriptions-list-api.js'
import { subscriptionsViewApi } from './youtube-subscriptions-view.js'
import { youtubeRssPollApi } from './youtube-rss-poll-api.js'
import { youtubeVideosApi } from './youtube-videos-api.js'
import { youtubeVideoTagsApi } from './youtube-video-tags-api.js'
import { youtubeVideosView } from './youtube-videos-view.js'
import { youtubeVideoDetailView } from './youtube-video-detail-view.js'
import { youtubeTranscriptsApi } from './youtube-transcripts-api.js'
import type { YouTubeTranscriptService } from './youtube-transcripts.js'

export interface EmailDeps {
  /** AES-256-GCM cipher for OAuth tokens at rest. */
  readonly tokenCipher: TokenCipher
  /** HMAC-signed state parameter generator for OAuth CSRF protection. */
  readonly stateSigner: StateSigner
  /** OAuth client id from the Google Cloud Console. */
  readonly oauthClientId: string
  /** OAuth client secret from the Google Cloud Console. */
  readonly oauthClientSecret: string
  /** Full callback URL, must match the registered redirect URI. */
  readonly redirectUri: string
  /** Optional injected fetch implementation for testing. Defaults
   *  to global `fetch`. Used by the OAuth API to talk to Google's
   *  token / profile / revoke endpoints. */
  readonly oauthFetchFn?: typeof fetch
  /** Optional injected fetch used by the UI disconnect form to call
   *  Google's revoke endpoint. Defaults to global `fetch`. */
  readonly revokeFetchFn?: typeof fetch
  /** Sync worker (issue #021). Required when `email` deps are
   *  provided so the manual-refresh route and the status endpoint
   *  can mount. */
  readonly syncWorker: EmailSyncWorker
}

export interface YouTubeDeps {
  /** AES-256-GCM cipher for OAuth tokens at rest. */
  readonly tokenCipher: TokenCipher
  /** HMAC-signed state parameter generator for OAuth CSRF protection. */
  readonly stateSigner: StateSigner
  /** OAuth client id from the Google Cloud Console (YouTube slice). */
  readonly oauthClientId: string
  /** OAuth client secret from the Google Cloud Console (YouTube slice). */
  readonly oauthClientSecret: string
  /** Full callback URL, must match the registered redirect URI. */
  readonly redirectUri: string
  /**
   * The shared `YouTubeOAuthClient` deep module. Constructed once in
   * `index.ts` and reused by both the HTTP layer and the settings
   * view's Disconnect form. Holds `db` + `cipher` so it can persist
   * rotated tokens in `refreshIfNeeded` without callers having to
   * touch the table helpers directly.
   */
  readonly client: YouTubeOAuthClient
  /**
   * Subscriptions sync orchestrator (issue YT-002). Used by:
   *   * `POST /api/youtube/sync` — manual trigger endpoint.
   *   * The OAuth callback handler — fire-and-forget auto-sync
   *     right after the account row is created/updated.
   *   * The daily scheduler (constructed in `index.ts`).
   */
  readonly subscriptionsSync: YouTubeSubscriptionsSync
  /**
   * RSS poller (issue YT-004). Used by:
   *   * `POST /api/youtube/poll` — manual trigger endpoint.
   *   * The 15-minute background scheduler (constructed in
   *     `index.ts`).
   * The route mounts the poller directly; the scheduler wraps
   * it with a timer but isn't part of the API surface.
   */
  readonly rssPoller: YouTubeRssPoller
  /** Persisted background queue used by automatic and on-demand transcript requests. */
  readonly transcriptService: YouTubeTranscriptService
}

export interface AppDeps {
  readonly passwordHash: string
  readonly tokenStore: TokenStore
  readonly db: Database
  readonly email?: EmailDeps
  readonly youtube?: YouTubeDeps
}

/**
 * Build a Hono app instance.
 *
 * Split out from the entry point so tests can construct an app with known
 * deps (incl. in-memory DB and InMemoryTokenStore) and exercise it via
 * `app.request()` without binding to a port.
 */
export function createApp({
  passwordHash,
  tokenStore,
  db,
  email,
  youtube,
}: AppDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>()

  // Unified auth — gates every route. UI uses Basic; extension uses Bearer.
  // See ADR-007 for the rationale on dual auth.
  app.use('*', auth({ passwordHash, tokenStore }))

  // Activity feed is the landing page. Mount at root so `GET /` lands
  // on the feed handler inside the activity-feed module.
  app.route('/', activityFeedApi(db))

  // Health check (auth required by the middleware above).
  app.get('/health', (c) => c.json({ status: 'ok' }))

  // Settings (HTML, UI-driven) — token list + generate + revoke.
  const settings = settingsView(tokenStore)
  app.get('/settings', settings.list)
  app.post('/settings/tokens', settings.createToken)
  app.post('/settings/tokens/:id/revoke', settings.revokeFromUi)

  // Bookmark detail page (HTML; 404 if missing). Mounted at /bookmarks
  // so it doesn't shadow future routes.
  app.route('/bookmarks', bookmarkDetailApi(db))

  // JSON API — token management + folder read + bookmark sync.
  app.route('/api/tokens', tokenApi(tokenStore))
  app.route('/api/folders', foldersApi(db))
  app.route('/api/bookmarks', bookmarksApi(db))
  app.route('/api/tags', tagsApi(db))

  // Email read API (issue #022): list, detail, thread, search.
  // Mounted unconditionally because it only reads from the DB —
  // no OAuth/cipher/sync-worker deps required. The OAuth + sync
  // routes (issue #020 / #021) are still gated behind `email` deps
  // further down. Coexists with the other `/api/email/*` mounts
  // because Hono dispatches by exact path match.
  app.route('/api/email', emailReadApi(db))

  // Email UI (issue #023): server-rendered inbox + detail + thread.
  // Lives at `/email` (NOT `/api/email`) so the Hono path match is
  // unambiguous. The view layer reads from the same DB rows the
  // JSON API serves — no duplicate data path. The optional
  // `syncWorker` (issue #026) powers the "Last synced X ago" /
  // "Syncing now..." indicator at the top of the inbox. When email
  // deps are absent (setup-only mode) the worker is omitted and
  // the indicator is hidden by `computeSyncSummary`.
  app.route(
    '/email',
    emailViewApi(db, email ? email.syncWorker : undefined),
  )

  // Static assets (categorize.js for the categorize UI). Hand-rolled
  // tiny handler — see static-handler.ts for why we don't use Hono's
  // serveStatic yet.
  app.route('/static', staticAssets())

  // Search — JSON endpoint for the search-as-you-type JS, plus a
  // server-rendered HTML page for direct navigation and deep links.
  app.route('/api/search', searchApi(db))
  app.route('/search', searchViewApi(db))

  // v2 visual preview — single page that mocks up the future
  // dashboard compartments (Bookmarks / YouTube / Projects / Email)
  // with hardcoded fixture data. Auth-gated like everything else so
  // the design language stays consistent; meta robots noindex keeps
  // it out of any search engines if exposed.
  app.get('/preview/v2', previewV2Page)

  // Email (issue #020): OAuth flow, settings page, disconnect.
  // Two branches: full wiring when `email` deps are provided, or a
  // setup-only `/settings/email` page when they're missing. The
  // setup-only branch exists to break the chicken-and-egg loop where
  // the env vars the operator needs to set are documented on a page
  // they cannot reach without those env vars.
  if (email) {
    app.route('/api/email', emailApi({
      db,
      cipher: email.tokenCipher,
      stateSigner: email.stateSigner,
      oauthClientId: email.oauthClientId,
      oauthClientSecret: email.oauthClientSecret,
      redirectUri: email.redirectUri,
      ...(email.oauthFetchFn !== undefined ? { fetchFn: email.oauthFetchFn } : {}),
    }))
    app.route('/api/email', emailSyncApi({
      db,
      cipher: email.tokenCipher,
      worker: email.syncWorker,
    }))
    app.route('/settings/email', emailSettingsView({
      db,
      cipher: email.tokenCipher,
      ...(email.revokeFetchFn !== undefined ? { revokeFetchFn: email.revokeFetchFn } : {}),
      syncWorker: email.syncWorker,
    }))
  } else {
    // Setup-only fallback. Renders the same setup docs page the
    // configured branch uses, but with no live data and a banner
    // listing the missing env vars. No `/api/email/*` routes are
    // mounted — calls would 404, which is the right signal: "this
    // surface doesn't exist yet, configure the server first".
    app.route('/settings/email', emailSettingsSetupOnly())
  }

  // YouTube (issue YT-001): OAuth flow, settings page, disconnect,
  // connection status. Same two-branch pattern as the email slice
  // above — full wiring when `youtube` deps are provided, setup-only
  // fallback otherwise. YT-002's subscriptions sync + videos routes
  // mount on top of `youtube.client` in a future slice.
  if (youtube) {
    app.route(
      '/api/youtube',
      youtubeApi({
        db,
        cipher: youtube.tokenCipher,
        stateSigner: youtube.stateSigner,
        client: youtube.client,
        autoSyncOnGrant: youtube.subscriptionsSync,
      }),
    )
    app.route(
      '/api/youtube',
      youtubeSyncApi({
        sync: youtube.subscriptionsSync,
      }),
    )
    // RSS poll endpoint (issue YT-004): `POST /api/youtube/poll`.
    // Mounted alongside the OAuth + sync routes on `/api/youtube`.
    app.route(
      '/api/youtube',
      youtubeRssPollApi({
        poller: youtube.rssPoller,
      }),
    )
    // Videos API (issue YT-005): `/api/videos/*`. Two factories —
    // one for the resource itself, one for the tag sub-resource.
    // Same DI surface (just `db`); separate factories because
    // they have different URL prefix spaces.
    app.route(
      '/api/videos',
      youtubeVideosApi({ db }),
    )
    app.route(
      '/api/videos',
      youtubeVideoTagsApi({ db }),
    )
    app.route(
      '/api/videos',
      youtubeTranscriptsApi({ db, service: youtube.transcriptService }),
    )
    app.route(
      '/api/subscriptions',
      subscriptionsApi({ db }),
    )
    app.route(
      '/settings/youtube',
      youtubeSettingsView({
        db,
        cipher: youtube.tokenCipher,
        client: youtube.client,
      }),
    )
    // Subscriptions list page (issue YT-003). Mounted at
    // `/subscriptions` — the URL is the resource, so Hono's
    // path match resolves unambiguously even with `/api/subscriptions`
    // also in play.
    app.route(
      '/subscriptions',
      subscriptionsViewApi({ db }),
    )
    // Videos list page (issue YT-005): `/videos`. Same router
    // also owns the detail page at `/videos/:id` so we mount
    // both factories on `/videos` and let Hono disambiguate by
    // method + path.
    app.route(
      '/videos',
      youtubeVideosView({ db }),
    )
    app.route(
      '/videos',
      youtubeVideoDetailView({ db }),
    )
  } else {
    app.route('/settings/youtube', youtubeSettingsSetupOnly())
  }

  // Logout endpoint — returns 401 with a *new* realm so the browser
  // drops the cached Basic-auth credentials and prompts again.
  // Browser behaviour with Basic auth means there's no clean server-
  // side "forget me" — a 401 with the original realm is silently
  // re-authenticated by some browsers. The new realm name is the
  // standard workaround.
  app.get('/api/logout', (c) => {
    c.header(
      'WWW-Authenticate',
      'Basic realm="Dashboard (logged out — enter credentials to sign back in)"',
    )
    return c.text('Logged out. Close this tab or refresh the dashboard.', 401)
  })

  return app
}
