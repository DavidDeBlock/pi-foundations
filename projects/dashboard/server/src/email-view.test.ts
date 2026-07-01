// email-view.test.ts — issue #023
//
// HTTP-layer tests for the three email UI surfaces:
//
//   GET /email                       — server-rendered inbox list
//   GET /email/:id                   — single email detail
//   GET /email/thread/:threadId      — chronological thread
//
// Verifies the acceptance criteria from the issue:
//   - /email renders an HTML list of messages sorted received_at DESC
//   - Filters are wired (?from, ?label, ?unread, ?provider)
//   - Inbox rows link to /email/:id and show sender/subject/snippet/time/unread
//   - /email/:id shows subject, sender, recipients, date, body, thread link,
//     and the Hide/Tag/Summarize placeholder buttons
//   - /email/thread/:threadId shows messages chronologically, each linking back
//   - The sidebar has an "Email" entry linking to /email
//   - 404 on unknown id / thread id
//   - Auth required (matches the rest of the dashboard)
//
// Reuses the same `seedEmail` / `resolveAccountId` helpers as the
// email-read test fixture so the FK constraints on `emails` are
// satisfied (migration #003 puts a NOT NULL FK on `emails.account_id`).

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
  readonly cc?: readonly string[]
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
      JSON.stringify(e.cc ?? []),
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
  const tmp = mkdtempSync(join(tmpdir(), 'email-view-test-'))
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

async function authed(env: TestEnv, path: string): Promise<Response> {
  return env.request(path, { headers: { authorization: basicHeader('david', PASSWORD) } })
}

// ─── GET /email (inbox) ───────────────────────────────────────────────────

describe('GET /email (inbox page)', () => {
  let env: TestEnv
  beforeEach(async () => {
    env = await buildEnv()
    accountCache.clear()
  })
  afterEach(() => {
    env.cleanup()
    env.db.close()
  })

  it('requires auth (returns 401 without credentials)', async () => {
    const res = await env.request('/email')
    expect(res.status).toBe(401)
  })

  it('renders the inbox as HTML with status 200', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hello',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, '/email')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type') ?? '').toMatch(/text\/html/)
  })

  it('shows an empty-state panel when no messages match', async () => {
    const res = await authed(env, '/email')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('email-empty')
    expect(html).toContain('No messages match your filters.')
  })

  it('lists seeded messages sorted by received_at DESC', async () => {
    // Seed OUT OF ORDER; the page should sort newest first.
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Older',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2', subject: 'Newer',
      sender: 'Bob <bob@example.com>', senderEmail: 'bob@example.com',
      receivedAt: '2024-06-15T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-3', subject: 'Middle',
      sender: 'Carol <carol@example.com>', senderEmail: 'carol@example.com',
      receivedAt: '2024-06-10T10:00:00.000Z',
    })
    const res = await authed(env, '/email')
    const html = await res.text()
    const newerIdx = html.indexOf('Newer')
    const middleIdx = html.indexOf('Middle')
    const olderIdx = html.indexOf('Older')
    expect(newerIdx).toBeGreaterThan(0)
    expect(middleIdx).toBeGreaterThan(newerIdx)
    expect(olderIdx).toBeGreaterThan(middleIdx)
  })

  it('each inbox row links to /email/:id', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hello',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, '/email')
    const html = await res.text()
    expect(html).toContain(`href="/email/${id}"`)
  })

  it('shows sender, subject, snippet, time, and unread indicator', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Project update',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      bodyPlain: 'Here is the project update you asked for.',
      snippet: 'Here is the project update you asked for.',
      receivedAt: '2024-06-01T10:00:00.000Z',
      isUnread: true,
    })
    const res = await authed(env, '/email')
    const html = await res.text()
    expect(html).toContain('Alice')
    expect(html).toContain('Project update')
    expect(html).toContain('Here is the project update')
    // Unread rows get the `.email-row-unread` class.
    expect(html).toMatch(/<li[^>]*class="email-row email-row-unread"/)
  })

  it('reads rows do not carry the unread class', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Read message',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
      isUnread: false,
    })
    const res = await authed(env, '/email')
    const html = await res.text()
    expect(html).toMatch(/<li[^>]*class="email-row"(?! email-row-unread)/)
  })

  it('excludes hidden rows (defense-in-depth)', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Visible',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2', subject: 'HiddenSubject',
      sender: 'Bob <bob@example.com>', senderEmail: 'bob@example.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
      hidden: true,
    })
    const res = await authed(env, '/email')
    const html = await res.text()
    expect(html).toContain('Visible')
    expect(html).not.toContain('HiddenSubject')
  })
})

