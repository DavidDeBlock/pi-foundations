// news/news-atom-fetcher.ts — issue NW-002
//
// Deep module: fetches one Atom 1.0 feed and returns a list of
// `RawArticle` (vendor-agnostic shape). Backed by `rss-parser`,
// which natively supports Atom 1.0.
//
// Why a separate class from the RSS fetcher (instead of e.g.
// a shared base class)? Because the field names differ:
//   * Atom uses `<id>` for the unique identifier. RSS uses
//     `<guid>`. rss-parser normalizes both onto the same
//     `Item.guid` field, but the value of `<id>` in Atom is
//     typically a tag URI (`tag:example.com,2024:foo`) which
//     is unsuitable as a dedupe key in some downstream
//     consumers. The Atom fetcher maps that to `id` cleanly.
//   * Atom uses ISO 8601 for `<updated>` and `<published>`;
//     RSS uses RFC 822 for `<pubDate>`. rss-parser normalizes
//     onto `Item.isoDate`, which we prefer.
//   * Atom uses `<content>` or `<summary>` for the body. RSS
//     uses `<description>`. The fallback chain is different.
//
// Sharing logic via a base class would couple them; the AC
// lists them as separate modules with separate test files, so
// separate classes is the cleaner expression. Duplication is
// bounded to the HTTP fetch + parseString + pickString helpers
// — small, easy to keep in sync.

import Parser from 'rss-parser'
import { FetchError, type RawArticle, type SourceType } from './types.js'
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  type HttpFetcher,
} from './news-rss-fetcher.js'

// ─── Public surface ───────────────────────────────────────────────────────

/** Discriminator value matching `news_sources.type = 'atom'`. */
export const SOURCE_TYPE: SourceType = 'atom'

export interface NewsAtomFetcherOptions {
  readonly httpFetcher?: HttpFetcher
  readonly serverUrl?: string
  readonly defaultTimeoutMs?: number
}

/**
 * Fetches Atom 1.0 feeds. Same error contract as
 * `NewsRssFetcher`:
 *
 *   * 2xx + valid Atom XML → `RawArticle[]` (possibly empty).
 *   * Non-2xx / network failure → `FetchError({ kind: 'network' })`.
 *   * 2xx but body isn't valid XML → `FetchError({ kind: 'parse' })`.
 *   * AbortController timeout → `FetchError({ kind: 'timeout' })`.
 */
export class NewsAtomFetcher {
  readonly #httpFetcher: HttpFetcher
  readonly #serverUrl: string
  readonly #defaultTimeoutMs: number
  readonly #parser: Parser

  constructor(options: NewsAtomFetcherOptions = {}) {
    this.#httpFetcher = options.httpFetcher ?? defaultHttpFetcher()
    this.#serverUrl = options.serverUrl ?? 'localhost'
    this.#defaultTimeoutMs =
      options.defaultTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    // rss-parser auto-detects Atom; no special config needed.
    this.#parser = new Parser()
  }

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
          accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.5',
        },
        signal: controller.signal,
      })
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new FetchError(
          `Atom request timed out after ${timeoutMs}ms for ${url}`,
          'timeout',
          err,
        )
      }
      throw new FetchError(
        `Atom request failed for ${url}: ${
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
        `Atom feed returned HTTP ${response.status} for ${url}`,
        'network',
      )
    }

    let body: string
    try {
      body = await response.text()
    } catch (err: unknown) {
      throw new FetchError(
        `Atom body read failed for ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        'network',
        err,
      )
    }

    if (body.trim() === '') return []

    let parsed: Awaited<ReturnType<Parser['parseString']>>
    try {
      parsed = await this.#parser.parseString(body)
    } catch (err: unknown) {
      throw new FetchError(
        `malformed Atom XML for ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        'parse',
        err,
      )
    }

    const items = Array.isArray(parsed.items) ? parsed.items : []
    const out: RawArticle[] = []
    for (const item of items) {
      // Atom `<id>` is the canonical identifier. rss-parser
      // surfaces it on `Item.id` (NOT `Item.guid`, which is
      // the RSS-only field). For some Atom feeds (e.g. GitHub
      // releases) the value is a tag URI. We pass it through;
      // the normalizer doesn't care about its shape.
      const id = pickString(item.id) ?? pickString(item.guid)
      const link = pickString(item.link)
      const title = pickString(item.title)
      if (title === undefined) continue
      out.push({
        id: id ?? '',
        url: link ?? '',
        title,
        description:
          pickString(item.contentSnippet) ??
          pickString(item.summary) ??
          pickString(item.content) ??
          '',
        imageUrl: item.enclosure?.url && (!item.enclosure.type || item.enclosure.type.startsWith('image/'))
          ? item.enclosure.url
          : imageFromHtml(item.content) ?? imageFromHtml(item.summary),
        // Atom items have `isoDate`; if missing, fall back to
        // `pubDate` (rss-parser sometimes sets it). The
        // normalizer picks whichever parses.
        publishedAt: pickString(item.isoDate) ?? pickString(item.pubDate),
      })
    }
    return out
  }
}

function imageFromHtml(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(value)
  return match?.[1]
}

// Re-export the default HTTP fetcher so the constructor
// default can use it without a circular import to
// news-rss-fetcher's private default.
function defaultHttpFetcher(): HttpFetcher {
  return (url, init) => fetch(url, init)
}

function pickString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.length > 0 ? value : undefined
}
