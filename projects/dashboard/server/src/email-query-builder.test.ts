// email-query-builder.test.ts — issue #022
//
// Unit tests for the pure SQL builder. Mirrors search-query-builder.test.ts:
// no DB needed, we assert on the `sql` and `params` shapes that the
// builder returns. Covers:
//
//   - Filter composition (from, to, subjectContains, label, unread,
//     since, until) and the always-present `hidden_at IS NULL`.
//   - Limit clamping (clampEmailLimit).
//   - Keyset cursor encoding/decoding roundtrip.
//   - SQL injection attempts: user input never appears as literal
//     SQL fragments; only the column whitelist and known operators
//     are interpolated.

import { describe, expect, it } from 'vitest'
import {
  buildListQuery,
  buildDetailQuery,
  buildThreadQuery,
  clampEmailLimit,
  encodeCursor,
  decodeCursor,
} from './email-query-builder.js'

describe('buildListQuery', () => {
  it('always emits hidden_at IS NULL as defense-in-depth', () => {
    const q = buildListQuery({})
    expect(q.sql).toContain('hidden_at IS NULL')
  })

  it('always appends the limit as a bound param', () => {
    const q = buildListQuery({})
    expect(q.sql).toContain('LIMIT ?')
    expect(q.params.at(-1)).toBe(50)
  })

  it('omits filters when undefined or empty string', () => {
    const q = buildListQuery({
      from: '',
      to: undefined,
      subjectContains: '',
      label: '',
      unread: undefined,
      since: '',
      until: '',
    })
    expect(q.sql).not.toContain('LOWER(sender_email) = LOWER(?)')
    expect(q.sql).not.toContain('LOWER(subject) LIKE ?')
    expect(q.sql).not.toContain('is_unread = 1')
    expect(q.sql).not.toContain('is_unread = 0')
    expect(q.sql).not.toContain('received_at >= ?')
    expect(q.sql).not.toContain('received_at <= ?')
  })

  it('from filter is parameterized and case-insensitive', () => {
    const q = buildListQuery({ from: 'sarah@example.com' })
    expect(q.sql).toContain('LOWER(sender_email) = LOWER(?)')
    expect(q.params).toContain('sarah@example.com')
  })

  it('to filter uses json_each + LIKE on the JSON array', () => {
    const q = buildListQuery({ to: 'sarah' })
    expect(q.sql).toContain('json_each(emails.to_addrs)')
    expect(q.sql).toContain("LIKE '%' || LOWER(?) || '%'")
    expect(q.params).toContain('sarah')
  })

  it('subjectContains is lowercased and wrapped in %', () => {
    const q = buildListQuery({ subjectContains: 'Launch' })
    expect(q.sql).toContain('LOWER(subject) LIKE ?')
    expect(q.params).toContain('%launch%')
  })

  it('label filter uses json_each EXISTS on the labels array', () => {
    const q = buildListQuery({ label: 'INBOX' })
    expect(q.sql).toContain('json_each(emails.labels)')
    expect(q.sql).toContain('je.value = ?')
    expect(q.params).toContain('INBOX')
  })

  it('unread=true adds is_unread = 1', () => {
    const q = buildListQuery({ unread: true })
    expect(q.sql).toContain('is_unread = 1')
  })

  it('unread=false adds is_unread = 0', () => {
    const q = buildListQuery({ unread: false })
    expect(q.sql).toContain('is_unread = 0')
  })

  it('since/until bound the received_at column inclusively', () => {
    const q = buildListQuery({
      since: '2024-01-01T00:00:00.000Z',
      until: '2024-12-31T23:59:59.999Z',
    })
    expect(q.sql).toContain('received_at >= ?')
    expect(q.sql).toContain('received_at <= ?')
    expect(q.params).toContain('2024-01-01T00:00:00.000Z')
    expect(q.params).toContain('2024-12-31T23:59:59.999Z')
  })

  it('combines all filters via AND', () => {
    const q = buildListQuery({
      from: 'sarah@example.com',
      to: 'team',
      subjectContains: 'Launch',
      label: 'INBOX',
      unread: true,
      since: '2024-01-01T00:00:00.000Z',
      until: '2024-12-31T23:59:59.999Z',
    })
    // The fragment between WHERE and the cursor is a list of AND-joined clauses.
    expect(q.sql).toContain(' AND ')
    expect(q.params.length).toBeGreaterThanOrEqual(7)
  })

  it('orders by received_at DESC, id DESC for stable pagination', () => {
    const q = buildListQuery({})
    expect(q.sql).toContain('ORDER BY received_at DESC, id DESC')
  })

  it('does not interpolate user input into SQL (SQL injection rejected)', () => {
    const evil = "'; DROP TABLE emails; --"
    const q = buildListQuery({ subjectContains: evil })
    // The literal must never appear in the SQL string.
    expect(q.sql).not.toContain('DROP TABLE')
    expect(q.sql).not.toContain(evil)
    // The value (lowercased) lands in params, not in SQL.
    expect(q.params).toContain(`%${evil.toLowerCase()}%`)
  })

  it('SQL injection via from is also rejected (parameterized only)', () => {
    const evil = "' OR 1=1 --"
    const q = buildListQuery({ from: evil })
    expect(q.sql).not.toContain('OR 1=1')
    expect(q.sql).not.toContain(evil)
    expect(q.params).toContain(evil)
  })

  it('SQL injection via cursor is rejected (decoded to null, no clause added)', () => {
    // Malformed cursor is silently treated as "no cursor" — the
    // decoded payload fails the regex check and the WHERE clause
    // is omitted entirely.
    const evil = "'; DROP TABLE emails; --"
    const q = buildListQuery({ cursor: evil })
    expect(q.sql).not.toContain('DROP TABLE')
    // Only the limit placeholder should be in params.
    expect(q.params).toEqual([50])
  })

  it('tag filter is reserved for #025 and is silently ignored today', () => {
    // The tag filter is in the type so callers can wire the route
    // param now, but the email_tags table doesn't exist yet (#025).
    // No WHERE clause is emitted; the value is not even pushed to
    // params. The route returns the same rows whether or not `tag`
    // is supplied.
    const q = buildListQuery({ tag: 'launch' })
    expect(q.sql).not.toContain('email_tags')
    expect(q.sql).not.toContain('launch')
    expect(q.params).not.toContain('launch')
  })
})

