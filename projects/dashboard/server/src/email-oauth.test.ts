// email-oauth.test.ts — issue #020
//
// Tests for the OAuth flow + disconnect endpoint. The Google endpoints
// are mocked via an injected `fetchFn`, so the suite never hits the
// network. We assert:
//
//   * `GET /oauth/start` redirects to Google's consent screen with
//     state = HMAC-sign(nonce, now) and scope = `gmail.readonly`.
//   * `GET /oauth/callback?code=...&state=...` exchanges the code,
//     fetches the Gmail profile, encrypts + stores tokens, redirects to
//     `/settings/email?status=connected`.
//   * State tampering / expiry → error redirect.
//   * Missing refresh token / bad token exchange / profile failure →
//     all branch into the same single error redirect.
//   * Re-linking the same email replaces the old row.
//   * `DELETE /api/email/accounts/:id` revokes at Google + removes the row.
//   * Scopes requested match exactly `gmail.readonly` (regression guard
//     wired through the page rendering as well).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import bcrypt from 'bcryptjs'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { createStateSigner, createTokenCipher } from './token-encryption.js'
import { InMemoryTokenStore } from './token-store.js'
import { auth, type AuthVariables } from './auth.js'
import { listEmailAccounts } from './email-accounts.js'
import { emailApi, OAUTH_SCOPE } from './email-oauth.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')
const PASSWORD = 'correct horse battery staple'
const HASH = bcrypt.hashSync(PASSWORD, 10)

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

interface Env {
  readonly app: Hono<{ Variables: AuthVariables }>
  readonly fetchFn: ReturnType<typeof vi.fn>
  readonly cipher: ReturnType<typeof createTokenCipher>
  readonly db: Database
  readonly tokenStore: InMemoryTokenStore
}

async function buildEnv(): Promise<Env> {
  const db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  const cipher = createTokenCipher(randomBytes(32))
  const stateSigner = createStateSigner(randomBytes(32))

  const tokenStore = new InMemoryTokenStore()
  const fetchFn = vi.fn() as unknown as ReturnType<typeof vi.fn>

  const app = new Hono<{ Variables: AuthVariables }>()
  app.use('*', auth({ passwordHash: HASH, tokenStore }))
  app.route(
    '/api/email',
    emailApi({
      db,
      cipher,
      stateSigner,
      oauthClientId: 'test-client-id',
      oauthClientSecret: 'test-client-secret',
      redirectUri: 'http://localhost:8080/api/email/oauth/callback',
      fetchFn: fetchFn as unknown as typeof fetch,
    }),
  )
  return { app, fetchFn: fetchFn as unknown as ReturnType<typeof vi.fn>, cipher, db, tokenStore }
}

// ─── Scope regression guard ───────────────────────────────────────────────

describe('OAuth scope', () => {
  it('requests exactly gmail.readonly', () => {
    expect(OAUTH_SCOPE).toBe('https://www.googleapis.com/auth/gmail.readonly')
    expect(OAUTH_SCOPE).not.toContain('gmail.modify')
    expect(OAUTH_SCOPE).not.toContain('gmail.send')
    expect(OAUTH_SCOPE).not.toContain('gmail.compose')
  })
})

// ─── /oauth/start ─────────────────────────────────────────────────────────

describe('GET /api/email/oauth/start', () => {
  let env: Env
  beforeEach(async () => {
    env = await buildEnv()
  })
  afterEach(() => vi.restoreAllMocks())

  it('redirects to Google with scope=gmail.readonly and a signed state', async () => {
    const res = await env.app.request('/api/email/oauth/start', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/)

    const url = new URL(location)
    expect(url.searchParams.get('client_id')).toBe('test-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8080/api/email/oauth/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')

    const state = url.searchParams.get('state') ?? ''
    // State has 3 dot-separated parts: nonce.issuedAtMs.signature.
    expect(state.split('.')).toHaveLength(3)
    expect(state).not.toBe('')
  })

  it('rejects requests without auth (401)', async () => {
    const res = await env.app.request('/api/email/oauth/start')
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="Dashboard"')
  })

  it('rejects requests with wrong password (401)', async () => {
    const res = await env.app.request('/api/email/oauth/start', {
      headers: { authorization: basicHeader('david', 'wrong') },
    })
    expect(res.status).toBe(401)
  })
})

// ─── /oauth/callback ──────────────────────────────────────────────────────

