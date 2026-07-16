import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import {
  getVideoDescription,
  YouTubeVideoDescriptionService,
} from './youtube-video-descriptions.js'
import {
  YouTubeVideoMetadataError,
  type VideoMetadataFetcher,
  type VideoMetadataResult,
} from './youtube-video-metadata-fetcher.js'
import { upsertYouTubeVideo } from './youtube-video-upsert.js'
import { getVideoDescriptionResources } from './youtube-description-resources.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

describe('YouTubeVideoDescriptionService', () => {
  let db: Database
  let videoId: string

  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    videoId = seedVideo('remote-1')
  })

  afterEach(() => db.close())

  function seedVideo(remoteId: string): string {
    return upsertYouTubeVideo(db, {
      videoId: remoteId,
      channelId: 'UCmetadata',
      channelTitle: 'Metadata channel',
      title: `Video ${remoteId}`,
      publishedAt: '2026-07-16T00:00:00.000Z',
      thumbnailUrl: null,
      link: `https://youtube.com/watch?v=${remoteId}`,
      origin: { type: 'manual' },
    }).id
  }

  function resultFetcher(
    factory: (id: string) => VideoMetadataResult = (id) => ({
      status: 'ready',
      description: `Description ${id}`,
      truncated: false,
    }),
  ): VideoMetadataFetcher & { fetch: ReturnType<typeof vi.fn> } {
    return {
      fetch: vi.fn(async (_token: string, ids: readonly string[]) =>
        new Map(ids.map((id) => [id, factory(id)]))),
    }
  }

  it('batches queued videos, persists hostile text as inert data, and deduplicates active work', async () => {
    const ids = [videoId]
    for (let i = 2; i <= 51; i++) ids.push(seedVideo(`remote-${i}`))
    const fetcher = resultFetcher((id) => ({
      status: 'ready',
      description: id === 'remote-1'
        ? '<script>window.pwned=true</script> & https://example.com'
        : `Description ${id}`,
      truncated: false,
    }))
    const service = new YouTubeVideoDescriptionService({
      db, accessToken: async () => 'token', fetcher,
    })

    expect(service.requestMany(ids)).toBe(51)
    expect(service.requestMany(ids)).toBe(0)
    await service.whenIdle()

    expect(fetcher.fetch).toHaveBeenCalledTimes(2)
    expect(fetcher.fetch.mock.calls.map((call) => call[1].length).sort()).toEqual([1, 50])
    expect(getVideoDescription(db, videoId)).toMatchObject({
      status: 'ready',
      description: '<script>window.pwned=true</script> & https://example.com',
      errorMessage: null,
    })
  })

  it('fingerprints descriptions and does not replace unchanged content', async () => {
    let now = Date.parse('2026-07-16T00:00:00.000Z')
    let description = 'First description'
    const fetcher = resultFetcher(() => ({ status: 'ready', description, truncated: false }))
    const service = new YouTubeVideoDescriptionService({
      db, accessToken: async () => 'token', fetcher, nowMs: () => now,
    })
    service.request(videoId)
    await service.whenIdle()
    const first = getVideoDescription(db, videoId)!

    now += 60_000
    service.request(videoId)
    await service.whenIdle()
    const unchanged = getVideoDescription(db, videoId)!
    expect(unchanged.description).toBe(first.description)
    expect(unchanged.fingerprint).toBe(first.fingerprint)
    expect(unchanged.fetchedAt).not.toBe(first.fetchedAt)

    description = 'Changed description'
    now += 60_000
    service.request(videoId)
    await service.whenIdle()
    const changed = getVideoDescription(db, videoId)!
    expect(changed.description).toBe(description)
    expect(changed.fingerprint).not.toBe(first.fingerprint)
  })

  it('extracts on successful refresh, backfills unchanged descriptions, and preserves resources on failure', async () => {
    const description = 'Code https://github.com/acme/project'
    const fetcher = resultFetcher(() => ({ status: 'ready', description, truncated: false }))
    const ready = new YouTubeVideoDescriptionService({
      db, accessToken: async () => 'token', fetcher,
    })
    ready.request(videoId)
    await ready.whenIdle()
    const first = getVideoDescriptionResources(db, videoId)
    expect(first).toMatchObject([{ category: 'repository', present: true }])

    // Simulate derived data absent after adding migration 023 to an existing DB.
    db.run('DELETE FROM video_description_resources WHERE video_id = ?', [videoId])
    ready.request(videoId)
    await ready.whenIdle()
    expect(getVideoDescriptionResources(db, videoId)).toHaveLength(1)

    const failed = new YouTubeVideoDescriptionService({
      db,
      accessToken: async () => 'token',
      fetcher: {
        fetch: async () => { throw new YouTubeVideoMetadataError('http', 'Temporary failure', { retryable: false }) },
      },
    })
    failed.request(videoId)
    await failed.whenIdle()
    expect(getVideoDescription(db, videoId)?.status).toBe('stale')
    expect(getVideoDescriptionResources(db, videoId)).toHaveLength(1)
  })

  it('retains the last ready value as stale when a forced refresh fails', async () => {
    const ready = new YouTubeVideoDescriptionService({
      db, accessToken: async () => 'token', fetcher: resultFetcher(),
    })
    ready.request(videoId)
    await ready.whenIdle()
    const previous = getVideoDescription(db, videoId)!

    const failedFetcher: VideoMetadataFetcher = {
      fetch: vi.fn().mockRejectedValue(new YouTubeVideoMetadataError(
        'auth', 'YouTube authentication failed', { status: 401 },
      )),
    }
    const failed = new YouTubeVideoDescriptionService({
      db, accessToken: async () => 'token', fetcher: failedFetcher,
    })
    failed.request(videoId)
    await failed.whenIdle()

    expect(getVideoDescription(db, videoId)).toMatchObject({
      status: 'stale',
      description: previous.description,
      fingerprint: previous.fingerprint,
      errorCode: 'auth',
    })
  })

  it.each([
    ['not_found', 'not_found'],
    ['no_description', 'no_description'],
  ] as const)('records %s videos as unavailable', async (_label, reason) => {
    const service = new YouTubeVideoDescriptionService({
      db,
      accessToken: async () => 'token',
      fetcher: resultFetcher(() => ({ status: 'unavailable', reason })),
    })
    service.request(videoId)
    await service.whenIdle()
    expect(getVideoDescription(db, videoId)).toMatchObject({
      status: 'unavailable', unavailableReason: reason, description: null,
    })
  })

  it('bounds retries and stores secret-safe quota failures', async () => {
    const fetcher: VideoMetadataFetcher = {
      fetch: vi.fn().mockRejectedValue(new YouTubeVideoMetadataError(
        'quota', 'YouTube quota or rate limit prevented metadata refresh',
        { status: 429, retryable: true },
      )),
    }
    const service = new YouTubeVideoDescriptionService({
      db,
      accessToken: async () => 'secret-token',
      fetcher,
      maxAttempts: 2,
      retryDelayMs: () => 0,
    })
    service.request(videoId)
    await service.whenIdle()
    expect(fetcher.fetch).toHaveBeenCalledTimes(2)
    const state = getVideoDescription(db, videoId)!
    expect(state).toMatchObject({ status: 'failed', attemptCount: 2, errorCode: 'quota' })
    expect(state.errorMessage).not.toContain('secret-token')
  })

  it('resumes pending rows after restart and cascades on video deletion', async () => {
    db.run(
      `INSERT INTO video_descriptions
         (video_id, status, requested_at, updated_at)
       VALUES (?, 'pending', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z')`,
      [videoId],
    )
    const service = new YouTubeVideoDescriptionService({
      db, accessToken: async () => 'token', fetcher: resultFetcher(),
    })
    expect(service.resumePending()).toBe(1)
    await service.whenIdle()
    expect(getVideoDescription(db, videoId)?.status).toBe('ready')

    db.run('DELETE FROM videos WHERE id = ?', [videoId])
    expect(getVideoDescription(db, videoId)).toBeNull()
  })

  it('sanitizes unknown OAuth errors instead of persisting provider internals', async () => {
    const service = new YouTubeVideoDescriptionService({
      db,
      accessToken: async () => { throw new Error('refresh_token=should-not-persist') },
      fetcher: resultFetcher(),
    })
    service.request(videoId)
    await service.whenIdle()
    const state = getVideoDescription(db, videoId)!
    expect(state.status).toBe('failed')
    expect(state.errorMessage).toBe('YouTube authentication failed; reconnect the account and retry')
    expect(JSON.stringify(state)).not.toContain('should-not-persist')
  })

  it('returns null for an unknown video', () => {
    const service = new YouTubeVideoDescriptionService({
      db, accessToken: async () => 'token', fetcher: resultFetcher(),
    })
    expect(service.request('missing')).toBeNull()
  })
})
