// news/types.ts — issue NW-002
//
// Shared types for the news & weather ingestion layer. The point
// of this file is to keep the module boundaries narrow: the
// fetchers only know about `RawArticle` (and `WeatherSnapshot`
// for Open-Meteo); the normalizer maps raw → normalized; the
// store reads/writes the `Source` / `Article` / `WeatherSnapshot`
// row shapes.
//
// No runtime code lives here — it's type-only by design so the
// `Database` wrapper in `db.ts` doesn't have to depend on the
// store module to see the row shapes.

// ─── Source registry ──────────────────────────────────────────────────────

/** The type discriminator in `news_sources.type`. Mirrors the
 *  string column in the DB (no CHECK constraint — app-layer
 *  allowlist per ADR-010). */
export type SourceType = 'rss' | 'atom' | 'json_api'

/** Categories rendered on the /news-weather page. The PRD's
 *  fixed order:
 *    1. General
 *    2. Economy
 *    3. Local and Politics
 *    4. Technology and Cybersecurity
 *  Weather is rendered separately on top, not as a category. */
export type NewsCategory =
  | 'General'
  | 'Economy'
  | 'Local and Politics'
  | 'Technology and Cybersecurity'
  | 'Weather'

/** Row shape of the `news_sources` table. The store layer reads
 *  rows in this shape and the scheduler / fetch-job writes them
 *  back. The `id` is `INTEGER` (autoincrement) per the migration. */
export interface Source {
  readonly id: number
  readonly name: string
  readonly category: string
  readonly type: SourceType
  readonly url: string
  readonly enabled: boolean
  readonly refreshIntervalMin: number
  readonly lastFetchedAt: string | null
  readonly lastSuccessfulFetchAt: string | null
  readonly lastError: string | null
  readonly createdAt: string
}

/** State fields the store updates on a fetch attempt. All
 *  optional so callers can update just one (e.g. clear
 *  `lastError` on success without re-stating the timestamps). */
export interface SourceStateUpdate {
  readonly lastFetchedAt?: string
  readonly lastSuccessfulFetchAt?: string
  readonly lastError?: string | null
}

// ─── Articles ─────────────────────────────────────────────────────────────

/** What a fetcher returns per item. Vendor-agnostic — RSS and
 *  Atom use different field names upstream (`guid` vs `<id>`,
 *  `pubDate` vs `isoDate`) but by the time the fetcher has
 *  finished the shape is uniform. The normalizer maps this to
 *  `NormalizedArticle`.
 *
 *  `id` is required to be present after the fetcher has run
 *  (RSS guid or Atom `<id>`); `url` is required for link
 *  generation. The normalizer may return null if BOTH are
 *  missing (AC requirement: "we can't dedupe or link without
 *  one"). */
export interface RawArticle {
  /** Feed-supplied identifier (RSS `guid` or Atom `<id>`). */
  readonly id: string
  /** Canonical link to the article. */
  readonly url: string
  /** Title (may include HTML; the normalizer trims+strips). */
  readonly title: string
  /** Description / summary (may include HTML; the normalizer
   *  strips). May be empty. */
  readonly description: string
  /** Publication timestamp, raw from the feed. The normalizer
   *  parses to ISO 8601 or returns undefined if unparseable. */
  readonly publishedAt: string | undefined
}

/** What the normalizer returns: trim+strip+truncate applied,
 *  `id` resolved to a dedup-safe value (URL fallback). This is
 *  the shape the store inserts into `news_articles`. */
export interface NormalizedArticle {
  /** Dedup-safe identifier. Either the feed's guid/Atom-id, or
   *  the URL when guid is missing. Always present. */
  readonly id: string
  readonly title: string
  /** Plain text, truncated to 500 chars at a word boundary.
   *  May be empty. */
  readonly description: string
  readonly url: string
  /** ISO 8601 or undefined if the feed's date was unparseable. */
  readonly publishedAt: string | undefined
}

/** Row shape of the `news_articles` table. The store returns
 *  this on read paths (e.g. `listArticlesByCategory`). `sourceId`
 *  is the news_sources row the article was ingested from. */
export interface Article {
  readonly id: string
  readonly sourceId: number
  readonly title: string
  readonly description: string | null
  readonly url: string
  readonly publishedAt: string | null
  readonly fetchedAt: string
}

// ─── Weather ──────────────────────────────────────────────────────────────

/** Open-Meteo's `current` block. Field names mirror the API
 *  response (camelCased). All fields are optional because
 *  Open-Meteo returns only the parameters requested in the URL. */
export interface WeatherCurrent {
  readonly time?: string
  readonly temperature_2m?: number
  readonly apparent_temperature?: number
  readonly precipitation?: number
  readonly rain?: number
  readonly weather_code?: number
  readonly wind_speed_10m?: number
  readonly wind_gusts_10m?: number
}

/** One day in the Open-Meteo `daily` block. Field names mirror
 *  the API. `time` is the local date string `YYYY-MM-DD`. */
export interface WeatherDaily {
  readonly time: string
  readonly weather_code?: number
  readonly temperature_2m_max?: number
  readonly temperature_2m_min?: number
  readonly precipitation_probability_max?: number
  readonly sunrise?: string
  readonly sunset?: string
}

/** One hour in the Open-Meteo `hourly` block. Field names mirror
 *  the API. `time` is the local datetime string. */
export interface WeatherHourly {
  readonly time: string
  readonly temperature_2m?: number
  readonly precipitation_probability?: number
  readonly precipitation?: number
  readonly weather_code?: number
}

/** Returned by `OpenMeteoFetcher.fetch()`. The store serializes
 *  the three arrays into the `_json` columns verbatim — the
 *  page layer parses them back into this shape for rendering. */
export interface WeatherSnapshot {
  /** ISO 8601 of when the snapshot was retrieved, populated
   *  by the fetcher (not the API — the API doesn't echo
   *  fetch time). */
  readonly fetchedAt: string
  readonly current: WeatherCurrent
  readonly daily: ReadonlyArray<WeatherDaily>
  readonly hourly: ReadonlyArray<WeatherHourly>
}

// ─── Errors ───────────────────────────────────────────────────────────────

/** Single typed error class for all three fetchers. The
 *  orchestrator (`NewsFetchJob`) catches and returns
 *  `{ ok: false, error: err.message }` so the caller never has
 *  to branch on the error class.
 *
 *  Constructed with a string message; the optional `cause` is
 *  the underlying error (network error, parser error, etc.) for
 *  logging. The `kind` field lets the orchestrator decide
 *  whether to log at warn or error level without parsing
 *  messages. */
export class FetchError extends Error {
  constructor(
    message: string,
    readonly kind: FetchErrorKind,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'FetchError'
  }
}

export type FetchErrorKind = 'network' | 'parse' | 'timeout'
