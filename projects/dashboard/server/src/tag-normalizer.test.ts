// tag-normalizer.test.ts — issue #008 unit tests
//
// Exercises every documented behavior of `normalize` and `normalizeAll`
// plus a battery of edge cases. The normalization rules are part of
// the storage contract: if these break, tags can collide or leak
// punctuation into UI.

import { describe, expect, it } from 'vitest'
import { normalize, normalizeAll } from './tag-normalizer.js'

// ─── normalize (single string) ────────────────────────────────────────────

describe('normalize — case folding', () => {
  it('lowercases uppercase ASCII', () => {
    expect(normalize('Postgres')).toBe('postgres')
    expect(normalize('POSTGRES')).toBe('postgres')
    expect(normalize('PostgreSQL')).toBe('postgresql')
  })

  it('preserves already-lowercase input unchanged', () => {
    expect(normalize('postgres')).toBe('postgres')
  })

  it('lowercases mixed case', () => {
    expect(normalize('DaTaBaSe')).toBe('database')
  })
})

describe('normalize — whitespace', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalize('  postgres  ')).toBe('postgres')
    expect(normalize('\tpostgres\n')).toBe('postgres')
  })

  it('collapses internal whitespace runs into a single hyphen', () => {
    expect(normalize('machine learning')).toBe('machine-learning')
    expect(normalize('machine  learning')).toBe('machine-learning')
    expect(normalize('machine\tlearning')).toBe('machine-learning')
  })

  it('trims whitespace before slugifying', () => {
    expect(normalize('  database & sql  ')).toBe('database-sql'
)
  })
})

describe('normalize — special character handling', () => {
  it('replaces ampersand with hyphen', () => {
    expect(normalize('cats & dogs')).toBe('cats-dogs')
  })

  it('replaces slashes with hyphens', () => {
    expect(normalize('web/http')).toBe('web-http')
  })

  it('collapses runs of special chars into a single hyphen', () => {
    expect(normalize('hello!!!world')).toBe('hello-world')
    expect(normalize('a@#$%b')).toBe('a-b')
  })

  it('strips leading and trailing hyphens', () => {
    expect(normalize('---postgres---')).toBe('postgres')
    expect(normalize('!!!hello!!!')).toBe('hello')
  })

  it('removes characters that have no alphanumeric equivalent', () => {
    expect(normalize('C++')).toBe('c')
    expect(normalize('.NET')).toBe('net')
    expect(normalize('node.js')).toBe('node-js')
  })

  it('returns empty string for input that becomes all-special', () => {
    expect(normalize('---')).toBe('')
    expect(normalize('!!!')).toBe('')
    expect(normalize('   ')).toBe('')
    expect(normalize('')).toBe('')
  })
})

describe('normalize — unicode', () => {
  it('preserves accented Latin letters as-is', () => {
    expect(normalize('café')).toBe('café')
    expect(normalize('naïve')).toBe('naïve')
  })

  it('preserves CJK characters as-is', () => {
    expect(normalize('数据')).toBe('数据')
    expect(normalize('数据库')).toBe('数据库')
  })

  it('preserves digits from non-ASCII scripts (Arabic-Indic, Devanagari)', () => {
    // Devanagari digits: ०१२३
    expect(normalize('०१२३')).toBe('०१२३')
  })

  it('treats punctuation between unicode words as a separator', () => {
    expect(normalize('café, croissants')).toBe('café-croissants')
    expect(normalize('数据 / 存储')).toBe('数据-存储')
  })

  it('preserves mixed Latin + CJK without inserting separators', () => {
    expect(normalize('web数据库')).toBe('web数据库')
  })
})

// ─── normalizeAll (list, dedupe) ───────────────────────────────────────────

describe('normalizeAll', () => {
  it('returns [] for empty input', () => {
    expect(normalizeAll([])).toEqual([])
  })

  it('normalizes each input independently', () => {
    expect(normalizeAll(['Postgres', 'database', 'WEB'])).toEqual([
      'postgres',
      'database',
      'web',
    ])
  })

  it('dedupes case-insensitively (after normalization they match)', () => {
    expect(normalizeAll(['Postgres', 'postgres', 'POSTGRES'])).toEqual(['postgres'])
  })

  it('dedupes after slugification', () => {
    expect(normalizeAll(['database & sql', 'database-sql', 'Database SQL'])).toEqual([
      'database-sql',
    ])
  })

  it('preserves input order for distinct tags', () => {
    expect(normalizeAll(['zebra', 'apple', 'mango'])).toEqual(['zebra', 'apple', 'mango'])
  })

  it('first occurrence wins on duplicate', () => {
    expect(normalizeAll(['Postgres', 'POSTGRES', 'postgres'])).toEqual(['postgres'])
  })

  it('filters out inputs that normalize to empty', () => {
    expect(normalizeAll(['postgres', '!!!', '   ', 'database'])).toEqual([
      'postgres',
      'database',
    ])
  })

  it('does not collapse distinct tags that happen to share substrings', () => {
    expect(normalizeAll(['post', 'postgres', 'postgresql'])).toEqual([
      'post',
      'postgres',
      'postgresql',
    ])
  })

  it('handles a realistic mixed-case + whitespace input from a user', () => {
    expect(
      normalizeAll(['Machine Learning', 'machine-learning', '  ML  ', 'AI']),
    ).toEqual(['machine-learning', 'ml', 'ai'])
  })
})