// news/news-fetch-job.ts — issue NW-002
//
// Thin orchestrator: given one source row, run the right
// fetcher, normalize the result, write it through the store,
// and record success/failure on the source row.
//
// This is the unit of work the scheduler (NW-003) will call
// in parallel via `Promise.allSettled`. It must NEVER throw —
// every error path lands in the returned `{ ok: false, ... }`
// so the scheduler's parallel loop is free of try/catch noise.
//
// Per ADR-010's failure-isolation requirement: a fetch error
// on one source only affects that source. The scheduler
// handles cross-source isolation (one tick can fetch many
// sources; one bad source doesn't poison the others). This
// job handles WITHIN-source isolation (one bad item in a feed
// is skipped, the rest are inserted).
//
// State-update ordering:
//   * On entry: `updateSourceState({ lastFetchedAt: now })` so
//     the due-check is "we tried" even if normalization or
//     DB writes fail mid-flight.
//   * On success: `updateSourceState({ lastSuccessfulFetchAt: now, lastError: null })`.
//   * On any failure: `updateSourceState({ lastError: message })`.
//
// We do NOT touch `last_successful_fetch_at` on the success
// path until the writes have committed. If a write fails after
// the fetch succeeded, the fetch was wasted but the source
// shouldn't claim success.

import type { NewsStore } from './news-store.js'
import { NewsRssFetcher } from './news-rss-fetcher.js'
import { NewsAtomFetcher } from './news-atom-fetcher.js'
import { OpenMeteoFetcher } from './open-meteo-fetcher.js'
import { normalize } from './article-normalizer.js'
import type { Source } from './types.js'

// ─── Result shape ─────────────────────────────────────────────────────────

/** Outcome of one source's fetch. Returned by `run()`; never throws. */
export type FetchJobResult =
  | { readonly ok: true; readonly inserted: number }
  | { readonly ok: false; readonly error: string }

// ─── Constructor deps ─────────────────────────────────────────────────────

export interface NewsFetchJobDeps {
  readonly store: NewsStore
  /** Optional fetcher injection. Default: real instances. */
  readonly rssFetcher?: NewsRssFetcher
  readonly atomFetcher?: NewsAtomFetcher
  readonly openMeteoFetcher?: OpenMeteoFetcher
  /** Injected clock for `last_fetched_at` and the per-row `fetched_at`.
   *  Default: `Date.now`. Tests use this to drive deterministic
   *  timestamps and to skip ahead in the due-check math. */
  readonly nowMs?: () => number
}

// ─── Module shape ─────────────────────────────────────────────────────────

/**
 * One-source-at-a-time job. Stateless; safe to share between
 * scheduler ticks. The scheduler constructs this once at boot
 * and calls `run(source)` for each due source.
 */
export class NewsFetchJob {
  readonly #store: NewsStore
  readonly #rssFetcher: NewsRssFetcher
  readonly #atomFetcher: NewsAtomFetcher
  readonly #openMeteoFetcher: OpenMeteoFetcher
  readonly #nowMs: () => number

  constructor(deps: NewsFetchJobDeps) {
    this.#store = deps.store
    this.#rssFetcher = deps.rssFetcher ?? new NewsRssFetcher()
    this.#atomFetcher = deps.atomFetcher ?? new NewsAtomFetcher()
    this.#openMeteoFetcher = deps.openMeteoFetcher ?? new OpenMeteoFetcher()
    this.#nowMs = deps.nowMs ?? (() => Date.now())
  }

  /**
   * Run one fetch end-to-end. Never throws.
   *
   * Dispatches on `source.type`:
   *   * `'rss'`      → NewsRssFetcher
   *   * `'atom'`     → NewsAtomFetcher
   *   * `'json_api'` → OpenMeteoFetcher (weather; no articles)
   *
   * Unknown types surface as `{ ok: false, error }` rather
   * than throwing — a misconfigured `news_sources.type` value
   * shouldn't crash the scheduler.
   */
  async run(source: Source): Promise<FetchJobResult> {
    const nowIso = new Date(this.#nowMs()).toISOString()
    // Record the attempt first so the due-check reflects
    // "we tried" even if everything after this throws.
    // Update happens in a try/catch so a DB write failure
    // doesn't prevent us from reporting the upstream error
    // to the caller.
    try {
      this.#store.updateSourceState(source.id, { lastFetchedAt: nowIso })
    } catch (err) {
      // Swallow — we're about to return the upstream error
      // anyway. Logging here would just duplicate the
      // message that the caller will see in `error`.
    }

    try {
      switch (source.type) {
        case 'rss':
          return await this.#runArticleFetch(
            source,
            () => this.#rssFetcher.fetch(source.url),
          )
        case 'atom':
          return await this.#runArticleFetch(
            source,
            () => this.#atomFetcher.fetch(source.url),
          )
        case 'json_api':
          return await this.#runWeatherFetch(source)
        default:
          return {
            ok: false,
            error: `unsupported source type: ${JSON.stringify(source.type)}`,
          }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      try {
        this.#store.updateSourceState(source.id, { lastError: message })
      } catch {
        // The store update itself can fail (e.g. DB busy);
        // we don't have a way to escalate, so swallow.
      }
      return { ok: false, error: message }
    }
  }

  /**
   * Article-shaped fetches: normalize, insert, return count.
   * The `fetch` parameter is a thunk (rather than the result
   * of `await`) so the `try` wraps both the network call and
   * the normalization in a single error boundary — partial
   * normalizer panics should also report `{ ok: false }`.
   */
  async #runArticleFetch(
    source: Source,
    fetch: () => Promise<import('./types.js').RawArticle[]>,
  ): Promise<FetchJobResult> {
    const raw = await fetch()
    // Normalize. Per the AC, an item with no usable id+url is
    // dropped by the normalizer; the rest are inserted.
    const normalized = []
    for (const item of raw) {
      const n = normalize(item)
      if (n !== null) normalized.push(n)
    }
    const { inserted } = this.#store.insertArticles(
      source.id,
      normalized,
    )
    const nowIso = new Date(this.#nowMs()).toISOString()
    this.#store.updateSourceState(source.id, {
      lastSuccessfulFetchAt: nowIso,
      lastError: null,
    })
    return { ok: true, inserted }
  }

  /**
   * Weather-shaped fetch: one snapshot, replaced atomically.
   * `inserted` is meaningless here (no rows "inserted" in the
   * dedupe sense — the row was either new or it replaced an
   * existing one). The result omits `inserted` on the weather
   * path; callers can still tell success from the `ok: true`
   * discriminator.
   */
  async #runWeatherFetch(source: Source): Promise<FetchJobResult> {
    const snapshot = await this.#openMeteoFetcher.fetch(source.url)
    this.#store.upsertWeatherSnapshot(source.id, snapshot)
    const nowIso = new Date(this.#nowMs()).toISOString()
    this.#store.updateSourceState(source.id, {
      lastSuccessfulFetchAt: nowIso,
      lastError: null,
    })
    return { ok: true, inserted: 0 }
  }
}
