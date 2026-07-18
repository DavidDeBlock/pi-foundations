// news/article-normalizer.ts — issue NW-002
//
// Maps a fetcher's `RawArticle` (vendor-agnostic but untrimmed)
// into a `NormalizedArticle` (trimmed, dedup-safe id, plain-text
// description). This is the deep module that knows about HTML
// stripping, entity decoding, word-boundary truncation, and the
// feed-vs-Atom date formats.
//
// Why this is a deep module:
//   * Feed items routinely have HTML in the description
//     (`<p>foo <em>bar</em></p>`), HTML entities (`&amp;`),
//     mixed whitespace, and very long summaries. The page layer
//     MUST render-safe by default (no XSS surface), and the
//     store MUST keep the column small. Both come from this one
//     pass.
//   * The truncation rule (500 chars at a word boundary, with
//     a 50-char hard-cut fallback) is the kind of policy that
//     leaks into callers if it lives inline. Isolated here so
//     changing the limit is a one-line edit.
//   * Date parsing across feed formats is messy. RFC 822 is
//     RSS's `pubDate`; ISO 8601 is Atom's `isoDate`. The fetcher
//     passes the raw string; this module decides whether it's
//     parseable and what shape to return.

import type { NormalizedArticle, RawArticle } from './types.js'

// ─── Constants ────────────────────────────────────────────────────────────

/** Max description length. Matches the column comment in
 *  025_news.sql. The PRD's intent is "summary cards on the
 *  glance page", not full-text — operators can click through. */
const MAX_DESCRIPTION_LENGTH = 500

/** When truncating, if no word boundary exists within the last
 *  this-many characters of the limit, hard-cut. Prevents
 *  pathological inputs (a single 10KB word) from producing a
 *  500-char truncated-with-no-elipsis result. */
const MAX_NO_BOUNDARY_BACKOFF = 50

// ─── Public surface ───────────────────────────────────────────────────────

/**
 * Normalize one raw feed item.
 *
 * Returns `null` when the item cannot be normalized:
 *   * title is empty after trim+collapse, OR
 *   * both `id` and `url` are missing/empty (we can't dedupe
 *     or link without one).
 *
 * The dedupe key for `news_articles` is `(source_id, id)`,
 * so the returned `id` is either the feed's identifier (RSS
 * `guid` or Atom `<id>`) or the URL as a last resort. The page
 * layer relies on `url` always being a usable link.
 */
export function normalize(raw: RawArticle): NormalizedArticle | null {
  // Title is the only truly required field. An empty title
  // means there's nothing to render.
  const title = collapseWhitespace(raw.title)
  if (title === '') return null

  // Resolve dedupe id. URL fallback when guid is missing —
  // URLs are unique per article in practice and let us dedupe
  // even when the feed omits a guid.
  const id = pickString(raw.id) ?? pickString(raw.url)
  const url = pickString(raw.url) ?? pickString(raw.id)
  if (id === null || url === null) return null

  // Description: plain text, truncated.
  const description = truncateAtWordBoundary(
    collapseWhitespace(decodeEntities(stripHtml(raw.description ?? ''))),
  )

  return {
    id,
    title,
    description,
    imageUrl: normalizeImageUrl(raw.imageUrl),
    url,
    publishedAt: parsePublishedAt(raw.publishedAt),
  }
}

/** Keep remote media passive and predictable: only absolute HTTP(S)
 * URLs are suitable for an <img src>. Invalid or non-web schemes are
 * treated exactly like a feed that supplied no image. */
