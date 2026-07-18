// youtube-oauth.test.ts — issue YT-001
//
// Tests for the YouTubeOAuthClient methods (the deep module) and the
// HTTP layer (`youtubeApi`). Google's endpoints are mocked via an
// injected `fetchFn`, so the suite never hits the network. We assert:
//
//   YouTubeOAuthClient:
//     * getAuthorizationUrl(state) returns the consent-screen URL
//       with scope=youtube.readonly + offline + consent.
//     * exchangeCode(code) POSTs to /token with the right body.
//     * refresh(refreshToken) POSTs to /token with grant_type=refresh_token.
//     * revoke(token) POSTs to /revoke.
//     * fetchUserIdentity(accessToken) reads userinfo and returns
//       {googleUserId, email}; rejects unverified emails.
//     * refreshIfNeeded(account) — returns the original tokens if not
//       near expiry; otherwise refreshes and updates the DB row.
//
//   HTTP layer (youtubeApi):
//     * GET /oauth/start redirects to Google with scope=youtube.readonly.
//     * GET /oauth/callback?code=...&state=... exchanges the code,
//       fetches userinfo, encrypts + stores tokens, redirects to
//       /settings/youtube?status=connected.
//     * State tampering / expiry → error redirect.
//     * Missing code/state → error redirect.
//     * No refresh token / bad token exchange / userinfo failure →
//       all branch into the same error redirect.
//     * Re-linking the same email updates credentials in place so local
//       YouTube library rows survive.
//     * GET /connection returns the connected status or {connected:false}.
//     * DELETE /connection revokes at Google + removes the row.
//     * Scopes requested match exactly youtube.readonly (regression
//       guard, mirrored from email-oauth).

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
import { createYouTubeAccount, listYouTubeAccounts } from './youtube-accounts.js'
import { OAUTH_SCOPE, REFRESH_WINDOW_MS, YouTubeOAuthClient, youtubeApi } from './youtube-oauth.js'

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
  readonly client: YouTubeOAuthClient
}

function buildEnv(opts: { fetchFn?: ReturnType<typeof vi.fn>; nowMs?: () => number } = {}): Env {
  const key = randomBytes(32)
  const db = new Database(':memory:')
  // Synchronous migration runner — but it's async; the test pattern
  // here uses sync block. The test files in this codebase don't await
  // runMigrations for inline tests; instead they use a top-level
  // beforeAll-style. For simplicity, every test in this file uses an
  // async `await runMigrations(...)`. Here we provide a sync-ish
  // helper that pre-migrates in beforeAll. For buildEnv to be sync,
  // we migrate lazily inside the tests themselves (they all use
  // beforeEach(async () => await seedDb(env))). Easier: make buildEnv
  // async and have tests await it. See usages below.
  const cipher = createTokenCipher(key)
  const signer = createStateSigner(key)
  const tokenStore = new InMemoryTokenStore()
  const fetchFn = opts.fetchFn ?? (vi.fn() as unknown as ReturnType<typeof vi.fn>)
  const client = new YouTubeOAuthClient({
    db,
    cipher,
    oauthClientId: 'test-client-id',
    oauthClientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:8080/api/youtube/oauth/callback',
    fetchFn: fetchFn as unknown as typeof fetch,
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
  })

  const app = new Hono<{ Variables: AuthVariables }>()
  app.use('*', auth({ passwordHash: HASH, tokenStore }))
  app.route(
    '/api/youtube',
    youtubeApi({
      db,
      cipher,
      client,
      stateSigner: signer,
    }),
  )
  return { app, fetchFn: fetchFn as unknown as ReturnType<typeof vi.fn>, cipher, db, tokenStore, client }
}

async function buildEnvAsync(opts: { fetchFn?: ReturnType<typeof vi.fn>; nowMs?: () => number } = {}): Promise<Env> {
  const env = buildEnv(opts)
  await runMigrations(env.db, { dir: MIGRATIONS_DIR })
  return env
}

// ─── Scope regression guard ───────────────────────────────────────────────

