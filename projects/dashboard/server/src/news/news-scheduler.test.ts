// news/news-scheduler.test.ts — issue NW-003
//
// Tests for the news scheduler timer wrapper. Mirrors the
// YouTube scheduler test pattern: deterministic IntervalScheduler
// double, runOnce() is public so we never have to advance
// fake timers, and we verify the wrapping (start/stop/idempotent)
// without touching real timers.
//
// Coverage map (per AC):
//   * empty source list → no-op
//   * start() arms both the one-shot and the recurring timer
//   * start() is idempotent
//   * stop() cancels both timers AND is idempotent
//   * stop() before start() is a safe no-op
//   * stop() clears a still-pending first-poll timeout
//   * intervalMin=0 disables scheduling entirely
//   * runOnce() invokes the orchestrator and returns its summary
//   * defaults match the documented constants

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { Database } from '../db.js'
import { runMigrations } from '../migrations.js'
import {
  DEFAULT_FIRST_POLL_DELAY_MS,
  DEFAULT_NEWS_INTERVAL_MIN,
  NewsScheduler,
  type RssIntervalScheduler,
} from './news-scheduler.js'
import { NewsSchedulerOrchestrator } from './news-scheduler-orchestrator.js'
import { NewsStore } from './news-store.js'
import type { TickSummary } from './news-scheduler-orchestrator.js'

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../migrations')

let db: Database
let store: NewsStore
let orchestrator: NewsSchedulerOrchestrator
let tickSpy: ReturnType<typeof vi.spyOn>

const STUB_SUMMARY: TickSummary = {
  fetchedCount: 0,
  succeededCount: 0,
  failedCount: 0,
  inFlightCount: 0,
  ranAt: '2024-07-16T12:00:00.000Z',
  results: [],
}

beforeEach(async () => {
  db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  store = new NewsStore(db)
  orchestrator = new NewsSchedulerOrchestrator({
    store,
    job: { run: vi.fn() } as never,
    nowMs: () => Date.parse('2024-07-16T12:00:00.000Z'),
  })
  tickSpy = vi.spyOn(
    NewsSchedulerOrchestrator.prototype as never,
    'tick',
  ) as unknown as ReturnType<typeof vi.spyOn>
  // Re-typed because vitest's `vi.spyOn` infers parameter
  // types via the instance method's signature, which clashes
  // with the optional `Date | undefined` parameter on `tick`.
  tickSpy.mockResolvedValue(STUB_SUMMARY as unknown as never)
})

afterEach(() => {
  db.close()
  tickSpy.mockRestore()
})

// ─── Test scheduler double ────────────────────────────────────────────────

interface TestScheduler {
  scheduler: RssIntervalScheduler
  recurring: Array<() => void>
  oneShot: Array<() => void>
  cancelRecurring: number
  cancelOneShot: number
  fireRecurring(): void
  fireAll(): void
}

function makeStubScheduler(): TestScheduler {
  const recurring: Array<() => void> = []
  const oneShot: Array<() => void> = []
  let cancelRecurring = 0
  let cancelOneShot = 0
  const scheduler: RssIntervalScheduler = {
    schedule(cb, _intervalMs) {
      recurring.push(cb)
      return () => {
        cancelRecurring++
      }
    },
    scheduleOnce(cb, _delayMs) {
      oneShot.push(cb)
      return () => {
        cancelOneShot++
      }
    },
  }
  return {
    scheduler,
    recurring,
    oneShot,
    get cancelRecurring() {
      return cancelRecurring
    },
    get cancelOneShot() {
      return cancelOneShot
    },
    fireRecurring() {
      // Run every scheduled recurring callback once.
      for (const cb of recurring) cb()
    },
    fireAll() {
      // Run one-shot (first-poll) once, then one recurring tick.
      for (const cb of oneShot) cb()
      for (const cb of recurring) cb()
    },
  }
}

// ─── Defaults ─────────────────────────────────────────────────────────────

