// email-searcher.test.ts — issue #022
//
// Integration tests for the email search orchestrator. Uses an in-
// memory SQLite DB with the real migration set so FTS5 + trigrams
// work end-to-end. Covers:
//
//   - FTS5 mode for exact + prefix matches.
//   - Fuzzy fallback for typo tolerance ("postgers" → "postgres").
//   - Snippet generation with <mark> tags around matched terms.
//   - Filter composition (from, label, unread, since, until) on top
//     of the text query.
//   - hidden_at IS NOT NULL rows excluded from all reads (defense-
//     in-depth before #024 wires hide/unhide endpoints).
//   - Performance smoke: search against 1,000 seeded emails returns
//     in <200ms (matches the PRD-002 AC #30 target).
//
// Helper: `seedEmail` writes an email row + populates the
// `email_trigrams` table from the subject + body + sender so the
// fuzzy fallback has something to score against. Real production
// wiring would have the sync worker (or a backfill on first read)
// maintain the trigram set.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { searchEmails } from './email-searcher.js'
import { extractTrigramsAsArray } from './search-query-builder.js'
import { randomUUID } from 'node:crypto'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

// ─── Test helpers ─────────────────────────────────────────────────────────

/**
 * Insert an `email_accounts` row so the FK on `emails.account_id`
 * is satisfied. Returns the generated account id. Encrypted token
 * columns are bypassed by direct INSERT — the searcher doesn't
 * touch the cipher (it only reads from `emails`).
 */
function seedEmailAccount(db: Database): string {
  const id = randomUUID()
  db.run(
    `INSERT INTO email_accounts (id, provider, email_address, access_token_enc, refresh_token_enc)
     VALUES (?, 'gmail', ?, 'enc', 'enc')`,
    [id, `${id}@example.com`],
  )
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
  /** Soft-delete flag. Set true to exercise the defense-in-depth
   *  filter. */
  readonly hidden?: boolean
}

function seedEmail(db: Database, e: SeedEmail): string {
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
      e.accountId,
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

  // Populate email_trigrams so the fuzzy fallback has a corpus to
  // score against. The trigram set includes subject + body + sender
  // + sender_email — the same fields the FTS5 index covers.
  const corpus = [
    e.subject,
    e.bodyPlain ?? '',
    e.sender,
    e.senderEmail,
  ]
    .join(' ')
    .toLowerCase()
  const trigrams = extractTrigramsAsArray(corpus)
  db.transaction(() => {
    for (const t of trigrams) {
      db.run(
        'INSERT OR IGNORE INTO email_trigrams (email_id, trigram) VALUES (?, ?)',
        [id, t],
      )
    }
  })
  return id
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('searchEmails — FTS5 mode', () => {
  let db: Database
  let accountId: string
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    accountId = seedEmailAccount(db)
    seedEmail(db, {
      accountId,
      threadId: 't-1',
      subject: 'Postgres tips',
      sender: 'Alice <alice@example.com>',
      senderEmail: 'alice@example.com',
      bodyPlain: 'Here are some useful Postgres query patterns.',
      receivedAt: '2024-06-01T10:00:00.000Z',
      labels: ['INBOX'],
      isUnread: true,
    })
    seedEmail(db, {
      accountId,
      threadId: 't-2',
      subject: 'Lunch plans',
      sender: 'Bob <bob@example.com>',
      senderEmail: 'bob@example.com',
      bodyPlain: 'Want to grab a sandwich at noon?',
      receivedAt: '2024-06-02T11:00:00.000Z',
      labels: ['INBOX'],
      isUnread: false,
    })
  })
  afterEach(() => db.close())

  it('returns empty mode for an empty query', () => {
    const r = searchEmails(db, '')
    expect(r.mode).toBe('empty')
    expect(r.results).toHaveLength(0)
  })

  it('finds an exact subject match via FTS5', () => {
    const r = searchEmails(db, 'Postgres')
    expect(r.mode).toBe('fts5')
    expect(r.results.some((x) => x.subject === 'Postgres tips')).toBe(true)
  })

  it('finds a prefix match via FTS5', () => {
    const r = searchEmails(db, 'post')
    expect(r.results.some((x) => x.subject === 'Postgres tips')).toBe(true)
  })

  it('matches against body text', () => {
    const r = searchEmails(db, 'sandwich')
    expect(r.results.some((x) => x.subject === 'Lunch plans')).toBe(true)
  })

  it('matches against sender_email', () => {
    const r = searchEmails(db, 'alice@example.com')
    expect(r.results.some((x) => x.subject === 'Postgres tips')).toBe(true)
  })

  it('emits FTS5-generated snippet with <mark> tags', () => {
    const r = searchEmails(db, 'Postgres')
    const hit = r.results.find((x) => x.subject === 'Postgres tips')
    expect(hit).toBeDefined()
    expect(hit?.snippet).toContain('<mark>')
    expect(hit?.snippet).toContain('</mark>')
  })

  it('returns zero results when no match exists', () => {
    const r = searchEmails(db, 'qzqzqzqz')
    expect(r.results).toHaveLength(0)
  })
})

