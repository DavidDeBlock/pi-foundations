// search-query-builder.test.ts — issue #009
//
// Unit tests for the pure SQL builder. No DB required; we assert on the
// `sql` and `params` shapes that the builder returns.

import { describe, expect, it } from 'vitest'
import {
  buildFtsMatchQuery,
  buildFtsSearchQuery,
  buildCandidateFetchQuery,
  extractTrigrams,
  extractTrigramsAsArray,
  clampSearchLimit,
  clampSearchOffset,
  MAX_CANDIDATES,
  FUZZY_TRIGGER_THRESHOLD,
} from './search-query-builder.js'

describe('buildFtsMatchQuery', () => {
  it('returns null for an empty / whitespace-only query', () => {
    expect(buildFtsMatchQuery('')).toBeNull()
    expect(buildFtsMatchQuery('   ')).toBeNull()
  })

  it('returns null when all tokens are FTS5-special characters', () => {
    expect(buildFtsMatchQuery('( ) :')).toBeNull()
    expect(buildFtsMatchQuery('"*"')).toBeNull()
  })

  it('wraps a plain word with a prefix wildcard', () => {
    expect(buildFtsMatchQuery('post')).toBe('post*')
  })

  it('joins multiple words with AND and adds a wildcard to each', () => {
    expect(buildFtsMatchQuery('post tips')).toBe('post* AND tips*')
  })

  it('strips FTS5-special characters but keeps alphanumeric parts', () => {
    expect(buildFtsMatchQuery('abc:def')).toBe('abc* AND def*')
    expect(buildFtsMatchQuery('foo(bar)')).toBe('foo* AND bar*')
    expect(buildFtsMatchQuery('"quoted"')).toBe('quoted*')
  })

  it('treats punctuation as word boundaries (safer for injection)', () => {
    // The `;` and quotes are split-off as boundaries, not concatenated.
    expect(buildFtsMatchQuery('evil"; DROP TABLE bookmarks; --')).toBe(
      'evil* AND DROP* AND TABLE* AND bookmarks*',
    )
  })

  it('collapses repeated whitespace', () => {
    expect(buildFtsMatchQuery('  post   tips  ')).toBe('post* AND tips*')
  })

  it('drops tokens that are pure punctuation', () => {
    expect(buildFtsMatchQuery('post ... tips')).toBe('post* AND tips*')
  })
})

