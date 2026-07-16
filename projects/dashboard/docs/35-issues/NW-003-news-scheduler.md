# NW-003 — News scheduler (tick, due-check, allSettled, in-flight)

**Labels**: `news-weather`, `v5.0`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-008](../35-prds/PRD-008-news-weather.md)

## What to build

The background scheduler that ties everything together: tick loop, due-check, concurrent fetch via `Promise.allSettled`, per-source timeout (already enforced by fetchers), in-flight tracking, and per-source state updates. This is what makes "refresh every 30 minutes" and "continue updating other feeds when one feed fails" actually happen.

Mirrors `YoutubeRssScheduler` (`server/src/youtube-rss-scheduler.ts`) for the timer-abstraction pattern. Architectural decisions per [ADR-010](../40-decisions/010-news-weather-architecture.md).

## Acceptance criteria

### NewsScheduler (timer)

- [ ] `NewsScheduler` (in `server/src/news/news-scheduler.ts`): `start()`, `stop()`, idempotent (calling `start()` twice doesn't double the interval). Mirrors the `RssIntervalScheduler` shape so tests can inject a deterministic scheduler (no real `setInterval`).
- [ ] First tick fires ~15s after `start()` (matches `DEFAULT_FIRST_POLL_DELAY_MS` precedent from YouTube)
- [ ] Subsequent ticks every 60s (configurable constant; the *per-source* refresh interval is separate and lives on the row)
- [ ] `setInterval` handle is `.unref()`-ed so it doesn't block process exit
- [ ] `stop()` clears the interval AND any pending `setTimeout` for the first-poll delay

### NewsSchedulerOrchestrator (tick body)

- [ ] `NewsSchedulerOrchestrator` (in `server/src/news/news-scheduler-orchestrator.ts`): `tick(now?: Date) → Promise<TickSummary>`. The scheduler calls this on each tick.
- [ ] Queries `NewsStore.listDueSources(now)` to find sources that need fetching
- [ ] Maintains an in-process `Set<number>` of in-flight source IDs; skips sources already in-flight
- [ ] Fires `Promise.allSettled(sources.map(s => withInFlight(s, () => NewsFetchJob.run(s))))`
- [ ] On settled `fulfilled`: updates `last_fetched_at` AND `last_successful_fetch_at` to `now`, clears `last_error`
- [ ] On settled `rejected` (or `{ ok: false }` from fetch job): updates `last_fetched_at` to `now`, sets `last_error` to a short message, leaves `last_successful_fetch_at` unchanged
- [ ] Returns `{ fetchedCount, succeededCount, failedCount, inFlightCount }`
- [ ] The `withInFlight` helper adds the source id to the in-flight set before the fetch and removes it in a `finally` block — even on throw

### Tests

- [ ] NewsScheduler: empty source list → no-op; due-check logic correct (one source past interval → fetched, one not due → skipped); in-flight source skipped on next tick; failed source updates `last_error`; succeeded source updates both timestamps and clears `last_error`; `Promise.allSettled` actually isolates failure (one source fails, others succeed, all states correct); scheduler `stop()` clears interval and pending first-poll timeout; idempotent `start()`
- [ ] NewsSchedulerOrchestrator: all-due happy path; mixed-due (some due, some not); mixed-result (some succeed, some fail); all-fail; in-flight source skipped; in-flight source removed in finally even when fetch throws

## Blocked by

- [NW-002](./NW-002-fetcher-dispatcher-and-normalizer.md) (needs `NewsFetchJob`, `NewsStore`, `NewsScheduler` types)

## Files to touch

- `server/src/news/news-scheduler.ts` (new)
- `server/src/news/news-scheduler-orchestrator.ts` (new)
- `server/src/news/news-scheduler.test.ts` (new)
- `server/src/news/news-scheduler-orchestrator.test.ts` (new)
