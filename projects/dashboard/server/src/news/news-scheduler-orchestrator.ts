// news/news-scheduler-orchestrator.ts — issue NW-003
//
// Tick body for the news scheduler: once per minute, fetch
// the due sources, write state updates, and report a
// TickSummary to the caller.
//
// Two requirements shape this module:
//
//   1. Concurrent fetch + per-source failure isolation (ADR-010
//      decision 6). `Promise.allSettled` ensures one slow /
//      broken source doesn't starve the others — each source
//      runs in its own micro-task, and one rejected promise
//      leaves the rest intact.
//
//   2. In-flight tracking (NW-003 AC). If a fetch outlives a
//      tick (e.g. a 15s timeout on a slow RSS endpoint while
//      the scheduler fires every 60s), the next tick must
//      skip that source — otherwise a slow feed gets fetched
//      repeatedly in parallel and burns through the request
//      quota. A small in-process `Set<number>` does the trick;
//      we add the id before the fetch and remove it in
//      `finally` so a thrown fetch still releases the slot.
//
// The orchestrator does NOT own timers. The scheduler owns
// timers and calls `tick()` on each fire. This split mirrors
// `YouTubeRssPoller` (orchestrator) vs `YouTubeRssScheduler`
// (timer) — keeping the timer-free logic unit-testable without
// any fake-timer dance.

import type { NewsFetchJob, FetchJobResult } from './news-fetch-job.js'
import type { NewsStore } from './news-store.js'
import type { Source } from './types.js'

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * What one tick did. Returned to the scheduler for logging
 * (the scheduler calls `console.log('[news-scheduler] tick: …')`
 * the same way `YouTubeRssScheduler` does). The counts let the
 * boot wiring (NW-005) expose a metrics surface later without
 * a code change.
 *
 *  - `fetchedCount`    : how many due sources we actually
 *                        invoked a fetch for (i.e. due minus
 *                        in-flight).
 *  - `succeededCount`  : how many of those returned
 *                        `{ ok: true }`.
 *  - `failedCount`     : how many returned `{ ok: false }` (or
 *                        had their `NewsFetchJob.run` reject).
 *  - `inFlightCount`   : how many sources were skipped this
 *                        tick because they were already in
 *                        flight from a prior tick.
 *
 * Invariant: `succeededCount + failedCount === fetchedCount`.
 * The `inFlightCount` line item is a separate class of skipped
 * source — due but already running.
 */
export interface TickSummary {
  readonly fetchedCount: number
  readonly succeededCount: number
  readonly failedCount: number
  readonly inFlightCount: number
  /** ISO timestamp the orchestrator used as `now` for the
   *  due-check and state updates. Echoed for log fidelity. */
  readonly ranAt: string
  /**
   * Per-source results, in due order. Use for diagnostics
   * (boot wiring / smoke) — production logs prefer the
   * summary counts.
   */
  readonly results: ReadonlyArray<{
    readonly sourceId: number
    readonly status: 'ok' | 'error' | 'skipped-in-flight'
    readonly inserted?: number
    readonly error?: string
  }>
}

// ─── Constructor deps ─────────────────────────────────────────────────────

export interface NewsSchedulerOrchestratorDeps {
  readonly store: NewsStore
  /** The actual unit of work. Tests inject a stub. Production
   *  wires `new NewsFetchJob({ store })` once at boot. */
  readonly job: NewsFetchJob
  /** Injected clock for `now`. Default: `Date.now`. The
   *  scheduler typically passes the same `nowMs` it uses for
   *  the timers so timestamps line up with log entries. */
  readonly nowMs?: () => number
}

// ─── Module shape ─────────────────────────────────────────────────────────

/**
 * One tick of the news scheduler. Owns the in-flight set.
 *
 * Lifecycle:
 *   * `tick(now?)` runs once. Returns a `TickSummary`.
 *   * `tick()` is safe to call from a `Promise.allSettled`-style
 *     scheduler or directly from a manual route — both reuse
 *     the same orchestrator instance.
 *
 * Concurrency:
 *   * Per-source in-flight is tracked in `#inFlight` (a
 *     `Set<number>` of source ids). A tick that finds a source
 *     already in flight SKIPS it (records `skipped-in-flight`,
 *     counts it in `inFlightCount`).
 *   * Sources that ARE due and NOT in flight all run in parallel
 *     via `Promise.allSettled`. The set is cleared in a
 *     `finally` block per source so even a synchronous throw
 *     inside `newsFetchJob.run` releases the slot.
 *
 * State writes:
 *   * `last_fetched_at` is updated on entry by `NewsFetchJob`
 *     (NW-002 AC). The orchestrator only writes on exit —
 *     `last_successful_fetch_at` + `last_error` clear on ok;
 *     `last_error` set + `last_successful_fetch_at` left alone
 *     on failure.
 */
