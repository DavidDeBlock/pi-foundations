// news/news-rss-fetcher.ts — issue NW-002
//
// Deep module: fetches one RSS 2.0 feed and returns a list of
// `RawArticle` (vendor-agnostic shape the normalizer consumes).
// Backed by `rss-parser` for the XML → JSON step. Does the HTTP
// fetch ourselves so we can:
//   * Set a hard `AbortController` timeout (rss-parser's own
//     timeout option is best-effort and not signal-aware).
//   * Set a custom User-Agent header so feeds that block
//     default Node UAs don't 403.
//   * Inject the HTTP transport for tests (no real network
//     in unit tests).
//
// We use `rss-parser`'s `parseString` rather than `parseURL`:
// `parseURL` does its own fetch internally and ignores our
// timeout/UA configuration. Doing the fetch here + `parseString`
// is the only way to enforce a 15s ceiling.
//
// What can throw:
//   * Network / timeout / non-2xx → `FetchError({ kind: 'network' | 'timeout' })`
//   * 2xx but body isn't valid XML → `FetchError({ kind: 'parse' })`
//
// Empty feeds (parser returns 0 items) are NOT an error — they
// return `[]` per the AC. (Open-Meteo is the odd one out; for
// the RSS/Atom fetchers an empty list is just "nothing new".)

import Parser from 'rss-parser'
import { FetchError, type RawArticle, type SourceType } from './types.js'

// ─── Defaults ────────────────────────────────────────────────────────────

/** Default per-call timeout. 15s per ADR-010: generous for a
 *  small feed, bounded so a hung connection can't stall the
 *  scheduler (which fetches all due sources in parallel). */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000

// ─── Public surface ───────────────────────────────────────────────────────

/** What kind of feed this fetcher handles. Wired through so
 *  the orchestrator can pick the right fetcher without a switch
 *  on `instanceof`. */
export const SOURCE_TYPE: SourceType = 'rss'

/** Pluggable HTTP transport. Mirrors the YouTube RSS fetcher's
 *  pattern so tests can pass a stub that returns canned
 *  responses. Default: global `fetch` (Node 22). */
export type HttpFetcher = (
  url: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>

const defaultHttpFetcher: HttpFetcher = (url, init) => fetch(url, init)

export interface NewsRssFetcherOptions {
  /** Override the HTTP transport (default: global `fetch`). */
  readonly httpFetcher?: HttpFetcher
  /** Public URL the dashboard is reachable at. Used in the
   *  User-Agent header (`Dashboard/1.0 (+<serverUrl>)`). When
   *  omitted, falls back to `localhost` — boot wiring (NW-005)
   *  plumbs the real value from env. */
  readonly serverUrl?: string
  /** Default timeout for `fetch()` if not overridden per-call. */
  readonly defaultTimeoutMs?: number
}

/**
 * Fetches RSS 2.0 feeds. The contract:
 *
 *   * 2xx + valid RSS XML → `RawArticle[]` (possibly empty).
 *   * Non-2xx (404, 5xx, network failure) → throws `FetchError`.
 *   * 2xx but body isn't valid XML → throws `FetchError`.
 *   * AbortController timeout → throws `FetchError({ kind: 'timeout' })`.
 *
 * The `RawArticle` shape is what the normalizer consumes;
 * vendor-specific fields (`pubDate`, `creator`, etc.) don't
 * leak past this layer.
 */
export class NewsRssFetcher {
  readonly #httpFetcher: HttpFetcher
  readonly #serverUrl: string
  readonly #defaultTimeoutMs: number
  readonly #parser: Parser

  constructor(options: NewsRssFetcherOptions = {}) {
    this.#httpFetcher = options.httpFetcher ?? defaultHttpFetcher
    this.#serverUrl = options.serverUrl ?? 'localhost'
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    // rss-parser's defaults are fine for RSS 2.0: it handles
    // CDATA, namespaces, and the single-vs-multi entry case
    // without further config.
    this.#parser = new Parser()
  }

  /**
   * Fetch and parse one RSS feed.
   *
   * @param url   The feed URL.
   * @param opts  Optional per-call overrides. `timeoutMs`
   *              overrides the constructor default; useful in
   *              tests where a stub is fast and a long timeout
   *              would just slow the test down.
   */
  async fetch(
    url: string,
    opts: { readonly timeoutMs?: number } = {},
  ): Promise<RawArticle[]> {
    const timeoutMs = opts.timeoutMs ?? this.#defaultTimeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await this.#httpFetcher(url, {
        headers: {
          'user-agent': `Dashboard/1.0 (+${this.#serverUrl})`,
          accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.5',
        },
        signal: controller.signal,
      })
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new FetchError(
          `RSS request timed out after ${timeoutMs}ms for ${url}`,
          'timeout',
          err,
        )
      }
      throw new FetchError(
        `RSS request failed for ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        'network',
        err,
      )
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      throw new FetchError(
        `RSS feed returned HTTP ${response.status} for ${url}`,
        'network',
      )
    }

    let body: string
    try {
      body = await response.text()
    } catch (err: unknown) {
      throw new FetchError(
        `RSS body read failed for ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        'network',
        err,
      )
    }

    if (body.trim() === '') {
      // An empty body is a valid (empty) feed. NOT an error.
      return []
    }

    let parsed: Awaited<ReturnType<Parser['parseString']>>
    try {
      parsed = await this.#parser.parseString(body)
    } catch (err: unknown) {
      throw new FetchError(
        `malformed RSS XML for ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        'parse',
        err,
      )
    }

    const items = Array.isArray(parsed.items) ? parsed.items : []
    const out: RawArticle[] = []
    for (const item of items) {
      // rss-parser's `Item.guid` is typed as optional string
      // but the parser is permissive about it. We treat any
      // truthy value as a usable id; the normalizer decides
      // whether to fall back to the URL.
      const id = pickString(item.guid)
      const link = pickString(item.link)
      const title = pickString(item.title)
      if (title === undefined) continue
      out.push({
        id: id ?? '',
        url: link ?? '',
        title,
        description: pickString(item.contentSnippet) ?? pickString(item.content) ?? pickString(item.summary) ?? '',
        // RSS uses `pubDate` (RFC 822) by default; `isoDate` is
        // populated when the parser can convert. We hand both
        // to the normalizer — it picks whichever parses.
        publishedAt: pickString(item.isoDate) ?? pickString(item.pubDate),
      })
    }
    return out
  }
}

function pickString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.length > 0 ? value : undefined
}