describe('searchEmails — fuzzy fallback', () => {
  let db: Database
  let accountId: string
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    accountId = seedEmailAccount(db)
    seedEmail(db, {
      accountId,
      threadId: 't-1',
      subject: 'Postgres tips',
      sender: 'Alice <alice@example.com>',
      senderEmail: 'alice@example.com',
      bodyPlain: 'Index tuning and EXPLAIN ANALYZE.',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
  })
  afterEach(() => db.close())

  it('finds "Postgres" when querying "postgers" (typo)', () => {
    // FTS5 prefix won't match — "postgers*" doesn't appear in the
    // corpus. The trigram fallback catches it via Jaccard overlap.
    const r = searchEmails(db, 'postgers')
    expect(r.mode).toBe('fuzzy')
    expect(r.results.some((x) => x.subject === 'Postgres tips')).toBe(true)
  })

  it('emits a <mark>-wrapped snippet for fuzzy matches', () => {
    const r = searchEmails(db, 'postgers')
    const hit = r.results.find((x) => x.subject === 'Postgres tips')
    expect(hit).toBeDefined()
    expect(hit?.snippet).toContain('<mark>')
  })

  it('returns zero results when no trigram overlap exists', () => {
    const r = searchEmails(db, 'qzqzqzqz')
    expect(r.results).toHaveLength(0)
  })
})

describe('searchEmails — filters compose with the text query', () => {
  let db: Database
  let accountId: string
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    accountId = seedEmailAccount(db)
    seedEmail(db, {
      accountId,
      threadId: 't-1',
      subject: 'Postgres tips',
      sender: 'Alice <alice@example.com>',
      senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
      isUnread: true,
      labels: ['INBOX', 'UNREAD'],
    })
    seedEmail(db, {
      accountId,
      threadId: 't-2',
      subject: 'Postgres release notes',
      sender: 'Bob <bob@example.com>',
      senderEmail: 'bob@example.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
      isUnread: false,
      labels: ['INBOX'],
    })
    seedEmail(db, {
      accountId,
      threadId: 't-3',
      subject: 'Lunch plans',
      sender: 'Alice <alice@example.com>',
      senderEmail: 'alice@example.com',
      receivedAt: '2024-06-03T10:00:00.000Z',
      isUnread: true,
      labels: ['INBOX', 'UNREAD'],
    })
  })
  afterEach(() => db.close())

  it('unread=true restricts to unread messages', () => {
    const r = searchEmails(db, 'postgres', { unread: true })
    expect(r.results.length).toBe(1)
    expect(r.results[0]?.subject).toBe('Postgres tips')
  })

  it('from filter restricts to a specific sender', () => {
    const r = searchEmails(db, 'postgres', { from: 'alice@example.com' })
    expect(r.results.length).toBe(1)
    expect(r.results[0]?.senderEmail).toBe('alice@example.com')
  })

  it('label filter restricts to messages with that label', () => {
    seedEmail(db, {
      accountId,
      threadId: 't-4',
      subject: 'Postgres archive',
      sender: 'Archive <archive@example.com>',
      senderEmail: 'archive@example.com',
      receivedAt: '2024-06-04T10:00:00.000Z',
      labels: ['STARRED'],
    })
    const r = searchEmails(db, 'postgres', { label: 'STARRED' })
    expect(r.results.length).toBe(1)
    expect(r.results[0]?.labels).toContain('STARRED')
  })

  it('since filter excludes older messages', () => {
    const r = searchEmails(db, 'postgres', {
      since: '2024-06-02T00:00:00.000Z',
    })
    expect(r.results.length).toBe(1)
    expect(r.results[0]?.subject).toBe('Postgres release notes')
  })

  it('until filter excludes newer messages', () => {
    const r = searchEmails(db, 'postgres', {
      until: '2024-06-01T23:59:59.999Z',
    })
    expect(r.results.length).toBe(1)
    expect(r.results[0]?.subject).toBe('Postgres tips')
  })
})

