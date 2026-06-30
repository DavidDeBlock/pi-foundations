// email-settings.test.ts — issue #020
//
// Tests for the HTML view at /settings/email plus its form-friendly
// POST /settings/email/accounts/:id/disconnect endpoint. Goals:
//
//   * Empty state shows the "Connect Gmail" button with scope note.
//   * Connected state lists the account(s) with a Disconnect form.
//   * The Google Cloud setup docs are present (the one-time checklist).
//   * The disconnect POST revokes at Google + deletes the row, then
//     redirects with status=disconnected.
//   * Scopes requested match exactly `gmail.readonly` everywhere.

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
import { createEmailAccount } from './email-accounts.js'
import { emailSettingsView } from './email-settings.js'
import { EmailSyncWorker } from './email-sync-worker.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')
const PASSWORD = 'correct horse battery staple'
const HASH = bcrypt.hashSync(PASSWORD, 10)

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

/** Build a no-op worker for tests that only exercise the view layer. */
function buildNoopWorker(db: Database, cipher: ReturnType<typeof createTokenCipher>): EmailSyncWorker {
  return new EmailSyncWorker({
    db,
    cipher,
    buildGmailClient: () => {
      throw new Error('noop worker')
    },
  })
}

interface Env {
  app: Hono<{ Variables: AuthVariables }>
  fetchFn: ReturnType<typeof vi.fn>
  db: Database
  cipher: ReturnType<typeof createTokenCipher>
  tokenStore: InMemoryTokenStore
  worker: EmailSyncWorker
}

async function buildEnv(): Promise<Env> {
  const db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  const cipher = createTokenCipher(randomBytes(32))
  const fetchFn = vi.fn()
  const tokenStore = new InMemoryTokenStore()
  const worker = buildNoopWorker(db, cipher)

  const app = new Hono<{ Variables: AuthVariables }>()
  app.use('*', auth({ passwordHash: HASH, tokenStore }))
  app.route(
    '/settings/email',
    emailSettingsView({
      db,
      cipher,
      revokeFetchFn: fetchFn as unknown as typeof fetch,
      syncWorker: worker,
    }),
  )
  return { app, fetchFn, db, cipher, tokenStore, worker }
}

// ─── Empty state ──────────────────────────────────────────────────────────

