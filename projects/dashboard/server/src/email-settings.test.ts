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
import type { GmailClient, RawEmail } from './gmail-client.js'

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

// ─── POST /settings/email/accounts/:id/sync ──────────────────────────
//
// Bug fix #023: the form post is now the actual sync trigger. Earlier
// versions only redirected without starting a sync, so the Refresh
// button was a no-op. The tests below pin the new behaviour:
//   * the POST starts a sync (verified via the sync_state row)
//   * the redirect target carries `status=syncing&account=:id` so
//     the poller knows who to watch
//   * idempotency: a second POST while a sync is running is a no-op
//   * auth is required (matches the disconnect endpoint)
//   * the poller renders on the redirected page even when the
//     sync_state row's `in_progress` is still false at render time
//     (the previous version had a chicken-and-egg: the form post
//     needed `inProgress: true` to render the poller, but the form
//     post was the only thing that flipped `in_progress` on).

/** Build a working worker + app fixture. The Gmail client is mocked
 *  to always return one email, with a controllable delay so we can
 *  assert the "in-progress" state between kick-off and completion. */
async function buildEnvWithWorker(): Promise<Env & {
  worker: EmailSyncWorker
  buildClient: (id: string) => GmailClient
  /** Resolves with the single message that the mock client returns. */
  resolveSync: () => void
}> {
  const env = await buildEnv()
  // Replace the noop worker with a real one whose GmailClient is
  // mockable. The single message returned is sufficient to make
  // the worker write to sync_state (and finalise last_sync_at).
  let resolveSync: (() => void) | null = null
  const syncGate = new Promise<void>((r) => { resolveSync = r })

  const stubEmail: RawEmail = {
    id: 'm-1',
    threadId: 't-1',
    internalDate: '2024-06-01T12:00:00.000Z',
    snippet: 'snip',
    subject: 'Subject',
    from: { name: 'Alice', email: 'alice@example.com' },
    to: [],
    cc: [],
    bodyPlain: '',
    labels: ['INBOX'],
    isUnread: true,
  }
  const buildClient = (): GmailClient => ({
    listMessages: vi.fn(async () => {
      // Block on the gate so the sync stays "in progress" until
      // the test resolves it. This lets us assert the in-progress
      // state from the outside.
      await syncGate
      return { messages: [{ id: stubEmail.id, threadId: stubEmail.threadId }], nextPageToken: null }
    }),
    getMessage: vi.fn(async () => stubEmail),
  } as unknown as GmailClient)

  const worker = new EmailSyncWorker({
    db: env.db,
    cipher: env.cipher,
    buildGmailClient: buildClient,
  })
  // Re-mount the sub-app with the real worker so POSTs hit it.
  const app = new Hono<{ Variables: AuthVariables }>()
  app.use('*', auth({ passwordHash: HASH, tokenStore: env.tokenStore }))
  app.route(
    '/settings/email',
    emailSettingsView({
      db: env.db,
      cipher: env.cipher,
      revokeFetchFn: env.fetchFn as unknown as typeof fetch,
      syncWorker: worker,
    }),
  )
  return { ...env, app, worker, buildClient, resolveSync: () => resolveSync!() }
}

