// youtube-settings.test.ts — issue YT-001
//
// Tests for the HTML view at /settings/youtube plus its form-friendly
// POST /settings/youtube/disconnect endpoint. Goals:
//
//   * Empty state shows the "Connect YouTube" button with scope note.
//   * Connected state lists the account with a Disconnect form.
//   * The Google Cloud setup docs are present (the one-time checklist).
//   * The disconnect POST revokes at Google + deletes the row, then
//     redirects with status=disconnected.
//   * Scopes requested match exactly `youtube.readonly` everywhere.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { createTokenCipher } from './token-encryption.js'
import { auth, type AuthVariables } from './auth.js'
import { InMemoryTokenStore } from './token-store.js'
import { createYouTubeAccount } from './youtube-accounts.js'
import { OAUTH_SCOPE, YouTubeOAuthClient } from './youtube-oauth.js'
import { youtubeSettingsView } from './youtube-settings.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')
const PASSWORD = 'correct horse battery staple'
const HASH = bcrypt.hashSync(PASSWORD, 10)

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

interface Env {
  app: Hono<{ Variables: AuthVariables }>
  fetchFn: ReturnType<typeof vi.fn>
  db: Database
  cipher: ReturnType<typeof createTokenCipher>
  tokenStore: InMemoryTokenStore
  client: YouTubeOAuthClient
}

async function buildEnv(): Promise<Env> {
  const key = randomBytes(32)
  const db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  const cipher = createTokenCipher(key)
  const tokenStore = new InMemoryTokenStore()
  const fetchFn = vi.fn()
  const client = new YouTubeOAuthClient({
    db,
    cipher,
    oauthClientId: 'test-client-id',
    oauthClientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:8080/api/youtube/oauth/callback',
    fetchFn: fetchFn as unknown as typeof fetch,
  })

  const app = new Hono<{ Variables: AuthVariables }>()
  app.use('*', auth({ passwordHash: HASH, tokenStore }))
  app.route(
    '/settings/youtube',
    youtubeSettingsView({
      db,
      cipher,
      client,
    }),
  )
  return { app, fetchFn, db, cipher, tokenStore, client }
}

// ─── Empty state ──────────────────────────────────────────────────────────