describe('NewsScheduler — defaults', () => {
  it('defaults to 1-min interval', () => {
    expect(DEFAULT_NEWS_INTERVAL_MIN).toBe(1)
  })

  it('defaults first-poll delay to 15s', () => {
    expect(DEFAULT_FIRST_POLL_DELAY_MS).toBe(15_000)
  })

  it('isEnabled() returns false when intervalMin=0', () => {
    const scheduler = new NewsScheduler({
      orchestrator,
      intervalMin: 0,
    })
    expect(scheduler.isEnabled()).toBe(false)
  })

  it('isEnabled() returns true when intervalMin>0', () => {
    const scheduler = new NewsScheduler({
      orchestrator,
      intervalMin: 1,
    })
    expect(scheduler.isEnabled()).toBe(true)
  })
})

// ─── Lifecycle ────────────────────────────────────────────────────────────

describe('NewsScheduler — lifecycle', () => {
  it('start() arms both the recurring and one-shot timers', () => {
    const stub = makeStubScheduler()
    const scheduler = new NewsScheduler({
      orchestrator,
      intervalMin: 1,
      intervalScheduler: stub.scheduler,
    })
    scheduler.start()
    expect(stub.oneShot).toHaveLength(1)
    expect(stub.recurring).toHaveLength(1)
    scheduler.stop()
  })

  it('start() is idempotent — second call is a no-op', () => {
    const stub = makeStubScheduler()
    const scheduler = new NewsScheduler({
      orchestrator,
      intervalMin: 1,
      intervalScheduler: stub.scheduler,
    })
    scheduler.start()
    scheduler.start()
    expect(stub.oneShot).toHaveLength(1)
    expect(stub.recurring).toHaveLength(1)
    scheduler.stop()
  })

  it('stop() cancels both timers and is idempotent', () => {
    const stub = makeStubScheduler()
    const scheduler = new NewsScheduler({
      orchestrator,
      intervalMin: 1,
      intervalScheduler: stub.scheduler,
    })
    scheduler.start()
    scheduler.stop()
    scheduler.stop()
    // Cancel was called exactly once per timer (not per stop
    // call). The second stop() should NOT cancel again.
    expect(stub.cancelRecurring).toBe(1)
    expect(stub.cancelOneShot).toBe(1)
  })

  it('stop() before start() is a safe no-op', () => {
    const scheduler = new NewsScheduler({
      orchestrator,
      intervalMin: 1,
    })
    expect(() => scheduler.stop()).not.toThrow()
  })

  it('start() with intervalMin=0 does NOT arm timers', () => {
    const stub = makeStubScheduler()
    const scheduler = new NewsScheduler({
      orchestrator,
      intervalMin: 0,
      intervalScheduler: stub.scheduler,
    })
    scheduler.start()
    expect(stub.oneShot).toHaveLength(0)
    expect(stub.recurring).toHaveLength(0)
    scheduler.stop()
  })

  it('first-poll-delay and recurring interval pass the right ms values', () => {
    // We can't observe the literal ms without a real timer;
    // instead, replace the stub with one that records them.
    const captured: Array<{ kind: 'recurring' | 'oneShot'; ms: number }> = []
    const recorder: RssIntervalScheduler = {
      schedule(cb, ms) {
        captured.push({ kind: 'recurring', ms })
        cb()
        return () => {}
      },
      scheduleOnce(cb, ms) {
        captured.push({ kind: 'oneShot', ms })
        cb()
        return () => {}
      },
    }
    const scheduler = new NewsScheduler({
      orchestrator,
      intervalMin: 5,
      firstPollDelayMs: 7_500,
      intervalScheduler: recorder,
    })
    scheduler.start()
    scheduler.stop()
    expect(captured).toContainEqual({ kind: 'recurring', ms: 5 * 60 * 1000 })
    expect(captured).toContainEqual({ kind: 'oneShot', ms: 7_500 })
  })
})

// ─── runOnce ──────────────────────────────────────────────────────────────

