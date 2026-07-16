// youtube-rss-fetcher.ts — issue YT-004
//
// Deep module: stateless fetcher of YouTube's public per-channel
// Atom feed. Pollers and tests pass a `channelId`; the fetcher
// returns the new entries or a typed error.
//
// Why this is a deep module:
//   * HTTP fetch + Atom XML parsing is the kind of code that
//     becomes a swamp of regex matches and substring slicing if
//     it leaks into the poller. Isolated here behind a single
//     `fetch(channelId) → FeedEntry[]` signature, with all
//     "parse weird responses into structured shapes" logic in
//     one place.
//   * Errors are typed (`RssFeedFetchError`, `RssFeedParseError`)
//     so the poller can log them per-channel and bail out that
//     one channel without breaking the loop.
//   * Stateless + injected `fetch` dependency → trivial to unit-
//     test against sample fixtures; one test covers malformed
//     XML, one covers 404, one covers empty feeds, etc.
//
// YouTube's feed URL is the public, no-auth RSS endpoint documented
// at https://developers.google.com/youtube/v3/guides/push_notifications
//
//   GET https://www.youtube.com/feeds/videos.xml?channel_id=<ID>
//   Accept: application/atom+xml
//
// Response is Atom XML with one `<entry>` per recent video.
// Malformed entries (missing `yt:videoId`, etc.) are dropped here
// rather than propagated — partial corruption in a feed should
// not break ingestion of the rest.

import { XMLParser } from 'fast-xml-parser'

// ─── Public types ──────────────────────────────────────────────────────────

/** One YouTube video as extracted from the Atom feed. Matches
 *  `VideoInsertInput` minus the `channelId` field — the fetcher
 *  is given a channel, so that's implied. */
export interface FeedEntry {
  readonly videoId: string
  readonly title: string
  readonly publishedAt: string
  readonly thumbnailUrl: string | null
  readonly link: string
}

/** HTTP / network failure. The poller should log + skip the
 *  channel for this tick. */
export class RssFeedFetchError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'RssFeedFetchError'
  }
}

/** The response was received but the body wasn't Atom XML.
 *  Could be YouTube returning an HTML error page, or an
 *  intermediate proxy rewriting the body. */
export class RssFeedParseError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'RssFeedParseError'
  }
}


// ─── Module shape ────────────────────────────────────────────────────────

/**
 * Pluggable HTTP fetch. Default is the global `fetch` (Node 18+
 *   ships one; we run on Node 22). Tests inject a stub.
 *
 * Should throw on non-2xx — the wrapper below treats HTTP errors
 * as `RssFeedFetchError`.
 */