describe('GET /settings/youtube — empty state', () => {
  let env: Env
  beforeEach(async () => {
    env = await buildEnv()
  })
  afterEach(() => vi.restoreAllMocks())

  it('renders the Connect YouTube button + scope note', async () => {
    const res = await env.app.request('/settings/youtube', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Connect YouTube')
    // The button is an <a> linking to the OAuth start route.
    expect(html).toContain('href="/api/youtube/oauth/start"')
    // Scope statement names the exact scope the dashboard requests.
    expect(html).toContain(OAUTH_SCOPE)
  })

  it('renders the setup docs (Google Cloud Console checklist)', async () => {
    const res = await env.app.request('/settings/youtube', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    // Spot-check the must-haves of the one-time setup.
    expect(html).toContain('Google Cloud Console')
    expect(html).toContain('YouTube Data API v3')
    expect(html).toContain('YOUTUBE_OAUTH_REDIRECT_URI')
    expect(html).toContain('YOUTUBE_TOKEN_ENCRYPTION_KEY')
    expect(html).toContain('redirect URI rules')
  })

  it('requires auth (401)', async () => {
    const res = await env.app.request('/settings/youtube')
    expect(res.status).toBe(401)
  })
})

// ─── Connected state ──────────────────────────────────────────────────────

describe('GET /settings/youtube — connected state', () => {
  let env: Env
  beforeEach(async () => {
    env = await buildEnv()
    createYouTubeAccount(env.db, env.cipher, {
      provider: 'youtube',
      googleUserId: 'gid-1',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
      scopes: OAUTH_SCOPE,
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('renders the connected account + Disconnect form', async () => {
    const res = await env.app.request('/settings/youtube', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('me@gmail.com')
    expect(html).toContain('Disconnect')
    // The Disconnect form posts to the form-friendly alias.
    expect(html).toContain('action="/settings/youtube/disconnect"')
    // Permissions: line shows the granted scope.
    expect(html).toContain('Permissions:')
    expect(html).toContain(OAUTH_SCOPE)
  })

  it('does not render the Connect button when an account is linked', async () => {
    const res = await env.app.request('/settings/youtube', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    // The Connect YouTube button is only rendered in the empty-state
    // prompt. The Disconnect form replaces it in connected state.
    expect(html).not.toContain('href="/api/youtube/oauth/start"')
  })

  it('shows jump links to /videos + /subscriptions when an account is linked', async () => {
    const res = await env.app.request('/settings/youtube', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    // Discoverability for YT-005: links to the new pages.
    expect(html).toContain('href="/videos"')
    expect(html).toContain('View new videos')
    expect(html).toContain('href="/subscriptions"')
    expect(html).toContain('Manage subscriptions')
  })
})

// ─── Flash banner ─────────────────────────────────────────────────────────

describe('GET /settings/youtube — flash banner', () => {
  let env: Env
  beforeEach(async () => {
    env = await buildEnv()
  })
  afterEach(() => vi.restoreAllMocks())

  it('shows a success flash when ?status=connected', async () => {
    const res = await env.app.request('/settings/youtube?status=connected', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('YouTube connected successfully.')
  })

  it('shows an error flash with humanised reason when ?status=error', async () => {
    const res = await env.app.request(
      '/settings/youtube?status=error&reason=invalid_or_expired_state',
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    const html = await res.text()
    expect(html).toContain('CSRF state was invalid or expired')
  })

  it('humanises token_exchange_failed:<detail> in the error flash', async () => {
    const res = await env.app.request(
      '/settings/youtube?status=error&reason=token_exchange_failed:invalid_grant',
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    const html = await res.text()
    expect(html).toContain('Google rejected the authorisation code')
    expect(html).toContain('invalid_grant')
  })
})

// ─── POST /settings/youtube/disconnect ────────────────────────────────────

describe('POST /settings/youtube/disconnect', () => {
  let env: Env
  beforeEach(async () => {
    env = await buildEnv()
  })
  afterEach(() => vi.restoreAllMocks())

  it('revokes the access token at Google, deletes the row, and redirects with status=disconnected', async () => {
    createYouTubeAccount(env.db, env.cipher, {
      provider: 'youtube',
      googleUserId: 'gid-1',
      emailAddress: 'me@gmail.com',
      accessToken: 'access-to-revoke',
      refreshToken: 'r',
      scopes: OAUTH_SCOPE,
    })
    env.fetchFn.mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const res = await env.app.request('/settings/youtube/disconnect', {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/youtube?status=disconnected')

    // Row gone, revoke endpoint called with the access token.
    const { listYouTubeAccounts } = await import('./youtube-accounts.js')
    expect(listYouTubeAccounts(env.db, env.cipher)).toEqual([])
    expect(env.fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = env.fetchFn.mock.calls[0]!
    expect(url).toMatch(/^https:\/\/oauth2\.googleapis\.com\/revoke\?token=/)
    expect(url).toContain(encodeURIComponent('access-to-revoke'))
    expect(init!.method).toBe('POST')
  })

  it('still redirects (no error) when no account is linked', async () => {
    const res = await env.app.request('/settings/youtube/disconnect', {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/youtube')
  })

  it('still deletes locally when the revoke endpoint throws', async () => {
    createYouTubeAccount(env.db, env.cipher, {
      provider: 'youtube',
      googleUserId: 'gid-1',
      emailAddress: 'me@gmail.com',
      accessToken: 'access',
      refreshToken: 'r',
      scopes: OAUTH_SCOPE,
    })
    env.fetchFn.mockRejectedValueOnce(new Error('network down'))

    const res = await env.app.request('/settings/youtube/disconnect', {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(302)
    const { listYouTubeAccounts } = await import('./youtube-accounts.js')
    expect(listYouTubeAccounts(env.db, env.cipher)).toEqual([])
  })

  it('requires auth (401)', async () => {
    const res = await env.app.request('/settings/youtube/disconnect', { method: 'POST' })
    expect(res.status).toBe(401)
  })
})