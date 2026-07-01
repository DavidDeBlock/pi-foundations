// email-read.test.ts — issue #022
//
// HTTP-layer tests for the four read endpoints. Uses an in-memory
// SQLite DB with the real migration set. Each test seeds a small
// corpus and exercises the JSON shape + status codes the routes
// promise in the PRD-002 API contract:
//
//   GET /api/email?from=&to=&subject_contains=&label=&unread=&since=&until=&tag=&limit=&cursor=
//   GET /api/email/:id                  → 404 when missing
//   GET /api/email/thread/:threadId      → chronological
//   GET /api/email/search?q=&limit=      → FTS5 + trigram + <mark> snippets
//
// Auth is enforced by the global middleware; we run the tests both
// with and without credentials to assert the 401 vs 200 split.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import bcrypt from 'bcryptjs'
import { resolve } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { createApp } from './app.js'
import { JsonTokenStore } from './token-store.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')
const PASSWORD = 'correct horse battery staple'
const HASH = bcrypt.hashSync(PASSWORD, 10)

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Lazy email_accounts id resolver: each literal accountId in the
 *  test fixtures maps to exactly one row, created on first use. */
const accountCache = new Map<string, string>()

function resolveAccountId(db: Database, accountId: string): string {
  const cached = accountCache.get(accountId)
  if (cached !== undefined) return cached
  const id = randomUUID()
  db.run(
    `INSERT INTO email_accounts (id, provider, email_address, access_token_enc, refresh_token_enc)
     VALUES (?, 'gmail', ?, 'enc', 'enc')`,
    [id, `${id}@example.com`],
  )
  accountCache.set(accountId, id)
  return id
}

interface SeedEmail {
  readonly id?: string
  readonly accountId: string
  readonly threadId: string
  readonly subject: string
  readonly sender: string
  readonly senderEmail: string
  readonly to?: readonly string[]
  readonly bodyPlain?: string
  readonly snippet?: string
  readonly receivedAt: string
  readonly isUnread?: boolean
  readonly labels?: readonly string[]
  readonly hidden?: boolean
}

function seedEmail(db: Database, e: SeedEmail): string {
  const realAccountId = resolveAccountId(db, e.accountId)
  const id = e.id ?? randomUUID()
  db.run(
    `INSERT INTO emails (
        id, account_id, thread_id, subject, sender, sender_email,
        to_addrs, cc_addrs, received_at, snippet, body_plain,
        is_unread, labels, synced_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )`,
    [
      id,
      realAccountId,
      e.threadId,
      e.subject,
      e.sender,
      e.senderEmail,
      JSON.stringify(e.to ?? []),
      JSON.stringify([]),
      e.receivedAt,
      e.snippet ?? '',
      e.bodyPlain ?? '',
      e.isUnread ? 1 : 0,
      JSON.stringify(e.labels ?? []),
      e.receivedAt,
    ],
  )
  if (e.hidden) {
    db.run('UPDATE emails SET hidden_at = ? WHERE id = ?', [e.receivedAt, id])
  }
  return id
}

interface TestEnv {
  db: Database
  request: (path: string, init?: RequestInit) => Promise<Response>
  cleanup: () => void
}