export class NewsSchedulerOrchestrator {
  readonly #store: NewsStore
  readonly #job: NewsFetchJob
  readonly #nowMs: () => number
  readonly #inFlight: Set<number> = new Set()

  constructor(deps: NewsSchedulerOrchestratorDeps) {
    this.#store = deps.store
    this.#job = deps.job
    this.#nowMs = deps.nowMs ?? (() => Date.now())
  }

  /**
   * Number of sources currently being fetched by an earlier
   * tick. Exposed for the boot wiring to log at startup
   * (mostly useful as a sanity check — should usually be 0).
   */
  inFlightCount(): number {
    return this.#inFlight.size
  }

  /**
   * Run one scheduler tick. Never throws.
   *
   * Default `now` is "now"; tests pass an explicit `Date` to
   * keep the run deterministic.
   */
  async tick(now?: Date): Promise<TickSummary> {
    const nowDate = now ?? new Date(this.#nowMs())
    const nowIso = nowDate.toISOString()
    const dueSources = this.#store.listDueSources(nowDate)

    // Partition into "fire now" and "skip — already in flight".
    const toFetch: Source[] = []
    const skipped: Source[] = []
    for (const s of dueSources) {
      if (this.#inFlight.has(s.id)) skipped.push(s)
      else toFetch.push(s)
    }

    const results: TickSummary['results'][number][] = []
    for (const s of skipped) {
      results.push({ sourceId: s.id, status: 'skipped-in-flight' })
    }

    // Each source gets its own try/catch (via the job's
    // `{ ok: false, error }` contract) AND its own
    // in-flight bookkeeping (added before, removed in
    // finally). Run them in parallel via allSettled.
    const settled = await Promise.allSettled(
      toFetch.map((s) => this.#withInFlight(s)),
    )

    let succeeded = 0
    let failed = 0
    for (let i = 0; i < toFetch.length; i++) {
      const s = toFetch[i]!
      const settledResult = settled[i]!
      // `withInFlight` is the only thing in the array; it
      // either returned a `FetchJobResult` (the job's ok
      // shape) or threw. We treat a rejection as a failed
      // fetch so the caller sees a consistent summary.
      if (settledResult.status === 'rejected') {
        const reason =
          settledResult.reason instanceof Error
            ? settledResult.reason.message
            : String(settledResult.reason)
        results.push({ sourceId: s.id, status: 'error', error: reason })
        failed++
        // State update per AC: failure path is
        // `last_fetched_at = now`, `last_error = <message>`,
        // `last_successful_fetch_at` left alone.
        try {
          this.#store.updateSourceState(s.id, {
            lastFetchedAt: nowIso,
            lastError: reason,
          })
        } catch {
          // The store may itself be in a bad state (e.g. DB
          // closed between ticks). We can't escalate, so
          // swallow and rely on `results` for diagnostics.
        }
        continue
      }
      const r: FetchJobResult = settledResult.value
      if (r.ok) {
        results.push({
          sourceId: s.id,
          status: 'ok',
          inserted: r.inserted,
        })
        succeeded++
        // State update per AC: success path is
        // `last_fetched_at = now`, `last_successful_fetch_at = now`,
        // `last_error = NULL`.
        try {
          this.#store.updateSourceState(s.id, {
            lastFetchedAt: nowIso,
            lastSuccessfulFetchAt: nowIso,
            lastError: null,
          })
        } catch {
          // Same rationale as the failure branch — the
          // store is the only escalation path and we don't
          // have a way around it being down. The on-disk
          // state is best-effort; the in-memory summary is
          // authoritative for the operator.
        }
      } else {
        results.push({
          sourceId: s.id,
          status: 'error',
          error: r.error,
        })
        failed++
        // State update per AC: `{ ok: false }` from the
        // job is treated identically to a rejection.
        try {
          this.#store.updateSourceState(s.id, {
            lastFetchedAt: nowIso,
            lastError: r.error,
          })
        } catch {
          // See failure branch above.
        }
      }
    }

    return {
      fetchedCount: toFetch.length,
      succeededCount: succeeded,
      failedCount: failed,
      inFlightCount: skipped.length,
      ranAt: nowIso,
      results,
    }
  }

  /**
   * Add the source id to the in-flight set, run the job,
   * remove it in `finally`. Always releases the slot, even
   * on synchronous throw.
   *
   * Returns the job's `FetchJobResult`; the orchestrator's
   * `tick()` unwraps the returned promise in `Promise.allSettled`.
   */
  async #withInFlight(source: Source): Promise<FetchJobResult> {
    this.#inFlight.add(source.id)
    try {
      return await this.#job.run(source)
    } finally {
      this.#inFlight.delete(source.id)
    }
  }
}