describe('searchEmails — hidden rows are excluded (defense-in-depth)', () => {
  let db: Database
  let accountId: string
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    accountId = seedEmailAccount(db)
  })
  afterEach(() => db.close())

  it('hidden_at IS NOT NULL rows never appear in FTS5 results', () => {
    seedEmail(db, {
      accountId,
      threadId: 't-1',
      subject: 'Visible Postgres tip',
      sender: 'Alice <alice@example.com>',
      senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(db, {
      accountId,
      threadId: 't-2',
      subject: 'Hidden Postgres tip',
      sender: 'Bob <bob@example.com>',
      senderEmail: 'bob@example.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
      hidden: true,
    })
    const r = searchEmails(db, 'postgres')
    expect(r.results.length).toBe(1)
    expect(r.results[0]?.subject).toBe('Visible Postgres tip')
  })

  it('hidden_at IS NOT NULL rows never appear in fuzzy results', () => {
    seedEmail(db, {
      accountId,
      threadId: 't-1',
      subject: 'Visible Postgres tip',
      sender: 'Alice <alice@example.com>',
      senderEmail: 'alice@example.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(db, {
      accountId,
      threadId: 't-2',
      subject: 'Hidden Postgres tip',
      sender: 'Bob <bob@example.com>',
      senderEmail: 'bob@example.com',
      receivedAt: '2024-06-02T10:00:00.000Z',
      hidden: true,
    })
    const r = searchEmails(db, 'postgers') // typo → fuzzy mode
    expect(r.results.every((x) => x.subject === 'Visible Postgres tip')).toBe(true)
  })
})

describe('searchEmails — performance smoke (AC #10)', () => {
  it('returns within 200ms for 1,000 seeded emails', async () => {
    const db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    const accountId = seedEmailAccount(db)

    for (let i = 0; i < 1000; i++) {
      seedEmail(db, {
        id: `bulk-${i}`,
        accountId,
        threadId: `t-${i % 50}`,
        subject: `Email number ${i} about Postgres`,
        sender: 'Sender <sender@example.com>',
        senderEmail: 'sender@example.com',
        bodyPlain: `Body of email ${i} discussing indexes.`,
        receivedAt: new Date(Date.UTC(2024, 0, 1, 0, i % 60, 0)).toISOString(),
      })
    }

    const start = performance.now()
    const r = searchEmails(db, 'Postgres', { limit: 50 })
    const elapsed = performance.now() - start

    expect(r.results.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(200)
    db.close()
  }, 10_000)

  it('fuzzy fallback completes within 200ms against 1,000 emails', async () => {
    const db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    const accountId = seedEmailAccount(db)

    for (let i = 0; i < 1000; i++) {
      seedEmail(db, {
        id: `bulk-${i}`,
        accountId,
        threadId: `t-${i % 50}`,
        subject: `Email number ${i} about Postgres`,
        sender: 'Sender <sender@example.com>',
        senderEmail: 'sender@example.com',
        receivedAt: new Date(Date.UTC(2024, 0, 1, 0, i % 60, 0)).toISOString(),
      })
    }

    const start = performance.now()
    const r = searchEmails(db, 'postgers', { limit: 50 }) // typo
    const elapsed = performance.now() - start

    expect(r.results.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(200)
    db.close()
  }, 10_000)
})