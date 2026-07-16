import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { insertVideo } from './youtube-videos.js'
import { upsertSubscription } from './youtube-subscriptions.js'
import { youtubeVideoSummariesApi } from './youtube-video-summaries-api.js'
import { YouTubeVideoSummaryService, type VideoSummarizer } from './youtube-video-summaries.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

describe('video summary API', () => {
  let db: Database
  let app: Hono
  let service: YouTubeVideoSummaryService
  let videoId: string

  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    db.run(`INSERT INTO youtube_accounts
      (id, provider, google_user_id, email_address, access_token_enc, refresh_token_enc, scopes)
      VALUES ('acct-1', 'youtube', 'g-1', 'd@example.com', 'x', 'y', 'youtube.readonly')`)
    upsertSubscription(db, {
      googleAccountId: 'acct-1', channelId: 'UCaaaaaaa000000000000aab', channelTitle: 'Alpha',
      channelThumbnailUrl: null, subscribedAt: '2026-01-01T00:00:00.000Z',
    })
    videoId = insertVideo(db, {
      videoId: 'dQw4w9WgXcQ', channelId: 'UCaaaaaaa000000000000aab', title: 'Example',
      publishedAt: '2026-07-16T00:00:00.000Z', thumbnailUrl: null,
      link: 'https://youtube.test/watch?v=dQw4w9WgXcQ',
    }).id
    const summarizer: VideoSummarizer = {
      model: 'MiniMax-M2.7',
      summarize: vi.fn().mockResolvedValue({
        tldr: 'Short.', keyPoints: [{ text: 'Point', startMs: 0 }],
        worthWatching: 'Useful demo.', actionItems: [], mentioned: [],
      }),
    }
    service = new YouTubeVideoSummaryService({ db, summarizer })
    app = new Hono()
    app.route('/api/videos', youtubeVideoSummariesApi({ db, service }))
  })

  afterEach(() => db.close())

  it('reports unconfigured without a service', async () => {
    const unconfigured = new Hono()
    unconfigured.route('/api/videos', youtubeVideoSummariesApi({ db }))
    const response = await unconfigured.request(`/api/videos/${videoId}/summary`, { method: 'POST' })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false, error: 'llm_not_configured' })
  })

  it('requires a transcript and returns 404 for unknown videos', async () => {
    expect((await app.request(`/api/videos/${videoId}/summary`, { method: 'POST' })).status).toBe(409)
    expect((await app.request('/api/videos/missing/summary', { method: 'POST' })).status).toBe(404)
  })

  it('queues and returns a completed cached summary', async () => {
    db.run(`INSERT INTO video_transcripts
      (video_id, status, language, requested_at, fetched_at, error_message, updated_at)
      VALUES (?, 'ready', 'en', '2026-01-01', '2026-01-01', NULL, '2026-01-01')`, [videoId])
    db.run(`INSERT INTO video_transcript_segments
      (video_id, position, start_ms, duration_ms, text) VALUES (?, 0, 0, 1000, 'Point')`, [videoId])
    const queued = await app.request(`/api/videos/${videoId}/summary`, { method: 'POST' })
    expect(queued.status).toBe(202)
    await service.whenIdle()
    const response = await app.request(`/api/videos/${videoId}/summary`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      configured: true,
      summary: { status: 'ready', tldr: 'Short.', key_points: [{ text: 'Point', start_ms: 0 }] },
    })
  })

  it('creates, lists, reads, and prefers immutable summary runs', async () => {
    db.run(`INSERT INTO video_transcripts
      (video_id, status, language, requested_at, fetched_at, error_message, updated_at)
      VALUES (?, 'ready', 'en', '2026-01-01', '2026-01-01', NULL, '2026-01-01')`, [videoId])
    db.run(`INSERT INTO video_transcript_segments
      (video_id, position, start_ms, duration_ms, text) VALUES (?, 0, 0, 1000, 'Point')`, [videoId])
    const queued = await app.request(`/api/videos/${videoId}/summaries`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: 'builtin-standard', output_language: 'nl', focus_instruction: 'Practical steps', research: false }),
    })
    expect(queued.status).toBe(202)
    const queuedBody = await queued.json() as { summary: { id: string } }
    await service.whenIdle()
    const detail = await app.request(`/api/videos/${videoId}/summaries/${queuedBody.summary.id}`)
    expect(await detail.json()).toMatchObject({ ok: true, summary: {
      id: queuedBody.summary.id, status: 'ready', output_language: 'nl',
      profile: { built_in_key: 'standard' }, focus_instruction: 'Practical steps', outputs: { nl: { tldr: 'Short.' } },
    } })
    const list = await app.request(`/api/videos/${videoId}/summaries`)
    expect(await list.json()).toMatchObject({ ok: true, preferred_run_id: queuedBody.summary.id,
      summaries: [{ id: queuedBody.summary.id, preferred: true }] })
    expect((await app.request(`/api/videos/${videoId}/summaries/${queuedBody.summary.id}/prefer`, { method: 'POST' })).status).toBe(200)
  })

  it('validates plural run requests', async () => {
    db.run(`INSERT INTO video_transcripts
      (video_id, status, language, requested_at, fetched_at, error_message, updated_at)
      VALUES (?, 'ready', 'en', '2026-01-01', '2026-01-01', NULL, '2026-01-01')`, [videoId])
    for (const body of [
      { profile_id: 'missing', output_language: 'en', research: false },
      { profile_id: 'builtin-quick', output_language: 'fr', research: false },
      { profile_id: 'builtin-quick', output_language: 'en', focus_instruction: 'x'.repeat(1001), research: false },
    ]) {
      expect((await app.request(`/api/videos/${videoId}/summaries`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(400)
    }
    expect((await app.request(`/api/videos/${videoId}/summaries`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        profile_id: 'builtin-quick', output_language: 'en', research: true,
      }) })).status).toBe(503)
  })
})
