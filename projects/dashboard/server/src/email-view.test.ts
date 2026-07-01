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

// ─── Sync summary indicator (#026) ───────────────────────────────────

describe('GET /email — sync summary indicator (#026)', () => {
  let env: TestEnv
  beforeEach(async () => {
    env = await buildEnv()
    accountCache.clear()
  })
  afterEach(() => {
    env.cleanup()
    env.db.close()
  })

  it('omits the indicator when the worker is not injected (setup-only mode)', async () => {
    // The default buildEnv creates the app without passing a sync
    // worker (matches the "email deps not configured" path).
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, '/email')
    const html = await res.text()
    // No data-email-sync-indicator element rendered (or it's the
    // empty no-accounts variant), and no script tag for it.
    expect(html).not.toContain('EMAIL_SYNC_SCRIPT')
    expect(html).not.toContain('Syncing now')
  })

  it('renders the indicator + JS updater when the worker is injected', async () => {
    // Build a fresh app WITH the worker injected. We import the
    // helpers in-line so the rest of the file doesn't have to
    // know about the optional param.
    const { createApp } = await import('./app.js')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { JsonTokenStore } = await import('./token-store.js')
    const { Database } = await import('./db.js')
    const { runMigrations } = await import('./migrations.js')
    const { emailViewApi } = await import('./email-view.js')
    const { Hono } = await import('hono')
    const { auth } = await import('./auth.js')
    const { EmailSyncWorker } = await import('./email-sync-worker.js')
    const { createTokenCipher } = await import('./token-encryption.js')
    const { randomBytes } = await import('node:crypto')

    const db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    const cipher = createTokenCipher(randomBytes(32))
    const stubWorker = new EmailSyncWorker({
      db,
      cipher,
      buildGmailClient: () => ({
        listMessages: async () => ({ messages: [], nextPageToken: null }),
        getMessage: async () => { throw new Error('no msgs') },
      } as unknown as import('./gmail-client.js').GmailClient),
    })
    const subApp = emailViewApi(db, stubWorker)
    const tmp = mkdtempSync(join(tmpdir(), 'email-view-sync-test-'))
    const app = createApp({ passwordHash: HASH, tokenStore: new JsonTokenStore({ dataDir: tmp }), db })
    app.route('/email-sync', subApp)
    void new Hono()
    void auth

    seedEmail(db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await app.request('/email-sync', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('data-email-sync-indicator')
    expect(html).toContain('Never synced')
    // The JS updater pings /api/email/sync/status every 30s — the
    // literal URL is the easiest rendered-HTML fingerprint for it.
    expect(html).toContain('/api/email/sync/status')
    rmSync(tmp, { recursive: true, force: true })
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

  it('sidebar has a "Bookmarks" link pointing to / (dashboard cross-link)', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hello',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, '/email')
    const html = await res.text()
    // The Bookmarks nav entry is a dashboard cross-link so users on
    // /email/* pages can navigate back to the activity feed without
    // typing `/`. It lives in a "Dashboard" section above "Email".
    expect(html).toContain('>Bookmarks</span>')
    expect(html).toMatch(/<a[^>]*class="compartment-button"[^>]*href="\/"[^>]*data-email-nav="bookmarks"/)
    // The "Dashboard" section title appears before the "Email" section
    // title in the sidebar.
    const dashboardIdx = html.indexOf('>Dashboard<')
    const emailIdx = html.indexOf('>Email<')
    expect(dashboardIdx).toBeGreaterThan(-1)
    expect(emailIdx).toBeGreaterThan(-1)
    expect(dashboardIdx).toBeLessThan(emailIdx)
  })
})

// ─── GET /email — tag filter (#025) ───────────────────────────────────

describe('GET /email — tag filter (#025)', () => {
  let env: TestEnv
  beforeEach(async () => {
    env = await buildEnv()
    accountCache.clear()
  })
  afterEach(() => {
    env.cleanup()
    env.db.close()
  })

  it('narrows the inbox to emails carrying the given tag', async () => {
    const tagged = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'tagged',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2', subject: 'untagged',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
    })
    env.db.run('INSERT INTO email_tags (email_id, tag) VALUES (?, ?)', [tagged, 'launch'])

    const res = await authed(env, '/email?tag=launch')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('>tagged</')
    expect(html).not.toContain('>untagged</')
  })

  it('renders an "active tag" chip in the filter bar with a clear link', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, '/email?tag=launch')
    const html = await res.text()
    expect(html).toContain('data-email-active-tag')
    expect(html).toContain('Tagged')
    expect(html).toContain('#launch')
    // Clear link drops the tag param.
    expect(html).toMatch(/<a[^>]+href="\/email"[^>]*>\u00d7<\/a>/)
  })

  it('does not render the active-tag chip when no tag filter is set', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, '/email')
    const html = await res.text()
    expect(html).not.toContain('data-email-active-tag')
  })

  it('combines tag filter with sender filter (AND)', async () => {
    const a = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'alice launch',
      sender: 'alice@example.com', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2', subject: 'bob launch',
      sender: 'bob@example.com', senderEmail: 'bob@example.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
    })
    env.db.run('INSERT INTO email_tags (email_id, tag) VALUES (?, ?)', [a, 'launch'])

    const res = await authed(env, '/email?tag=launch&from=alice@example.com')
    const html = await res.text()
    expect(html).toContain('>alice launch</')
    expect(html).not.toContain('>bob launch</')
  })

  it('shows an empty state when the tag filter matches nothing', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'msg',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, '/email?tag=nope')
    const html = await res.text()
    expect(html).toContain('No messages match your filters.')
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

  it('renders the detail page (with Unhide) when the row is hidden (#024)', async () => {
    // As of #024, hidden emails still render on the detail page so
    // the user can unhide directly without going through /email/hidden.
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hidden',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
      hidden: true,
    })
    const res = await authed(env, `/email/${id}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Hidden')
    expect(html).toContain('data-email-action="unhide"')
    // data-email-hidden="true" tells the script this is the hidden state.
    expect(html).toContain('data-email-hidden="true"')
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

  it('renders the Summarize placeholder (disabled) and a working Hide button; tags render as chips (#024+#025)', async () => {
    // Hide is wired up in #024; tags are wired up in #025 (chips +
    // add-tag input); Summarize remains a placeholder for #027.
    // The Hide button's label and endpoint flip based on hidden_at
    // so a reload always lands on the right toggle. The tag chips
    // and add-tag input render from the canonical server state.
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hello',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, `/email/${id}`)
    const html = await res.text()
    expect(html).toContain('data-email-action="hide"')
    // Tag button is GONE in #025 — tags are chips + input, not a
    // single button. Confirm the chips + input surface is present.
    expect(html).toContain('data-email-tag-form')
    expect(html).toContain('data-email-tag-input')
    expect(html).toContain('data-email-action="summarize"')
    // Hide is NOT disabled and renders "Hide" label.
    expect(html).toMatch(/<button[^>]*data-email-action="hide"(?![^>]*disabled)[^>]*>Hide</)
    // Summarize stays disabled (placeholder for #027).
    expect(html).toMatch(/<button[^>]*data-email-action="summarize"[^>]*disabled/)
    // data-email-id is present so the JS handler can POST to the right URL.
    expect(html).toContain(`data-email-id="${id}"`)
  })

  it('flips the button label to "Unhide" when the email is hidden, and stays that way after a reload (#024 AC)', async () => {
    // The AC: "Detail view 'Hide' button toggles to 'Unhide' (and
    // stays that way after page reload) when an email is hidden".
    // Persistence across reloads is the server-rendered truth: the
    // page re-reads hidden_at on every load.
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Soft-deleted',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
      hidden: true,
    })
    // Render #1
    const res1 = await authed(env, `/email/${id}`)
    expect(res1.status).toBe(200)
    const html1 = await res1.text()
    expect(html1).toMatch(/<button[^>]*data-email-action="unhide"(?![^>]*disabled)[^>]*>Unhide</)
    expect(html1).not.toMatch(/<button[^>]*data-email-action="hide"(?![^>]*disabled)[^>]*>Hide</)

    // Render #2 (simulate reload). Server state hasn't changed →
    // server still renders Unhide + same data-email-hidden="true".
    const res2 = await authed(env, `/email/${id}`)
    const html2 = await res2.text()
    expect(html2).toMatch(/<button[^>]*data-email-action="unhide"(?![^>]*disabled)[^>]*>Unhide</)
    expect(html2).toContain('data-email-hidden="true"')
  })

  it('includes the EMAIL_HIDE_SCRIPT on the detail page so the button fires fetch + reload', async () => {
    // The script picks up `[data-email-hide-button]` and POSTs + reloads.
    // We don't drive the browser, but we check the script is inlined
    // and references the binding we rely on.
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hello',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, `/email/${id}`)
    const html = await res.text()
    expect(html).toContain('data-email-hide-button')
    // The script uses fetch('/api/email/' + emailId + '/' + action).
    expect(html).toMatch(/'\/api\/email\/'/)
    expect(html).toContain('window.location.reload()')
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

  // ─── Tag chips + Add-tag input (#025) ────────────────────────────

  it('renders "No tags yet" placeholder when the email has no tags', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hello',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, `/email/${id}`)
    const html = await res.text()
    expect(html).toContain('data-email-tags-empty')
    expect(html).toContain('No tags yet.')
  })

  it('renders existing tags as chips with × remove buttons', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hello',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    env.db.run('INSERT INTO email_tags (email_id, tag) VALUES (?, ?)', [id, 'launch'])
    env.db.run('INSERT INTO email_tags (email_id, tag) VALUES (?, ?)', [id, 'waiting-on-sarah'])
    const res = await authed(env, `/email/${id}`)
    const html = await res.text()
    expect(html).toContain('data-email-tag-chips')
    expect(html).toContain('#launch')
    expect(html).toContain('#waiting-on-sarah')
    // Each chip has a × button with data-email-tag-remove.
    const removeMatches = html.match(/data-email-tag-remove[^>]+data-tag="[^"]+"/g) ?? []
    expect(removeMatches.length).toBe(2)
    // The × buttons carry the email id so the JS can DELETE.
    expect(html).toMatch(/data-email-tag-remove[^>]+data-email-id="[^"]+"/)
  })

  it('renders an Add-tag input with autocomplete (datalist sourced from /api/email/tags)', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hello',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    // Some existing tags the user has created (none attached to this email).
    const other = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2', subject: 'Other',
      sender: 'Bob <b@b.com>', senderEmail: 'b@b.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
    })
    env.db.run('INSERT INTO email_tags (email_id, tag) VALUES (?, ?)', [other, 'launch'])
    env.db.run('INSERT INTO email_tags (email_id, tag) VALUES (?, ?)', [other, 'urgent'])

    const res = await authed(env, `/email/${id}`)
    const html = await res.text()
    // The input + button are present.
    expect(html).toContain('data-email-tag-input')
    expect(html).toContain('data-email-tag-add')
    expect(html).toContain('data-email-tag-form')
    // The datalist + JSON block provide autocomplete.
    expect(html).toContain('id="email-all-tags-list"')
    expect(html).toContain('id="email-all-tags"')
    // JSON-encoded payload (HTML-escaped quotes).
    expect(html).toMatch(/email-all-tags[^>]*>\[(?:&quot;|")launch(?:&quot;|")/)
    expect(html).toMatch(/email-all-tags[^>]*>(?:.*)(?:&quot;|")urgent(?:&quot;|")/)
    // The script wires fetch + reload.
    expect(html).toMatch(/data-email-tag-remove/) // the script binds × buttons
  })

  it('tag chip links to /email?tag=... (inbox filter)', async () => {
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hello',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    env.db.run('INSERT INTO email_tags (email_id, tag) VALUES (?, ?)', [id, 'launch'])
    const res = await authed(env, `/email/${id}`)
    const html = await res.text()
    // The chip is a link to the inbox with the tag filter set.
    expect(html).toMatch(/href="\/email\?tag=launch"/)
  })

  it('persists existing tag chips across reloads (server-rendered source of truth)', async () => {
    // The AC for tag chips: chips reflect the canonical state.
    // The server re-reads email_tags on every page load — no
    // local JS state to go stale.
    const id = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Hello',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    env.db.run('INSERT INTO email_tags (email_id, tag) VALUES (?, ?)', [id, 'launch'])
    env.db.run('INSERT INTO email_tags (email_id, tag) VALUES (?, ?)', [id, 'urgent'])

    const res1 = await authed(env, `/email/${id}`)
    expect(res1.status).toBe(200)
    const html1 = await res1.text()
    expect(html1).toContain('#launch')
    expect(html1).toContain('#urgent')

    // Second load returns the same chips — server-rendered truth.
    const res2 = await authed(env, `/email/${id}`)
    const html2 = await res2.text()
    expect(html2).toContain('#launch')
    expect(html2).toContain('#urgent')
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

// ─── GET /email/hidden (#024) ──────────────────────────────────────────────

describe('GET /email/hidden (#024)', () => {
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
    const res = await env.request('/email/hidden')
    expect(res.status).toBe(401)
  })

  it('renders an empty-state message when no emails are hidden', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Visible',
      sender: 'Alice <alice@example.com>', senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, '/email/hidden')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('No hidden messages')
  })

  it('renders hidden emails sorted by hidden_at DESC with an Unhide button per row', async () => {
    const older = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1',
      subject: 'Older hidden', sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z', hidden: true,
    })
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-2',
      subject: 'Visible (should not appear)', sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
    })
    const newer = seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-3',
      subject: 'Newer hidden', sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-03T10:00:00.000Z', hidden: true,
    })
    const res = await authed(env, '/email/hidden')
    expect(res.status).toBe(200)
    const html = await res.text()
    // Subject order: newer first.
    const newerIdx = html.indexOf('Newer hidden')
    const olderIdx = html.indexOf('Older hidden')
    expect(newerIdx).toBeGreaterThan(0)
    expect(olderIdx).toBeGreaterThan(newerIdx)
    // The visible row must not appear.
    expect(html).not.toContain('Visible (should not appear)')
    // Each row has an Unhide button with the row's id and the email-action wiring.
    expect(html).toMatch(new RegExp(`data-email-id="${older}"`))
    expect(html).toMatch(new RegExp(`data-email-id="${newer}"`))
    expect(html).toContain('data-email-action="unhide"')
    expect(html).toContain('data-email-hide-button')
  })

  it('does not collide with the /:id route (literal /hidden is matched, not captured as id="hidden")', async () => {
    // No hidden emails needed — we just verify the route lands on
    // the hidden-list renderer (showing the empty state), NOT the
    // detail route's 404.
    const res = await authed(env, '/email/hidden')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Hidden emails') // page title
  })

  it('sidebar shows the "Hidden" link pointing to /email/hidden', async () => {
    seedEmail(env.db, {
      accountId: 'acc-1', threadId: 't-1', subject: 'Visible',
      sender: 'a@b.com', senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const res = await authed(env, '/email/hidden')
    const html = await res.text()
    // The Hidden link exists and points at /email/hidden.
    expect(html).toMatch(/<a[^>]*class="compartment-button[^"]*"[^>]*href="\/email\/hidden"/)
    // The Hidden link is marked active on /email/hidden (active class added).
    expect(html).toMatch(/<a[^>]*class="compartment-button compartment-button-active"[^>]*href="\/email\/hidden"/)
    expect(html).toContain('>Hidden</span>')
  })
})