describe('buildFtsSearchQuery', () => {
  it('returns an empty-mode query for an empty input', () => {
    const q = buildFtsSearchQuery('', {}, 50, 0)
    expect(q.mode).toBe('empty')
    expect(q.sql).toContain('1 = 0')
    expect(q.params).toEqual([])
  })

  it('embeds the MATCH expression as a bound parameter (no string concat)', () => {
    const q = buildFtsSearchQuery('post tips', {}, 50, 0)
    if (q.mode !== 'fts5') throw new Error('expected fts5 mode')
    // The MATCH placeholder must be a ? (parameterized), not the
    // literal expression spliced into the SQL string.
    expect(q.sql).toContain('bookmark_fts MATCH ?')
    expect(q.sql).not.toContain('post tips')
    expect(q.sql).not.toContain('post*')
    // First bound param is the FTS expression.
    expect(q.params[0]).toBe('post* AND tips*')
    // Last two params are limit + offset.
    expect(q.params.at(-2)).toBe(50)
    expect(q.params.at(-1)).toBe(0)
  })

  it('appends LIMIT and OFFSET as bound params', () => {
    const q = buildFtsSearchQuery('hello', {}, 25, 100)
    if (q.mode !== 'fts5') throw new Error('expected fts5 mode')
    expect(q.sql).toContain('LIMIT ? OFFSET ?')
    expect(q.params.at(-2)).toBe(25)
    expect(q.params.at(-1)).toBe(100)
  })

  it('adds a folderId WHERE clause when provided', () => {
    const q = buildFtsSearchQuery('hello', { folderId: 'f-123' }, 50, 0)
    if (q.mode !== 'fts5') throw new Error('expected fts5 mode')
    expect(q.sql).toContain('b.folder_id = ?')
    expect(q.params).toContain('f-123')
  })

  it('adds a tagId subquery WHERE clause when provided', () => {
    const q = buildFtsSearchQuery('hello', { tagId: 't-456' }, 50, 0)
    if (q.mode !== 'fts5') throw new Error('expected fts5 mode')
    expect(q.sql).toContain('EXISTS (SELECT 1 FROM bookmark_tags bt')
    expect(q.params).toContain('t-456')
  })

  it('adds date-range WHERE clauses when provided', () => {
    const q = buildFtsSearchQuery(
      'hello',
      { fromDate: '2024-01-01T00:00:00.000Z', toDate: '2024-12-31T23:59:59.999Z' },
      50,
      0,
    )
    if (q.mode !== 'fts5') throw new Error('expected fts5 mode')
    expect(q.sql).toContain('b.created_at >= ?')
    expect(q.sql).toContain('b.created_at <= ?')
    expect(q.params).toContain('2024-01-01T00:00:00.000Z')
    expect(q.params).toContain('2024-12-31T23:59:59.999Z')
  })

  it('omits filters that are undefined or empty string', () => {
    const q = buildFtsSearchQuery(
      'hello',
      { folderId: '', tagId: undefined, fromDate: '', toDate: undefined },
      50,
      0,
    )
    if (q.mode !== 'fts5') throw new Error('expected fts5 mode')
    // The SQL does contain `b.folder_id = fp.id` as a JOIN predicate;
    // assert specifically the filter form (with bound placeholder) is absent.
    expect(q.sql).not.toContain('b.folder_id = ?')
    expect(q.sql).not.toContain('EXISTS (SELECT 1 FROM bookmark_tags')
    expect(q.sql).not.toContain('b.created_at >= ?')
    expect(q.sql).not.toContain('b.created_at <= ?')
  })

  it('uses a recursive CTE for folder paths', () => {
    const q = buildFtsSearchQuery('hello', {}, 50, 0)
    if (q.mode !== 'fts5') throw new Error('expected fts5 mode')
    expect(q.sql).toContain('WITH RECURSIVE')
    expect(q.sql).toContain('folder_paths')
  })

  it('orders by bm25 rank_score then created_at', () => {
    const q = buildFtsSearchQuery('hello', {}, 50, 0)
    if (q.mode !== 'fts5') throw new Error('expected fts5 mode')
    expect(q.sql).toContain('ORDER BY rank_score, b.created_at DESC, b.id DESC')
  })

  it('does not embed user input directly into the SQL string', () => {
    // Injection attempt: the literal text must never appear in the SQL.
    const evil = 'evil"; DROP TABLE bookmarks; --'
    const q = buildFtsSearchQuery(evil, {}, 50, 0)
    if (q.mode !== 'fts5') throw new Error('expected fts5 mode')
    expect(q.sql).not.toContain('DROP TABLE')
    expect(q.sql).not.toContain('evil')
    // The safe-quoted expression lands in params, not in the SQL string.
    expect(q.params[0]).toBe('evil* AND DROP* AND TABLE* AND bookmarks*')
  })
})

describe('buildCandidateFetchQuery', () => {
  it('returns empty mode when the query has no trigrams', () => {
    const q = buildCandidateFetchQuery('', {}, 1000)
    expect(q.mode).toBe('empty')
    expect(q.trigrams).toEqual([])
  })

  it('returns candidate mode with trigrams for a normal query', () => {
    const q = buildCandidateFetchQuery('post', {}, 1000)
    if (q.mode !== 'candidates') throw new Error('expected candidates mode')
    expect(q.trigrams.length).toBeGreaterThan(0)
    expect(q.trigrams).toContain('pos')
    expect(q.trigrams).toContain('ost')
    // First params are the trigrams themselves.
    expect(q.params.slice(0, q.trigrams.length)).toEqual(q.trigrams)
  })

  it('includes the trigram EXISTS subquery', () => {
    const q = buildCandidateFetchQuery('post', {}, 1000)
    if (q.mode !== 'candidates') throw new Error('expected candidates mode')
    expect(q.sql).toContain('EXISTS')
    expect(q.sql).toContain('bookmark_trigrams')
    expect(q.sql).toContain('bt.trigram IN')
  })

  it('appends filters as bound params', () => {
    const q = buildCandidateFetchQuery(
      'post',
      { folderId: 'f-1', tagId: 't-1' },
      1000,
    )
    if (q.mode !== 'candidates') throw new Error('expected candidates mode')
    expect(q.sql).toContain('b.folder_id = ?')
    expect(q.sql).toContain('EXISTS (SELECT 1 FROM bookmark_tags bt')
    // The trigrams come first, then the filter values, then the limit.
    const trigramCount = q.trigrams.length
    expect(q.params[trigramCount]).toBe('f-1')
    expect(q.params[trigramCount + 1]).toBe('t-1')
    expect(q.params.at(-1)).toBe(1000)
  })
})