describe('OAuth scope', () => {
  it('requests youtube.readonly AND openid AND userinfo.email (no others)', () => {
    // We need exactly three scopes:
    //   - youtube.readonly for the data API
    //   - openid for OIDC identity (and the JWT id_token in the
    //     token-exchange response)
    //   - userinfo.email so the v2 userinfo endpoint actually
    //     returns the email field (without it, the response has no
    //     email and the OAuth flow fails with "missing email")
    expect(OAUTH_SCOPE).toContain('youtube.readonly')
    expect(OAUTH_SCOPE).toContain('openid')
    expect(OAUTH_SCOPE).toContain('userinfo.email')
    // The full scope set must be exactly these three (space-separated).
    expect(OAUTH_SCOPE.split(' ').sort()).toEqual([
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/youtube.readonly',
      'openid',
    ])
    // Negative assertions — never request write/upload/comment scopes.
    expect(OAUTH_SCOPE).not.toContain('youtube.upload')
    expect(OAUTH_SCOPE).not.toContain('youtube.force-ssl')
    expect(OAUTH_SCOPE).not.toContain('youtubepartner')
    expect(OAUTH_SCOPE).not.toContain('youtube.channel.force-ssl')
  })

  it('REFRESH_WINDOW_MS is 5 minutes', () => {
    expect(REFRESH_WINDOW_MS).toBe(5 * 60 * 1000)
  })
})

// ─── YouTubeOAuthClient (deep module) ─────────────────────────────────────

describe('YouTubeOAuthClient.getAuthorizationUrl', () => {
  it('builds the consent-screen URL with the documented params', () => {
    const env = buildEnv()
    const url = new URL(env.client.getAuthorizationUrl('signed-state'))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe('test-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:8080/api/youtube/oauth/callback',
    )
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe(OAUTH_SCOPE)
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('state')).toBe('signed-state')
  })
})

describe('YouTubeOAuthClient.exchangeCode', () => {
  it('POSTs to /token with the right form body and parses the response', async () => {
    const env = await buildEnvAsync({
      fetchFn: vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'ya29.access',
            refresh_token: '1//refresh',
            expires_in: 3600,
            scope: OAUTH_SCOPE,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ) as unknown as ReturnType<typeof vi.fn>,
    })
    const res = await env.client.exchangeCode('AUTH_CODE')
    expect(res.access_token).toBe('ya29.access')
    expect(res.refresh_token).toBe('1//refresh')
    expect(res.expires_in).toBe(3600)
    expect(res.scope).toBe(OAUTH_SCOPE)
    // Verify the outgoing HTTP shape.
    expect(env.fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = env.fetchFn.mock.calls[0]!
    expect(url).toBe('https://oauth2.googleapis.com/token')
    expect(init!.method).toBe('POST')
    expect((init!.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    )
    const body = new URLSearchParams(init!.body as string)
    expect(body.get('code')).toBe('AUTH_CODE')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('client_id')).toBe('test-client-id')
  })

  it('throws on a non-2xx response from Google', async () => {
    const env = await buildEnvAsync({
      fetchFn: vi.fn().mockResolvedValueOnce(new Response('invalid_grant', { status: 400 })) as unknown as ReturnType<typeof vi.fn>,
    })
    await expect(env.client.exchangeCode('BAD')).rejects.toThrow(/HTTP 400/)
  })
})

describe('YouTubeOAuthClient.refresh', () => {
  it('POSTs to /token with grant_type=refresh_token and returns new access token', async () => {
    const env = await buildEnvAsync({
      fetchFn: vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'ya29.rotated', expires_in: 3600 }),
          { status: 200 },
        ),
      ) as unknown as ReturnType<typeof vi.fn>,
    })
    const res = await env.client.refresh('1//old-refresh')
    expect(res.access_token).toBe('ya29.rotated')
    expect(res.expires_in).toBe(3600)

    const [url, init] = env.fetchFn.mock.calls[0]!
    expect(url).toBe('https://oauth2.googleapis.com/token')
    const body = new URLSearchParams(init!.body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('1//old-refresh')
  })

  it('throws when the response is missing access_token', async () => {
    const env = await buildEnvAsync({
      fetchFn: vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 }),
      ) as unknown as ReturnType<typeof vi.fn>,
    })
    await expect(env.client.refresh('rt')).rejects.toThrow(/missing access_token/)
  })

  it('falls back to expires_in=3600 when Google omits it', async () => {
    const env = await buildEnvAsync({
      fetchFn: vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'a' }), { status: 200 }),
      ) as unknown as ReturnType<typeof vi.fn>,
    })
    const res = await env.client.refresh('rt')
    expect(res.expires_in).toBe(3600)
  })
})

