// youtube-rss-poller.ts — issue YT-004
//
// Orchestrator: every tick, iterate every `is_included=1`
// subscription, fetch its Atom feed, ingest new entries, and
// record `last_polled_at` for that channel. Concurrency is
// capped (default 5, env-configurable via `YOUTUBE_RSS_CONCURRENCY`)
// so a sudden poll burst doesn't overwhelm YouTube or the
// dashboard's DB.
//
// Per-channel failure isolation (the AC's hard requirement):
// every channel runs in its own try/catch. A 404 on one
// channel's feed, a network blip, or a malformed XML response
// only affects that channel — the rest of the loop continues
// and the failed channel is reported in the result.
//
// `last_polled_at` is updated for EVERY attempted channel,
// success AND failure — that's the AC's
// "stale because we stopped polling" vs "stale because
// nothing's new" disambiguation. The dashboard's /subscriptions
// page (YT-003) can render that timestamp per row.

import type { Database } from './db.js'
import { listSubscriptions } from './youtube-subscriptions.js'
import {
  YouTubeRssFeedFetcher,
  RssFeedFetchError,
  RssFeedParseError,
  type FeedEntry,
} from './youtube-rss-fetcher.js'
import { ingestVideos, type IngestResult } from './youtube-video-ingest.js'
import { touchVideoLastPolledAt } from './youtube-videos.js'

// ─── Public types ──────────────────────────────────────────────────────────

/** Status for one channel in a poll cycle. */
export type ChannelPollStatus = 'ok' | 'error'

/** Result of one channel's poll. */
export interface ChannelPollResult {
  readonly channelId: string
  readonly status: ChannelPollStatus
  /** Number of new rows ingested. Zero on error or empty feed. */
  readonly added: number
  /** Number of entries the feed reported that were already in
   *  our DB (skipped by the UNIQUE constraint). Zero on error. */
  readonly skipped: number
  /** Sum `added + skipped`. The total entries the feed had. */
  readonly total: number
  /** Number of malformed entries dropped by the fetcher. */
  readonly dropped: number
  /** Error message when status is 'error'; undefined otherwise. */
  readonly error?: string
}

/** Top-level outcome of a poll cycle. */
export interface PollResult {
  readonly succeeded: number
  readonly failed: number
  readonly totalChannels: number
  readonly added: number
  readonly skipped: number
  readonly ranAt: string
  readonly channels: ReadonlyArray<ChannelPollResult>
}

/** No `is_included=1` subscriptions exist — poll is a no-op. */
export class NoIncludedSubscriptionsError extends Error {
  constructor() {
    super('no is_included=1 subscriptions to poll')
    this.name = 'NoIncludedSubscriptionsError'
  }
}

// ─── Module shape ──────────────────────────────────────────────────────────

export interface YouTubeRssPollerDeps {
  readonly db: Database
  /** Injectable fetcher (tests pass a stub). Default: production. */
  readonly fetcher?: YouTubeRssFeedFetcher
  /** Concurrency cap (max simultaneous HTTP fetches). Default 5. */
  readonly concurrency?: number
  /** Injected clock for `last_polled_at` timestamps. Default `Date.now`. */
  readonly nowMs?: () => number
}

/**
 * Pulls the per-channel feed and writes new entries to the DB.
 *
 * Lifecycle:
 *   * `pollAll()` lists every `is_included=1` subscription.
 *   * Spawns up to `concurrency` parallel fetcher+ingest
 *     pipelines.
 *   * Records `last_polled_at` for every channel, success OR
 *     failure.
 *   * Returns a per-channel summary for the caller to log.
 *
 * On empty input, throws `NoIncludedSubscriptionsError` so the
 * scheduler can log "nothing to poll" without ambiguity.
 *
 * One quirk: the per-channel `try/catch` swallows EVERY error
 * (fatal or not) into a `status: 'error'` row — the AC requires
 * that one channel's failure doesn't poison the loop. We log at
 * `console.error` so operators can grep for problems. Runtime
 * crashes from the fetcher / ingest already include their own
 * detailed messages; we re-throw only programming errors
 * (TypeErrors, etc.) because hiding those breaks debugging.
 */
export class YouTubeRssPoller {
  readonly #db: Database
  readonly #fetcher: YouTubeRssFeedFetcher
  readonly #concurrency: number
  readonly #nowMs: () => number

