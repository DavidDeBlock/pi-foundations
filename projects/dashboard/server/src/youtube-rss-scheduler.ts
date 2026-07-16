// youtube-rss-scheduler.ts — issue YT-004
//
// Background scheduler for the RSS poller. Mirrors the
// subscriptions scheduler:
//   * 15-min interval between polls
//   * First poll runs ~15s after boot (AC requirement: surface
//     issues early so a misconfigured dashboard fails loud at
//     boot, not silently hours later)
//   * `.unref()`-ed setInterval — process can exit cleanly
//   * Idempotent start/stop
//   * Per-tick errors logged but the interval keeps firing
//
// The actual polling logic lives in `YouTubeRssPoller`. This
// scheduler is just a thin timer wrapper.

import type { YouTubeRssPoller } from './youtube-rss-poller.js'

// ─── Defaults ────────────────────────────────────────────────────────────

/** Default RSS poll interval, minutes. */
export const DEFAULT_YOUTUBE_RSS_INTERVAL_MIN = 15

/** First-poll delay, ms. Fired by a one-shot setTimeout at
 *  start; ~15s is a deliberate trade-off: long enough that the
 *  HTTP server has had time to bind, short enough that an
 *  operator hitting `<Enter>` and then waiting a second sees
 *  results come in. */
export const DEFAULT_FIRST_POLL_DELAY_MS = 15_000

const MS_PER_MINUTE = 60 * 1000

// ─── Timer abstraction ───────────────────────────────────────────────────

/**
 * Timer abstraction. Mirrors the subscriptions scheduler's
 * `IntervalScheduler` shape (so swapping them is a one-liner).
 * Tests inject a deterministic scheduler that captures
 * scheduled callbacks without firing timers; that pattern
 * dodges the `vi.useFakeTimers` + real-async races.
 */
export interface RssIntervalScheduler {
  /**
   * Arm a recurring callback every `intervalMs`. Returns a
   * disposer the caller can call to cancel.
   */
  schedule(callback: () => void, intervalMs: number): () => void
  /**
   * Arm a one-shot callback after `delayMs`. Returns a
   * disposer. Used for the first-poll-delay on boot.
   */
  scheduleOnce(callback: () => void, delayMs: number): () => void
}

const defaultIntervalScheduler: RssIntervalScheduler = {
  schedule(callback, intervalMs) {
    const id = setInterval(callback, intervalMs)
    if (typeof id === 'object' && id !== null && 'unref' in id) {
      ;(id as { unref: () => void }).unref()
    }
    return () => clearInterval(id)
  },
  scheduleOnce(callback, delayMs) {
    const id = setTimeout(callback, delayMs)
    if (typeof id === 'object' && id !== null && 'unref' in id) {
      ;(id as { unref: () => void }).unref()
    }
    return () => clearTimeout(id)
  },
}

// ─── Scheduler ───────────────────────────────────────────────────────────

export interface YouTubeRssSchedulerDeps {
  readonly poller: YouTubeRssPoller
  /** Polling interval in minutes. Default 15; `0` disables the
   *  scheduler entirely (manual-only mode). */
  readonly intervalMin?: number
  /** First-poll delay in ms (the AC specifies ~15s). */
  readonly firstPollDelayMs?: number
  /** Injected clock; defaults to `Date.now`. */
  readonly nowMs?: () => number
  /** Timer abstraction; defaults to a `setInterval`-based one. */
  readonly intervalScheduler?: RssIntervalScheduler
}

/**
 * Owns the recurring + one-shot timers for RSS polling.
 *
 * Lifecycle:
 *   * `start()` schedules the first poll after `firstPollDelayMs`
 *     and the recurring poll every `intervalMin * 60_000` ms.
 *   * `stop()` cancels both timers. Idempotent.
 *   * `runOnce()` is public for tests (and the manual route).
 *
 * When `intervalMin === 0`, the scheduler is intentionally inert
 * — manual-only mode. The manual `POST /api/youtube/poll` route
 * (next step in this issue) is the only path that runs the
 * poller.
 */
export class YouTubeRssScheduler {
  readonly #poller: YouTubeRssPoller
  readonly #intervalMin: number
  readonly #firstPollDelayMs: number
  readonly #nowMs: () => number
  readonly #intervalScheduler: RssIntervalScheduler
  readonly #intervalMs: number

  #cancelInterval: (() => void) | null = null
  #cancelTimeout: (() => void) | null = null

  constructor(deps: YouTubeRssSchedulerDeps) {
    this.#poller = deps.poller
    this.#intervalMin = deps.intervalMin ?? DEFAULT_YOUTUBE_RSS_INTERVAL_MIN
    this.#firstPollDelayMs =
      deps.firstPollDelayMs ?? DEFAULT_FIRST_POLL_DELAY_MS
    this.#nowMs = deps.nowMs ?? (() => Date.now())
    this.#intervalScheduler =
      deps.intervalScheduler ?? defaultIntervalScheduler
    this.#intervalMs = this.#intervalMin * MS_PER_MINUTE
  }

  /** Whether `start()` would actually arm timers. When
   *  `intervalMin === 0` the scheduler is intentionally inert. */
  isEnabled(): boolean {
    return this.#intervalMin > 0
  }

  /** Begin polling. Idempotent. Fires the first poll after
   *  `firstPollDelayMs`, then every `intervalMin` minutes. */
  start(): void {
    if (this.#cancelInterval !== null || this.#cancelTimeout !== null) return
    if (!this.isEnabled()) {
      // eslint-disable-next-line no-console
      console.log(
        '[youtube-rss-scheduler] disabled (intervalMin=0). Manual triggers only.',
      )
      return
    }
    // eslint-disable-next-line no-console
    console.log(
      `[youtube-rss-scheduler] starting; interval=${this.#intervalMin}min, first-poll-delay=${this.#firstPollDelayMs}ms`,
    )
    this.#cancelTimeout = this.#intervalScheduler.scheduleOnce(
      () => this.#runOnceSafe(),
      this.#firstPollDelayMs,
    )
    this.#cancelInterval = this.#intervalScheduler.schedule(
      () => this.#runOnceSafe(),
      this.#intervalMs,
    )
  }

  /** Tear down both timers and refuse further ticks. Idempotent. */
  stop(): void {
    if (this.#cancelTimeout !== null) {
      this.#cancelTimeout()
      this.#cancelTimeout = null
    }
    if (this.#cancelInterval !== null) {
      this.#cancelInterval()
      this.#cancelInterval = null
    }
  }

  /** Execute one tick of the scheduler synchronously. Public so
   *  tests can drive it deterministically without fake timers,
   *  and so the manual `/api/youtube/poll` route can reuse it
   *  for the actual run (after auth). */
  async runOnce(): Promise<void> {
    await this.#runOnceSafe()
  }

  async #runOnceSafe(): Promise<void> {
    const startedAt = this.#nowMs()
    try {
      const result = await this.#poller.pollAll()
      const elapsedMs = this.#nowMs() - startedAt
      // eslint-disable-next-line no-console
      console.log(
        `[youtube-rss-scheduler] tick: ${result.succeeded}/${result.totalChannels} ok, +${result.added} new, ${result.failed} failed (${elapsedMs}ms)`,
      )
    } catch (err: unknown) {
      // Most common case: NoIncludedSubscriptionsError — the
      // operator hasn't toggled any channels to `is_included=1`.
      // That's fine, log at info not error.
      // eslint-disable-next-line no-console
      console.log(
        `[youtube-rss-scheduler] tick skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
}