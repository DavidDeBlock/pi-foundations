// news/news-refresh-route.ts — issue NW-005
//
// HTTP route for the manual news refresh trigger.
//
//   POST /api/news/refresh    — runs one scheduler tick
//                                synchronously, returns the
//                                TickSummary as JSON.
//
// Why a manual trigger at all?
//   * Operators sometimes want to force a fetch right after
//     changing a source URL via SQL, before the next 60s tick.
//   * Useful for the smoke script: it can disable the auto-
//     scheduler via DASHBOARD_NEWS_INTERVAL_MIN=0 and rely on
//     this endpoint to drive ingestion.
//
// Why sync (200 with body) rather than kick-off (202 + poll)?
//   The scheduler's tick is bounded — one source runs in ~1-5s,
//   and the slowest source has a 15s timeout. Even if every source
//   is due in parallel, the wall-clock is bounded by the timeout
//   ceiling. A `200 + TickSummary` response is the simpler
//   contract and matches the email/manual-refresh precedent where
//   the operation is short. If a future migration makes ticks
//   longer (e.g. fetching hundreds of sources), this endpoint can
//   be flipped to async without breaking the response shape.

import { Hono } from 'hono'
import type { AuthVariables } from '../auth.js'
import type { NewsScheduler } from './news-scheduler.js'

// ─── Public types ─────────────────────────────────────────────────────────

/** Shape of the JSON response. Mirrors `TickSummary` from
 *  `news-scheduler-orchestrator.ts` but spelled out here so
 *  the API contract is decoupled from internal types (the
 *  internal `TickSummary` is allowed to evolve without
 *  breaking callers). */
export interface NewsRefreshResponse {
  readonly fetchedCount: number
  readonly succeededCount: number
  readonly failedCount: number
  readonly inFlightCount: number
  readonly ranAt: string
  readonly results: ReadonlyArray<{
    readonly sourceId: number
    readonly status: 'ok' | 'error' | 'skipped-in-flight'
    readonly inserted?: number
    readonly error?: string
  }>
}

// ─── Hono sub-app ─────────────────────────────────────────────────────────

export interface NewsRefreshRouteDeps {
  /** The scheduler whose `runOnce()` we invoke. Held in
   *  `main()` and threaded through `createApp()` so the
   *  boot wiring owns lifecycle (start / stop on signal)
   *  while the route owns "what happens on POST". */
  readonly scheduler: NewsScheduler
}

export function newsRefreshApi(
  deps: NewsRefreshRouteDeps,
): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  // ─── POST /api/news/refresh ─────────────────────────────────────
  // Run one tick. Synchronous; bounded wall-clock by the 15s
  // per-source timeout. Returns `200 + TickSummary` on success.
  //
  // Errors are NOT surfaced as non-2xx — the tick is internally
  // never-throws (`NewsScheduler.#runOnceSafe` catches any
  // throwable). A failure to run is a 500 (the scheduler itself
  // is broken — an operator needs to see it).
  api.post('/refresh', async (c) => {
    const summary = await deps.scheduler.runOnce()
    const body: NewsRefreshResponse = {
      fetchedCount: summary.fetchedCount,
      succeededCount: summary.succeededCount,
      failedCount: summary.failedCount,
      inFlightCount: summary.inFlightCount,
      ranAt: summary.ranAt,
      results: summary.results,
    }
    return c.json(body)
  })

  return api
}