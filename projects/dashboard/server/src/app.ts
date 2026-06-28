import { Hono } from 'hono'
import { auth, type AuthVariables } from './auth.js'
import type { Database } from './db.js'
import type { TokenStore } from './token-store.js'
import { tokenApi } from './api-tokens.js'
import { settingsView } from './settings-view.js'
import { foldersApi } from './folders.js'

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

  app.get('/', (c) => {
    const who = c.get('user') ?? c.get('tokenId') ?? 'unknown'
    return c.html(homePage(who))
  })

  // Placeholder for the future activity feed / bookmark UI.
  app.get('/health', (c) => c.json({ status: 'ok' }))

  // Settings (HTML, UI-driven) — token list + generate + revoke.
  const settings = settingsView(tokenStore)
  app.get('/settings', settings.list)
  app.post('/settings/tokens', settings.createToken)
  app.post('/settings/tokens/:id/revoke', settings.revokeFromUi)

  // JSON API — token management + folder read.
  app.route('/api/tokens', tokenApi(tokenStore))
  app.route('/api/folders', foldersApi(db))

  return app
}

function homePage(user: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Dashboard</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
      h1 { font-weight: 500; }
      .user { color: #666; font-size: 0.9rem; }
      nav { margin-top: 1.5rem; }
      nav a { margin-right: 1rem; color: #06c; }
    </style>
  </head>
  <body>
    <h1>Dashboard is up</h1>
    <p class="user">Signed in as <strong>${escapeHtml(user)}</strong></p>
    <p>The activity feed and bookmark UI land in v1 issues #007–#009.</p>
    <nav><a href="/settings">Settings</a></nav>
  </body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
