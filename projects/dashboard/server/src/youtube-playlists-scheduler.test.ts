import { describe, expect, it, vi } from 'vitest'
import {
  YouTubePlaylistsScheduler,
  type PlaylistIntervalScheduler,
} from './youtube-playlists-scheduler.js'

describe('YouTubePlaylistsScheduler', () => {
  it('runs daily, is idempotent, and stops cleanly', async () => {
    const sync = { sync: vi.fn().mockResolvedValue({}) }
    const cancel = vi.fn()
    const calls: Array<{ callback: () => void; delay: number }> = []
    const timer: PlaylistIntervalScheduler = {
      schedule(callback, delay) { calls.push({ callback, delay }); return cancel },
    }
    const scheduler = new YouTubePlaylistsScheduler({ sync, intervalScheduler: timer })
    scheduler.start()
    scheduler.start()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.delay).toBe(24 * 60 * 60 * 1000)
    await scheduler.runOnce()
    expect(sync.sync).toHaveBeenCalledOnce()
    scheduler.stop()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('supports manual-only mode and contains scheduled failures', async () => {
    const sync = { sync: vi.fn().mockRejectedValue(new Error('quota')) }
    const schedule = vi.fn()
    const scheduler = new YouTubePlaylistsScheduler({
      sync, intervalHours: 0, intervalScheduler: { schedule },
    })
    scheduler.start()
    expect(schedule).not.toHaveBeenCalled()
    await expect(scheduler.runOnce()).resolves.toBeUndefined()
  })
})
