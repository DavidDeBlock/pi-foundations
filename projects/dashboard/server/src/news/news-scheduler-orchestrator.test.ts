// news/news-scheduler-orchestrator.test.ts — issue NW-003
//
// Tests for the tick body — the function the scheduler calls
// every minute. Uses an in-memory SQLite for `NewsStore` (so
// the due-check math and state updates run against real SQL,
// matching what the production runner does) and a stubbed
// `NewsFetchJob` (so we never touch the network).
//
// Coverage map (per AC):
//   * all-due happy path
//   * mixed-due (some due, some not)
//   * mixed-result (some succeed, some fail)
//   * all-fail
//   * in-flight source skipped
//   * in-flight source removed in finally even when fetch throws
//   * successful fetch updates last_successful_fetch_at + clears last_error
//   * failed fetch updates last_error + leaves last_successful_fetch_at alone
//   * promise.allSettled isolates failure

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Database } from '../db.js'
import { runMigrations } from '../migrations.js'
import { NewsSchedulerOrchestrator } from './news-scheduler-orchestrator.js'
import { NewsStore } from './news-store.js'
import type { NewsFetchJob, FetchJobResult } from './news-fetch-job.js'
import type { Source } from './types.js'

// ─── Setup helpers ────────────────────────────────────────────────────────

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../migrations')

let db: Database
let store: NewsStore
const NOW_EPOCH = Date.parse('2024-07-16T12:00:00.000Z')
const NOW = new Date(NOW_EPOCH)

beforeEach(async () => {
  db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  // Wipe the seed sources — tests use controlled fixtures.
  db.run('DELETE FROM news_sources')
  store = new NewsStore(db)
})

afterEach(() => {
  db.close()
})

/** Build a stub NewsFetchJob that records calls and returns
 *  a fixed result. `resultFn` lets tests dispatch on
 *  `source.id` so multiple sources can have different outcomes
 *  in the same tick. */
function makeStubJob(
  resultFn: (source: Source) => Promise<FetchJobResult>,
): { job: NewsFetchJob; calls: Source[] } {
  const calls: Source[] = []
  const job = {
    async run(source: Source): Promise<FetchJobResult> {
      calls.push(source)
      return resultFn(source)
    },
  } as unknown as NewsFetchJob
  return { job, calls }
}

function insertSource(fields: Partial<{
  name: string
  category: string
  type: string
  url: string
  enabled: number
  refresh_interval_min: number
  last_fetched_at: string | null
  last_successful_fetch_at: string | null
  last_error: string | null
}> = {}): number {
  const r = db.run(
    `INSERT INTO news_sources
       (name, category, type, url, enabled, refresh_interval_min,
        last_fetched_at, last_successful_fetch_at, last_error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.name ?? 'Test source',
      fields.category ?? 'General',
      fields.type ?? 'rss',
      fields.url ?? `https://example.com/${Math.random()}`,
      fields.enabled ?? 1,
      fields.refresh_interval_min ?? 30,
      fields.last_fetched_at ?? null,
      fields.last_successful_fetch_at ?? null,
      fields.last_error ?? null,
      '2024-07-16T12:00:00.000Z',
    ],
  )
  return Number(r.lastInsertRowid)
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('NewsSchedulerOrchestrator — happy path', () => {
  it('fetches all due sources and reports a clean summary', async () => {
    const a = insertSource({ name: 'A', last_fetched_at: null })
    const b = insertSource({ name: 'B', last_fetched_at: null })
    const { job, calls } = makeStubJob(async () => ({
      ok: true,
      inserted: 3,
    }))
    const orch = new NewsSchedulerOrchestrator({
      store,
      job,
      nowMs: () => NOW_EPOCH,
    })
    const summary = await orch.tick(NOW)
    expect(summary.fetchedCount).toBe(2)
    expect(summary.succeededCount).toBe(2)
    expect(summary.failedCount).toBe(0)
    expect(summary.inFlightCount).toBe(0)
    expect(calls).toHaveLength(2)
    // Both sources had last_fetched_at updated (by the job,
    // we trust the job-side contract) — but the orchestrator
    // writes last_successful_fetch_at on success and clears
    // last_error. Verify those.
    for (const id of [a, b]) {
      const row = db.get<{
        last_successful_fetch_at: string | null
        last_error: string | null
      }>(
        `SELECT last_successful_fetch_at, last_error FROM news_sources WHERE id = ?`,
        [id],
      )
      expect(row?.last_successful_fetch_at).toBe('2024-07-16T12:00:00.000Z')
      expect(row?.last_error).toBeNull()
    }
  })

  it('skips sources whose refresh_interval has not elapsed', async () => {
    // A is due (never polled), B was just polled.
    insertSource({ name: 'A', last_fetched_at: null })
    insertSource({
      name: 'B',
      last_fetched_at: '2024-07-16T11:55:00.000Z',
      refresh_interval_min: 30,
    })
    const { job, calls } = makeStubJob(async () => ({ ok: true, inserted: 1 }))
    const orch = new NewsSchedulerOrchestrator({
      store,
      job,
      nowMs: () => NOW_EPOCH,
    })
    const summary = await orch.tick(NOW)
    expect(summary.fetchedCount).toBe(1)
    expect(calls.map((s) => s.name)).toEqual(['A'])
  })
})

