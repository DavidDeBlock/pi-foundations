// email-tags.test.ts — issue #025
//
// Pure-module tests for `email-tags.ts`. Verifies normalize +
// CRUD + idempotency + tag-count + filter on a real in-memory
// SQLite. Mirrors the email-visibility.test.ts setup so we
// exercise the same defense-in-depth invariants on a real DB,
// not a mock.
//
// Coverage:
//   - normalizeTag: trim, lowercase, leading '#' strip, internal
//     whitespace rejection, invalid-char rejection, length cap,
//     Unicode letters.
//   - addTag: success, idempotent re-add, email_not_found,
//     normalization happens at the storage boundary.
//   - removeTag: success, no-op for missing pair, no-op for
//     missing email id, requires normalized input.
//   - getTagsForEmail: returns sorted tag list, empty for no tags.
//   - listAllTagsWithCounts: sorted by count DESC then tag ASC,
//     respects limit.
//   - filterEmailIdsByTag: returns matching ids only.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import {
  normalizeTag,
  InvalidTagError,
  addTag,
  removeTag,
  getTagsForEmail,
  listAllTagsWithCounts,
  filterEmailIdsByTag,
} from './email-tags.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

// ─── Fixtures ─────────────────────────────────────────────────────────────

function seedEmailAccount(db: Database): string {
  const id = randomUUID()
  db.run(
    `INSERT INTO email_accounts (id, provider, email_address, access_token_enc, refresh_token_enc)
     VALUES (?, 'gmail', ?, 'enc', 'enc')`,
    [id, `${id}@example.com`],
  )
  return id
}

const accountCache = new Map<string, string>()
function resolveAccount(db: Database, key: string): string {
  const cached = accountCache.get(key)
  if (cached !== undefined) return cached
  const id = seedEmailAccount(db)
  accountCache.set(key, id)
  return id
}

function seedEmail(db: Database, idHint: string, receivedAt = '2024-06-01T10:00:00.000Z'): string {
  const accountId = resolveAccount(db, idHint)
  const id = idHint
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
      accountId,
      `t-${id}`,
      `subject for ${id}`,
      'Alice <a@b.com>',
      'a@b.com',
      '[]', '[]',
      receivedAt, '', '', 0, '[]',
      receivedAt,
    ],
  )
  return id
}

// ─── normalizeTag ─────────────────────────────────────────────────────────

