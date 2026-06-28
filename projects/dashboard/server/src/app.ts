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

export interface AppDeps {
  readonly passwordHash: string
  readonly tokenStore: TokenStore
  readonly db: Database
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

  // Static assets (categorize.js for the categorize UI). Hand-rolled
  // tiny handler — see static-handler.ts for why we don't use Hono's
  // serveStatic yet.
  app.route('/static', staticAssets())

  // Search — JSON endpoint for the search-as-you-type JS, plus a
  // server-rendered HTML page for direct navigation and deep links.
  app.route('/api/search', searchApi(db))
  app.route('/search', searchViewApi(db))

  return app
}
