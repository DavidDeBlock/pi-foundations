// app-email.test.ts — issue #020
//
// End-to-end tests that exercise email routes via `createApp()` so the
// wiring (auth middleware, route mounting, env propagation) is itself
// under test. Anything that can be tested via the dedicated module
// suites (token-encryption, gmail-client, email-oauth, email-settings)
// is tested there instead — this file only checks the cross-module
// contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { createApp } from './app.js'
import type { AuthVariables } from './auth.js'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { InMemoryTokenStore } from './token-store.js'
import { createStateSigner, createTokenCipher } from './token-encryption.js'
import { listEmailAccounts } from './email-accounts.js'
import { EmailSyncWorker } from './email-sync-worker.js'
import type { Hono } from 'hono'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')
const PASSWORD = 'correct horse battery staple'
const HASH = bcrypt.hashSync(PASSWORD, 10)

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

interface EmailAppEnv {
  app: Hono<{ Variables: AuthVariables }>
  db: Database
  cipher: ReturnType<typeof createTokenCipher>
  fetchFn: ReturnType<typeof vi.fn>
  worker: EmailSyncWorker
}

/** Build a no-op sync worker that the wiring code can hold. Routes
 *  that exercise sync behaviour have dedicated tests; the cross-
 *  module wiring test (this file) only checks that nothing throws
 *  on construction. */
function buildNoopWorker(db: Database, cipher: ReturnType<typeof createTokenCipher>): EmailSyncWorker {
  return new EmailSyncWorker({
    db,
    cipher,
    buildGmailClient: () => {
      throw new Error('noop worker: not meant to be called')
    },
  })
}