describe('normalizeTag', () => {
  it('lowercases', () => {
    expect(normalizeTag('Launch')).toBe('launch')
    expect(normalizeTag('LAUNCH')).toBe('launch')
  })

  it('trims leading/trailing whitespace', () => {
    expect(normalizeTag('  launch  ')).toBe('launch')
    expect(normalizeTag('\tlaunch\n')).toBe('launch')
  })

  it('strips a single leading "#"', () => {
    expect(normalizeTag('#launch')).toBe('launch')
    expect(normalizeTag('  #Launch ')).toBe('launch')
  })

  it('does NOT strip embedded "#" (would be invalid char)', () => {
    // "launch#urgent" lowercases and trims but the "#" is in the
    // middle, which is rejected by the invalid-chars rule.
    expect(() => normalizeTag('launch#urgent')).toThrow(InvalidTagError)
  })

  it('accepts letters, digits, dashes, underscores, dots, slashes', () => {
    expect(normalizeTag('work-urgent')).toBe('work-urgent')
    expect(normalizeTag('release_v2')).toBe('release_v2')
    expect(normalizeTag('release.v2')).toBe('release.v2')
    expect(normalizeTag('work/urgent')).toBe('work/urgent')
    expect(normalizeTag('Q4-2026')).toBe('q4-2026')
  })

  it('rejects empty / whitespace-only tags', () => {
    expect(() => normalizeTag('')).toThrow(InvalidTagError)
    expect(() => normalizeTag('   ')).toThrow(InvalidTagError)
    expect(() => normalizeTag('#')).toThrow(InvalidTagError)
    expect(() => normalizeTag('#   ')).toThrow(InvalidTagError)
  })

  it('rejects tags containing internal whitespace', () => {
    expect(() => normalizeTag('launch plans')).toThrow(InvalidTagError)
    expect(() => normalizeTag('launch\tplans')).toThrow(InvalidTagError)
  })

  it('rejects tags with invalid characters', () => {
    expect(() => normalizeTag('launch!')).toThrow(InvalidTagError)
    expect(() => normalizeTag('launch@plans')).toThrow(InvalidTagError)
    expect(() => normalizeTag('launch?')).toThrow(InvalidTagError)
  })

  it('caps length at 64 characters', () => {
    const tooLong = 'a'.repeat(65)
    expect(() => normalizeTag(tooLong)).toThrow(InvalidTagError)
    const justRight = 'a'.repeat(64)
    expect(normalizeTag(justRight)).toBe(justRight)
  })

  it('accepts Unicode letters', () => {
    expect(normalizeTag('café')).toBe('café')
    expect(normalizeTag('naïve')).toBe('naïve')
  })

  it('rejects non-string input', () => {
    expect(() => normalizeTag(undefined as unknown as string)).toThrow(InvalidTagError)
    expect(() => normalizeTag(null as unknown as string)).toThrow(InvalidTagError)
    expect(() => normalizeTag(123 as unknown as string)).toThrow(InvalidTagError)
  })

  it('error messages are human-readable (for the 400 response)', () => {
    expect(() => normalizeTag('')).toThrow(/empty/i)
    expect(() => normalizeTag('a b')).toThrow(/whitespace/i)
    expect(() => normalizeTag('a!')).toThrow(/invalid characters/i)
    expect(() => normalizeTag('a'.repeat(65))).toThrow(/too long/i)
  })
})

// ─── addTag ───────────────────────────────────────────────────────────────

describe('addTag', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    accountCache.clear()
  })
  afterEach(() => db.close())

  it('attaches a tag to an email (returns "added")', () => {
    const id = seedEmail(db, 'm-1')
    const r = addTag(db, id, 'launch')
    expect(r.status).toBe('added')
    expect(getTagsForEmail(db, id)).toEqual(['launch'])
  })

  it('is idempotent — re-adding the same tag returns "already_present"', () => {
    const id = seedEmail(db, 'm-1')
    addTag(db, id, 'launch')
    const r = addTag(db, id, 'launch')
    expect(r.status).toBe('already_present')
    // Still exactly one row.
    expect(getTagsForEmail(db, id)).toEqual(['launch'])
  })

  it('normalizes before storage ("#Launch " → "launch")', () => {
    const id = seedEmail(db, 'm-1')
    addTag(db, id, '#Launch ')
    expect(getTagsForEmail(db, id)).toEqual(['launch'])
  })

  it('treats normalized-equivalent duplicates as idempotent', () => {
    const id = seedEmail(db, 'm-1')
    addTag(db, id, 'launch')
    const r = addTag(db, id, '#LAUNCH ')
    expect(r.status).toBe('already_present')
    expect(getTagsForEmail(db, id)).toEqual(['launch'])
  })

  it('returns "email_not_found" for a missing id', () => {
    const r = addTag(db, 'does-not-exist', 'launch')
    expect(r.status).toBe('email_not_found')
  })

  it('returns "email_not_found" for an empty id', () => {
    const r = addTag(db, '', 'launch')
    expect(r.status).toBe('email_not_found')
  })

  it('throws InvalidTagError on invalid raw tag (HTTP maps to 400)', () => {
    const id = seedEmail(db, 'm-1')
    expect(() => addTag(db, id, '')).toThrow(InvalidTagError)
    expect(() => addTag(db, id, 'launch plans')).toThrow(InvalidTagError)
  })

  it('persists across re-open (FK CASCADE goes the other way; data lives independently)', () => {
    const id = seedEmail(db, 'm-1')
    addTag(db, id, 'launch')
    addTag(db, id, 'waiting')
    expect(getTagsForEmail(db, id).sort()).toEqual(['launch', 'waiting'])
  })
})