export type Fetcher = (
  url: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>

const defaultFetcher: Fetcher = (url, init) => fetch(url, init)

/**
 * One-time feed fetcher. Holds the HTTP transport + the parser
 * options — both injectable for tests.
 */
export class YouTubeRssFeedFetcher {
  readonly #url: string
  readonly #fetcher: Fetcher
  readonly #timeoutMs: number
  readonly #parser: XMLParser

  constructor(
    options: {
      /** Override the base feed URL (tests use a local HTTPServer /
       *  fixture string). */
      url?: string
      /** Override the HTTP transport (default: global `fetch`). */
      fetcher?: Fetcher
      /** Request timeout in ms before the request is aborted.
       *  Default 15s — generous for a small feed but bounded so
       *  a hung connection can't stall the poller. */
      timeoutMs?: number
    } = {},
  ) {
    this.#url = options.url ?? 'https://www.youtube.com/feeds/videos.xml'
    this.#fetcher = options.fetcher ?? defaultFetcher
    this.#timeoutMs = options.timeoutMs ?? 15_000
    this.#parser = new XMLParser({
      // We don't need the DOM hierarchy preserved verbatim — we
      // only read a handful of fields. Flatten arrays so a
      // single-entry feed still lands as `entry[0]` rather than
      // `entry` (the parser's default would skip the array
      // wrapper when there's one entry).
      isArray: (name) => name === 'entry',
      // Strip namespace prefixes so `yt:videoId` lands as
      // `videoId`. The feed's media-namespace attrs (`url` on
      // `<media:thumbnail>`) collapse cleanly.
      // Strip namespace prefixes so `yt:videoId` lands as
      // `videoId`. The feed's media-namespace attrs (`url` on
      // `<media:thumbnail>`) collapse cleanly.
      removeNSPrefix: true,
      // Preserve XML attributes (`<link rel="alternate" href="...">`
      // → `link: { '@_rel': 'alternate', '@_href': '...', '#text': '...' }`).
      ignoreAttributes: false,
      // Don't bother with strict parsing — YouTube uses valid XML
      // but the parser's default tolerant mode handles small
      // whitespace quirks without raising.
      parseTagValue: false,
      trimValues: true,
      // Skip the @ prefix on attribute names — fast-xml-parser
      // uses `@_` to distinguish attrs from children so they
      // coexist on the same object without collision.
      attributeNamePrefix: '@_',
    })
  }

  /**
   * Fetch and parse the Atom feed for one channel.
   *
   *   * 2xx + valid Atom XML → `FeedEntry[]` (empty if no entries).
   *   * Non-2xx (404, 5xx, network error) → throws `RssFeedFetchError`.
   *   * 2xx but body isn't Atom XML → throws `RssFeedParseError`.
   *   * Malformed `<entry>` rows are silently skipped (counted
   *     and reflected in the result's `dropped` field).
   *
   * `dropped` is here rather than logged because it's useful
   * test output and would otherwise need a separate log-channel.
   */
  async fetch(channelId: string): Promise<{
    readonly entries: FeedEntry[]
    /** Entries the parser saw but couldn't normalize —
     *  missing videoId, missing published, missing title, etc. */
    readonly dropped: number
  }> {
    if (!isValidChannelId(channelId)) {
      throw new RssFeedFetchError(
        `invalid channel_id format: ${JSON.stringify(channelId)}`,
      )
    }

    const url = `${this.#url}?channel_id=${encodeURIComponent(channelId)}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const res = await this.#fetcher(url, {
        headers: {
          accept:
            'application/atom+xml, application/xml;q=0.9, */*;q=0.5',
          'user-agent': 'dashboard-server/youtube-rss (yt-004)',
        },
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new RssFeedFetchError(
          `YouTube RSS feed returned HTTP ${res.status} for channel_id=${channelId}`,
        )
      }
      const text = await res.text()
      if (text.trim() === '') {
        // An empty body is plausible for a brand-new channel
        // that hasn't published yet. Treat as "no entries" —
        // NOT an error.
        return { entries: [], dropped: 0 }
      }
      return parseFeed(text, this.#parser, channelId)
    } catch (err: unknown) {
      if (err instanceof RssFeedFetchError) throw err
      if (err instanceof RssFeedParseError) throw err
      // `AbortController` from the timeout fires as
      // `DOMException { name: 'AbortError' }` — rename to a
      // fetch error so the poller can log it consistently.
      if (err instanceof Error && err.name === 'AbortError') {
        throw new RssFeedFetchError(
          `YouTube RSS request timed out after ${this.#timeoutMs}ms for channel_id=${channelId}`,
          err,
        )
      }
      throw new RssFeedFetchError(
        `YouTube RSS request failed for channel_id=${channelId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err,
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

// ─── Parser ───────────────────────────────────────────────────────────────

interface RawFeed {
  feed?: {
    entry?: ReadonlyArray<Record<string, unknown>> | Record<string, unknown>
  }
}

/**
 * Parse a YouTube Atom feed body into typed entries.
 *
 * Why an internal helper instead of inlined in `fetch()`:
 *   * Easy to unit-test the parser in isolation (no HTTP).
 *   * Keeps the try/throw/finally blocks in `fetch()` focused on
 *     transport concerns.
 */
export function parseFeed(
  text: string,
  parser: XMLParser,
  channelId: string,
): { entries: FeedEntry[]; dropped: number } {
  let parsed: unknown
  try {
    parsed = parser.parse(text)
  } catch (err: unknown) {
    throw new RssFeedParseError(
      `malformed Atom XML for channel_id=${channelId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    )
  }
  const raw = parsed as RawFeed
  // The parser represents `<feed></feed>` as `{ feed: '' }` — an
  // empty string is itself a valid (empty) feed. Only throw when
  // the root element is something other than `<feed>`.
  if (raw.feed === undefined || raw.feed === null) {
    throw new RssFeedParseError(
      `response body does not have a <feed> root for channel_id=${channelId}`,
    )
  }
  if (typeof raw.feed === 'string' && raw.feed === '') {
    return { entries: [], dropped: 0 }
  }
  const rawEntries = rawEntriesOf(raw.feed)
  const entries: FeedEntry[] = []
  let dropped = 0
  for (const raw of rawEntries) {
    const entry = normalizeEntry(raw)
    if (entry === null) {
      dropped++
      continue
    }
    entries.push(entry)
  }
  return { entries, dropped }
}