describe('GET /settings/email — empty state', () => {
  let env: Env
  beforeEach(async () => {
    env = await buildEnv()
  })
  afterEach(() => vi.restoreAllMocks())

  it('renders the Connect Gmail button + scope note', async () => {
    const res = await env.app.request('/settings/email', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Connect Gmail')
    // The button is an <a> linking to the OAuth start route.
    expect(html).toContain('href="/api/email/oauth/start"')
    // Scope statement names the exact scope the dashboard requests.
    expect(html).toContain('https://www.googleapis.com/auth/gmail.readonly')
    // (The setup docs further down deliberately name the disallowed
    //  scopes — gmail.modify / gmail.send / gmail.compose — to explain
    //  what we never ask for. So we don't negative-assert them here.
    //  The actual OAuth-flow request uses only gmail.readonly; that
    //  is asserted in email-oauth.test.ts.)
  })

  it('renders the one-time Google Cloud setup documentation', async () => {
    const res = await env.app.request('/settings/email', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    // Every required env var is named in the docs section.
    expect(html).toContain('EMAIL_TOKEN_ENCRYPTION_KEY')
    expect(html).toContain('GOOGLE_OAUTH_CLIENT_ID')
    expect(html).toContain('GOOGLE_OAUTH_CLIENT_SECRET')
    expect(html).toContain('EMAIL_OAUTH_REDIRECT_URI')
    // The setup checklist mentions consent screen + scope pinning.
    expect(html).toContain('gmail.readonly')
    expect(html).toMatch(/consent/i)
  })

  it('404-level: requires auth (401 without credentials)', async () => {
    const res = await env.app.request('/settings/email')
    expect(res.status).toBe(401)
  })
})

// ─── Connected state ──────────────────────────────────────────────────────

describe('GET /settings/email — connected state', () => {
  let env: Env
  beforeEach(async () => {
    env = await buildEnv()
    createEmailAccount(env.db, env.cipher, {
      provider: 'gmail',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
      tokenExpiresAt: '2026-12-31T00:00:00.000Z',
    })
  })

  it('lists the connected account email + Disconnect form', async () => {
    const res = await env.app.request('/settings/email', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Connected Gmail accounts')
    expect(html).toContain('me@gmail.com')
    // Disconnect form posts to the disconnect UI endpoint.
    expect(html).toMatch(
      /<form[^>]+action="\/settings\/email\/accounts\/[^"]+\/disconnect"/,
    )
    expect(html).toContain('Disconnect')
  })

  it('shows the "Connect another account" link', async () => {
    const res = await env.app.request('/settings/email', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('Connect another account')
  })

  it('does NOT render the Connect Gmail primary CTA when at least one account is connected', async () => {
    const res = await env.app.request('/settings/email', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    // The empty-state prompt is hidden; only "Connect another" remains.
    // We assert the prompt copy isn't present (the "Connect another"
    // text is the secondary CTA, distinct copy).
    expect(html).not.toContain('>Connect Gmail<')
  })
})

// ─── Flash banner ─────────────────────────────────────────────────────────

describe('GET /settings/email — flash banner', () => {
  let env: Env
  beforeEach(async () => {
    env = await buildEnv()
  })

  it('renders a success banner when status=connected', async () => {
    const res = await env.app.request('/settings/email?status=connected', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toMatch(/class="flash flash-connected"/)
    expect(html).toContain('Gmail connected successfully.')
  })

  it('renders a disconnected banner when status=disconnected', async () => {
    const res = await env.app.request('/settings/email?status=disconnected', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toMatch(/class="flash flash-disconnected"/)
    expect(html).toContain('Gmail disconnected.')
  })

  it('renders an error banner with human-readable reason text', async () => {
    const res = await env.app.request(
      '/settings/email?status=error&reason=no_refresh_token',
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    const html = await res.text()
    expect(html).toMatch(/class="flash flash-error"/)
    expect(html).toContain('Google did not return a refresh token')
  })

  it('escapes HTML in error reasons to avoid reflected XSS', async () => {
    const res = await env.app.request(
      '/settings/email?status=error&reason=' + encodeURIComponent('<script>alert(1)</script>'),
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    const html = await res.text()
    // The escapeHtml() call inside readFlash preserves only safe chars
    // anyway, but the rendered banner must never contain an unescaped
    // <script> tag, even if a future regression changes that.
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/)
  })

  it('renders no banner when status is absent', async () => {
    const res = await env.app.request('/settings/email', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).not.toMatch(/class="flash /)
  })
})

// ─── POST /settings/email/accounts/:id/disconnect ─────────────────────────

describe('POST /settings/email/accounts/:id/disconnect', () => {
  let env: Env
  beforeEach(async () => {
    env = await buildEnv()
    createEmailAccount(env.db, env.cipher, {
      provider: 'gmail',
      emailAddress: 'me@gmail.com',
      accessToken: 'access-token-to-revoke',
      refreshToken: 'r',
    })
  })

  it('revokes the token at Google and redirects with status=disconnected', async () => {
    const row = env.db.get<{ id: string }>('SELECT id FROM email_accounts LIMIT 1')
    expect(row).toBeTruthy()
    env.fetchFn.mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const res = await env.app.request(`/settings/email/accounts/${row!.id}/disconnect`, {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/email?status=disconnected')

    // Local row is gone.
    const rows = env.db.all<{ id: string }>('SELECT id FROM email_accounts')
    expect(rows).toEqual([])

    // Revoke endpoint hit with the right token in the URL.
    expect(env.fetchFn).toHaveBeenCalledTimes(1)
    const url = env.fetchFn.mock.calls[0]![0] as string
    expect(url).toContain(encodeURIComponent('access-token-to-revoke'))
  })

  it('still succeeds when the revoke endpoint throws', async () => {
    const row = env.db.get<{ id: string }>('SELECT id FROM email_accounts LIMIT 1')
    env.fetchFn.mockRejectedValueOnce(new Error('network down'))

    const res = await env.app.request(`/settings/email/accounts/${row!.id}/disconnect`, {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(302)
    expect(env.db.get<{ id: string }>('SELECT id FROM email_accounts LIMIT 1')).toBeUndefined()
  })

  it('is idempotent: a second POST on the same id silently redirects', async () => {
    const row = env.db.get<{ id: string }>('SELECT id FROM email_accounts LIMIT 1')
    env.fetchFn.mockResolvedValue(new Response('ok', { status: 200 }))

    const first = await env.app.request(`/settings/email/accounts/${row!.id}/disconnect`, {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const second = await env.app.request(`/settings/email/accounts/${row!.id}/disconnect`, {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(first.status).toBe(302)
    expect(second.status).toBe(302)
    expect(second.headers.get('location')).toBe('/settings/email')
  })

  it('requires auth (401)', async () => {
    const row = env.db.get<{ id: string }>('SELECT id FROM email_accounts LIMIT 1')
    const res = await env.app.request(`/settings/email/accounts/${row!.id}/disconnect`, {
      method: 'POST',
    })
    expect(res.status).toBe(401)
  })
})
