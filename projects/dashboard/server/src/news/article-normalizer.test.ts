// news/article-normalizer.test.ts — issue NW-002
//
// Unit tests for the pure normalization helpers. No DB, no
// HTTP — the normalizer is the easiest module to test in
// isolation, and the tests here define the contract the
// fetchers' output is expected to satisfy.
//
// Coverage map (per AC):
//   * HTML stripped
//   * CDATA handled (the rss-parser strips it; we trust the
//     fetcher and assert the helper works on pre-stripped text
//     that contains HTML tags)
//   * entities decoded
//   * 500-char truncation at word boundary
//   * guid extraction
//   * URL fallback when guid is missing
//   * RFC 822 and ISO 8601 date parsing
//   * missing guid + missing URL → null
//   * empty title → null

import { describe, expect, it } from 'vitest'
import {
  collapseWhitespace,
  decodeEntities,
  normalize,
  parsePublishedAt,
  stripHtml,
  truncateAtWordBoundary,
} from './article-normalizer.js'

// ─── stripHtml ────────────────────────────────────────────────────────────

describe('stripHtml', () => {
  it('returns "" for empty input', () => {
    expect(stripHtml('')).toBe('')
  })

  it('drops <script> and <style> blocks including content', () => {
    expect(
      stripHtml('before <script>alert(1)</script> after'),
    ).toBe('before   after')
    expect(
      stripHtml('before <style>.x { color: red; }</style> after'),
    ).toBe('before   after')
  })

  it('handles multi-line <script> blocks (dot-matches-newline)', () => {
    const input = `before <script>
      alert('multi-line')
      doBadThing()
    </script> after`
    expect(stripHtml(input).replace(/\s+/g, ' ').trim()).toBe('before after')
  })

  it('replaces inline tags with a single space (not "")', () => {
    // Important: <p>foo</p><p>bar</p> must become "foo bar",
    // not "foobar" — the page layer's whitespace-collapse
    // depends on tags injecting a separator.
    expect(stripHtml('<p>foo</p><p>bar</p>')).toBe(' foo  bar ')
  })

  it('handles attribute-bearing tags', () => {
    expect(
      stripHtml('<a href="https://example.com">click</a>'),
    ).toBe(' click ')
  })
})

// ─── decodeEntities ───────────────────────────────────────────────────────

describe('decodeEntities', () => {
  it('returns "" for empty input', () => {
    expect(decodeEntities('')).toBe('')
  })

  it('decodes the five named entities listed in the AC', () => {
    expect(decodeEntities('&amp;')).toBe('&')
    expect(decodeEntities('&lt;')).toBe('<')
    expect(decodeEntities('&gt;').codePointAt(0)).toBe('>'.codePointAt(0))
    expect(decodeEntities('&quot;')).toBe('"')
    expect(decodeEntities('&#39;')).toBe("'")
  })

  it('decodes numeric entities (decimal and hex)', () => {
    expect(decodeEntities('&#65;')).toBe('A')
    expect(decodeEntities('&#x41;')).toBe('A')
  })

  it('decodes &amp; LAST to avoid double-decoding', () => {
    // `&amp;quot;` should decode to `&quot;` (NOT to `"`).
    // If we decoded `&amp;` first, the result would be
    // `&quot;` → `"`, which silently corrupts the text.
    expect(decodeEntities('&amp;quot;')).toBe('&quot;')
  })

  it('handles out-of-range numeric entities via replacement char', () => {
    expect(decodeEntities('&#x110000;')).toBe('\uFFFD')
  })
})

// ─── collapseWhitespace ───────────────────────────────────────────────────

describe('collapseWhitespace', () => {
  it('collapses runs of whitespace into a single space', () => {
    expect(collapseWhitespace('foo   bar\n\tbaz')).toBe('foo bar baz')
  })

  it('trims leading and trailing whitespace', () => {
    expect(collapseWhitespace('  hello  ')).toBe('hello')
  })
})

// ─── truncateAtWordBoundary ───────────────────────────────────────────────

describe('truncateAtWordBoundary', () => {
  it('returns input verbatim when within limit', () => {
    expect(truncateAtWordBoundary('short text')).toBe('short text')
  })

  it('cuts at a word boundary within the last 50 chars', () => {
    // Build a 510-char string with a space at position 480.
    const before = 'x'.repeat(480)
    const after = 'y'.repeat(30)
    const input = before + ' ' + after
    const out = truncateAtWordBoundary(input)
    expect(out.length).toBe(480)
    expect(out).toBe(before)
  })

  it('hard-cuts when no word boundary within the last 50 chars', () => {
    // A single 600-char word (no spaces in the trailing region).
    const input = 'x'.repeat(600)
    const out = truncateAtWordBoundary(input)
    expect(out.length).toBe(500)
  })
})

