// email-retriever.test.ts — issue #022
//
// Integration tests for the EmailRetriever deep module. Uses an in-
// memory SQLite DB with the real migration set. Covers:
//
//   - getById returns the full detail shape (subject, body, recipients).
//   - getById returns null for missing id (route maps to 404).
//   - getById returns null for hidden rows (defense-in-depth before
//     #024 wires hide/unhide).
//   - getThread returns messages in chronological order (oldest
//     first), with hidden rows excluded.
//   - getThread returns [] for unknown threadId.
//   - Defensive JSON-array parsing: a corrupted row's to_addrs
//     falls back to [], doesn't crash the route.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { getById, getThread } from './email-retriever.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

/** Insert a bare `email_accounts` row so the FK on `emails.account_id`
 *  is satisfied. The retriever doesn't touch the cipher. */
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
  readonly subject?: string
  readonly sender?: string
  readonly senderEmail?: string
  readonly to?: readonly string[]
  readonly cc?: readonly string[]
  readonly bodyPlain?: string
  readonly receivedAt: string
  readonly labels?: readonly string[]
  readonly isUnread?: boolean
  readonly hidden?: boolean
}

/**
 * Cache of email_accounts ids created lazily by the test fixtures.
 * Each `accountId` literal in the test fixtures ('acc-1', 'acc-2')
 * maps to exactly one row, inserted the first time it's referenced.
 */
const accountCache = new Map<string, string>()

function resolveAccountId(db: Database, accountId: string): string {
  const cached = accountCache.get(accountId)
  if (cached !== undefined) return cached
  const id = seedEmailAccount(db)
  accountCache.set(accountId, id)
  return id
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
      e.subject ?? 'subject',
      e.sender ?? '',
      e.senderEmail ?? '',
      JSON.stringify(e.to ?? []),
      JSON.stringify(e.cc ?? []),
      e.receivedAt,
      '',
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

// ─── Tests ────────────────────────────────────────────────────────────────

describe('getById', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    accountCache.clear()
  })
  afterEach(() => db.close())

  it('returns the full detail shape for a known id', () => {
    const id = seedEmail(db, {
      accountId: 'acc-1',
      threadId: 't-1',
      subject: 'Hello',
      sender: 'Alice <alice@example.com>',
      senderEmail: 'alice@example.com',
      to: ['bob@example.com', 'carol@example.com'],
      cc: ['manager@example.com'],
      bodyPlain: 'Body content here.',
      receivedAt: '2024-06-01T10:00:00.000Z',
      labels: ['INBOX', 'UNREAD'],
      isUnread: true,
    })
    const detail = getById(db, id)
    expect(detail).not.toBeNull()
    expect(detail?.id).toBe(id)
    expect(detail?.threadId).toBe('t-1')
    expect(detail?.accountId).toBe(accountCache.get('acc-1'))
    expect(detail?.subject).toBe('Hello')
    expect(detail?.sender).toBe('Alice <alice@example.com>')
    expect(detail?.senderEmail).toBe('alice@example.com')
    expect(detail?.to).toEqual(['bob@example.com', 'carol@example.com'])
    expect(detail?.cc).toEqual(['manager@example.com'])
    expect(detail?.bodyPlain).toBe('Body content here.')
    expect(detail?.receivedAt).toBe('2024-06-01T10:00:00.000Z')
    expect(detail?.labels).toEqual(['INBOX', 'UNREAD'])
    expect(detail?.isUnread).toBe(true)
  })

  it('returns null for a missing id (route maps to 404)', () => {
    expect(getById(db, 'does-not-exist')).toBeNull()
  })

  it('returns null for an empty string id', () => {
    expect(getById(db, '')).toBeNull()
  })

  it('returns null when the row is hidden (defense-in-depth)', () => {
    const id = seedEmail(db, {
      accountId: 'acc-1',
      threadId: 't-1',
      subject: 'Hidden email',
      senderEmail: 'a@b.com',
      receivedAt: '2024-06-01T10:00:00.000Z',
      hidden: true,
    })
    expect(getById(db, id)).toBeNull()
  })

  it('does not throw on corrupted JSON arrays (defensive parse)', () => {
    // Insert a row with malformed JSON in to_addrs. Use the
    // resolved account id from the cache so the FK is satisfied.
    const realAccountId = resolveAccountId(db, 'acc-1')
    const id = randomUUID()
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
        't-1',
        'subject',
        '',
        '',
        'not-valid-json{',
        'also-broken',
        '2024-06-01T10:00:00.000Z',
        '',
        '',
        0,
        '[]',
        '2024-06-01T10:00:00.000Z',
      ],
    )
    const detail = getById(db, id)
    expect(detail).not.toBeNull()
    expect(detail?.to).toEqual([])
    expect(detail?.cc).toEqual([])
    expect(detail?.labels).toEqual([])
  })
})