describe('NewsSchedulerOrchestrator — failure isolation', () => {
  it('one source failing does not affect the other (Promise.allSettled)', async () => {
    const a = insertSource({ name: 'A', last_fetched_at: null })
    const b = insertSource({ name: 'B', last_fetched_at: null })
    const { job, calls } = makeStubJob(async (s) => {
      if (s.id === a) return { ok: true, inserted: 2 }
      return { ok: false, error: 'connection reset' }
    })
    const orch = new NewsSchedulerOrchestrator({
      store,
      job,
      nowMs: () => NOW_EPOCH,
    })
    const summary = await orch.tick(NOW)
    expect(summary.fetchedCount).toBe(2)
    expect(summary.succeededCount).toBe(1)
    expect(summary.failedCount).toBe(1)
    expect(calls).toHaveLength(2)

    // Source A: last_successful_fetch_at set, last_error cleared.
    const aRow = db.get<{
      last_successful_fetch_at: string | null
      last_error: string | null
    }>(
      `SELECT last_successful_fetch_at, last_error FROM news_sources WHERE id = ?`,
      [a],
    )
    expect(aRow?.last_successful_fetch_at).toBe('2024-07-16T12:00:00.000Z')
    expect(aRow?.last_error).toBeNull()

    // Source B: last_error set, last_successful_fetch_at UNCHANGED
    // (it was NULL before, stays NULL).
    const bRow = db.get<{
      last_successful_fetch_at: string | null
      last_error: string | null
    }>(
      `SELECT last_successful_fetch_at, last_error FROM news_sources WHERE id = ?`,
      [b],
    )
    expect(bRow?.last_successful_fetch_at).toBeNull()
    expect(bRow?.last_error).toBe('connection reset')
  })

  it('a job run() that THROWS (programmer error) is captured as a failure, not propagated', async () => {
    insertSource({ name: 'Boom', last_fetched_at: null })
    insertSource({ name: 'OK', last_fetched_at: null })
    const { job } = makeStubJob(async (s) => {
      if (s.name === 'Boom') throw new TypeError('programmer goofed')
      return { ok: true, inserted: 1 }
    })
    const orch = new NewsSchedulerOrchestrator({
      store,
      job,
      nowMs: () => NOW_EPOCH,
    })
    // The orchestrator's tick() must NOT throw — the
    // `Promise.allSettled` boundary plus the catch on each
    // settled result guarantees this.
    const summary = await orch.tick(NOW)
    expect(summary.fetchedCount).toBe(2)
    expect(summary.succeededCount).toBe(1)
    expect(summary.failedCount).toBe(1)
    // The "Boom" source gets `last_error = "programmer goofed"`.
    const boomRow = db.get<{ last_error: string | null }>(
      `SELECT last_error FROM news_sources WHERE name = ?`,
      ['Boom'],
    )
    expect(boomRow?.last_error).toContain('programmer goofed')
  })

  it('records the per-source result detail in summary.results', async () => {
    insertSource({ name: 'OK', last_fetched_at: null })
    insertSource({ name: 'Bad', last_fetched_at: null })
    const { job } = makeStubJob(async (s) => {
      if (s.name === 'OK') return { ok: true, inserted: 5 }
      return { ok: false, error: 'parse error' }
    })
    const orch = new NewsSchedulerOrchestrator({
      store,
      job,
      nowMs: () => NOW_EPOCH,
    })
    const summary = await orch.tick(NOW)
    const ok = summary.results.find((r) => r.status === 'ok')!
    const bad = summary.results.find((r) => r.status === 'error')!
    expect(ok.inserted).toBe(5)
    expect(bad.error).toBe('parse error')
  })
})