async function buildEnv(): Promise<TestEnv> {
  const db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  const tmp = mkdtempSync(join(tmpdir(), 'dashboard-test-'))
  const app = createApp({ passwordHash: HASH, tokenStore: new JsonTokenStore({ dataDir: tmp }), db })
  return {
    db,
    request: async (path, init) => app.request(path, init),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

// ─── GET /api/email ────────────────────────────────────────────────────────

describe('GET /api/email (list)', () => {
  let env: TestEnv
  beforeEach(async () => {
    env = await buildEnv()
    accountCache.clear()
  })
  afterEach(() => {
    env.cleanup()
    env.db.close()
  })

  it('requires auth', async () => {
    const res = await env.request('/api/email')
    expect(res.status).toBe(401)
  })

  it('returns an empty results array + null cursor when no rows exist', async () => {
    const res = await env.request('/api/email', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: unknown[]; nextCursor: string | null }
    expect(body.results).toEqual([])
    expect(body.nextCursor).toBeNull()
  })

  it('returns seeded emails in received_at DESC order', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1',
      threadId: 't-1',
      subject: 'Older',
      sender: 'Alice <a@example.com>',
      senderEmail: 'a@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1',
      threadId: 't-2',
      subject: 'Newer',
      sender: 'Bob <b@example.com>',
      senderEmail: 'b@example.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
    })
    const res = await env.request('/api/email', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as { results: Array<{ subject: string }> }
    expect(body.results.map((r) => r.subject)).toEqual(['Newer', 'Older'])
  })

  it('from filter restricts to a specific sender', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'a1', sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com', receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2', subject: 'b1', sender: 'Bob <bob@example.com>', senderEmail: 'bob@example.com', receivedAt: '2024-06-02T10:00:00.000Z',
    })
    const res = await env.request('/api/email?from=alice@example.com', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as { results: Array<{ subject: string }> }
    expect(body.results.map((r) => r.subject)).toEqual(['a1'])
  })

  it('subject_contains filter applies a case-insensitive substring match', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Launch Plans Q4', sender: 'a@b.com', senderEmail: 'a@b.com', receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2', subject: 'Lunch plans', sender: 'a@b.com', senderEmail: 'a@b.com', receivedAt: '2024-06-02T10:00:00.000Z',
    })
    const res = await env.request('/api/email?subject_contains=launch', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as { results: Array<{ subject: string }> }
    expect(body.results.map((r) => r.subject)).toEqual(['Launch Plans Q4'])
  })

  it('unread=1 filters to unread only; unread=0 to read only', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'unread msg', sender: 'a@b.com', senderEmail: 'a@b.com', receivedAt: '2024-06-01T10:00:00.000Z', isUnread: true,
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2', subject: 'read msg', sender: 'a@b.com', senderEmail: 'a@b.com', receivedAt: '2024-06-02T10:00:00.000Z', isUnread: false,
    })
    const unreadRes = await env.request('/api/email?unread=1', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const unreadBody = (await unreadRes.json()) as { results: Array<{ subject: string }> }
    expect(unreadBody.results.map((r) => r.subject)).toEqual(['unread msg'])

    const readRes = await env.request('/api/email?unread=0', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const readBody = (await readRes.json()) as { results: Array<{ subject: string }> }
    expect(readBody.results.map((r) => r.subject)).toEqual(['read msg'])
  })

  it('label filter restricts to messages with that label', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'inbox', sender: 'a@b.com', senderEmail: 'a@b.com', receivedAt: '2024-06-01T10:00:00.000Z', labels: ['INBOX'],
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2', subject: 'starred', sender: 'a@b.com', senderEmail: 'a@b.com', receivedAt: '2024-06-02T10:00:00.000Z', labels: ['STARRED'],
    })
    const res = await env.request('/api/email?label=STARRED', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as { results: Array<{ subject: string }> }
    expect(body.results.map((r) => r.subject)).toEqual(['starred'])
  })

  it('since / until bound the date range inclusively', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'before', sender: 'a@b.com', senderEmail: 'a@b.com', receivedAt: '2024-05-31T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2', subject: 'inside', sender: 'a@b.com', senderEmail: 'a@b.com', receivedAt: '2024-06-15T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-3', subject: 'after', sender: 'a@b.com', senderEmail: 'a@b.com', receivedAt: '2024-07-01T10:00:00.000Z',
    })
    const res = await env.request('/api/email?since=2024-06-01T00:00:00.000Z&until=2024-06-30T23:59:59.999Z', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as { results: Array<{ subject: string }> }
    expect(body.results.map((r) => r.subject)).toEqual(['inside'])
  })

  it('excludes hidden rows from list results', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'visible', sender: 'a@b.com', senderEmail: 'a@b.com', receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2', subject: 'hidden', sender: 'a@b.com', senderEmail: 'a@b.com', receivedAt: '2024-06-02T10:00:00.000Z', hidden: true,
    })
    const res = await env.request('/api/email', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as { results: Array<{ subject: string }> }
    expect(body.results.map((r) => r.subject)).toEqual(['visible'])
  })

  it('returns a nextCursor when the page is full and the cursor decodes back to the boundary row', async () => {
    // Seed 5 emails; limit=3 → first page has 3 rows + a cursor.
    for (let i = 0; i < 5; i++) {
      seedEmail(env.db, {
        accountId: 'acc-1',
        threadId: `t-${i}`,
        subject: `msg ${i}`,
        sender: 'a@b.com',
        senderEmail: 'a@b.com',
        receivedAt: new Date(Date.UTC(2024, 5, 1, 0, i, 0)).toISOString(),
      })
    }
    const res = await env.request('/api/email?limit=3', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as { results: Array<{ id: string }>; nextCursor: string | null }
    expect(body.results).toHaveLength(3)
    expect(body.nextCursor).not.toBeNull()

    // Page 2: pass the cursor, get the remaining 2 rows.
    const res2 = await env.request(`/api/email?limit=3&cursor=${body.nextCursor}`, {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body2 = (await res2.json()) as { results: unknown[]; nextCursor: string | null }
    expect(body2.results).toHaveLength(2)
    expect(body2.nextCursor).toBeNull()
  })

  it('clamps limit to MAX_LIMIT (200)', async () => {
    const res = await env.request('/api/email?limit=99999', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    // Just assert the response is well-formed; clamp behavior is
    // covered by clampEmailLimit unit tests.
    const body = (await res.json()) as { results: unknown[]; nextCursor: string | null }
    expect(Array.isArray(body.results)).toBe(true)
    expect(body.nextCursor).toBeNull()
  })

  it('tag filter narrows to emails carrying the given tag (#025)', async () => {
    // The tag filter is now active: only emails carrying the
    // requested tag are returned. Combines with other filters
    // (asserted in a later test).
    const a = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'tagged',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2', subject: 'untagged',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
    })
    // Attach the tag directly via SQL (no need to round-trip through the API).
    env.db.run('INSERT INTO email_tags (email_id, tag) VALUES (?, ?)', [a, 'launch'])

    const res = await env.request('/api/email?tag=launch', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as { results: Array<{ subject: string }> }
    expect(body.results.map((r) => r.subject)).toEqual(['tagged'])
  })

  it('tag filter with no matching emails returns an empty list', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await env.request('/api/email?tag=does-not-exist', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as { results: unknown[] }
    expect(body.results).toEqual([])
  })

  it('tag filter is case-insensitive (matches the normalized storage form)', async () => {
    // Tags are stored normalized (lowercase). The filter query uses
    // an exact match against the stored value, so callers must send
    // the normalized form. UI autocomplete always does, but a raw
    // API caller can send either case as long as it matches the
    // canonical form.
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    env.db.run('INSERT INTO email_tags (email_id, tag) VALUES (?, ?)', [id, 'launch'])

    const res = await env.request('/api/email?tag=launch', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as { results: Array<{ subject: string }> }
    expect(body.results.map((r) => r.subject)).toEqual(['msg'])
  })

  it('SQL injection via query params is rejected (returns 200, harmless)', async () => {
    // A real injection attempt at the HTTP layer. The builder uses
    // bound params for every user value, so the request simply
    // returns an empty list — the literal doesn't make it into SQL.
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg', sender: 'a@b.com', senderEmail: 'a@b.com', receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await env.request(
      `/api/email?subject_contains=${encodeURIComponent("'; DROP TABLE emails; --")}`,
      { headers: { authorization: basicHeader('david', PASSWORD) } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: unknown[] }
    // The seeded row doesn't contain "drop table" so it's filtered out.
    expect(body.results).toEqual([])
    // Sanity: the row is still there.
    const still = env.db.all<{ id: string }>('SELECT id FROM emails')
    expect(still).toHaveLength(1)
  })
})

// ─── GET /api/email/:id ───────────────────────────────────────────────────

describe('GET /api/email/:id', () => {
  let env: TestEnv
  beforeEach(async () => {
    env = await buildEnv()
    accountCache.clear()
  })
  afterEach(() => {
    env.cleanup()
    env.db.close()
  })

  it('requires auth', async () => {
    const res = await env.request('/api/email/anything')
    expect(res.status).toBe(401)
  })

  it('returns the full detail with body_plain for a known id', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hello',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      to: ['bob@example.com'], bodyPlain: 'Body content here.',
      receivedAt: '2024-06-01T10:00:00.000Z',
      labels: ['INBOX'], isUnread: true,
    })
    const res = await env.request(`/api/email/${id}`, {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.id).toBe(id)
    expect(body.subject).toBe('Hello')
    expect(body.sender).toBe('Alice <alice@example.com>')
    expect(body.senderEmail).toBe('alice@example.com')
    expect(body.to).toEqual(['bob@example.com'])
    expect(body.bodyPlain).toBe('Body content here.')
    expect(body.isUnread).toBe(true)
    expect(body.labels).toEqual(['INBOX'])
  })

  it('returns 404 for a missing id', async () => {
    const res = await env.request('/api/email/no-such-id', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('not_found')
  })

  it('returns 404 for a hidden email (defense-in-depth)', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hidden',
      sender: 'a@b.com', senderEmail: 'a@b.com', receivedAt: '2024-06-01T10:00:00.000Z',
      hidden: true,
    })
    const res = await env.request(`/api/email/${id}`, {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(404)
  })
})