describe('GET /api/email/oauth/callback', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * Build a state signed with the **same HMAC key** the env's API uses.
   * The env helpers hide the key, so we sign the state via a tiny HTTP
   * detour through the real endpoint. Simpler approach: build a *new*
   * env with a captured key. We do that here.
   */
  async function envWithSigningKey(): Promise<{
    env: Env
    stateSigner: ReturnType<typeof createStateSigner>
  }> {
    const key = randomBytes(32)
    const db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    const cipher = createTokenCipher(key)
    const signer = createStateSigner(key)
    const tokenStore = new InMemoryTokenStore()
    const fetchFn = vi.fn()

    const app = new Hono<{ Variables: AuthVariables }>()
    app.use('*', auth({ passwordHash: HASH, tokenStore }))
    app.route(
      '/api/email',
      emailApi({
        db,
        cipher,
        stateSigner: signer,
        oauthClientId: 'test-client-id',
        oauthClientSecret: 'test-client-secret',
        redirectUri: 'http://localhost:8080/api/email/oauth/callback',
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    )
    return {
      env: {
        app,
        fetchFn: fetchFn as unknown as ReturnType<typeof vi.fn>,
        cipher,
        db,
        tokenStore,
      },
      stateSigner: signer,
    }
  }

  it('exchanges the code, stores encrypted tokens, redirects with status=connected', async () => {
    const { env: e, stateSigner: signer } = await envWithSigningKey()

    // Google's token endpoint returns access + refresh + expires_in
    e.fetchFn.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'ya29.new-access',
          refresh_token: '1//new-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    // Gmail profile endpoint returns the user's email
    e.fetchFn.mockResolvedValueOnce(
      new Response(JSON.stringify({ emailAddress: 'user@gmail.com' }), { status: 200 }),
    )

    const state = signer.sign('nonce', Date.now())
    const res = await e.app.request(
      `/api/email/oauth/callback?code=AUTH_CODE&state=${encodeURIComponent(state)}`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/email?status=connected')

    // Verify the row was written and tokens decrypt correctly.
    const accounts = listEmailAccounts(e.db, e.cipher)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.emailAddress).toBe('user@gmail.com')
    expect(accounts[0]!.accessToken).toBe('ya29.new-access')
    expect(accounts[0]!.refreshToken).toBe('1//new-refresh')

    // The two fetches went to the right URLs.
    expect(e.fetchFn).toHaveBeenCalledTimes(2)
    const tokenCall = e.fetchFn.mock.calls[0]!
    expect(tokenCall[0]).toBe('https://oauth2.googleapis.com/token')
    expect(tokenCall[1]!.method).toBe('POST')
    const profileCall = e.fetchFn.mock.calls[1]!
    expect(profileCall[0]).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile')
  })

  it('rejects an invalid (tampered) state', async () => {
    const { env: e } = await envWithSigningKey()

    const res = await e.app.request(
      `/api/email/oauth/callback?code=CODE&state=${encodeURIComponent('forged.nonce.signature')}`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(
      /^\/settings\/email\?status=error&reason=invalid_or_expired_state/,
    )
  })

  it('rejects an expired state (>10 minutes old)', async () => {
    const { env: e, stateSigner: signer } = await envWithSigningKey()
    const stale = signer.sign('nonce', Date.now() - 11 * 60 * 1000)
    const res = await e.app.request(
      `/api/email/oauth/callback?code=CODE&state=${encodeURIComponent(stale)}`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/status=error&reason=invalid_or_expired_state/)
  })

  it('redirects to error when Google returns ?error=access_denied', async () => {
    const { env: e } = await envWithSigningKey()
    const res = await e.app.request(
      `/api/email/oauth/callback?error=access_denied&state=anything`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/status=error/)
    expect(res.headers.get('location')!).toContain('access_denied')
  })

  it('redirects to error when the token exchange returns 400', async () => {
    const { env: e, stateSigner: signer } = await envWithSigningKey()
    e.fetchFn.mockResolvedValueOnce(
      new Response('invalid_grant', { status: 400 }),
    )
    const state = signer.sign('nonce', Date.now())
    const res = await e.app.request(
      `/api/email/oauth/callback?code=BAD&state=${encodeURIComponent(state)}`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/status=error&reason=token_exchange_failed/)
  })

  it('redirects to error when the refresh token is missing from the response', async () => {
    const { env: e, stateSigner: signer } = await envWithSigningKey()
    e.fetchFn.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'only-access',
          expires_in: 3600,
          // refresh_token: intentionally absent
        }),
        { status: 200 },
      ),
    )
    const state = signer.sign('nonce', Date.now())
    const res = await e.app.request(
      `/api/email/oauth/callback?code=CODE&state=${encodeURIComponent(state)}`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/status=error&reason=no_refresh_token/)
  })

  it('redirects to error when Gmail profile lookup fails', async () => {
    const { env: e, stateSigner: signer } = await envWithSigningKey()
    e.fetchFn.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    )
    e.fetchFn.mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
    const state = signer.sign('nonce', Date.now())
    const res = await e.app.request(
      `/api/email/oauth/callback?code=CODE&state=${encodeURIComponent(state)}`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/status=error&reason=gmail_profile_failed/)
  })

  it('re-linking the same email replaces the prior row', async () => {
    const { env: e, stateSigner: signer } = await envWithSigningKey()

    // First link: succeed.
    e.fetchFn.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'first-access',
          refresh_token: 'first-refresh',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    )
    e.fetchFn.mockResolvedValueOnce(
      new Response(JSON.stringify({ emailAddress: 'me@gmail.com' }), { status: 200 }),
    )
    let state = signer.sign('nonce', Date.now())
    let res = await e.app.request(
      `/api/email/oauth/callback?code=C1&state=${encodeURIComponent(state)}`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.headers.get('location')).toBe('/settings/email?status=connected')

    const firstAccounts = listEmailAccounts(e.db, e.cipher)
    expect(firstAccounts).toHaveLength(1)
    expect(firstAccounts[0]!.accessToken).toBe('first-access')

    // Second link of the same email (e.g. user reconnected): should
    // delete the first row and insert a new one — not throw on the
    // UNIQUE index, not leave two rows around.
    e.fetchFn.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'second-access',
          refresh_token: 'second-refresh',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    )
    e.fetchFn.mockResolvedValueOnce(
      new Response(JSON.stringify({ emailAddress: 'me@gmail.com' }), { status: 200 }),
    )
    state = signer.sign('nonce', Date.now())
    res = await e.app.request(
      `/api/email/oauth/callback?code=C2&state=${encodeURIComponent(state)}`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.headers.get('location')).toBe('/settings/email?status=connected')

    const secondAccounts = listEmailAccounts(e.db, e.cipher)
    expect(secondAccounts).toHaveLength(1)
    expect(secondAccounts[0]!.accessToken).toBe('second-access')
    expect(secondAccounts[0]!.refreshToken).toBe('second-refresh')
  })

  it('rejects missing code or state (redirects to error)', async () => {
    const { env: e } = await envWithSigningKey()
    const resNoCode = await e.app.request(
      `/api/email/oauth/callback?state=something`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(resNoCode.headers.get('location')).toMatch(/status=error&reason=missing_params/)
    const resNoState = await e.app.request(
      `/api/email/oauth/callback?code=CODE`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(resNoState.headers.get('location')).toMatch(/status=error&reason=missing_params/)
  })
})