function rawEntriesOf(
  feed: NonNullable<RawFeed['feed']>,
): ReadonlyArray<Record<string, unknown>> {
  const e = feed.entry
  if (Array.isArray(e)) return e
  if (e !== undefined && typeof e === 'object' && e !== null) {
    return [e as Record<string, unknown>]
  }
  return []
}

/**
 * Pull the documented fields out of one `<entry>` row. Returns
 * `null` when any required field is missing — those rows are
 * counted as `dropped` so the poller can still log + continue.
 *
 * Required fields: `videoId`, `title`, `published`, `link`. The
 * thumbnail is optional (some old channels don't have one).
 */
function normalizeEntry(
  raw: Record<string, unknown>,
): FeedEntry | null {
  const videoId = pickString(raw.videoId)
  const title = pickString(raw.title)
  const publishedAt = pickString(raw.published)
  const link = pickAlternateLink(raw.link)
  if (videoId === null || title === null || publishedAt === null || link === null) {
    return null
  }
  if (!looksLikeVideoId(videoId)) return null
  const thumbnailUrl = pickThumbnail(raw.group ?? raw['media:group'])
  return {
    videoId,
    title,
    publishedAt,
    thumbnailUrl,
    link,
  }
}

/** `<link rel="alternate" href="...">` → the href. Falls back
 *  to the first link's href if rel is missing — some tools
 *  inline the canonical link as a bare element. */
function pickAlternateLink(raw: unknown): string | null {
  const links = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  for (const l of links) {
    if (typeof l !== 'object' || l === null) continue
    const obj = l as Record<string, unknown>
    const rel = obj['@_rel']
    const href = obj['@_href'] ?? obj.href ?? obj['#text']
    if (typeof href !== 'string') continue
    if (rel === 'alternate' || rel === undefined) return href
  }
  return null
}

/** `<media:thumbnail url="...">` from inside `<media:group>`.
 *  Prefers the highest-resolution thumbnail (width × height):
 *   sddefault (640×480) > hqdefault (480×360) > default (120×90).
 *  If the group is missing, the entry has no thumbnail. */
function pickThumbnail(mediaGroup: unknown): string | null {
  if (typeof mediaGroup !== 'object' || mediaGroup === null) return null
  const mg = mediaGroup as Record<string, unknown>; const thumbs = mg.thumbnail ?? mg['media:thumbnail']
  if (thumbs === undefined) return null
  const arr = Array.isArray(thumbs) ? thumbs : [thumbs]
  // Collect { url, width, height, area } and take the largest.
  let best: { url: string; area: number } | null = null
  for (const t of arr) {
    if (typeof t !== 'object' || t === null) continue
    const obj = t as Record<string, unknown>
    const url = obj['@_url'] ?? obj.url
    if (typeof url !== 'string') continue
    const width = numberOr(obj['@_width'], 0)
    const height = numberOr(obj['@_height'], 0)
    const area = width * height
    if (best === null || area > best.area) {
      best = { url, area }
    }
  }
  return best?.url ?? null
}

function pickString(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null
  return null
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

/** Lightweight shape check. YouTube video IDs are 11 chars of
 *  `[A-Za-z0-9_-]`. We don't anchor with `^...$` because the
 *  parser sometimes trims; `length` of 11 + charset is good
 *  enough for "looks like an id, not a title" filter. */
function looksLikeVideoId(s: string): boolean {
  if (s.length !== 11) return false
  return /^[A-Za-z0-9_-]+$/.test(s)
}

/** YouTube channel IDs start with `UC` and are 24 chars of
 *  `[A-Za-z0-9_-]`. We validate before making the HTTP call so
 *  a malformed input fails fast (and avoids URL injection). */
function isValidChannelId(s: string): boolean {
  if (s.length !== 24) return false
  if (!s.startsWith('UC')) return false
  return /^[A-Za-z0-9_-]+$/.test(s)
}