describe('NewsScheduler — runOnce', () => {
  it('invokes orchestrator.tick() and returns its summary', async () => {
    const scheduler = new NewsScheduler({
      orchestrator,
      intervalMin: 1,
    })
    const summary = await scheduler.runOnce()
    expect(summary).toBe(STUB_SUMMARY)
    expect(tickSpy).toHaveBeenCalledOnce()
  })

  it('swallows orchestrator throws and returns an empty summary', async () => {
    tickSpy.mockRejectedValue(new Error('disk full'))
    const fixedNow = Date.parse('2024-07-16T12:00:00.000Z')
    const scheduler = new NewsScheduler({
      orchestrator,
      intervalMin: 1,
      nowMs: () => fixedNow,
    })
    const summary = await scheduler.runOnce()
    expect(summary).toEqual({
      fetchedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      inFlightCount: 0,
      ranAt: '2024-07-16T12:00:00.000Z',
      results: [],
    })
    // Process is still alive (the test runner didn't crash).
  })

  it('passes a Date constructed from nowMs to orchestrator.tick()', async () => {
    const fixedNow = Date.parse('2024-07-16T12:00:00.000Z')
    const scheduler = new NewsScheduler({
      orchestrator,
      intervalMin: 1,
      nowMs: () => fixedNow,
    })
    await scheduler.runOnce()
    expect(tickSpy).toHaveBeenCalledOnce()
    const arg = tickSpy.mock.calls[0]![0]
    expect(arg).toBeInstanceOf(Date)
    expect((arg as Date).toISOString()).toBe('2024-07-16T12:00:00.000Z')
  })
})

// ─── Tick-body integration ────────────────────────────────────────────────

describe('NewsScheduler — tick end-to-end against real NewsStore', () => {
  it('fetches a due source end-to-end and updates state', async () => {
    // Restore the prototype spy for this test only — we want
    // the real orchestrator implementation to run, since the
    // test asserts on the side-effect writes that the
    // orchestrator performs after the job settles.
    tickSpy.mockRestore()
    // Insert one source via the real store.
    db.run(`DELETE FROM news_sources`)
    db.run(
      `INSERT INTO news_sources
         (name, category, type, url, enabled, refresh_interval_min, created_at)
       VALUES ('Real', 'General', 'rss', 'https://example.com/feed.xml', 1, 30, '2024-07-16T12:00:00.000Z')`,
    )
    // Build a fresh orchestrator with a stub job that returns ok.
    const fixedNow = Date.parse('2024-07-16T12:00:00.000Z')
    const realOrch = new NewsSchedulerOrchestrator({
      store,
      job: {
        run: async () => ({ ok: true, inserted: 4 }),
      } as never,
      nowMs: () => fixedNow,
    })
    const scheduler = new NewsScheduler({
      orchestrator: realOrch,
      intervalMin: 1,
      nowMs: () => fixedNow,
    })
    const summary = await scheduler.runOnce()
    expect(summary.fetchedCount).toBe(1)
    expect(summary.succeededCount).toBe(1)
    // Confirm the source row was updated by the orchestrator.
    const row = db.get<{
      last_fetched_at: string | null
      last_successful_fetch_at: string | null
      last_error: string | null
    }>(
      `SELECT last_fetched_at, last_successful_fetch_at, last_error FROM news_sources WHERE name = ?`,
      ['Real'],
    )
    expect(row?.last_fetched_at).toBe('2024-07-16T12:00:00.000Z')
    expect(row?.last_successful_fetch_at).toBe('2024-07-16T12:00:00.000Z')
    expect(row?.last_error).toBeNull()
  })

  it('empty source list → no-op (no fetcher calls)', async () => {
    tickSpy.mockRestore()
    db.run(`DELETE FROM news_sources`)
    const realOrch = new NewsSchedulerOrchestrator({
      store,
      job: {
        run: vi.fn(async () => ({ ok: true, inserted: 0 })),
      } as never,
      nowMs: () => Date.parse('2024-07-16T12:00:00.000Z'),
    })
    const scheduler = new NewsScheduler({
      orchestrator: realOrch,
      intervalMin: 1,
    })
    const summary = await scheduler.runOnce()
    expect(summary.fetchedCount).toBe(0)
    expect(summary.succeededCount).toBe(0)
    expect(summary.failedCount).toBe(0)
  })
})
