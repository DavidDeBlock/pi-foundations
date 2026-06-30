// email-sync.test.ts — issue #021
//
// End-to-end tests for the HTTP layer exposed by email-sync.ts:
//   * POST /api/email/sync — kick off manual refresh; returns 202.
//   * GET  /api/email/accounts/:id/status — observability.
//
// These ride on the existing `auth()` middleware (the same as every
// other protected route) plus the cross-module wiring verified in
// app-email.test.ts. We focus here on the routes' own contract:
// response shape, status codes, account-id resolution.

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
import { emailSyncApi } from './email-sync.js'
import { EmailSyncWorker, AccountNotFoundError } from './email-sync-worker.js'
import type { GmailClient, RawEmail } from './gmail-client.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')
const PASSWORD = 'correct horse battery staple'
const HASH = bcrypt.hashSync(PASSWORD, 10)

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

function email(over: Partial<RawEmail> = {}): RawEmail {
  return {
    id: 'm-1',
    threadId: 't-1',
    internalDate: '2024-06-01T12:00:00.000Z',
    snippet: '',
    subject: 'Subject',
    from: { name: 'Alice', email: 'alice@example.com' },
    to: [],
    cc: [],
    bodyPlain: '',
    labels: ['INBOX'],
    isUnread: true,
    ...over,
  }
}

interface Env {
  app: Hono<{ Variables: AuthVariables }>
  db: Database
  cipher: ReturnType<typeof createTokenCipher>
  accountId: string
  worker: EmailSyncWorker
  /** Resolves with whatever listMessages returns. Always returns
   *  a single page with `id`. */
  buildClient: (id: string) => GmailClient
}

async function buildEnv(): Promise<Env> {
  const db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  const cipher = createTokenCipher(randomBytes(32))
  const account = createEmailAccount(db, cipher, {
    provider: 'gmail',
    emailAddress: 'me@gmail.com',
    accessToken: 'a',
    refreshToken: 'r',
    tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  })

  // Single-account test: there is exactly one email account, so
  // an unspecified account_id picks it up automatically. The
  // factory receives the `accountId` (NOT a Gmail message id) —
  // we ignore it here and return a stub that always lists the
  // single message 'm-1'.
  const stubId = 'm-1'
  const buildClient = (_accountId: string): GmailClient => ({
    listMessages: vi.fn(async () => ({
      messages: [{ id: stubId, threadId: 't-1' }],
      nextPageToken: null,
    })),
    getMessage: vi.fn(async () => email({ id: stubId })),
  } as unknown as GmailClient)

  const worker = new EmailSyncWorker({
    db,
    cipher,
    buildGmailClient: (idArg) => buildClient(idArg),
  })
  const app = new Hono<{ Variables: AuthVariables }>()
  app.use('*', auth({ passwordHash: HASH, tokenStore: new InMemoryTokenStore() }))
  app.route('/api/email', emailSyncApi({ db, cipher, worker }))
  return { app, db, cipher, accountId: account.id, worker, buildClient }
}

// ─── Tests ────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /api/email/sync', () => {
  let env: Env
  beforeEach(async () => {
    env = await buildEnv()
  })

  it('returns 202 + account id when a sync is kicked off', async () => {
    const res = await env.app.request('/api/email/sync', {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as {
      ok: boolean
      started: boolean
      accountId: string
      startedAt: string
    }
    expect(body.ok).toBe(true)
    expect(body.started).toBe(true)
    expect(body.accountId).toBe(env.accountId)
    expect(typeof body.startedAt).toBe('string')

    // Worker actually ran to completion (the route awaits the
    // first cycle before responding). DB has the synced message.
    // We give the fire-and-forget promise a tick to settle.
    await new Promise((r) => setTimeout(r, 50))
    const rows = env.db.all<{ id: string }>(
      'SELECT id FROM emails WHERE account_id = ?',
      [env.accountId],
    )
    expect(rows.map((r) => r.id)).toContain('m-1')
  })

  it('accepts a target via ?account_id= and persists the chosen id', async () => {
    const res = await env.app.request(
      `/api/email/sync?account_id=${env.accountId}`,
      {
        method: 'POST',
        headers: { authorization: basicHeader('david', PASSWORD) },
      },
    )
    expect(res.status).toBe(202)
    const body = (await res.json()) as { accountId: string }
    expect(body.accountId).toBe(env.accountId)
  })

  it('returns 400 with no_accounts when there are no connected accounts', async () => {
    // Wipe accounts → no default.
    env.db.run('DELETE FROM email_accounts')
    const res = await env.app.request('/api/email/sync', {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.error).toBe('no_accounts')
  })

  it('returns an already_in_progress 202 when a sync is mid-flight', async () => {
    // Mark the sync as in_progress, mirroring a crash-leftover.
    env.db.run(
      `INSERT INTO sync_state (account_id, provider, in_progress, started_at)
       VALUES (?, 'gmail', 1, ?)
       ON CONFLICT(account_id) DO UPDATE SET in_progress = 1`,
      [env.accountId, '2024-06-01T12:00:00.000Z'],
    )
    const res = await env.app.request('/api/email/sync', {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as {
      ok: boolean
      started: boolean
      reason: string
    }
    expect(body.ok).toBe(true)
    expect(body.started).toBe(false)
    expect(body.reason).toBe('already_in_progress')
  })

  it('requires auth (401 without credentials)', async () => {
    const res = await env.app.request('/api/email/sync', { method: 'POST' })
    expect(res.status).toBe(401)
  })
})

describe('GET /api/email/accounts/:id/status', () => {
  let env: Env
  beforeEach(async () => {
    env = await buildEnv()
  })

  it('returns the AC contract: {lastSyncAt, inProgress, messagesSynced}', async () => {
    const res = await env.app.request(
      `/api/email/accounts/${env.accountId}/status`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      accountId: string
      lastSyncAt: string | null
      inProgress: boolean
      messagesSynced: number
      lastAdded: number
      lastUpdated: number
      lastRemoved: number
      startedAt: string | null
    }
    expect(body.accountId).toBe(env.accountId)
    expect(body.inProgress).toBe(false)
    expect(body.lastSyncAt).toBeNull()
    expect(body.messagesSynced).toBe(0)
  })

  it('after a sync, surfaces the latest run counters', async () => {
    // Run a sync first via the route.
    await env.app.request('/api/email/sync', {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    await new Promise((r) => setTimeout(r, 50))

    const res = await env.app.request(
      `/api/email/accounts/${env.accountId}/status`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    const body = (await res.json()) as {
      lastSyncAt: string | null
      inProgress: boolean
      messagesSynced: number
      lastAdded: number
    }
    expect(body.inProgress).toBe(false)
    expect(body.lastSyncAt).not.toBeNull()
    expect(body.messagesSynced).toBe(1)
    expect(body.lastAdded).toBe(1)
  })

  it('requires auth (401 without credentials)', async () => {
    const res = await env.app.request(
      `/api/email/accounts/${env.accountId}/status`,
    )
    expect(res.status).toBe(401)
  })
})

// ─── Account errors ───────────────────────────────────────────────────────

describe('EmailSyncWorker error types', () => {
  it('AccountNotFoundError is exported and instanceof-checkable', () => {
    expect(AccountNotFoundError).toBeTypeOf('function')
    const err = new AccountNotFoundError('test')
    expect(err).toBeInstanceOf(AccountNotFoundError)
    expect(err.accountId).toBe('test')
  })
})