describe('getThread', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    accountCache.clear()
  })
  afterEach(() => db.close())

  it('returns messages in chronological order (oldest first)', () => {
    // Seed 3 messages in non-chronological insert order — the
    // returned array must reorder by received_at ASC.
    seedEmail(db, {
      id: 'msg-3',
      accountId: 'acc-1',
      threadId: 't-1',
      subject: 'Reply',
      receivedAt: '2024-06-03T10:00:00.000Z',
    })
    seedEmail(db, {
      id: 'msg-1',
      accountId: 'acc-1',
      threadId: 't-1',
      subject: 'Original',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(db, {
      id: 'msg-2',
      accountId: 'acc-1',
      threadId: 't-1',
      subject: 'First reply',
      receivedAt: '2024-06-02T10:00:00.000Z',
    })
    const thread = getThread(db, 't-1')
    expect(thread.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3'])
  })

  it('returns an empty array for an unknown threadId', () => {
    expect(getThread(db, 'no-such-thread')).toEqual([])
  })

  it('returns an empty array for an empty threadId', () => {
    expect(getThread(db, '')).toEqual([])
  })

  it('excludes hidden messages from the thread (defense-in-depth)', () => {
    seedEmail(db, {
      id: 'msg-1',
      accountId: 'acc-1',
      threadId: 't-1',
      subject: 'Original',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(db, {
      id: 'msg-2',
      accountId: 'acc-1',
      threadId: 't-1',
      subject: 'First reply (hidden)',
      receivedAt: '2024-06-02T10:00:00.000Z',
      hidden: true,
    })
    seedEmail(db, {
      id: 'msg-3',
      accountId: 'acc-1',
      threadId: 't-1',
      subject: 'Second reply',
      receivedAt: '2024-06-03T10:00:00.000Z',
    })
    const thread = getThread(db, 't-1')
    expect(thread.map((m) => m.id)).toEqual(['msg-1', 'msg-3'])
  })

  it('does not include messages from other threads', () => {
    seedEmail(db, {
      id: 'msg-1',
      accountId: 'acc-1',
      threadId: 't-1',
      subject: 'Thread 1',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(db, {
      id: 'msg-2',
      accountId: 'acc-1',
      threadId: 't-2',
      subject: 'Thread 2',
      receivedAt: '2024-06-01T11:00:00.000Z',
    })
    expect(getThread(db, 't-1').map((m) => m.id)).toEqual(['msg-1'])
  })

  it('breaks received_at ties with id ASC for stable order', () => {
    // Two messages with identical received_at — id is the tiebreaker.
    seedEmail(db, {
      id: 'msg-2',
      accountId: 'acc-1',
      threadId: 't-1',
      subject: 'Later id, same time',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    seedEmail(db, {
      id: 'msg-1',
      accountId: 'acc-1',
      threadId: 't-1',
      subject: 'Earlier id, same time',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const thread = getThread(db, 't-1')
    expect(thread.map((m) => m.id)).toEqual(['msg-1', 'msg-2'])
  })

  it('returns the full detail shape (body, recipients, etc.)', () => {
    seedEmail(db, {
      id: 'msg-1',
      accountId: 'acc-1',
      threadId: 't-1',
      subject: 'Original',
      sender: 'Alice <alice@example.com>',
      senderEmail: 'alice@example.com',
      to: ['bob@example.com'],
      bodyPlain: 'Body content.',
      receivedAt: '2024-06-01T10:00:00.000Z',
      labels: ['INBOX'],
    })
    const thread = getThread(db, 't-1')
    expect(thread).toHaveLength(1)
    expect(thread[0]?.bodyPlain).toBe('Body content.')
    expect(thread[0]?.to).toEqual(['bob@example.com'])
    expect(thread[0]?.labels).toEqual(['INBOX'])
  })
})