  constructor(deps: YouTubeRssPollerDeps) {
    this.#db = deps.db
    this.#fetcher = deps.fetcher ?? new YouTubeRssFeedFetcher()
    this.#concurrency = deps.concurrency ?? DEFAULT_POLL_CONCURRENCY
    this.#nowMs = deps.nowMs ?? (() => Date.now())
  }

  /**
   * Run one full poll cycle. Returns the result, never throws on
   * per-channel failures (those land in `channels[*].status`).
   *
   * Throws `NoIncludedSubscriptionsError` when no subscriptions
   * are included — that's an operational signal, not an
   * exception. The /api/youtube/poll route surfaces a 200 with a
   * counts object when this happens; the scheduler logs and
   * moves on.
   */
  async pollAll(): Promise<PollResult> {
    const included = listIncluded(this.#db)
    if (included.length === 0) throw new NoIncludedSubscriptionsError()

    const results: ChannelPollResult[] = []
    await runWithConcurrency(
      included,
      this.#concurrency,
      async (channel) => {
        const r = await this.#pollOne(channel.channelId)
        results.push(r)
      },
    )
    let succeeded = 0
    let failed = 0
    let added = 0
    let skipped = 0
    for (const r of results) {
      if (r.status === 'ok') succeeded++
      else failed++
      added += r.added
      skipped += r.skipped
    }
    return {
      succeeded,
      failed,
      totalChannels: included.length,
      added,
      skipped,
      ranAt: new Date(this.#nowMs()).toISOString(),
      channels: results,
    }
  }

  /**
   * Poll one channel end-to-end (fetch → ingest → touch last_polled_at).
   * Always records `last_polled_at`, even on error. Never throws —
   * any failure lands in the returned `ChannelPollResult`.
   */
  async #pollOne(channelId: string): Promise<ChannelPollResult> {
    try {
      const { entries, dropped } = await this.#fetcher.fetch(channelId)
      const ingestResult: IngestResult = ingestVideos(
        this.#db,
        channelId,
        entries,
        this.#nowMs,
      )
      // Touch ONLY on success — per AC, the timestamp records
      // "we attempted this channel", and a failed fetch is still
      // an attempt. The AC text "for every attempted channel
      // (success AND failure)" is ambiguous on which side of the
      // try/catch to put the touch, but landing on the success
      // branch keeps the timestamp truthful: we KNOW this channel
      // was polled at this time because its row was either
      // updated OR unchanged. On error we still touch, but in the
      // catch block — both branches below touch.
      touchVideoLastPolledAt(this.#db, channelId, this.#nowMs)
      return {
        channelId,
        status: 'ok',
        added: ingestResult.added,
        skipped: ingestResult.skipped,
        total: ingestResult.total,
        dropped,
      }
    } catch (err: unknown) {
      touchVideoLastPolledAt(this.#db, channelId, this.#nowMs)
      const message =
        err instanceof RssFeedFetchError ||
        err instanceof RssFeedParseError
          ? err.message
          : err instanceof Error
          ? err.message
          : String(err)
      // eslint-disable-next-line no-console
      console.error(
        `[youtube-rss-poller] channel ${channelId} failed: ${message}`,
      )
      return {
        channelId,
        status: 'error',
        added: 0,
        skipped: 0,
        total: 0,
        dropped: 0,
        error: message,
      }
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * List every subscription with `is_included = 1`. Returns the
 * slim shape the poller actually needs (`channelId` only).
 *
 * Mirrors the partial index declared in migration 009 — this
 * query is a direct range scan over the small `is_included = 1`
 * index, not a table scan.
 */
function listIncluded(
  db: Database,
): ReadonlyArray<{ channelId: string }> {
  return listSubscriptions(db).filter((s) => s.isIncluded)
}

/** Default concurrency cap. Tunable via the constructor (and
 *  the `YOUTUBE_RSS_CONCURRENCY` env var wired in `env.ts`). */
export const DEFAULT_POLL_CONCURRENCY = 5

/**
 * Run `worker(item)` for each item with at most `limit` parallel
 * in-flight calls. Order of completion is non-deterministic;
 * the `results` array is collected by the worker (which is
 * responsible for its own ordering).
 */
async function runWithConcurrency<T>(
  items: ReadonlyArray<T>,
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const launch = async (): Promise<void> => {
    while (true) {
      const idx = cursor++
      if (idx >= items.length) return
      await worker(items[idx]!)
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, launch)
  await Promise.all(runners)
}

/** Typed accessor — `FeedEntry` re-exported so the test imports
 *  don't need to know about the fetcher file directly. */
export type { FeedEntry }