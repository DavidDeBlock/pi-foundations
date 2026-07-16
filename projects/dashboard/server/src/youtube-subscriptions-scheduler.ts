// youtube-subscriptions-scheduler.ts — issue YT-002
//
// Background scheduler for the subscriptions sync. Mirrors
// `email-sync-scheduler.ts` — same patterns, same DI shape,
// same lifecycle (start once on boot, stop on SIGINT/SIGTERM,
// idempotent on either side).
//
// Key differences from the email scheduler:
//   * Interval is in HOURS not minutes (24h default; minute-grain
//     would be silly for a daily sync).
//   * No per-account mutex / manual-trigger debounce — there's
//     only one account in v3.0 and no UI button to debounce
//     against. Single sync per tick, period.
//   * No "in progress" lock against concurrent runs: with one
//     account and 24h tick, the only way to overlap would be
//     a sync that takes >24h (never going to happen with
//     ~100 subscriptions).
//
// The scheduler logs every tick and every error so operators can
// see what happened. The dashboard's /subscriptions page will
// surface the last sync result (added/updated/removed) from the
// `subscriptions` row `updated_at` for the operator's convenience.

import type { YouTubeSubscriptionsSync } from './youtube-subscriptions-sync.js'

// ─── Defaults ────────────────────────────────────────────────────────────

/** Default sync interval, hours. Daily = 24h. */
export const DEFAULT_YOUTUBE_SYNC_INTERVAL_HOURS = 24

/** Interval unit, exposed so the wiring in `index.ts` reads naturally. */
export const MS_PER_HOUR = 60 * 60 * 1000

// ─── Timer abstraction ───────────────────────────────────────────────────

/**
 * Timer abstraction. Same shape as `email-sync-scheduler.ts`'s
 * `IntervalScheduler` — the production implementation wraps
 * `setInterval` and `.unref()`s the handle so a running scheduler
 * doesn't keep the Node process alive past `serve()` shutdown.
 *
 * Tests inject a deterministic scheduler that records calls
 * without firing timers; that pattern avoids the
 * `vi.useFakeTimers`-vs-real-async races the email scheduler
 * specifically calls out.
 */
export interface IntervalScheduler {
  /**
   * Arm a recurring callback every `intervalMs`. Returns a
   * disposer the caller can call to cancel.
   */
  schedule(callback: () => void, intervalMs: number): () => void
}

const defaultIntervalScheduler: IntervalScheduler = {
  schedule(callback, intervalMs) {
    const id = setInterval(callback, intervalMs)
    if (typeof id === 'object' && id !== null && 'unref' in id) {
      ;(id as { unref: () => void }).unref()
    }
    return () => clearInterval(id)
  },
}

// ─── Scheduler ───────────────────────────────────────────────────────────

export interface YouTubeSyncSchedulerDeps {
  readonly sync: YouTubeSubscriptionsSync
  /** Polling interval in hours. `0` disables the scheduler entirely
   *  (manual-only mode — `POST /api/youtube/sync` is the only path). */
  readonly intervalHours: number
  /** Injected clock; defaults to `Date.now`. */
  readonly nowMs?: () => number
  /** Timer abstraction; defaults to a `setInterval`-based
   *  implementation with `.unref()`. Tests inject a deterministic one. */
  readonly intervalScheduler?: IntervalScheduler
}

export class YouTubeSubscriptionsScheduler {
  readonly #sync: YouTubeSubscriptionsSync
  readonly #intervalHours: number
  readonly #nowMs: () => number
  readonly #intervalScheduler: IntervalScheduler
  readonly #intervalMs: number

  #cancelTimer: (() => void) | null = null

  constructor(deps: YouTubeSyncSchedulerDeps) {
    this.#sync = deps.sync
    this.#intervalHours = deps.intervalHours
    this.#nowMs = deps.nowMs ?? (() => Date.now())
    this.#intervalScheduler =
      deps.intervalScheduler ?? defaultIntervalScheduler
    this.#intervalMs = deps.intervalHours * MS_PER_HOUR
  }

  /** Whether `start()` would actually arm a timer. When
   *  `intervalHours === 0` the scheduler is intentionally inert
   *  — manual-only mode. */
  isEnabled(): boolean {
    return this.#intervalHours > 0
  }

  /** Begin polling at the configured interval. Idempotent —
   *  calling twice is a no-op. */
  start(): void {
    if (this.#cancelTimer !== null) return
    if (!this.isEnabled()) {
      // eslint-disable-next-line no-console
      console.log(
        '[youtube-subscriptions-scheduler] disabled (intervalHours=0). Manual triggers only.',
      )
      return
    }
    // eslint-disable-next-line no-console
    console.log(
      `[youtube-subscriptions-scheduler] starting; interval=${this.#intervalHours}h`,
    )
    this.#cancelTimer = this.#intervalScheduler.schedule(
      () => this.#runOnceSafe(),
      this.#intervalMs,
    )
  }

  /** Tear down the timer and refuse further ticks. Idempotent. */
  stop(): void {
    if (this.#cancelTimer === null) return
    this.#cancelTimer()
    this.#cancelTimer = null
  }

  /**
   * Execute one tick of the scheduler synchronously against
   * the shared `YouTubeSubscriptionsSync`. Public so tests can
   * drive it deterministically without advancing fake timers.
   *
   * Errors are caught here so a single misbehaving sync doesn't
   * poison the interval — the timer keeps firing at the next tick.
   */
  async runOnce(): Promise<void> {
    await this.#runOnceSafe()
  }

  async #runOnceSafe(): Promise<void> {
    const startedAt = this.#nowMs()
    try {
      const result = await this.#sync.sync()
      const elapsedMs = this.#nowMs() - startedAt
      // eslint-disable-next-line no-console
      console.log(
        `[youtube-subscriptions-scheduler] tick: +${result.added} ~${result.updated} -${result.removed} =${result.unchanged} (${result.total} total, ${elapsedMs}ms)`,
      )
    } catch (err: unknown) {
      // Common case: no account connected yet. That's fine — log
      // at info, not error. The operator just hasn't completed
      // the OAuth flow yet (or is on a fresh install).
      // eslint-disable-next-line no-console
      console.log(
        `[youtube-subscriptions-scheduler] tick skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
}