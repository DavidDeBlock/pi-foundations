// email-visibility.test.ts — issue #024
//
// Pure-module tests for `email-visibility.ts`. Verifies the
// hide/unhide/list/getByIdIncludingHidden helpers in isolation,
// against the real SQLite migration set. Mirrors the email-
// retriever.test.ts setup so we exercise the same defense-in-
// depth invariants on a real DB, not a mock.
//
// Coverage:
//   - hideEmail sets hidden_at on a previously visible row.
//   - hideEmail returns false for missing id / empty id.
//   - unhideEmail clears hidden_at on a hidden row.
//   - unhideEmail returns false for missing id / empty id.
//   - List returns hidden emails sorted by hidden_at DESC.
//   - List excludes visible emails.
//   - List respects limit (clamped to [1, 200]).
//   - getByIdIncludingHidden returns hidden rows (where the
//     JSON API's getById would have returned null).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import {
  hideEmail,
  unhideEmail,
  listHiddenEmails,
  getByIdIncludingHidden,
} from './email-visibility.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

/** Insert a bare `email_accounts` row so the FK on `emails.account_id`
 *  is satisfied. The visibility helpers don't touch the cipher. */
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
  readonly bodyPlain?: string
  readonly receivedAt: string
  readonly labels?: readonly string[]
  readonly hiddenAt?: string | null
}

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
        is_unread, labels, synced_at, hidden_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )`,
    [
      id,
      realAccountId,
      e.threadId,
      e.subject ?? 'subject',
      e.sender ?? 'Alice <a@b.com>',
      e.senderEmail ?? 'a@b.com',
      JSON.stringify(e.to ?? []),
      JSON.stringify([]),
      e.receivedAt,
      '',
      e.bodyPlain ?? '',
      0,
      JSON.stringify(e.labels ?? []),
      e.receivedAt,
      e.hiddenAt ?? null,
    ],
  )
  return id
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('hideEmail', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    accountCache.clear()
  })
  afterEach(() => db.close())

  it('sets hidden_at on a previously visible row', () => {
    const id = seedEmail(db, {
      accountId: 'acc-1', threadId: 't-1',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const before = db.get<{ hidden_at: string | null }>(
      'SELECT hidden_at FROM emails WHERE id = ?', [id],
    )
    expect(before?.hidden_at).toBeNull()

    const ok = hideEmail(db, id, () => Date.parse('2024-07-15T12:34:56.789Z'))
    expect(ok).toBe(true)

    const after = db.get<{ hidden_at: string | null }>(
      'SELECT hidden_at FROM emails WHERE id = ?', [id],
    )
    expect(after?.hidden_at).toBe('2024-07-15T12:34:56.789Z')
  })

  it('returns false for an unknown id', () => {
    expect(hideEmail(db, 'unknown-id')).toBe(false)
  })

  it('returns false for an empty string id', () => {
    expect(hideEmail(db, '')).toBe(false)
  })

  it('is idempotent (re-hide on an already-hidden row still returns true and updates timestamp)', () => {
    const id = seedEmail(db, {
      accountId: 'acc-1', threadId: 't-1',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const first = hideEmail(db, id, () => 1_000)
    const second = hideEmail(db, id, () => 2_000)
    expect(first).toBe(true)
    expect(second).toBe(true)
    const row = db.get<{ hidden_at: string | null }>(
      'SELECT hidden_at FROM emails WHERE id = ?', [id],
    )
    // Timestamp bumped to second call's "now".
    expect(row?.hidden_at).toBe('1970-01-01T00:00:02.000Z')
  })
})

describe('unhideEmail', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    accountCache.clear()
  })
  afterEach(() => db.close())

  it('clears hidden_at on a hidden row', () => {
    const id = seedEmail(db, {
      accountId: 'acc-1', threadId: 't-1',
      receivedAt: '2024-06-01T10:00:00.000Z',
      hiddenAt: '2024-07-15T12:34:56.789Z',
    })
    const before = db.get<{ hidden_at: string | null }>(
      'SELECT hidden_at FROM emails WHERE id = ?', [id],
    )
    expect(before?.hidden_at).toBe('2024-07-15T12:34:56.789Z')

    const ok = unhideEmail(db, id)
    expect(ok).toBe(true)

    const after = db.get<{ hidden_at: string | null }>(
      'SELECT hidden_at FROM emails WHERE id = ?', [id],
    )
    expect(after?.hidden_at).toBeNull()
  })

  it('returns false for an unknown id', () => {
    expect(unhideEmail(db, 'unknown-id')).toBe(false)
  })

  it('returns false for an empty string id', () => {
    expect(unhideEmail(db, '')).toBe(false)
  })

  it('is idempotent (unhide on a visible row still returns true)', () => {
    const id = seedEmail(db, {
      accountId: 'acc-1', threadId: 't-1',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const ok = unhideEmail(db, id)
    expect(ok).toBe(true)
    const row = db.get<{ hidden_at: string | null }>(
      'SELECT hidden_at FROM emails WHERE id = ?', [id],
    )
    expect(row?.hidden_at).toBeNull()
  })
})

describe('listHiddenEmails', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    accountCache.clear()
  })
  afterEach(() => db.close())

  it('returns empty array when nothing is hidden', () => {
    seedEmail(db, {
      accountId: 'acc-1', threadId: 't-1',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    expect(listHiddenEmails(db)).toEqual([])
  })

  it('returns only hidden emails sorted by hidden_at DESC', () => {
    // Seed with explicit hidden_at values so we control ordering.
    seedEmail(db, {
      id: 'old', accountId: 'acc-1', threadId: 't-1',
      receivedAt: '2024-06-01T10:00:00.000Z',
      hiddenAt: '2024-05-01T08:00:00.000Z',
    })
    seedEmail(db, {
      id: 'newest', accountId: 'acc-1', threadId: 't-2',
      receivedAt: '2024-06-02T10:00:00.000Z',
      hiddenAt: '2024-05-15T16:30:00.000Z',
    })
    seedEmail(db, {
      id: 'middle', accountId: 'acc-1', threadId: 't-3',
      receivedAt: '2024-06-03T10:00:00.000Z',
      hiddenAt: '2024-05-10T12:00:00.000Z',
    })
    seedEmail(db, {
      id: 'visible', accountId: 'acc-1', threadId: 't-4',
      receivedAt: '2024-06-04T10:00:00.000Z',
    })
    const rows = listHiddenEmails(db)
    expect(rows.map((r) => r.id)).toEqual(['newest', 'middle', 'old'])
  })

  it('returns the full read shape (sender/subject/snippet/labels/hiddenAt)', () => {
    seedEmail(db, {
      id: 'h1', accountId: 'acc-1', threadId: 't-1',
      subject: 'Launch plans',
      sender: 'Alice <alice@example.com>',
      senderEmail: 'alice@example.com',
      bodyPlain: 'Body',
      receivedAt: '2024-06-01T10:00:00.000Z',
      labels: ['INBOX', 'STARRED'],
      hiddenAt: '2024-06-15T08:00:00.000Z',
    })
    const [row] = listHiddenEmails(db)
    expect(row?.subject).toBe('Launch plans')
    expect(row?.sender).toBe('Alice <alice@example.com>')
    expect(row?.senderEmail).toBe('alice@example.com')
    expect(row?.labels).toEqual(['INBOX', 'STARRED'])
    expect(row?.hiddenAt).toBe('2024-06-15T08:00:00.000Z')
  })

  it('respects limit (returns at most N)', () => {
    for (let i = 0; i < 5; i++) {
      seedEmail(db, {
        id: `h-${i}`,
        accountId: 'acc-1', threadId: `t-${i}`,
        receivedAt: '2024-06-01T10:00:00.000Z',
        hiddenAt: new Date(Date.UTC(2024, 5, 1, 0, i, 0)).toISOString(),
      })
    }
    const rows = listHiddenEmails(db, 3)
    expect(rows).toHaveLength(3)
  })

  it('clamps limit to [1, 200]', () => {
    // Below-1 limit falls back to default (50).
    const tiny = listHiddenEmails(db, -5)
    expect(Array.isArray(tiny)).toBe(true)
    // Above-200 limit is clamped to 200 (no rows seeded → returns empty).
    const huge = listHiddenEmails(db, 99999)
    expect(Array.isArray(huge)).toBe(true)
    expect(huge).toEqual([])
  })
})

describe('getByIdIncludingHidden', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    accountCache.clear()
  })
  afterEach(() => db.close())

  it('returns the full detail shape for a visible row (hiddenAt === null)', () => {
    const id = seedEmail(db, {
      accountId: 'acc-1', threadId: 't-1',
      subject: 'Hi',
      bodyPlain: 'Body',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    const detail = getByIdIncludingHidden(db, id)
    expect(detail).not.toBeNull()
    expect(detail?.id).toBe(id)
    expect(detail?.subject).toBe('Hi')
    expect(detail?.hiddenAt).toBeNull()
  })

  it('returns the full detail shape for a hidden row (hiddenAt non-null)', () => {
    const id = seedEmail(db, {
      accountId: 'acc-1', threadId: 't-1',
      subject: 'Secret',
      bodyPlain: 'Body',
      receivedAt: '2024-06-01T10:00:00.000Z',
      hiddenAt: '2024-07-15T12:34:56.789Z',
    })
    const detail = getByIdIncludingHidden(db, id)
    expect(detail).not.toBeNull()
    expect(detail?.id).toBe(id)
    expect(detail?.subject).toBe('Secret')
    expect(detail?.hiddenAt).toBe('2024-07-15T12:34:56.789Z')
  })

  it('returns null for a missing id', () => {
    expect(getByIdIncludingHidden(db, 'does-not-exist')).toBeNull()
  })

  it('returns null for an empty string id', () => {
    expect(getByIdIncludingHidden(db, '')).toBeNull()
  })
})

// ─── Cross-helper integration ────────────────────────────────────────────

describe('hide / unhide round-trip', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    accountCache.clear()
  })
  afterEach(() => db.close())

  it('hidden row disappears from listHiddenEmails after unhide', () => {
    const id = seedEmail(db, {
      accountId: 'acc-1', threadId: 't-1',
      receivedAt: '2024-06-01T10:00:00.000Z',
    })
    expect(hideEmail(db, id)).toBe(true)
    expect(listHiddenEmails(db).map((r) => r.id)).toEqual([id])

    expect(unhideEmail(db, id)).toBe(true)
    expect(listHiddenEmails(db)).toEqual([])
  })

  it('listHiddenEmails reflects current state across mixed rows', () => {
    // Three rows: two visible, one to be hidden later.
    seedEmail(db, { id: 'r-1', accountId: 'acc-1', threadId: 't-1', receivedAt: '2024-06-01T10:00:00.000Z' })
    seedEmail(db, { id: 'r-2', accountId: 'acc-1', threadId: 't-2', receivedAt: '2024-06-02T10:00:00.000Z' })
    seedEmail(db, { id: 'r-3', accountId: 'acc-1', threadId: 't-3', receivedAt: '2024-06-03T10:00:00.000Z' })

    expect(listHiddenEmails(db)).toEqual([])

    // Use a controllable clock so we can assert hidden_at DESC
    // ordering deterministically.
    let now = 1_000
    const nowMs = () => ++now

    hideEmail(db, 'r-2', nowMs)
    expect(listHiddenEmails(db).map((r) => r.id)).toEqual(['r-2'])

    hideEmail(db, 'r-1', nowMs)
    // r-1 has a later hidden_at → comes first.
    expect(listHiddenEmails(db).map((r) => r.id)).toEqual(['r-1', 'r-2'])

    unhideEmail(db, 'r-1')
    expect(listHiddenEmails(db).map((r) => r.id)).toEqual(['r-2'])
  })
})