describe('YouTubeOAuthClient.revoke', () => {
  it('POSTs to /revoke with the token in the URL', async () => {
    const env = await buildEnvAsync({
      fetchFn: vi.fn().mockResolvedValueOnce(new Response('', { status: 200 })) as unknown as ReturnType<typeof vi.fn>,
    })
    await env.client.revoke('TOKEN_TO_REVOKE')
    const [url, init] = env.fetchFn.mock.calls[0]!
    expect(url).toMatch(/^https:\/\/oauth2\.googleapis\.com\/revoke\?token=/)
    expect(url).toContain(encodeURIComponent('TOKEN_TO_REVOKE'))
    expect(init!.method).toBe('POST')
  })
})

describe('YouTubeOAuthClient.fetchUserIdentity', () => {
  it('returns googleUserId + email from userinfo', async () => {
    const env = await buildEnvAsync({
      fetchFn: vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'gid-123',
            email: 'david@gmail.com',
            verified_email: true,
            name: 'David',
          }),
          { status: 200 },
        ),
      ) as unknown as ReturnType<typeof vi.fn>,
    })
    const id = await env.client.fetchUserIdentity('ACCESS')
    expect(id).toEqual({ googleUserId: 'gid-123', email: 'david@gmail.com' })
    expect(env.fetchFn.mock.calls[0]![0]).toBe(
      'https://www.googleapis.com/oauth2/v2/userinfo',
    )
    const init = env.fetchFn.mock.calls[0]![1]!
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ACCESS')
  })

  it('throws on an unverified email', async () => {
    const env = await buildEnvAsync({
      fetchFn: vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'gid-123',
            email: 'david@gmail.com',
            verified_email: false,
          }),
          { status: 200 },
        ),
      ) as unknown as ReturnType<typeof vi.fn>,
    })
    await expect(env.client.fetchUserIdentity('ACCESS')).rejects.toThrow(/not verified/)
  })

  it('throws when email is missing', async () => {
    const env = await buildEnvAsync({
      fetchFn: vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'gid' }), { status: 200 }),
      ) as unknown as ReturnType<typeof vi.fn>,
    })
    await expect(env.client.fetchUserIdentity('ACCESS')).rejects.toThrow(/missing email/)
  })

  it('throws on a non-2xx response', async () => {
    const env = await buildEnvAsync({
      fetchFn: vi.fn().mockResolvedValueOnce(new Response('forbidden', { status: 403 })) as unknown as ReturnType<typeof vi.fn>,
    })
    await expect(env.client.fetchUserIdentity('ACCESS')).rejects.toThrow(/HTTP 403/)
  })
})

describe('YouTubeOAuthClient.refreshIfNeeded', () => {
  it('returns the original tokens when not near expiry', async () => {
    const env = await buildEnvAsync()
    // Pre-insert a row with expires_at 1 hour in the future.
    const farFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const acc = createYouTubeAccount(env.db, env.cipher, {
      provider: 'youtube',
      googleUserId: 'gid',
      emailAddress: 'me@gmail.com',
      accessToken: 'still-valid-access',
      refreshToken: 'rt',
      scopes: OAUTH_SCOPE,
      tokenExpiresAt: farFuture,
    })
    const res = await env.client.refreshIfNeeded(acc)
    expect(res.accessToken).toBe('still-valid-access')
    expect(res.refreshed).toBe(false)
    // No fetch calls were made.
    expect(env.fetchFn).not.toHaveBeenCalled()
  })

  it('refreshes when expires_at is within the refresh window', async () => {
    const now = 1_700_000_000_000
    const env = await buildEnvAsync({
      nowMs: () => now,
      fetchFn: vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'ya29.rotated', expires_in: 3600 }),
          { status: 200 },
        ),
      ) as unknown as ReturnType<typeof vi.fn>,
    })
    const almostExpired = new Date(now + 60 * 1000).toISOString() // 1 min from now
    const acc = createYouTubeAccount(env.db, env.cipher, {
      provider: 'youtube',
      googleUserId: 'gid',
      emailAddress: 'me@gmail.com',
      accessToken: 'about-to-expire',
      refreshToken: 'rt-keep',
      scopes: OAUTH_SCOPE,
      tokenExpiresAt: almostExpired,
    })

    const res = await env.client.refreshIfNeeded(acc)
    expect(res.accessToken).toBe('ya29.rotated')
    expect(res.refreshed).toBe(true)
    expect(res.expiresAt).toBe(new Date(now + 3600 * 1000).toISOString())

    // DB was updated: access token rotated, expires_at updated,
    // last_refreshed_at set, refresh_token preserved.
    const stored = listYouTubeAccounts(env.db, env.cipher)
    expect(stored).toHaveLength(1)
    expect(stored[0]!.accessToken).toBe('ya29.rotated')
    expect(stored[0]!.refreshToken).toBe('rt-keep') // unchanged
    expect(stored[0]!.lastRefreshedAt).toBe(new Date(now).toISOString())
  })

  it('refreshes when tokenExpiresAt is null (unknown expiry)', async () => {
    const env = await buildEnvAsync({
      fetchFn: vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'ya29.rotated', expires_in: 3600 }),
          { status: 200 },
        ),
      ) as unknown as ReturnType<typeof vi.fn>,
    })
    const acc = createYouTubeAccount(env.db, env.cipher, {
      provider: 'youtube',
      googleUserId: 'gid',
      emailAddress: 'me@gmail.com',
      accessToken: 'old',
      refreshToken: 'rt',
      scopes: OAUTH_SCOPE,
    })
    const res = await env.client.refreshIfNeeded(acc)
    expect(res.refreshed).toBe(true)
    expect(res.accessToken).toBe('ya29.rotated')
  })
})