export function normalizeImageUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const url = new URL(raw.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Parse a feed-supplied publication timestamp.
 *
 * Accepts:
 *   * RFC 822 (e.g. `Tue, 16 Jul 2024 12:34:56 GMT`) — RSS.
 *   * ISO 8601 (e.g. `2024-07-16T12:34:56.000Z`) — Atom.
 *
 * Returns ISO 8601 (with millisecond precision) on success,
 * `undefined` on parse failure or empty input. The store
 * stores whatever this returns; `news_articles.published_at`
 * is nullable so undefined → NULL is fine.
 */
export function parsePublishedAt(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined
  const t = Date.parse(raw)
  if (Number.isNaN(t)) return undefined
  return new Date(t).toISOString()
}

// ─── Internals (exported for testing) ─────────────────────────────────────

/** Strip HTML tags. CDATA sections come through as their inner
 *  text by the time rss-parser is done with them, so no
 *  explicit CDATA handling here.
 *
 *  Implementation: replace `<...>` blocks with a single space,
 *  then collapse. Whitespace-aware so e.g. `<p>foo</p><p>bar</p>`
 *  doesn't run together. The `<script>` and `<style>` blocks
 *  are stripped along with their content (we don't want any
 *  inline JS landing in the description column). */
export function stripHtml(input: string): string {
  if (input === '') return ''
  // Drop <script>...</script> and <style>...</style> blocks
  // entirely (including their content). Case-insensitive,
  // dot-matches-newline so a multi-line <script> block is fully
  // removed. The `?` after `*` makes it non-greedy so we don't
  // match across the whole document.
  const withoutScripts = input.replace(
    /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
    ' ',
  )
  const withoutStyles = withoutScripts.replace(
    /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
    ' ',
  )
  // Replace any remaining tags with a single space. The space
  // matters: `<p>foo</p><p>bar</p>` would otherwise become
  // `foobar`.
  return withoutStyles.replace(/<[^>]+>/g, ' ')
}

/** Decode the five common HTML entities listed in the AC.
 *  The order matters: `&amp;` must be decoded LAST so we don't
 *  double-decode (e.g. `&amp;quot;` → `&quot;` → `"`).
 *
 *  Numeric entities like `&#39;` are handled by the regex's
 *  digit run. The named entities are the most common five in
 *  RSS/Atom description fields. We don't decode the full
 *  entity set (e.g. `&nbsp;`, `&copy;`) because:
 *   * They'd expand the column for no rendering benefit.
 *   * `&nbsp;` is a non-breaking space — we want to collapse
 *     to a regular space anyway, so leaving it as `&nbsp;`
 *     in the input is harmless (collapse-whitespace sees it
 *     as one char). */
export function decodeEntities(input: string): string {
  if (input === '') return ''
  // Numeric entities first: `&#NN;` and `&#xHH;` to their
  // unicode codepoints. Missing the trailing `;` (some feeds
  // omit it for `&amp` etc.) is tolerated by the optional `;?`.
  let out = input.replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) =>
    safeFromCodePoint(parseInt(hex, 16)),
  )
  out = out.replace(/&#(\d+);?/g, (_, dec: string) =>
    safeFromCodePoint(parseInt(dec, 10)),
  )
  // Named entities in REVERSE order: decode `&amp;` last so
  // we don't double-decode.
  out = out.replace(/&quot;/g, '"')
  out = out.replace(/&#39;/g, "'")
  out = out.replace(/&lt;/g, '<')
  out = out.replace(/&gt;/g, '>')
  out = out.replace(/&amp;/g, '&')
  return out
}

/** `String.fromCodePoint` throws on out-of-range values; the
 *  safe fallback returns the replacement character. */
function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
    return '\uFFFD'
  }
  return String.fromCodePoint(code)
}

/** Trim + collapse runs of whitespace (including the spaces we
 *  injected when stripping HTML) into a single space. */
export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

/** Truncate a string to `MAX_DESCRIPTION_LENGTH` characters at a
 *  word boundary. If no word boundary exists within the last
 *  `MAX_NO_BOUNDARY_BACKOFF` characters, hard-cut.
 *
 *  Word boundary = the last ASCII space (`U+0020`) before the
 *  cut. Anything fancier (Unicode word segmentation) is
 *  overkill for a 500-char description cap. */
export function truncateAtWordBoundary(input: string): string {
  if (input.length <= MAX_DESCRIPTION_LENGTH) return input
  // Look for a space in [limit - backoff, limit).
  const lowerBound = MAX_DESCRIPTION_LENGTH - MAX_NO_BOUNDARY_BACKOFF
  for (let i = MAX_DESCRIPTION_LENGTH - 1; i >= lowerBound; i--) {
    if (input.charCodeAt(i) === 0x20) {
      return input.slice(0, i)
    }
  }
  return input.slice(0, MAX_DESCRIPTION_LENGTH)
}

/** Return the string if non-empty, otherwise null. */
function pickString(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null
  if (value === '') return null
  return value
}
