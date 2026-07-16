import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { insertVideo } from './youtube-videos.js'
import { upsertSubscription } from './youtube-subscriptions.js'
import { youtubeTranscriptsApi } from './youtube-transcripts-api.js'
import {
  YouTubeTranscriptService,
  type TranscriptFetcher,
} from './youtube-transcripts.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

describe('video transcript API', () => {
  let db: Database
  let app: Hono
  let service: YouTubeTranscriptService
  let videoId: string

  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    db.run(
      `INSERT INTO youtube_accounts
         (id, provider, google_user_id, email_address,
          access_token_enc, refresh_token_enc, scopes)
       VALUES ('acct-1', 'youtube', 'g-1', 'd@example.com', 'x', 'y', 'youtube.readonly')`,
    )
    upsertSubscription(db, {
      googleAccountId: 'acct-1',
      channelId: 'UCaaaaaaa000000000000aab',
      channelTitle: 'Alpha',
      channelThumbnailUrl: null,
      subscribedAt: '2026-01-01T00:00:00.000Z',
    })
    videoId = insertVideo(db, {
      videoId: 'dQw4w9WgXcQ',
      channelId: 'UCaaaaaaa000000000000aab',
      title: 'Example',
      publishedAt: '2026-07-16T00:00:00.000Z',
      thumbnailUrl: null,
      link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    }).id
    const fetcher: TranscriptFetcher = {
      fetch: vi.fn().mockResolvedValue({
        language: 'en',
        segments: [{ startMs: 250, durationMs: 1000, text: 'Hello' }],
      }),
    }
    service = new YouTubeTranscriptService({ db, fetcher })
    app = new Hono()
    app.route('/api/videos', youtubeTranscriptsApi({ db, service }))
  })

  afterEach(() => db.close())

  it('returns null before a transcript is requested', async () => {
    const res = await app.request(`/api/videos/${videoId}/transcript`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, transcript: null })
  })

  it('queues a request and exposes the completed transcript', async () => {
    const queued = await app.request(`/api/videos/${videoId}/transcript`, {
      method: 'POST',
    })
    expect([200, 202]).toContain(queued.status)
    await service.whenIdle()

    const res = await app.request(`/api/videos/${videoId}/transcript`)
    const body = (await res.json()) as {
      transcript: { status: string; language: string; segments: unknown[] }
    }
    expect(body.transcript.status).toBe('ready')
    expect(body.transcript.language).toBe('en')
    expect(body.transcript.segments).toEqual([
      { start_ms: 250, duration_ms: 1000, text: 'Hello' },
    ])
  })

  it('returns 404 for an unknown video', async () => {
    const res = await app.request('/api/videos/missing/transcript', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