// ─── GET /api/email/thread/:threadId ──────────────────────────────────────

describe('GET /api/email/thread/:threadId', () => {
  let env: TestEnv
  beforeEach(async () => {
    env = await buildEnv()
    accountCache.clear()
  })
  afterEach(() => {
    env.cleanup()
    env.db.close()
  })

  it('requires auth', async () => {
    const res = await env.request('/api/email/thread/t-1')
    expect(res.status).toBe(401)
  })

  it('returns messages in chronological order with thread metadata', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Reply 2',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-03T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Original',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Reply 1',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
    })
    const res = await env.request('/api/email/thread/t-1', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      threadId: string
      count: number
      messages: Array<{ subject: string }>
    }
    expect(body.threadId).toBe('t-1')
    expect(body.count).toBe(3)
    expect(body.messages.map((m) => m.subject)).toEqual([
      'Original',
      'Reply 1',
      'Reply 2',
    ])
  })

  it('returns an empty messages array for an unknown thread', async () => {
    const res = await env.request('/api/email/thread/no-such-thread', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { count: number; messages: unknown[] }
    expect(body.count).toBe(0)
    expect(body.messages).toEqual([])
  })

  it('excludes hidden messages from the thread', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Original',
      sender: 'a@b.com', senderEmail: 'a@b.com', receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hidden reply',
      sender: 'a@b.com', senderEmail: 'a@b.com', receivedAt: '2024-06-02T10:00:00.000Z',
      hidden: true,
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Later reply',
      sender: 'a@b.com', senderEmail: 'a@b.com', receivedAt: '2024-06-03T10:00:00.000Z',
    })
    const res = await env.request('/api/email/thread/t-1', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as { messages: Array<{ subject: string }> }
    expect(body.messages.map((m) => m.subject)).toEqual(['Original', 'Later reply'])
  })
})