describe('NewsSchedulerOrchestrator — in-flight tracking', () => {
  it('source in flight at tick time is SKIPPED (not re-fetched)', async () => {
    insertSource({ name: 'A', last_fetched_at: null })
    const b = insertSource({ name: 'B', last_fetched_at: null })
    // Manually populate in-flight with B before the tick.
    let resolveFirst!: () => void
    const firstCallRunning = new Promise<void>((r) => {
      resolveFirst = r
    })
    let callsToB = 0
    const { job } = makeStubJob(async (s) => {
      if (s.id === b) {
        callsToB++
        await firstCallRunning
        return { ok: true, inserted: 1 }
      }
      return { ok: true, inserted: 1 }
    })
    const orch = new NewsSchedulerOrchestrator({
      store,
      job,
      nowMs: () => NOW_EPOCH,
    })

    // Manually mark B as in flight (simulating a prior tick
    // that hasn't returned yet). We use `inFlightCount()`'s
    // principle: there's no public API to mark in-flight
    // (the orchestrator only adds ids inside `#withInFlight`),
    // so we instead drive the scenario via tick sequencing:
    // start the first tick but DON'T await it yet, then start
    // the second tick while the first is still running.
    const firstTick = orch.tick(NOW)
    // The first tick is now mid-flight: A and B both running.
    // Before resolving, the second tick should observe B in
    // flight (because the first call's promise is still
    // pending).
    // However, the orchestrator's `#inFlight` is an instance
    // variable; the second tick shares the same instance, so
    // both B's IDs are in flight concurrently at the second
    // tick boundary.
    const secondSummary = await orch.tick(NOW)
    // In the second tick, both sources are still in flight.
    // We expect secondSummary.fetchedCount === 0.
    expect(secondSummary.fetchedCount).toBe(0)
    expect(secondSummary.inFlightCount).toBe(2)

    // Resolve the first tick so the test can finish.
    resolveFirst()
    const firstSummary = await firstTick
    expect(firstSummary.fetchedCount).toBe(2)
    // The duplicate suppression only kicks in when the second
    // tick's `withInFlight` runs in parallel with the first —
    // in this test the second tick has already finished by
    // the time the first resolves, so `callsToB === 1` is
    // expected (no double-fetch).
    expect(callsToB).toBe(1)
  })

  it('in-flight set is cleared in finally even when the fetch throws', async () => {
    insertSource({ name: 'X', last_fetched_at: null })
    const { job } = makeStubJob(async () => {
      throw new Error('boom')
    })
    const orch = new NewsSchedulerOrchestrator({
      store,
      job,
      nowMs: () => NOW_EPOCH,
    })
    // First tick: source is in-flight, fetch throws. The
    // set MUST empty before the tick returns (defense-in-depth,
    // otherwise future ticks would skip the source forever).
    const firstTick = orch.tick(NOW)
    expect(orch.inFlightCount()).toBe(1)
    await firstTick
    expect(orch.inFlightCount()).toBe(0)
    // Side effect: the orchestrator wrote `last_fetched_at`
    // and `last_error` per the AC's failure contract. Confirm.
    const row = db.get<{
      last_fetched_at: string | null
      last_error: string | null
    }>(
      `SELECT last_fetched_at, last_error FROM news_sources WHERE name = ?`,
      ['X'],
    )
    expect(row?.last_fetched_at).toBe('2024-07-16T12:00:00.000Z')
    expect(row?.last_error).toContain('boom')
  })
})

describe('NewsSchedulerOrchestrator — summary invariants', () => {
  it('succeeded + failed === fetched when inFlightCount is 0', async () => {
    insertSource({ name: 'A', last_fetched_at: null })
    insertSource({ name: 'B', last_fetched_at: null })
    const { job } = makeStubJob(async (s) =>
      s.name === 'A'
        ? { ok: true, inserted: 1 }
        : { ok: false, error: 'fail' },
    )
    const orch = new NewsSchedulerOrchestrator({
      store,
      job,
      nowMs: () => NOW_EPOCH,
    })
    const summary = await orch.tick(NOW)
    expect(summary.succeededCount + summary.failedCount).toBe(
      summary.fetchedCount,
    )
  })

  it('ranAt echoes the requested `now`', async () => {
    const orch = new NewsSchedulerOrchestrator({
      store,
      job: makeStubJob(async () => ({ ok: true, inserted: 0 })).job,
      nowMs: () => NOW_EPOCH,
    })
    const summary = await orch.tick(NOW)
    expect(summary.ranAt).toBe('2024-07-16T12:00:00.000Z')
  })

  it('uses the default `now = new Date(nowMs())` when none is passed', async () => {
    const orch = new NewsSchedulerOrchestrator({
      store,
      job: makeStubJob(async () => ({ ok: true, inserted: 0 })).job,
      nowMs: () => NOW_EPOCH,
    })
    const summary = await orch.tick()
    expect(summary.ranAt).toBe('2024-07-16T12:00:00.000Z')
  })
})

describe('NewsSchedulerOrchestrator — empty universe', () => {
  it('returns all-zero summary when there are no enabled sources', async () => {
    const { job } = makeStubJob(async () => ({ ok: true, inserted: 0 }))
    const orch = new NewsSchedulerOrchestrator({
      store,
      job,
      nowMs: () => NOW_EPOCH,
    })
    const summary = await orch.tick(NOW)
    expect(summary).toEqual({
      fetchedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      inFlightCount: 0,
      ranAt: '2024-07-16T12:00:00.000Z',
      results: [],
    })
  })
})

describe('NewsSchedulerOrchestrator — disable propagation', () => {
  it('does not fetch disabled sources even if their due-check would pass', async () => {
    // enabled = 0 (the seed has VRT NWS enabled by default —
    // we already wiped; now add one disabled source that
    // would otherwise be due).
    insertSource({
      name: 'Off',
      enabled: 0,
      last_fetched_at: null,
    })
    const { job, calls } = makeStubJob(async () => ({ ok: true, inserted: 0 }))
    const orch = new NewsSchedulerOrchestrator({
      store,
      job,
      nowMs: () => NOW_EPOCH,
    })
    const summary = await orch.tick(NOW)
    expect(summary.fetchedCount).toBe(0)
    expect(calls).toEqual([])
  })
})