// ─── Filter wiring ────────────────────────────────────────────────────────

describe('GET /email — filter wiring', () => {
  let env: TestEnv
  beforeEach(async () => {
    env = await buildEnv()
    accountCache.clear()
  })
  afterEach(() => {
    env.cleanup()
    env.db.close()
  })

  it('?from restricts to messages from that sender', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'From Alice',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2', subject: 'From Bob',
      sender: 'Bob <bob@example.com>', senderEmail: 'bob@example.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
    })
    const res = await authed(env, '/email?from=alice@example.com')
    const html = await res.text()
    expect(html).toContain('From Alice')
    expect(html).not.toContain('From Bob')
  })

  it('?label restricts to messages with that label', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Starred mail',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
      labels: ['INBOX', 'STARRED'],
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2', subject: 'Plain mail',
      sender: 'Bob <bob@example.com>', senderEmail: 'bob@example.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
      labels: ['INBOX'],
    })
    const res = await authed(env, '/email?label=STARRED')
    const html = await res.text()
    expect(html).toContain('Starred mail')
    expect(html).not.toContain('Plain mail')
  })

  it('?unread=1 hides read messages', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Unread one',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
      isUnread: true,
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2', subject: 'Read one',
      sender: 'Bob <bob@example.com>', senderEmail: 'bob@example.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
      isUnread: false,
    })
    const res = await authed(env, '/email?unread=1')
    const html = await res.text()
    expect(html).toContain('Unread one')
    expect(html).not.toContain('Read one')
  })

  it('?provider=gmail does not exclude any messages (v1 is Gmail-only)', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'A message',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, '/email?provider=gmail')
    const html = await res.text()
    expect(html).toContain('A message')
  })

  it('renders the filter pills with active state matching the URL', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'A message',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, '/email?label=STARRED')
    const html = await res.text()
    // The STARRED pill is marked active.
    expect(html).toMatch(/<a[^>]*class="email-filter email-filter-active"[^>]*data-email-label-filter="STARRED"/)
    // The "All" pill is not active.
    expect(html).toMatch(/<a[^>]*class="email-filter"(?! email-filter-active)[^>]*data-email-label-filter=""/)
  })

  it('preserves other filters when submitting the from-substring form', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'A message',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, '/email?label=INBOX')
    const html = await res.text()
    // The from-substring form should emit a hidden input for label=INBOX
    // so applying a sender filter doesn't drop the label filter.
    expect(html).toContain('type="hidden" name="label" value="INBOX"')
  })
})

// ─── Pagination ───────────────────────────────────────────────────────────

describe('GET /email — pagination', () => {
  let env: TestEnv
  beforeEach(async () => {
    env = await buildEnv()
    accountCache.clear()
  })
  afterEach(() => {
    env.cleanup()
    env.db.close()
  })

  it('omits pagination when fewer than limit messages exist', async () => {
    for (let i = 0; i < 5; i++) {
      seedEmail(env.db, {
        accountId: 'acc-1', threadId: `t-${i}`, subject: `Subject ${i}`,
        sender: `Sender <s${i}@example.com>`, senderEmail: `s${i}@example.com`,
        receivedAt: new Date(Date.UTC(2024, 0, 1, 0, i, 0)).toISOString(),
      })
    }
    const res = await authed(env, '/email?limit=20')
    const html = await res.text()
    // The CSS defines the class even when no pagination is rendered,
    // so check for the actual <nav> element.
    expect(html).not.toContain('<nav class="email-pagination"')
    expect(html).not.toContain('email-pagination-next"')
  })

  it('emits a "Next page" link with the cursor when more pages remain', async () => {
    for (let i = 0; i < 5; i++) {
      seedEmail(env.db, {
        accountId: 'acc-1', threadId: `t-${i}`, subject: `Subject ${i}`,
        sender: `Sender <s${i}@example.com>`, senderEmail: `s${i}@example.com`,
        receivedAt: new Date(Date.UTC(2024, 0, 1, 0, i, 0)).toISOString(),
      })
    }
    const res = await authed(env, '/email?limit=2')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<nav class="email-pagination"')
    expect(html).toMatch(/<a[^>]*class="email-pagination-next"[^>]*href="\/email\?[^"]*cursor=[A-Za-z0-9_-]+/)
  })
})