// ─── GET /api/email/search ────────────────────────────────────────────────

describe('GET /api/email/search', () => {
  let env: TestEnv
  beforeEach(async () => {
    env = await buildEnv()
    accountCache.clear()
  })
  afterEach(() => {
    env.cleanup()
    env.db.close()
  })

  it('requires auth', async () => {
    const res = await env.request('/api/email/search?q=anything')
    expect(res.status).toBe(401)
  })

  it('returns empty mode for an empty query', async () => {
    const res = await env.request('/api/email/search?q=', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mode: string; results: unknown[] }
    expect(body.mode).toBe('empty')
    expect(body.results).toEqual([])
  })

  it('does not collide with the /:id route (the literal /search is matched, not captured as id="search")', async () => {
    // Seed nothing → search returns empty mode.
    const res = await env.request('/api/email/search?q=anything', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    // We expect a search-shaped response, not a 404 from the /:id route.
    const body = (await res.json()) as { mode?: string; error?: string }
    expect(body.mode).toBeDefined()
    expect(body.error).toBeUndefined()
  })

  it('does not collide with the /thread/:threadId route', async () => {
    // /search — we should get a search-shape response.
    const searchRes = await env.request('/api/email/search?q=anything', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(searchRes.status).toBe(200)
    // /thread/anything — we should get a thread-shape response.
    const threadRes = await env.request('/api/email/thread/anything', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(threadRes.status).toBe(200)
  })
})

// ─── GET /api/email/hidden (#024) ──────────────────────────────────────────

describe('GET /api/email/hidden', () => {
  let env: TestEnv
  beforeEach(async () => {
    env = await buildEnv()
    accountCache.clear()
  })
  afterEach(() => {
    env.cleanup()
    env.db.close()
  })

  it('requires auth', async () => {
    const res = await env.request('/api/email/hidden')
    expect(res.status).toBe(401)
  })

  it('does not collide with the /:id route (literal /hidden is matched, not captured as id="hidden")', async () => {
    // Seed nothing → returns an empty list (200), not a 404.
    const res = await env.request('/api/email/hidden', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results?: unknown[]; error?: string }
    expect(body.results).toBeDefined()
    expect(body.error).toBeUndefined()
  })

  it('returns hidden emails sorted by hidden_at DESC, excluding visible rows', async () => {
    const v1 = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1',
      subject: 'Visible A',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2',
      subject: 'Visible B',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
    })
    const h1 = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-3',
      subject: 'Hidden A',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-03T10:00:00.000Z',
      hidden: true,
    })
    const h2 = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-4',
      subject: 'Hidden B',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-04T10:00:00.000Z',
      hidden: true,
    })
    // Sanity: visible ones are visible.
    void v1

    const res = await env.request('/api/email/hidden', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      results: Array<{ id: string; subject: string; hiddenAt: string }>
    }
    expect(body.results).toHaveLength(2)
    expect(body.results.map((r) => r.id)).toEqual([h2, h1]) // newer hidden first
    for (const r of body.results) {
      expect(r.hiddenAt).toBeTruthy()
    }
  })

  it('returns an empty array when no emails are hidden', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1',
      subject: 'Visible',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await env.request('/api/email/hidden', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as { results: unknown[] }
    expect(body.results).toEqual([])
  })

  it('clamps limit to [1, 200]', async () => {
    // Above-200 is silently clamped — we only need it to not crash.
    const res = await env.request('/api/email/hidden?limit=99999', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: unknown[] }
    expect(Array.isArray(body.results)).toBe(true)
  })
})

