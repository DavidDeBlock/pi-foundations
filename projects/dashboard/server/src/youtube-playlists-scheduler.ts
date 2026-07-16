import type { YouTubePlaylistsSync } from './youtube-playlists-sync.js'

export const DEFAULT_YOUTUBE_PLAYLIST_SYNC_INTERVAL_HOURS = 24

export interface PlaylistIntervalScheduler {
  schedule(callback: () => void, delayMs: number): () => void
}

const defaultIntervalScheduler: PlaylistIntervalScheduler = {
  schedule(callback, delayMs) {
    const timer = setInterval(callback, delayMs)
    timer.unref()
    return () => clearInterval(timer)
  },
}

export class YouTubePlaylistsScheduler {
  readonly #sync: Pick<YouTubePlaylistsSync, 'sync'>
  readonly #intervalHours: number
  readonly #scheduler: PlaylistIntervalScheduler
  #cancel: (() => void) | null = null

  constructor(deps: {
    readonly sync: Pick<YouTubePlaylistsSync, 'sync'>
    readonly intervalHours?: number
    readonly intervalScheduler?: PlaylistIntervalScheduler
  }) {
    this.#sync = deps.sync
    this.#intervalHours = deps.intervalHours ?? DEFAULT_YOUTUBE_PLAYLIST_SYNC_INTERVAL_HOURS
    this.#scheduler = deps.intervalScheduler ?? defaultIntervalScheduler
  }

  isEnabled(): boolean { return this.#intervalHours > 0 }

  start(): void {
    if (this.#cancel || !this.isEnabled()) return
    this.#cancel = this.#scheduler.schedule(() => { void this.runOnce() }, this.#intervalHours * 60 * 60 * 1000)
  }

  stop(): void {
    this.#cancel?.()
    this.#cancel = null
  }

  async runOnce(): Promise<void> {
    try { await this.#sync.sync() }
    catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown error'
      // eslint-disable-next-line no-console
      console.error(`[youtube-playlists] scheduled sync failed: ${message}`)
    }
  }
}
