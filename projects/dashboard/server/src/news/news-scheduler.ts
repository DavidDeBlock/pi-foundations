// news/news-scheduler.ts — issue NW-003
//
// Background scheduler for the news poller. Mirrors
// `YouTubeRssScheduler` (timer + first-poll pattern) so a
// reader who knows the YouTube code knows this one:
//
//   * First poll fires ~15s after boot
//   * Subsequent ticks every 60s (configurable constant)
//   * Per-source `refresh_interval_min` is separate and lives
//     on the row (the AC for the *scheduler* is one fixed
//     "is it time to look at the list again" interval; the
//     per-source due-check happens inside the orchestrator).
//   * `.unref()`-ed `setInterval` so the scheduler doesn't
//     block process exit
//   * `stop()` clears the interval AND any pending
//     `setTimeout` for the first-poll delay
//   * Idempotent `start()` and `stop()`
//
// The actual tick logic (due-check, in-flight tracking,
// parallel fetch, state updates) lives in
// `NewsSchedulerOrchestrator`. This file is just a thin
// timer wrapper — same separation as YT-004 used for
// `YouTubeRssPoller` vs `YouTubeRssScheduler`.

import type { NewsSchedulerOrchestrator, TickSummary } from './news-scheduler-orchestrator.js'

// ─── Defaults ────────────────────────────────────────────────────────────

/** Default scheduler tick interval, minutes. The per-source
 *  refresh interval is a separate row-level setting; this is
 *  the *frequency at which we re-evaluate the due-check*. */
export const DEFAULT_NEWS_INTERVAL_MIN = 1

/** First-poll delay, ms. Matches the YouTube scheduler (~15s).
 *  Long enough that the HTTP server has bound by the time the
 *  first fetch fires; short enough that an operator hitting
 *  reload sees results come in within a reasonable wait. */
export const DEFAULT_FIRST_POLL_DELAY_MS = 15_000

const MS_PER_MINUTE = 60 * 1000

// ─── Timer abstraction ───────────────────────────────────────────────────

/**
 * Timer abstraction. Mirrors the YouTube scheduler's
 * `RssIntervalScheduler` shape so swapping implementations
 * is a one-liner. Tests inject a deterministic double that
 * captures scheduled callbacks without firing timers; that
 * pattern dodges the `vi.useFakeTimers` + real-async races.
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

export interface NewsSchedulerDeps {
  readonly orchestrator: NewsSchedulerOrchestrator
  /** Scheduler tick interval in minutes. Default 1 (one
   *  re-evaluation per minute). `0` disables the scheduler
   *  entirely (manual-only mode, used by tests + boot wiring
   *  that wires a manual POST endpoint instead). */
  readonly intervalMin?: number
  /** First-poll delay in ms. Default 15_000 (~15s). */
  readonly firstPollDelayMs?: number
  /** Injected clock; defaults to `Date.now`. */
  readonly nowMs?: () => number
  /** Timer abstraction; defaults to a `setInterval`-based one. */
  readonly intervalScheduler?: RssIntervalScheduler
}

/**
 * Owns the recurring + one-shot timers and invokes the
 * orchestrator's `tick()` on each fire.
 *
 * Lifecycle:
 *   * `start()` schedules the first poll after `firstPollDelayMs`
 *     and the recurring poll every `intervalMin * 60_000` ms.
 *   * `stop()` cancels both timers. Idempotent.
 *   * `runOnce()` is public for tests and the boot wiring's
 *     manual route (NW-005 will define
 *     `POST /api/news/refresh`).
 *
 * When `intervalMin === 0`, the scheduler is intentionally inert
 * — manual-only mode. The boot wiring's manual endpoint is the
 * only path that runs the orchestrator.
 */
export class NewsScheduler {
  readonly #orchestrator: NewsSchedulerOrchestrator
  readonly #intervalMin: number
  readonly #firstPollDelayMs: number
  readonly #nowMs: () => number
  readonly #intervalScheduler: RssIntervalScheduler
  readonly #intervalMs: number

  #cancelInterval: (() => void) | null = null
  #cancelTimeout: (() => void) | null = null

  constructor(deps: NewsSchedulerDeps) {
    this.#orchestrator = deps.orchestrator
    this.#intervalMin = deps.intervalMin ?? DEFAULT_NEWS_INTERVAL_MIN
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

  /** Begin polling. Idempotent. Fires the first tick after
   *  `firstPollDelayMs`, then every `intervalMin` minutes. */
  start(): void {
    if (this.#cancelInterval !== null || this.#cancelTimeout !== null) return
    if (!this.isEnabled()) {
      // eslint-disable-next-line no-console
      console.log(
        '[news-scheduler] disabled (intervalMin=0). Manual triggers only.',
      )
      return
    }
    // eslint-disable-next-line no-console
    console.log(
      `[news-scheduler] starting; interval=${this.#intervalMin}min, first-poll-delay=${this.#firstPollDelayMs}ms`,
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
   *  and so the manual `/api/news/refresh` route can reuse it. */
  async runOnce(): Promise<TickSummary> {
    return this.#runOnceSafe()
  }

  async #runOnceSafe(): Promise<TickSummary> {
    const startedAt = this.#nowMs()
    try {
      const summary = await this.#orchestrator.tick(
        new Date(this.#nowMs()),
      )
      const elapsedMs = this.#nowMs() - startedAt
      // eslint-disable-next-line no-console
      console.log(
        `[news-scheduler] tick: ${summary.succeededCount}/${summary.fetchedCount} ok (${summary.failedCount} failed, ${summary.inFlightCount} skipped) (${elapsedMs}ms)`,
      )
      return summary
    } catch (err: unknown) {
      // Tick MUST NOT crash the process. If the orchestrator
      // throws (it shouldn't — it has internal try/catches —
      // but defense-in-depth), log and return an empty
      // summary so the scheduler stays alive for the next tick.
      const message = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.error(
        `[news-scheduler] tick crashed unexpectedly: ${message}`,
      )
      const nowIso = new Date(this.#nowMs()).toISOString()
      return {
        fetchedCount: 0,
        succeededCount: 0,
        failedCount: 0,
        inFlightCount: 0,
        ranAt: nowIso,
        results: [],
      }
    }
  }
}