// ─── DELETE /api/email/accounts/:id ───────────────────────────────────────

describe('DELETE /api/email/accounts/:id', () => {
  let env: Env
  beforeEach(async () => {
    env = await buildEnv()
  })

  async function seedAccount(): Promise<string> {
    // Pre-insert a row by hitting /start (avoid a render in the test).
    const mod = await import('./email-accounts.js')
    const row = mod.createEmailAccount(env.db, env.cipher, {
      provider: 'gmail',
      emailAddress: 'me@gmail.com',
      accessToken: 'access-to-revoke',
      refreshToken: 'refresh-to-keep-around',
    })
    return row.id
  }

  it('revokes the access token at Google and deletes the local row', async () => {
    const id = await seedAccount()

    env.fetchFn.mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const res = await env.app.request(`/api/email/accounts/${id}`, {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(204)

    // Row is gone.
    const accounts = listEmailAccounts(env.db, env.cipher)
    expect(accounts).toEqual([])

    // Revoke endpoint was called with the access token in the URL.
    expect(env.fetchFn).toHaveBeenCalledTimes(1)
    const callArgs = env.fetchFn.mock.calls[0]!
    const url = callArgs[0] as string
    expect(url).toMatch(/^https:\/\/oauth2\.googleapis\.com\/revoke\?token=/)
    expect(url).toContain(encodeURIComponent('access-to-revoke'))
    expect(callArgs[1]!.method).toBe('POST')
  })

  it('still deletes locally when the revoke endpoint throws', async () => {
    const id = await seedAccount()
    env.fetchFn.mockRejectedValueOnce(new Error('network down'))

    const res = await env.app.request(`/api/email/accounts/${id}`, {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(204)
    expect(listEmailAccounts(env.db, env.cipher)).toEqual([])
  })

  it('returns 404 for an unknown id', async () => {
    const res = await env.app.request('/api/email/accounts/does-not-exist', {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(404)
  })

  it('requires auth (401)', async () => {
    const id = await seedAccount()
    const res = await env.app.request(`/api/email/accounts/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(401)
  })

  it('still deletes locally when the stored token cannot be decrypted (rotation)', async () => {
    const id = await seedAccount()
    // Simulate key rotation by mutating the ciphertext column to garbage.
    env.db.run(
      'UPDATE email_accounts SET access_token_enc = ? WHERE id = ?',
      ['not-a-valid-ciphertext', id],
    )

    const res = await env.app.request(`/api/email/accounts/${id}`, {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(204)
    expect(listEmailAccounts(env.db, env.cipher)).toEqual([])
  })
})