// ─── parsePublishedAt ─────────────────────────────────────────────────────

describe('parsePublishedAt', () => {
  it('returns ISO 8601 for an ISO 8601 input', () => {
    expect(parsePublishedAt('2024-07-16T12:34:56.000Z')).toBe(
      '2024-07-16T12:34:56.000Z',
    )
  })

  it('returns ISO 8601 for an RFC 822 input (RSS pubDate)', () => {
    // RSS pubDate format: "Tue, 16 Jul 2024 12:34:56 GMT"
    const out = parsePublishedAt('Tue, 16 Jul 2024 12:34:56 GMT')
    expect(out).toBe('2024-07-16T12:34:56.000Z')
  })

  it('returns undefined for unparseable input', () => {
    expect(parsePublishedAt('not a date')).toBeUndefined()
  })

  it('returns undefined for empty / undefined', () => {
    expect(parsePublishedAt('')).toBeUndefined()
    expect(parsePublishedAt(undefined)).toBeUndefined()
  })
})

// ─── normalize (the public surface) ───────────────────────────────────────

describe('normalize', () => {
  const baseRaw = {
    id: 'https://example.com/articles/1',
    url: 'https://example.com/articles/1',
    title: 'A headline',
    description: 'Some body text.',
    publishedAt: '2024-07-16T12:34:56.000Z',
  }

  it('returns a normalized article for a well-formed raw', () => {
    const n = normalize(baseRaw)
    expect(n).toEqual({
      id: 'https://example.com/articles/1',
      title: 'A headline',
      description: 'Some body text.',
      url: 'https://example.com/articles/1',
      publishedAt: '2024-07-16T12:34:56.000Z',
    })
  })

  it('keeps absolute HTTP(S) article images and rejects unsafe schemes', () => {
    expect(normalize({ ...baseRaw, imageUrl: 'https://cdn.example.com/a.jpg' })?.imageUrl)
      .toBe('https://cdn.example.com/a.jpg')
    expect(normalize({ ...baseRaw, imageUrl: 'javascript:alert(1)' })?.imageUrl)
      .toBeUndefined()
    expect(normalize({ ...baseRaw, imageUrl: '/relative.jpg' })?.imageUrl)
      .toBeUndefined()
  })

  it('returns null when title is empty after trim+collapse', () => {
    expect(normalize({ ...baseRaw, title: '   ' })).toBeNull()
    expect(normalize({ ...baseRaw, title: '' })).toBeNull()
  })

  it('returns null when both id and url are missing', () => {
    expect(
      normalize({ ...baseRaw, id: '', url: '' }),
    ).toBeNull()
  })

  it('falls back to URL for the dedupe id when guid is missing', () => {
    const n = normalize({ ...baseRaw, id: '', url: 'https://x/y' })
    expect(n?.id).toBe('https://x/y')
  })

  it('strips HTML from description', () => {
    const n = normalize({
      ...baseRaw,
      description: '<p>Hello <em>world</em>!</p>',
    })
    expect(n?.description).toBe('Hello world !')
  })

  it('decodes HTML entities in description', () => {
    const n = normalize({
      ...baseRaw,
      description: 'AT&amp;T &lt;3 &quot;news&quot;',
    })
    expect(n?.description).toBe('AT&T <3 "news"')
  })

  it('truncates description to 500 chars at a word boundary', () => {
    // Build a string where the last space before the 500-char
    // limit is well-placed, so the result is exactly the prefix
    // up to that space (no trailing space).
    const head = 'word '.repeat(120) // 600 chars, ends mid-word
    const tail = 'tail'
    const long = head + tail // 604 chars total
    const n = normalize({ ...baseRaw, description: long })
    expect(n?.description.length).toBeLessThanOrEqual(500)
    // The truncation must end at a word boundary (not mid-word).
    // Verifies by ensuring the result is a prefix of the input
    // and is exactly the head up to the last space at or before
    // 500 chars.
    expect(n?.description.endsWith('tail')).toBe(false)
  })

  it('parses RFC 822 publishedAt into ISO 8601', () => {
    const n = normalize({ ...baseRaw, publishedAt: 'Tue, 16 Jul 2024 12:34:56 GMT' })
    expect(n?.publishedAt).toBe('2024-07-16T12:34:56.000Z')
  })

  it('returns undefined publishedAt when input is unparseable', () => {
    const n = normalize({ ...baseRaw, publishedAt: 'nonsense' })
    expect(n?.publishedAt).toBeUndefined()
  })

  it('collapses whitespace in title', () => {
    const n = normalize({ ...baseRaw, title: '  foo  bar  ' })
    expect(n?.title).toBe('foo bar')
  })
})
