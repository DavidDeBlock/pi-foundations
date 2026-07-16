// youtube-subscriptions-scheduler.test.ts — issue YT-002
//
// Unit tests for the daily scheduler. The scheduler is a thin
// wrapper around `YouTubeSubscriptionsSync.sync` — we mock the
// sync and verify the lifecycle (start / stop / interval choice /
// error swallow).

import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  YouTubeSubscriptionsScheduler,
  type IntervalScheduler,
} from './youtube-subscriptions-scheduler.js'
import type { YouTubeSubscriptionsSync } from './youtube-subscriptions-sync.js'

interface FakeSync {
  sync: ReturnType<typeof vi.fn>
}

let fakeSync: FakeSync

beforeEach(() => {
  fakeSync = {
    sync: vi.fn(),
  }
})

function makeScheduler(
  deps: Partial<ConstructorParameters<typeof YouTubeSubscriptionsScheduler>[0]> = {},
): { scheduler: YouTubeSubscriptionsScheduler; intervalScheduler: IntervalScheduler & { calls: Array<{ cb: () => void; ms: number }> } } {
  const calls: Array<{ cb: () => void; ms: number }> = []
  const intervalScheduler: IntervalScheduler & { calls: typeof calls } = {
    calls,
    schedule(cb, ms) {
      calls.push({ cb, ms })
      return () => {
        // no-op cancel; not exercised in tests
      }
    },
  }
  const scheduler = new YouTubeSubscriptionsScheduler({
    sync: fakeSync as unknown as YouTubeSubscriptionsSync,
    intervalHours: 24,
    intervalScheduler,
    ...deps,
  })
  return { scheduler, intervalScheduler }
}

describe('YouTubeSubscriptionsScheduler', () => {
  it('isEnabled() reflects intervalHours', () => {
    const { scheduler } = makeScheduler({ intervalHours: 24 })
    expect(scheduler.isEnabled()).toBe(true)
  })

  it('isEnabled() returns false when intervalHours is 0', () => {
    const { scheduler } = makeScheduler({ intervalHours: 0 })
    expect(scheduler.isEnabled()).toBe(false)
  })

  it('start() arms a timer at the configured interval', () => {
    const { scheduler, intervalScheduler } = makeScheduler({ intervalHours: 24 })
    scheduler.start()
    expect(intervalScheduler.calls).toHaveLength(1)
    expect(intervalScheduler.calls[0]!.ms).toBe(24 * 60 * 60 * 1000)
  })

  it('start() is a no-op when intervalHours is 0', () => {
    const { scheduler, intervalScheduler } = makeScheduler({ intervalHours: 0 })
    scheduler.start()
    expect(intervalScheduler.calls).toHaveLength(0)
  })

  it('start() is idempotent — a second call does not re-arm', () => {
    const { scheduler, intervalScheduler } = makeScheduler()
    scheduler.start()
    scheduler.start()
    expect(intervalScheduler.calls).toHaveLength(1)
  })

  it('stop() tears down the timer; a subsequent start re-arms', () => {
    const { scheduler, intervalScheduler } = makeScheduler()
    scheduler.start()
    scheduler.stop()
    scheduler.start()
    expect(intervalScheduler.calls).toHaveLength(2)
  })

  it('stop() is a no-op before start()', () => {
    const { scheduler } = makeScheduler()
    expect(() => scheduler.stop()).not.toThrow()
  })

  it('runOnce() calls sync.sync()', async () => {
    const { scheduler } = makeScheduler()
    fakeSync.sync.mockResolvedValueOnce({
      added: 1, updated: 0, removed: 0, unchanged: 0, total: 1, ranAt: '',
    })
    await scheduler.runOnce()
    expect(fakeSync.sync).toHaveBeenCalledTimes(1)
  })

  it('runOnce() swallows "no account" errors so the timer keeps firing', async () => {
    const { scheduler } = makeScheduler()
    fakeSync.sync.mockRejectedValueOnce(new Error('no YouTube account connected'))
    // Should not throw — the interval shouldn't die on a no-account tick.
    await expect(scheduler.runOnce()).resolves.toBeUndefined()
  })

  it('runOnce() swallows unexpected errors with a logged message', async () => {
    const { scheduler } = makeScheduler()
    fakeSync.sync.mockRejectedValueOnce(new Error('HTTP 500'))
    await expect(scheduler.runOnce()).resolves.toBeUndefined()
  })
})