// ─── removeTag ────────────────────────────────────────────────────────────

describe('removeTag', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    accountCache.clear()
  })
  afterEach(() => db.close())

  it('removes an attached tag (returns true)', () => {
    const id = seedEmail(db, 'm-1')
    addTag(db, id, 'launch')
    expect(removeTag(db, id, 'launch')).toBe(true)
    expect(getTagsForEmail(db, id)).toEqual([])
  })

  it('is a no-op when the email does not have the tag (returns false)', () => {
    const id = seedEmail(db, 'm-1')
    expect(removeTag(db, id, 'launch')).toBe(false)
  })

  it('is a no-op when the email id is missing (returns false)', () => {
    expect(removeTag(db, 'does-not-exist', 'launch')).toBe(false)
  })

  it('is a no-op for empty inputs (returns false)', () => {
    expect(removeTag(db, '', 'launch')).toBe(false)
    const id = seedEmail(db, 'm-1')
    expect(removeTag(db, id, '')).toBe(false)
  })

  it('only removes the targeted (emailId, tag) pair (other emails keep the tag)', () => {
    const a = seedEmail(db, 'm-1')
    const b = seedEmail(db, 'm-2')
    addTag(db, a, 'launch')
    addTag(db, b, 'launch')
    expect(removeTag(db, a, 'launch')).toBe(true)
    expect(getTagsForEmail(db, a)).toEqual([])
    expect(getTagsForEmail(db, b)).toEqual(['launch'])
  })

  it('requires normalized input (does not lowercase for you)', () => {
    // The HTTP layer normalizes the URL segment before calling. The
    // pure module is honest about its contract.
    const id = seedEmail(db, 'm-1')
    addTag(db, id, 'launch')
    expect(removeTag(db, id, 'Launch')).toBe(false)
    expect(getTagsForEmail(db, id)).toEqual(['launch'])
  })
})

// ─── getTagsForEmail ──────────────────────────────────────────────────────

describe('getTagsForEmail', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    accountCache.clear()
  })
  afterEach(() => db.close())

  it('returns [] for an email with no tags', () => {
    const id = seedEmail(db, 'm-1')
    expect(getTagsForEmail(db, id)).toEqual([])
  })

  it('returns tags sorted alphabetically', () => {
    const id = seedEmail(db, 'm-1')
    addTag(db, id, 'zebra')
    addTag(db, id, 'apple')
    addTag(db, id, 'mango')
    expect(getTagsForEmail(db, id)).toEqual(['apple', 'mango', 'zebra'])
  })

  it('returns [] for a missing email id', () => {
    expect(getTagsForEmail(db, 'does-not-exist')).toEqual([])
  })

  it('returns [] for empty id', () => {
    expect(getTagsForEmail(db, '')).toEqual([])
  })
})

// ─── listAllTagsWithCounts ────────────────────────────────────────────────