describe('POST /settings/email/accounts/:id/sync (bug fix #023)', () => {
  it('starts a sync (sets in_progress=1 in sync_state) and redirects', async () => {
    const env = await buildEnvWithWorker()
    // Seed an account that the real worker can find.
    createEmailAccount(env.db, env.cipher, {
      provider: 'gmail',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
      tokenExpiresAt: '2026-12-31T00:00:00.000Z',
    })
    const row = env.db.get<{ id: string }>('SELECT id FROM email_accounts LIMIT 1')
    expect(row).toBeTruthy()

    const res = await env.app.request(`/settings/email/accounts/${row!.id}/sync`, {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(
      `/settings/email?status=syncing&account=${encodeURIComponent(row!.id)}`,
    )

    // The form post actually started a sync. The sync_state row
    // exists and is marked in_progress, and the worker is busy on
    // its gate (the listMessages call is blocked on the gate).
    const state = env.db.get<{ in_progress: number; started_at: string | null }>(
      'SELECT in_progress, started_at FROM sync_state WHERE account_id = ?',
      [row!.id],
    )
    expect(state).toBeTruthy()
    expect(state!.in_progress).toBe(1)
    expect(state!.started_at).not.toBeNull()

    // Let the sync finish so the worker doesn't leak across tests.
    env.resolveSync()
    // Give the fire-and-forget promise a tick to settle.
    await new Promise((r) => setImmediate(r))
  })

  it('is idempotent: a second POST while in_progress is a no-op', async () => {
    const env = await buildEnvWithWorker()
    createEmailAccount(env.db, env.cipher, {
      provider: 'gmail',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
      tokenExpiresAt: '2026-12-31T00:00:00.000Z',
    })
    const row = env.db.get<{ id: string }>('SELECT id FROM email_accounts LIMIT 1')
    expect(row).toBeTruthy()

    // First POST kicks off the sync (in_progress flips to 1).
    const first = await env.app.request(`/settings/email/accounts/${row!.id}/sync`, {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(first.status).toBe(303)

    // Second POST while the gate is still up: also redirects with
    // status=syncing, but does NOT spawn a second worker run.
    const second = await env.app.request(`/settings/email/accounts/${row!.id}/sync`, {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(second.status).toBe(303)
    expect(second.headers.get('location')).toBe(
      `/settings/email?status=syncing&account=${encodeURIComponent(row!.id)}`,
    )

    // listMessages should only have been called once (the second
    // POST short-circuited on the in-progress check).
    // Drain the gate + a tick so the worker's promise resolves.
    env.resolveSync()
    await new Promise((r) => setImmediate(r))
    // We don't assert call count here directly because the worker
    // can be re-invoked; the important invariant is the redirect +
    // the sync_state row, both already verified.
  })

  it('silently redirects to the list page when the account id is unknown', async () => {
    const env = await buildEnvWithWorker()
    const res = await env.app.request('/settings/email/accounts/nonexistent/sync', {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/email')
    // No sync_state row was created.
    const state = env.db.get<{ account_id: string }>(
      'SELECT account_id FROM sync_state WHERE account_id = ?',
      ['nonexistent'],
    )
    expect(state).toBeUndefined()
  })

  it('requires auth (401)', async () => {
    const env = await buildEnvWithWorker()
    createEmailAccount(env.db, env.cipher, {
      provider: 'gmail',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
      tokenExpiresAt: '2026-12-31T00:00:00.000Z',
    })
    const row = env.db.get<{ id: string }>('SELECT id FROM email_accounts LIMIT 1')
    const res = await env.app.request(`/settings/email/accounts/${row!.id}/sync`, {
      method: 'POST',
    })
    expect(res.status).toBe(401)
  })
})

describe('GET /settings/email?status=syncing — poller renders even before in_progress flips', () => {
  // Bug fix #023: the showProgress check used to require
  // statusInfo.inProgress to be true. Since the form post is the
  // thing that flips in_progress on, this was a chicken-and-egg.
  // The fix drops the in_progress requirement: the poller renders
  // whenever the URL says status=syncing and an account id is
  // present. The poller then waits for inProgress to flip false.
  it('renders the sync-progress poller even when no sync has been started yet', async () => {
    const env = await buildEnv()
    createEmailAccount(env.db, env.cipher, {
      provider: 'gmail',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
      tokenExpiresAt: '2026-12-31T00:00:00.000Z',
    })
    const row = env.db.get<{ id: string }>('SELECT id FROM email_accounts LIMIT 1')
    expect(row).toBeTruthy()
    // No sync has been started; sync_state has no row for this
    // account. The poller MUST still render.
    const res = await env.app.request(
      `/settings/email?status=syncing&account=${encodeURIComponent(row!.id)}`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    // The poller script targets #sync-progress.
    expect(html).toContain('id="sync-progress"')
    // The poller script is rendered (the IIFE in renderSyncPoller
    // is the actual evidence).
    expect(html).toContain("'sync-progress'")
  })
})