// ─── GET /oauth/start ─────────────────────────────────────────────────────

describe('GET /api/youtube/oauth/start', () => {
  let env: Env
  beforeEach(async () => {
    env = await buildEnvAsync()
  })
  afterEach(() => vi.restoreAllMocks())

  it('redirects to Google with scope=youtube.readonly and a signed state', async () => {
    const res = await env.app.request('/api/youtube/oauth/start', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/)

    const url = new URL(location)
    expect(url.searchParams.get('client_id')).toBe('test-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:8080/api/youtube/oauth/callback',
    )
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe(OAUTH_SCOPE)
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')

    const state = url.searchParams.get('state') ?? ''
    // State has 3 dot-separated parts: nonce.issuedAtMs.signature.
    expect(state.split('.')).toHaveLength(3)
    expect(state).not.toBe('')
  })

  it('rejects requests without auth (401)', async () => {
    const res = await env.app.request('/api/youtube/oauth/start')
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="Dashboard"')
  })
})

// ─── GET /oauth/callback ──────────────────────────────────────────────────

describe('GET /api/youtube/oauth/callback', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Build an env where the signer key is the same as the cipher key,
   *  and return the signer so the test can mint a valid state. */
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
      '/api/youtube',
      youtubeApi({
        db,
        cipher,
        client,
        stateSigner: signer,
      }),
    )
    return {
      env: {
        app,
        fetchFn: fetchFn as unknown as ReturnType<typeof vi.fn>,
        cipher,
        db,
        tokenStore,
        client,
      },
      stateSigner: signer,
    }
  }

  it('exchanges the code, fetches userinfo, stores encrypted tokens, redirects with status=connected', async () => {
    const { env: e, stateSigner: signer } = await envWithSigningKey()

    // Google /token endpoint returns access + refresh + expires_in + scope.
    e.fetchFn.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'ya29.new-access',
          refresh_token: '1//new-refresh',
          expires_in: 3600,
          scope: OAUTH_SCOPE,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    // userinfo endpoint returns the user's Google identity.
    e.fetchFn.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'gid-123',
          email: 'user@gmail.com',
          verified_email: true,
        }),
        { status: 200 },
      ),
    )

    const state = signer.sign('nonce', Date.now())
    const res = await e.app.request(
      `/api/youtube/oauth/callback?code=AUTH_CODE&state=${encodeURIComponent(state)}`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/youtube?status=connected')

    // Verify the row was written and tokens decrypt correctly.
    const accounts = listYouTubeAccounts(e.db, e.cipher)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.emailAddress).toBe('user@gmail.com')
    expect(accounts[0]!.googleUserId).toBe('gid-123')
    expect(accounts[0]!.accessToken).toBe('ya29.new-access')
    expect(accounts[0]!.refreshToken).toBe('1//new-refresh')
    expect(accounts[0]!.scopes).toBe(OAUTH_SCOPE)

    // The two fetches went to the right URLs.
    expect(e.fetchFn).toHaveBeenCalledTimes(2)
    expect(e.fetchFn.mock.calls[0]![0]).toBe('https://oauth2.googleapis.com/token')
    expect(e.fetchFn.mock.calls[1]![0]).toBe('https://www.googleapis.com/oauth2/v2/userinfo')
  })

  it('rejects an invalid (tampered) state', async () => {
    const { env: e } = await envWithSigningKey()
    const res = await e.app.request(
      `/api/youtube/oauth/callback?code=CODE&state=${encodeURIComponent('forged.nonce.signature')}`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(
      /^\/settings\/youtube\?status=error&reason=invalid_or_expired_state/,
    )
  })

  it('rejects an expired state (>10 minutes old)', async () => {
    const { env: e, stateSigner: signer } = await envWithSigningKey()
    const stale = signer.sign('nonce', Date.now() - 11 * 60 * 1000)
    const res = await e.app.request(
      `/api/youtube/oauth/callback?code=CODE&state=${encodeURIComponent(stale)}`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/status=error&reason=invalid_or_expired_state/)
  })

  it('redirects to error when Google returns ?error=access_denied', async () => {
    const { env: e } = await envWithSigningKey()
    const res = await e.app.request(
      `/api/youtube/oauth/callback?error=access_denied&state=anything`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/status=error/)
    expect(res.headers.get('location')!).toContain('access_denied')
  })

  it('redirects to error when the token exchange returns 400', async () => {
    const { env: e, stateSigner: signer } = await envWithSigningKey()
    e.fetchFn.mockResolvedValueOnce(new Response('invalid_grant', { status: 400 }))
    const state = signer.sign('nonce', Date.now())
    const res = await e.app.request(
      `/api/youtube/oauth/callback?code=BAD&state=${encodeURIComponent(state)}`,
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
      `/api/youtube/oauth/callback?code=CODE&state=${encodeURIComponent(state)}`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/status=error&reason=no_refresh_token/)
  })

  it('redirects to error when userinfo lookup fails', async () => {
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
      `/api/youtube/oauth/callback?code=CODE&state=${encodeURIComponent(state)}`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/status=error&reason=userinfo_failed/)
  })

  it('re-linking the same email preserves the local account identity and dependent data', async () => {
    const { env: e, stateSigner: signer } = await envWithSigningKey()

    // First link: succeed.
    e.fetchFn.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'first-access',
          refresh_token: 'first-refresh',
          expires_in: 3600,
          scope: OAUTH_SCOPE,
        }),
        { status: 200 },
      ),
    )
    e.fetchFn.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: 'gid-1', email: 'me@gmail.com', verified_email: true }),
        { status: 200 },
      ),
    )
    let state = signer.sign('nonce', Date.now())
    let res = await e.app.request(
      `/api/youtube/oauth/callback?code=C1&state=${encodeURIComponent(state)}`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.headers.get('location')).toBe('/settings/youtube?status=connected')

    const firstAccounts = listYouTubeAccounts(e.db, e.cipher)
    expect(firstAccounts).toHaveLength(1)
    expect(firstAccounts[0]!.accessToken).toBe('first-access')
    const localAccountId = firstAccounts[0]!.id
    e.db.run(
      `INSERT INTO youtube_channels (channel_id, title)
       VALUES ('UC-local', 'Locally mirrored channel')`,
    )
    e.db.run(
      `INSERT INTO subscriptions
         (id, google_account_id, channel_id, channel_title, subscribed_at)
       VALUES ('sub-local', ?, 'UC-local', 'Locally mirrored channel',
               '2026-01-01T00:00:00.000Z')`,
      [localAccountId],
    )
    e.db.run(
      `INSERT INTO youtube_playlists (google_account_id, playlist_id, title)
       VALUES (?, 'PL-local', 'Locally mirrored playlist')`,
      [localAccountId],
    )

    // Second link of the same email updates credentials on the existing
    // local entity. Its stable id and dependent library rows must survive.
    e.fetchFn.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'second-access',
          refresh_token: 'second-refresh',
          expires_in: 3600,
          scope: OAUTH_SCOPE,
        }),
        { status: 200 },
      ),
    )
    e.fetchFn.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: 'gid-1', email: 'me@gmail.com', verified_email: true }),
        { status: 200 },
      ),
    )
    state = signer.sign('nonce', Date.now())
    res = await e.app.request(
      `/api/youtube/oauth/callback?code=C2&state=${encodeURIComponent(state)}`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.headers.get('location')).toBe('/settings/youtube?status=connected')

    const secondAccounts = listYouTubeAccounts(e.db, e.cipher)
    expect(secondAccounts).toHaveLength(1)
    expect(secondAccounts[0]!.id).toBe(localAccountId)
    expect(secondAccounts[0]!.accessToken).toBe('second-access')
    expect(secondAccounts[0]!.refreshToken).toBe('second-refresh')
    expect(e.db.get(
      `SELECT id FROM subscriptions
       WHERE google_account_id = ? AND id = 'sub-local'`,
      [localAccountId],
    )).toBeDefined()
    expect(e.db.get(
      `SELECT playlist_id FROM youtube_playlists
       WHERE google_account_id = ? AND playlist_id = 'PL-local'`,
      [localAccountId],
    )).toBeDefined()
  })

  it('rejects missing code or state (redirects to error)', async () => {
    const { env: e } = await envWithSigningKey()
    const resNoCode = await e.app.request(
      `/api/youtube/oauth/callback?state=something`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(resNoCode.headers.get('location')).toMatch(/status=error&reason=missing_params/)
    const resNoState = await e.app.request(
      `/api/youtube/oauth/callback?code=CODE`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(resNoState.headers.get('location')).toMatch(/status=error&reason=missing_params/)
  })
})