async function buildEmailApp(): Promise<EmailAppEnv> {
  const db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  const cipher = createTokenCipher(randomBytes(32))
  const stateSigner = createStateSigner(randomBytes(32))
  const fetchFn = vi.fn() as unknown as ReturnType<typeof vi.fn>
  const worker = buildNoopWorker(db, cipher)

  const app = createApp({
    passwordHash: HASH,
    tokenStore: new InMemoryTokenStore(),
    db,
    email: {
      tokenCipher: cipher,
      stateSigner,
      oauthClientId: 'cid',
      oauthClientSecret: 'csecret',
      redirectUri: 'http://localhost:8080/api/email/oauth/callback',
      oauthFetchFn: fetchFn as unknown as typeof fetch,
      syncWorker: worker,
    },
  })
  return { app, db, cipher, fetchFn, worker }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createApp — email wires routes correctly', () => {
  let env: Awaited<ReturnType<typeof buildEmailApp>>
  beforeEach(async () => {
    env = await buildEmailApp()
  })

  it('mounts /api/email/oauth/start, /api/email/oauth/callback, /api/email/accounts/:id', async () => {
    // /start — needs auth. Should redirect to Google.
    const startRes = await env.app.request('/api/email/oauth/start', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(startRes.status).toBe(302)
    expect(startRes.headers.get('location')).toMatch(/accounts\.google\.com/)

    // /callback — no GET params → missing_params error redirect.
    const cbRes = await env.app.request('/api/email/oauth/callback', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(cbRes.status).toBe(302)
    expect(cbRes.headers.get('location')).toMatch(/status=error&reason=missing_params/)

    // /accounts/:id DELETE — unknown id → 404 JSON.
    const delRes = await env.app.request('/api/email/accounts/no-such-id', {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(delRes.status).toBe(404)
  })

  it('mounts /settings/email (HTML page)', async () => {
    const res = await env.app.request('/settings/email', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Connect Gmail')
    expect(html).toContain('EMAIL_TOKEN_ENCRYPTION_KEY')
  })

  it('requires auth on every email route (verified via /api/email/oauth/start)', async () => {
    const noAuth = await env.app.request('/api/email/oauth/start')
    expect(noAuth.status).toBe(401)
  })
})

describe('createApp — email routes stay out when not configured', () => {
  it('does NOT mount /api/email/* when email deps are omitted', async () => {
    const db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    const app = createApp({
      passwordHash: HASH,
      tokenStore: new InMemoryTokenStore(),
      db,
      // NO `email` deps — these routes should be absent.
    })

    const res = await app.request('/api/email/oauth/start', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    // Hono returns 404 for un-routed paths.
    expect(res.status).toBe(404)
  })

  it('mounts /settings/email in setup-only mode when email deps are omitted', async () => {
    // The page must be reachable even when email env vars are
    // missing — it's the only way an operator can read the env-var
    // setup docs (the same docs explain the env vars that gate the
    // other email routes). This is the explicit resolution of the
    // chicken-and-egg bug where /settings/email said "see
    // /settings/email for details" but couldn't start without
    // email env vars.
    const db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    const app = createApp({
      passwordHash: HASH,
      tokenStore: new InMemoryTokenStore(),
      db,
    })

    // No query params: setup docs render with an empty missing list.
    const res = await app.request('/settings/email', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Email slice not configured')
    expect(html).toContain('pnpm keygen')
  })

  it('setup-only page lists missing env vars from ?missing=', async () => {
    const db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    const app = createApp({
      passwordHash: HASH,
      tokenStore: new InMemoryTokenStore(),
      db,
    })
    const res = await app.request(
      '/settings/email?missing=EMAIL_TOKEN_ENCRYPTION_KEY,GOOGLE_OAUTH_CLIENT_ID',
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('EMAIL_TOKEN_ENCRYPTION_KEY')
    expect(html).toContain('GOOGLE_OAUTH_CLIENT_ID')
  })

  it('does NOT mount /api/email/* routes when email deps are omitted', async () => {
    // The OAuth + sync JSON routes genuinely cannot work without
    // deps — those are the surface that uses the cipher and the
    // Google credentials. They MUST 404 so an operator (or a
    // stray client) gets the right signal: "this surface doesn't
    // exist yet, configure the server first."
    const db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    const app = createApp({
      passwordHash: HASH,
      tokenStore: new InMemoryTokenStore(),
      db,
    })
    for (const path of [
      '/api/email/oauth/start',
      '/api/email/sync',
      `/api/email/accounts/abc/status`,
    ]) {
      const res = await app.request(path, {
        headers: { authorization: basicHeader('david', PASSWORD) },
      })
      expect(res.status, path).toBe(404)
    }
  })
})

describe('end-to-end: OAuth round-trip through createApp', () => {
  it('callback writes a row encrypted at rest + readable via storage helpers', async () => {
    await buildEmailApp() // ensures the no-deps path is reachable, ignored below.
    // Build a new app where the state signer key is captured so we
    // can sign a valid callback state.
    const key = randomBytes(32)
    const cipher = createTokenCipher(key)
    const signer = createStateSigner(key)
    const db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    const fetchFn = vi.fn()
    fetchFn
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'the-access',
            refresh_token: 'the-refresh',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ emailAddress: 'me@gmail.com' }), { status: 200 }),
      )

    const app = createApp({
      passwordHash: HASH,
      tokenStore: new InMemoryTokenStore(),
      db,
      email: {
        tokenCipher: cipher,
        stateSigner: signer,
        oauthClientId: 'cid',
        oauthClientSecret: 'csecret',
        redirectUri: 'http://localhost:8080/api/email/oauth/callback',
        oauthFetchFn: fetchFn as unknown as typeof fetch,
        syncWorker: buildNoopWorker(db, cipher),
      },
    })

    const state = signer.sign('nonce', Date.now())
    const res = await app.request(
      `/api/email/oauth/callback?code=AUTH&state=${encodeURIComponent(state)}`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/email?status=connected')

    // The encryption boundary is preserved through createApp's wiring.
    const accounts = listEmailAccounts(db, cipher)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.accessToken).toBe('the-access')
    expect(accounts[0]!.refreshToken).toBe('the-refresh')
    expect(accounts[0]!.emailAddress).toBe('me@gmail.com')

    // Plaintext tokens must not appear in the DB directly.
    const rawRows = db.all<{ access_token_enc: string }>(
      'SELECT access_token_enc FROM email_accounts',
    )
    expect(rawRows[0]!.access_token_enc).not.toContain('the-access')

    // The settings page now lists the connected account.
    const pageRes = await app.request('/settings/email?status=connected', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const pageHtml = await pageRes.text()
    expect(pageHtml).toContain('me@gmail.com')
    expect(pageHtml).toMatch(/Gmail connected successfully\./)
  })
})