// ─── Sidebar nav ──────────────────────────────────────────────────────────

describe('GET /email — sidebar nav', () => {
  let env: TestEnv
  beforeEach(async () => {
    env = await buildEnv()
    accountCache.clear()
  })
  afterEach(() => {
    env.cleanup()
    env.db.close()
  })

  it('renders the sidebar with an "Email" section title', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hello',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, '/email')
    const html = await res.text()
    expect(html).toContain('sidebar-title')
    expect(html).toContain('Email')
    // The "Email" sidebar title is a separate occurrence from
    // the title bar — verify the sidebar section is there.
    expect(html).toContain('compartment-nav')
  })

  it('sidebar has an "Inbox" link pointing to /email', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hello',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, '/email')
    const html = await res.text()
    // The Inbox nav entry links to /email and carries the active class.
    expect(html).toMatch(/<a[^>]*class="compartment-button compartment-button-active"[^>]*href="\/email"/)
    expect(html).toContain('>Inbox</span>')
  })
})

// ─── GET /email/:id (detail) ──────────────────────────────────────────────

describe('GET /email/:id (detail page)', () => {
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
    const res = await env.request('/email/some-id')
    expect(res.status).toBe(401)
  })

  it('renders 404 when the id is unknown', async () => {
    const res = await authed(env, '/email/does-not-exist')
    expect(res.status).toBe(404)
  })

  it('renders 404 when the row is hidden', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hidden',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
      hidden: true,
    })
    const res = await authed(env, `/email/${id}`)
    expect(res.status).toBe(404)
  })

  it('shows subject, sender, recipients, date, and body', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Project update',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      to: ['bob@example.com', 'carol@example.com'],
      cc: ['manager@example.com'],
      bodyPlain: 'Here are the latest numbers from the project.',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, `/email/${id}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Project update')
    expect(html).toContain('Alice')
    expect(html).toContain('alice@example.com')
    expect(html).toContain('bob@example.com')
    expect(html).toContain('carol@example.com')
    expect(html).toContain('manager@example.com')
    expect(html).toContain('Here are the latest numbers from the project.')
    // The ISO datetime is in <time datetime=...> for machine readers.
    expect(html).toMatch(/<time[^>]*datetime="2024-06-01T10:00:00\.000Z"/)
  })

  it('shows a "View all messages in this thread" link to /email/thread/:id', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 'thread-42', subject: 'Hello',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, `/email/${id}`)
    const html = await res.text()
    expect(html).toContain('href="/email/thread/thread-42"')
  })

  it('renders the Hide / Tag / Summarize action placeholders (disabled)', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hello',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, `/email/${id}`)
    const html = await res.text()
    expect(html).toContain('data-email-action="hide"')
    expect(html).toContain('data-email-action="tag"')
    expect(html).toContain('data-email-action="summarize"')
    // All three buttons are disabled until #024/#025/#027.
    expect(html).toMatch(/<button[^>]*data-email-action="hide"[^>]*disabled/)
    expect(html).toMatch(/<button[^>]*data-email-action="tag"[^>]*disabled/)
    expect(html).toMatch(/<button[^>]*data-email-action="summarize"[^>]*disabled/)
  })

  it('includes a back-to-inbox breadcrumb', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hello',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, `/email/${id}`)
    const html = await res.text()
    expect(html).toContain('email-breadcrumb')
    expect(html).toContain('href="/email"')
  })
})

// ─── GET /email/thread/:threadId ──────────────────────────────────────────

describe('GET /email/thread/:threadId (thread page)', () => {
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
    const res = await env.request('/email/thread/abc')
    expect(res.status).toBe(401)
  })

  it('renders 404 when the thread has no messages', async () => {
    const res = await authed(env, '/email/thread/empty')
    expect(res.status).toBe(404)
  })

  it('lists all messages in the thread in chronological order', async () => {
    // Seed out of order; expect the page to show them oldest-first.
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 'thr-1', subject: 'Reply',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      bodyPlain: 'Sounds good.', receivedAt: '2024-06-03T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 'thr-1', subject: 'Original',
      sender: 'Bob <bob@example.com>', senderEmail: 'bob@example.com',
      bodyPlain: 'Want to grab lunch?', receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 'thr-1', subject: 'RE: Original',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      bodyPlain: 'Sure!', receivedAt: '2024-06-02T10:00:00.000Z',
    })
    const res = await authed(env, '/email/thread/thr-1')
    expect(res.status).toBe(200)
    const html = await res.text()
    const origIdx = html.indexOf('Original')
    const reIdx = html.indexOf('RE: Original')
    const replyIdx = html.indexOf('Reply')
    // The thread messages are in an article container; assert that
    // the "Original" subject appears before "RE:" before "Reply".
    expect(origIdx).toBeGreaterThan(0)
    expect(reIdx).toBeGreaterThan(origIdx)
    expect(replyIdx).toBeGreaterThan(reIdx)
  })

  it('each message links back to /email/:id', async () => {
    const first = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 'thr-1', subject: 'First',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const second = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 'thr-1', subject: 'Second',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
    })
    const res = await authed(env, '/email/thread/thr-1')
    const html = await res.text()
    expect(html).toContain(`href="/email/${first}"`)
    expect(html).toContain(`href="/email/${second}"`)
  })

  it('excludes hidden messages from the thread', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 'thr-1', subject: 'VisibleThread',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 'thr-1', subject: 'HiddenInThread',
      sender: 'Bob <bob@example.com>', senderEmail: 'bob@example.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
      hidden: true,
    })
    const res = await authed(env, '/email/thread/thr-1')
    const html = await res.text()
    expect(html).toContain('VisibleThread')
    expect(html).not.toContain('HiddenInThread')
  })

  it('includes a back-to-inbox breadcrumb', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 'thr-1', subject: 'First',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, '/email/thread/thr-1')
    const html = await res.text()
    expect(html).toContain('email-breadcrumb')
    expect(html).toContain('href="/email"')
  })
})

// ─── /preview/v2 no longer renders email ──────────────────────────────────

describe('/preview/v2 — email compartment is gone (#023)', () => {
  let env: TestEnv
  beforeEach(async () => {
    env = await buildEnv()
    accountCache.clear()
  })
  afterEach(() => {
    env.cleanup()
    env.db.close()
  })

  it('does not render the email compartment in the preview', async () => {
    const res = await authed(env, '/preview/v2')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).not.toContain('data-compartment="email"')
    expect(html).not.toContain('data-panel="email"')
    // Hardcoded fixture markers are also gone.
    expect(html).not.toContain('John Smith')
    expect(html).not.toContain('Sarah Lee')
  })
})

// ─── Performance smoke ────────────────────────────────────────────────────

describe('GET /email — performance smoke (AC)', () => {
  let env: TestEnv
  beforeEach(async () => {
    env = await buildEnv()
    accountCache.clear()
  })
  afterEach(() => {
    env.cleanup()
    env.db.close()
  })

  it('renders <500ms with 1000 emails', async () => {
    const accountId = resolveAccountId(env.db, 'acc-1')
    for (let i = 0; i < 1000; i++) {
      seedEmail(env.db, {
        id: `bulk-${i}`,
        accountId,
        threadId: `t-${i % 50}`,
        subject: `Email number ${i} about Postgres`,
        sender: 'Sender <sender@example.com>', senderEmail: 'sender@example.com',
        bodyPlain: `Body of email ${i} discussing indexes.`,
        snippet: `Body of email ${i} discussing indexes.`,
        receivedAt: new Date(Date.UTC(2024, 0, 1, 0, i % 60, 0)).toISOString(),
      })
    }
    const start = performance.now()
    const res = await authed(env, '/email?limit=50')
    const elapsed = performance.now() - start
    expect(res.status).toBe(200)
    expect(elapsed).toBeLessThan(500)
  }, 10_000)
})
