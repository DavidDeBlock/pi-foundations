import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { YoutubeTranscriptNotAvailableError } from 'youtube-transcript'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { insertVideo } from './youtube-videos.js'
import {
  upsertSubscription,
  updateSubscriptionToggles,
} from './youtube-subscriptions.js'
import {
  getVideoTranscript,
  YouTubeTranscriptService,
  type TranscriptFetcher,
} from './youtube-transcripts.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

describe('YouTubeTranscriptService', () => {
  let db: Database
  let videoId: string
  let subscriptionId: string

  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    db.run(
      `INSERT INTO youtube_accounts
         (id, provider, google_user_id, email_address,
          access_token_enc, refresh_token_enc, scopes)
       VALUES ('acct-1', 'youtube', 'g-1', 'd@example.com', 'x', 'y', 'youtube.readonly')`,
    )
    subscriptionId = upsertSubscription(db, {
      googleAccountId: 'acct-1',
      channelId: 'UCaaaaaaa000000000000aab',
      channelTitle: 'Informative channel',
      channelThumbnailUrl: null,
      subscribedAt: '2026-01-01T00:00:00.000Z',
    }).id
    videoId = insertVideo(db, {
      videoId: 'dQw4w9WgXcQ',
      channelId: 'UCaaaaaaa000000000000aab',
      title: 'Useful explainer',
      publishedAt: '2026-07-16T00:00:00.000Z',
      thumbnailUrl: null,
      link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    }).id
  })

  afterEach(() => db.close())

  function successfulFetcher(): TranscriptFetcher {
    return {
      fetch: vi.fn().mockResolvedValue({
        language: 'en',
        segments: [
          { startMs: 0, durationMs: 1_500, text: 'First line' },
          { startMs: 1_500, durationMs: 2_000, text: 'Second line' },
        ],
      }),
    }
  }

  it('queues an on-demand request and stores timed segments', async () => {
    const fetcher = successfulFetcher()
    const service = new YouTubeTranscriptService({ db, fetcher })

    expect(service.request(videoId)?.status).toBe('pending')
    await service.whenIdle()

    expect(fetcher.fetch).toHaveBeenCalledWith('dQw4w9WgXcQ')
    expect(getVideoTranscript(db, videoId)).toMatchObject({
      status: 'ready',
      language: 'en',
      segments: [
        { position: 0, startMs: 0, durationMs: 1_500, text: 'First line' },
        { position: 1, startMs: 1_500, durationMs: 2_000, text: 'Second line' },
      ],
    })
  })

  it('does not automatically request when the subscription toggle is off', () => {
    const service = new YouTubeTranscriptService({ db, fetcher: successfulFetcher() })
    expect(service.requestAutomatically(videoId)).toBe(false)
    expect(getVideoTranscript(db, videoId)).toBeNull()
  })

  it('automatically requests when the included subscription opted in', async () => {
    const fetcher = successfulFetcher()
    updateSubscriptionToggles(db, subscriptionId, { autoFetchTranscripts: true })
    const service = new YouTubeTranscriptService({ db, fetcher })

    expect(service.requestAutomatically(videoId)).toBe(true)
    await service.whenIdle()
    expect(getVideoTranscript(db, videoId)?.status).toBe('ready')
  })

  it('does not automatically request for an excluded subscription', () => {
    updateSubscriptionToggles(db, subscriptionId, {
      isIncluded: false,
      autoFetchTranscripts: true,
    })
    const service = new YouTubeTranscriptService({ db, fetcher: successfulFetcher() })
    expect(service.requestAutomatically(videoId)).toBe(false)
  })

  it('records extraction failures and allows a later retry', async () => {
    const failedFetcher: TranscriptFetcher = {
      fetch: vi.fn().mockRejectedValue(new Error('temporary YouTube failure')),
    }
    const failedService = new YouTubeTranscriptService({ db, fetcher: failedFetcher })
    failedService.request(videoId)
    await failedService.whenIdle()
    expect(getVideoTranscript(db, videoId)).toMatchObject({
      status: 'failed',
      errorMessage: 'temporary YouTube failure',
    })

    const retryService = new YouTubeTranscriptService({ db, fetcher: successfulFetcher() })
    retryService.request(videoId)
    await retryService.whenIdle()
    expect(getVideoTranscript(db, videoId)?.status).toBe('ready')
  })

  it('records missing captions as unavailable rather than a system failure', async () => {
    const fetcher: TranscriptFetcher = {
      fetch: vi.fn().mockRejectedValue(
        new YoutubeTranscriptNotAvailableError('dQw4w9WgXcQ'),
      ),
    }
    const service = new YouTubeTranscriptService({ db, fetcher })
    service.request(videoId)
    await service.whenIdle()
    expect(getVideoTranscript(db, videoId)?.status).toBe('unavailable')
  })

  it('resumes persisted pending requests after restart', async () => {
    db.run(
      `INSERT INTO video_transcripts
         (video_id, status, requested_at, updated_at)
       VALUES (?, 'pending', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z')`,
      [videoId],
    )
    const service = new YouTubeTranscriptService({ db, fetcher: successfulFetcher() })
    expect(service.resumePending()).toBe(1)
    await service.whenIdle()
    expect(getVideoTranscript(db, videoId)?.status).toBe('ready')
  })

  it('returns null for an unknown video', () => {
    const service = new YouTubeTranscriptService({ db, fetcher: successfulFetcher() })
    expect(service.request('missing')).toBeNull()
  })
})