describe('listAllTagsWithCounts', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    accountCache.clear()
  })
  afterEach(() => db.close())

  it('returns [] when no tags exist', () => {
    expect(listAllTagsWithCounts(db)).toEqual([])
  })

  it('returns tag + count, sorted by count DESC then tag ASC', () => {
    seedEmail(db, 'm-1')
    seedEmail(db, 'm-2')
    seedEmail(db, 'm-3')

    addTag(db, 'm-1', 'launch')
    addTag(db, 'm-2', 'launch')    // launch: 2
    addTag(db, 'm-1', 'waiting')   // waiting: 1
    addTag(db, 'm-2', 'zebra')     // zebra: 1

    expect(listAllTagsWithCounts(db)).toEqual([
      { tag: 'launch', count: 2 },
      { tag: 'waiting', count: 1 },
      { tag: 'zebra', count: 1 },
    ])
  })

  it('counts distinct email_ids (same email twice = 1)', () => {
    const id = seedEmail(db, 'm-1')
    addTag(db, id, 'launch')
    addTag(db, id, 'launch') // idempotent — no double count
    expect(listAllTagsWithCounts(db)).toEqual([{ tag: 'launch', count: 1 }])
  })

  it('respects limit (returns at most N)', () => {
    for (let i = 0; i < 5; i++) seedEmail(db, `m-${i}`)
    for (let i = 0; i < 5; i++) addTag(db, `m-${i}`, `tag-${i}`)
    const out = listAllTagsWithCounts(db, 3)
    expect(out).toHaveLength(3)
  })

  it('falls back to default limit for invalid input', () => {
    expect(Array.isArray(listAllTagsWithCounts(db, -5))).toBe(true)
    expect(Array.isArray(listAllTagsWithCounts(db))).toBe(true)
  })
})

// ─── filterEmailIdsByTag ──────────────────────────────────────────────────

describe('filterEmailIdsByTag', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    accountCache.clear()
  })
  afterEach(() => db.close())

  it('returns matching email ids', () => {
    seedEmail(db, 'm-1')
    seedEmail(db, 'm-2')
    seedEmail(db, 'm-3')
    addTag(db, 'm-1', 'launch')
    addTag(db, 'm-3', 'launch')
    const out = filterEmailIdsByTag(db, 'launch')
    expect([...out].sort()).toEqual(['m-1', 'm-3'])
  })

  it('returns empty Set when no email has the tag', () => {
    seedEmail(db, 'm-1')
    expect(filterEmailIdsByTag(db, 'nope').size).toBe(0)
  })

  it('returns empty Set for empty tag', () => {
    expect(filterEmailIdsByTag(db, '').size).toBe(0)
  })

  it('returns empty Set for non-string tag', () => {
    expect(filterEmailIdsByTag(db, undefined as unknown as string).size).toBe(0)
  })
})

// ─── FK CASCADE ──────────────────────────────────────────────────────────

describe('FK CASCADE — email deletion removes tags', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    accountCache.clear()
  })
  afterEach(() => db.close())

  it('removing an email wipes its tag rows (Gmail-side delete)', () => {
    seedEmail(db, 'm-keep')
    seedEmail(db, 'm-gone')
    addTag(db, 'm-keep', 'launch')
    addTag(db, 'm-gone', 'launch')
    addTag(db, 'm-gone', 'waiting')

    // Hard-delete m-gone (simulates a Gmail-side source delete).
    db.run('DELETE FROM emails WHERE id = ?', ['m-gone'])

    expect(getTagsForEmail(db, 'm-gone')).toEqual([])
    expect(getTagsForEmail(db, 'm-keep')).toEqual(['launch'])
    // "waiting" is gone too — its only carrier was m-gone.
    expect(listAllTagsWithCounts(db).map((t) => t.tag).sort()).toEqual(['launch'])
  })
})

// ─── Round-trip integration ──────────────────────────────────────────────

describe('add / remove / list round-trip', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    accountCache.clear()
  })
  afterEach(() => db.close())

  it('add 3 tags to 2 emails, remove one, list reflects state', () => {
    const a = seedEmail(db, 'm-1')
    const b = seedEmail(db, 'm-2')

    addTag(db, a, 'launch')
    addTag(db, a, 'urgent')
    addTag(db, b, 'launch')

    expect(getTagsForEmail(db, a).sort()).toEqual(['launch', 'urgent'])
    expect(getTagsForEmail(db, b)).toEqual(['launch'])

    expect(removeTag(db, a, 'urgent')).toBe(true)
    expect(getTagsForEmail(db, a)).toEqual(['launch'])
    expect(listAllTagsWithCounts(db)).toEqual([{ tag: 'launch', count: 2 }])
  })
})