// ─── GET /connection ──────────────────────────────────────────────────────

describe('GET /api/youtube/connection', () => {
  let env: Env
  beforeEach(async () => {
    env = await buildEnvAsync()
  })

  it('returns connected:false when no account is linked', async () => {
    const res = await env.app.request('/api/youtube/connection', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { connected: boolean }
    expect(body.connected).toBe(false)
  })

  it('returns the connected account fields when one is linked', async () => {
    // Seed a row directly via the table helper.
    const mod = await import('./youtube-accounts.js')
    mod.createYouTubeAccount(env.db, env.cipher, {
      provider: 'youtube',
      googleUserId: 'gid-1',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
      scopes: OAUTH_SCOPE,
      tokenExpiresAt: '2026-01-01T00:00:00.000Z',
    })

    const res = await env.app.request('/api/youtube/connection', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      connected: boolean
      google_user_id: string
      email_address: string
      token_expires_at: string
      scopes: string
    }
    expect(body.connected).toBe(true)
    expect(body.google_user_id).toBe('gid-1')
    expect(body.email_address).toBe('me@gmail.com')
    expect(body.token_expires_at).toBe('2026-01-01T00:00:00.000Z')
    expect(body.scopes).toBe(OAUTH_SCOPE)
  })

  it('requires auth (401)', async () => {
    const res = await env.app.request('/api/youtube/connection')
    expect(res.status).toBe(401)
  })
})

// ─── DELETE /connection ───────────────────────────────────────────────────

describe('DELETE /api/youtube/connection', () => {
  let env: Env
  beforeEach(async () => {
    env = await buildEnvAsync()
  })

  async function seedAccount(): Promise<string> {
    const mod = await import('./youtube-accounts.js')
    const row = mod.createYouTubeAccount(env.db, env.cipher, {
      provider: 'youtube',
      googleUserId: 'gid-1',
      emailAddress: 'me@gmail.com',
      accessToken: 'access-to-revoke',
      refreshToken: 'refresh-to-keep-around',
      scopes: OAUTH_SCOPE,
    })
    return row.id
  }

  it('revokes the access token at Google and deletes the local row', async () => {
    await seedAccount()

    env.fetchFn.mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const res = await env.app.request('/api/youtube/connection', {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(204)

    // Row is gone.
    expect(listYouTubeAccounts(env.db, env.cipher)).toEqual([])

    // Revoke endpoint was called with the access token in the URL.
    expect(env.fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = env.fetchFn.mock.calls[0]!
    expect(url).toMatch(/^https:\/\/oauth2\.googleapis\.com\/revoke\?token=/)
    expect(url).toContain(encodeURIComponent('access-to-revoke'))
    expect(init!.method).toBe('POST')
  })

  it('still deletes locally when the revoke endpoint throws', async () => {
    await seedAccount()
    env.fetchFn.mockRejectedValueOnce(new Error('network down'))

    const res = await env.app.request('/api/youtube/connection', {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(204)
    expect(listYouTubeAccounts(env.db, env.cipher)).toEqual([])
  })

  it('returns 404 when no account is linked', async () => {
    const res = await env.app.request('/api/youtube/connection', {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(404)
  })

  it('requires auth (401)', async () => {
    await seedAccount()
    const res = await env.app.request('/api/youtube/connection', { method: 'DELETE' })
    expect(res.status).toBe(401)
  })

  it('still deletes locally when the stored token cannot be decrypted (rotation)', async () => {
    const id = await seedAccount()
    // Simulate key rotation by mutating the ciphertext column to garbage.
    env.db.run(
      'UPDATE youtube_accounts SET access_token_enc = ? WHERE id = ?',
      ['not-a-valid-ciphertext', id],
    )

    const res = await env.app.request('/api/youtube/connection', {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(204)
    expect(listYouTubeAccounts(env.db, env.cipher)).toEqual([])
  })
})