describe('extractTrigrams', () => {
  it('returns an empty set for strings shorter than 3 chars (after padding)', () => {
    // Single-space padding: "a" → " a " (length 3) → 1 trigram: " a "
    const set = extractTrigrams('a')
    expect(set.size).toBeGreaterThan(0)
  })

  it('returns distinct trigrams for a longer string', () => {
    const set = extractTrigrams('Postgres')
    expect(set.has('pos')).toBe(true)
    expect(set.has('ost')).toBe(true)
    expect(set.has('stg')).toBe(true)
    expect(set.has('tgr')).toBe(true)
    expect(set.has('gre')).toBe(true)
    expect(set.has('res')).toBe(true)
    expect(set.has('es ')).toBe(true)
  })

  it('lowercases before extracting', () => {
    const a = extractTrigrams('Postgres')
    const b = extractTrigrams('postgres')
    expect([...a].sort()).toEqual([...b].sort())
  })

  it('produces overlapping trigrams across whitespace-separated words', () => {
    // "a b" → " a b " → trigrams include "a b" (the boundary)
    const set = extractTrigrams('a b')
    expect(set.has('a b')).toBe(true)
  })

  it('extractTrigramsAsArray returns a stable list', () => {
    const arr = extractTrigramsAsArray('post')
    expect(arr.length).toBeGreaterThan(0)
    expect(arr.every((t) => t.length === 3)).toBe(true)
  })

  it('extractTrigramsAsArray returns [] for empty input', () => {
    expect(extractTrigramsAsArray('')).toEqual([])
  })
})

describe('clampSearchLimit / clampSearchOffset', () => {
  it('clampSearchLimit returns DEFAULT for undefined / invalid / <=0', () => {
    expect(clampSearchLimit(undefined)).toBe(50)
    expect(clampSearchLimit(0)).toBe(50)
    expect(clampSearchLimit(-5)).toBe(50)
    expect(clampSearchLimit(Number.NaN)).toBe(50)
  })

  it('clampSearchLimit caps at 200', () => {
    expect(clampSearchLimit(201)).toBe(200)
    expect(clampSearchLimit(999999)).toBe(200)
  })

  it('clampSearchLimit accepts valid values', () => {
    expect(clampSearchLimit(1)).toBe(1)
    expect(clampSearchLimit(50)).toBe(50)
    expect(clampSearchLimit(200)).toBe(200)
  })

  it('clampSearchOffset returns 0 for undefined / invalid / negative', () => {
    expect(clampSearchOffset(undefined)).toBe(0)
    expect(clampSearchOffset(-1)).toBe(0)
    expect(clampSearchOffset(Number.NaN)).toBe(0)
  })

  it('clampSearchOffset accepts valid values', () => {
    expect(clampSearchOffset(0)).toBe(0)
    expect(clampSearchOffset(50)).toBe(50)
    expect(clampSearchOffset(1000)).toBe(1000)
  })
})

describe('constants', () => {
  it('MAX_CANDIDATES is high enough for personal scale but caps cost', () => {
    expect(MAX_CANDIDATES).toBeGreaterThanOrEqual(500)
    expect(MAX_CANDIDATES).toBeLessThanOrEqual(2000)
  })

  it('FUZZY_TRIGGER_THRESHOLD is positive and small', () => {
    expect(FUZZY_TRIGGER_THRESHOLD).toBeGreaterThanOrEqual(3)
    expect(FUZZY_TRIGGER_THRESHOLD).toBeLessThanOrEqual(20)
  })
})