describe('keyset cursor', () => {
  it('encodes receivedAt + id to opaque base64', () => {
    const cursor = encodeCursor({
      receivedAt: '2024-06-01T12:00:00.000Z',
      id: 'msg-123',
    })
    expect(typeof cursor).toBe('string')
    // Base64url only — no '+', '/', or padding.
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('decodes back to the same (receivedAt, id)', () => {
    const original = {
      receivedAt: '2024-06-01T12:00:00.000Z',
      id: 'msg-abc',
    }
    const decoded = decodeCursor(encodeCursor(original))
    expect(decoded).toEqual(original)
  })

  it('returns null for malformed input (any garbage → no cursor)', () => {
    expect(decodeCursor('')).toBeNull()
    expect(decodeCursor('not-base64!!!')).toBeNull()
    expect(decodeCursor(Buffer.from('no-pipe-separator').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('|just-id').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('just-receivedAt|').toString('base64url'))).toBeNull()
  })

  it('returns null when receivedAt is not a valid ISO timestamp', () => {
    const bad = Buffer.from('garbage|msg-1').toString('base64url')
    expect(decodeCursor(bad)).toBeNull()
  })

  it('buildListQuery emits a keyset WHERE clause when cursor is valid', () => {
    const cursor = encodeCursor({
      receivedAt: '2024-06-01T12:00:00.000Z',
      id: 'msg-1',
    })
    const q = buildListQuery({ cursor })
    expect(q.sql).toContain('(received_at < ? OR (received_at = ? AND id < ?))')
    // The decoded payload is bound as three params (receivedAt appears twice).
    expect(q.params.slice(0, 3)).toEqual([
      '2024-06-01T12:00:00.000Z',
      '2024-06-01T12:00:00.000Z',
      'msg-1',
    ])
  })

  it('buildListQuery omits the cursor clause when decode returns null', () => {
    const q = buildListQuery({ cursor: '!!!not-valid!!!' })
    expect(q.sql).not.toContain('received_at < ?')
    expect(q.params).toEqual([50])
  })
})

describe('buildThreadQuery', () => {
  it('filters hidden_at IS NULL and orders chronologically', () => {
    const q = buildThreadQuery('thread-1')
    expect(q.sql).toContain('hidden_at IS NULL')
    expect(q.sql).toContain('thread_id = ?')
    expect(q.sql).toContain('ORDER BY received_at ASC, id ASC')
    expect(q.params).toEqual(['thread-1'])
  })

  it('does not interpolate the threadId into the SQL string', () => {
    const evil = "'; DROP TABLE emails; --"
    const q = buildThreadQuery(evil)
    expect(q.sql).not.toContain('DROP TABLE')
    expect(q.sql).not.toContain(evil)
    expect(q.params).toEqual([evil])
  })
})

describe('buildDetailQuery', () => {
  it('filters by id and hidden_at IS NULL', () => {
    const q = buildDetailQuery('msg-1')
    expect(q.sql).toContain('id = ?')
    expect(q.sql).toContain('hidden_at IS NULL')
    expect(q.params).toEqual(['msg-1'])
  })

  it('includes body_plain in the SELECT list (full detail)', () => {
    const q = buildDetailQuery('msg-1')
    expect(q.sql).toContain('body_plain')
  })

  it('does not interpolate the id into the SQL string', () => {
    const evil = "' OR 1=1 --"
    const q = buildDetailQuery(evil)
    expect(q.sql).not.toContain('OR 1=1')
    expect(q.params).toEqual([evil])
  })
})

describe('clampEmailLimit', () => {
  it('returns DEFAULT for undefined / invalid / <=0', () => {
    expect(clampEmailLimit(undefined)).toBe(50)
    expect(clampEmailLimit(0)).toBe(50)
    expect(clampEmailLimit(-5)).toBe(50)
    expect(clampEmailLimit(Number.NaN)).toBe(50)
  })

  it('caps at MAX_LIMIT (200)', () => {
    expect(clampEmailLimit(201)).toBe(200)
    expect(clampEmailLimit(999999)).toBe(200)
  })

  it('accepts valid values', () => {
    expect(clampEmailLimit(1)).toBe(1)
    expect(clampEmailLimit(50)).toBe(50)
    expect(clampEmailLimit(200)).toBe(200)
  })
})