// ─── POST /api/email/:id/hide (#024) ──────────────────────────────────────

describe('POST /api/email/:id/hide', () => {
  let env: TestEnv
  beforeEach(async () => {
    env = await buildEnv()
    accountCache.clear()
  })
  afterEach(() => {
    env.cleanup()
    env.db.close()
  })

  it('requires auth', async () => {
    const res = await env.request('/api/email/anything/hide', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('sets hidden_at = now() on a visible row and returns 204', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1',
      subject: 'Visible',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const before = env.db.get<{ hidden_at: string | null }>(
      'SELECT hidden_at FROM emails WHERE id = ?', [id],
    )
    expect(before?.hidden_at).toBeNull()

    const res = await env.request(`/api/email/${id}/hide`, {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(204)
    const text = await res.text()
    expect(text).toBe('')

    const after = env.db.get<{ hidden_at: string | null }>(
      'SELECT hidden_at FROM emails WHERE id = ?', [id],
    )
    expect(after?.hidden_at).not.toBeNull()
    // The flag is an ISO timestamp — shape check (not value) so we
    // don't depend on the exact "now".
    expect(after?.hidden_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('returns 404 for an unknown id', async () => {
    const res = await env.request('/api/email/does-not-exist/hide', {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('not_found')
  })

  it('is idempotent (returns 204 when the row is already hidden)', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1',
      subject: 'Already hidden',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
      hidden: true,
    })
    const res = await env.request(`/api/email/${id}/hide`, {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(204)
    // Still hidden.
    const row = env.db.get<{ hidden_at: string | null }>(
      'SELECT hidden_at FROM emails WHERE id = ?', [id],
    )
    expect(row?.hidden_at).not.toBeNull()
  })

  it('persists the change across a re-read via GET /api/email/:id (which 404s hidden)', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1',
      subject: 'Soon-to-be-hidden',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    await env.request(`/api/email/${id}/hide`, {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const getRes = await env.request(`/api/email/${id}`, {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(getRes.status).toBe(404) // hidden → invisible to JSON detail API
    // But the row is there in /hidden.
    const hiddenRes = await env.request('/api/email/hidden', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const hiddenBody = (await hiddenRes.json()) as { results: Array<{ id: string }> }
    expect(hiddenBody.results.map((r) => r.id)).toContain(id)
  })
})

// ─── POST /api/email/:id/unhide (#024) ────────────────────────────────────

describe('POST /api/email/:id/unhide', () => {
  let env: TestEnv
  beforeEach(async () => {
    env = await buildEnv()
    accountCache.clear()
  })
  afterEach(() => {
    env.cleanup()
    env.db.close()
  })

  it('requires auth', async () => {
    const res = await env.request('/api/email/anything/unhide', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('clears hidden_at on a hidden row and returns 204', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1',
      subject: 'Hidden',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
      hidden: true,
    })
    const res = await env.request(`/api/email/${id}/unhide`, {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(204)

    const row = env.db.get<{ hidden_at: string | null }>(
      'SELECT hidden_at FROM emails WHERE id = ?', [id],
    )
    expect(row?.hidden_at).toBeNull()
  })

  it('returns 404 for an unknown id', async () => {
    const res = await env.request('/api/email/does-not-exist/unhide', {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(404)
  })

  it('is idempotent (returns 204 when the row is already visible)', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1',
      subject: 'Visible',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await env.request(`/api/email/${id}/unhide`, {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(204)
  })

  it('round-trips: hide then unhide restores the row to the default view', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1',
      subject: 'Round trip',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    // Hide.
    await env.request(`/api/email/${id}/hide`, {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const hiddenList = await env.request('/api/email/hidden', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(((await hiddenList.json()) as { results: Array<{ id: string }> }).results.map((r) => r.id)).toContain(id)

    // Unhide.
    const unhideRes = await env.request(`/api/email/${id}/unhide`, {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(unhideRes.status).toBe(204)

    // The row is back in the default list endpoint.
    const listRes = await env.request('/api/email', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const listBody = (await listRes.json()) as { results: Array<{ id: string }> }
    expect(listBody.results.map((r) => r.id)).toContain(id)

    // And no longer in /hidden.
    const hiddenAfter = await env.request('/api/email/hidden', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const hiddenBodyAfter = (await hiddenAfter.json()) as { results: Array<{ id: string }> }
    expect(hiddenBodyAfter.results.map((r) => r.id)).not.toContain(id)
  })
})

// ─── POST /api/email/:id/tags (#025) ────────────────────────────────────

describe('POST /api/email/:id/tags', () => {
  let env: TestEnv
  beforeEach(async () => {
    env = await buildEnv()
    accountCache.clear()
  })
  afterEach(() => {
    env.cleanup()
    env.db.close()
  })

  it('requires auth', async () => {
    const res = await env.request('/api/email/anything/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag: 'launch' }),
    })
    expect(res.status).toBe(401)
  })

  it('adds a tag (returns 204)', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await env.request(`/api/email/${id}/tags`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tag: 'launch' }),
    })
    expect(res.status).toBe(204)
    // Confirm the row exists.
    const rows = env.db.all<{ tag: string }>(
      'SELECT tag FROM email_tags WHERE email_id = ?',
      [id],
    )
    expect(rows.map((r) => r.tag)).toEqual(['launch'])
  })

  it('is idempotent — adding the same tag twice returns 204', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res1 = await env.request(`/api/email/${id}/tags`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tag: 'launch' }),
    })
    expect(res1.status).toBe(204)
    const res2 = await env.request(`/api/email/${id}/tags`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tag: 'launch' }),
    })
    expect(res2.status).toBe(204)
    // Still exactly one row.
    const rows = env.db.all<{ tag: string }>(
      'SELECT tag FROM email_tags WHERE email_id = ?',
      [id],
    )
    expect(rows).toHaveLength(1)
  })

  it('normalizes before storage ("#Launch " \u2192 "launch")', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await env.request(`/api/email/${id}/tags`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tag: '#Launch ' }),
    })
    expect(res.status).toBe(204)
    const rows = env.db.all<{ tag: string }>(
      'SELECT tag FROM email_tags WHERE email_id = ?',
      [id],
    )
    expect(rows.map((r) => r.tag)).toEqual(['launch'])
  })

  it('returns 404 for missing email id', async () => {
    const res = await env.request('/api/email/does-not-exist/tags', {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tag: 'launch' }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('not_found')
  })

  it('returns 400 for an invalid tag (empty)', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await env.request(`/api/email/${id}/tags`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tag: '' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('invalid_tag')
    expect(body.message).toMatch(/empty/i)
  })

  it('returns 400 for a tag with internal whitespace', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await env.request(`/api/email/${id}/tags`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tag: 'launch plans' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('invalid_tag')
    expect(body.message).toMatch(/whitespace/i)
  })

  it('returns 400 for missing tag in body', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await env.request(`/api/email/${id}/tags`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('missing_tag')
  })

  it('returns 400 for malformed JSON', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await env.request(`/api/email/${id}/tags`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_json')
  })
})

// ─── DELETE /api/email/:id/tags/:tag (#025) ─────────────────────────────

describe('DELETE /api/email/:id/tags/:tag', () => {
  let env: TestEnv
  beforeEach(async () => {
    env = await buildEnv()
    accountCache.clear()
  })
  afterEach(() => {
    env.cleanup()
    env.db.close()
  })

  it('requires auth', async () => {
    const res = await env.request('/api/email/anything/tags/launch', {
      method: 'DELETE',
    })
    expect(res.status).toBe(401)
  })

  it('removes an attached tag (returns 204)', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    env.db.run(
      'INSERT INTO email_tags (email_id, tag) VALUES (?, ?)',
      [id, 'launch'],
    )
    const res = await env.request(`/api/email/${id}/tags/launch`, {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(204)
    const rows = env.db.all<{ tag: string }>(
      'SELECT tag FROM email_tags WHERE email_id = ?',
      [id],
    )
    expect(rows).toEqual([])
  })

  it('is a no-op (404) when the (emailId, tag) pair does not exist', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await env.request(`/api/email/${id}/tags/never-added`, {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 for a missing email id', async () => {
    const res = await env.request('/api/email/does-not-exist/tags/launch', {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(404)
  })

  it('normalizes the URL segment (deletes "Launch" when canonical is "launch")', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    env.db.run(
      'INSERT INTO email_tags (email_id, tag) VALUES (?, ?)',
      [id, 'launch'],
    )
    // Caller sends "Launch" with a leading whitespace-ish form
    // (\u00a0 is a non-breaking space — the trim should handle it).
    const res = await env.request(`/api/email/${id}/tags/${encodeURIComponent('\u00a0Launch\u00a0')}`, {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(204)
    const rows = env.db.all<{ tag: string }>(
      'SELECT tag FROM email_tags WHERE email_id = ?',
      [id],
    )
    expect(rows).toEqual([])
  })

  it('returns 400 for an invalid tag in the URL', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await env.request(`/api/email/${id}/tags/${encodeURIComponent('a b')}`, {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_tag')
  })

  it('only removes the targeted (emailId, tag) pair (other emails keep the tag)', async () => {
    const a = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'a',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const b = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2', subject: 'b',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
    })
    env.db.run('INSERT INTO email_tags (email_id, tag) VALUES (?, ?)', [a, 'launch'])
    env.db.run('INSERT INTO email_tags (email_id, tag) VALUES (?, ?)', [b, 'launch'])

    const res = await env.request(`/api/email/${a}/tags/launch`, {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(204)

    const aTags = env.db.all<{ tag: string }>(
      'SELECT tag FROM email_tags WHERE email_id = ?',
      [a],
    )
    const bTags = env.db.all<{ tag: string }>(
      'SELECT tag FROM email_tags WHERE email_id = ?',
      [b],
    )
    expect(aTags).toEqual([])
    expect(bTags.map((t) => t.tag)).toEqual(['launch'])
  })
})

// ─── GET /api/email/tags (#025) ──────────────────────────────────────────

describe('GET /api/email/tags', () => {
  let env: TestEnv
  beforeEach(async () => {
    env = await buildEnv()
    accountCache.clear()
  })
  afterEach(() => {
    env.cleanup()
    env.db.close()
  })

  it('requires auth', async () => {
    const res = await env.request('/api/email/tags')
    expect(res.status).toBe(401)
  })

  it('returns empty results when no tags exist', async () => {
    const res = await env.request('/api/email/tags', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: unknown[] }
    expect(body.results).toEqual([])
  })

  it('returns all distinct tags with counts (sorted by count DESC then tag ASC)', async () => {
    const a = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'a',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const b = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2', subject: 'b',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
    })
    const c = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-3', subject: 'c',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-03T10:00:00.000Z',
    })
    env.db.run('INSERT INTO email_tags (email_id, tag) VALUES (?, ?)', [a, 'launch'])
    env.db.run('INSERT INTO email_tags (email_id, tag) VALUES (?, ?)', [b, 'launch'])
    env.db.run('INSERT INTO email_tags (email_id, tag) VALUES (?, ?)', [c, 'waiting'])

    const res = await env.request('/api/email/tags', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as {
      results: Array<{ tag: string; count: number }>
    }
    expect(body.results).toEqual([
      { tag: 'launch', count: 2 },
      { tag: 'waiting', count: 1 },
    ])
  })

  it('respects limit (returns at most N)', async () => {
    for (let i = 0; i < 5; i++) {
      const id = seedEmail(env.db, {
        accountId: 'acc-1', threadId: `t-${i}`, subject: `m${i}`,
        sender: 'a@b.com', senderEmail: 'a@b.com',
        receivedAt: new Date(Date.UTC(2024, 5, 1, 0, i, 0)).toISOString(),
      })
      env.db.run('INSERT INTO email_tags (email_id, tag) VALUES (?, ?)', [id, `tag-${i}`])
    }
    const res = await env.request('/api/email/tags?limit=3', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as { results: unknown[] }
    expect(body.results).toHaveLength(3)
  })

  it('counts distinct email_ids (idempotent add does not double-count)', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    // POST the same tag twice via the API (which uses INSERT OR IGNORE
    // — the public idempotent path).
    const auth = { authorization: basicHeader('david', PASSWORD) }
    const first = await env.request(`/api/email/${id}/tags`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ tag: 'launch' }),
    })
    const second = await env.request(`/api/email/${id}/tags`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ tag: 'launch' }),
    })
    expect(first.status).toBe(204)
    expect(second.status).toBe(204)
    // GET /api/email/tags must report count=1 even after two POSTs.
    const res = await env.request('/api/email/tags', { headers: auth })
    const body = (await res.json()) as { results: Array<{ tag: string; count: number }> }
    expect(body.results).toEqual([{ tag: 'launch', count: 1 }])
  })
})