import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { insertVideo } from './youtube-videos.js'
import { upsertSubscription } from './youtube-subscriptions.js'
import {
  getVideoSummary,
  parseGeneratedSummary,
  YouTubeVideoSummaryService,
  type VideoSummarizer,
} from './youtube-video-summaries.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

describe('YouTubeVideoSummaryService', () => {
  let db: Database
  let videoId: string

  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    db.run(`INSERT INTO youtube_accounts
      (id, provider, google_user_id, email_address, access_token_enc, refresh_token_enc, scopes)
      VALUES ('acct-1', 'youtube', 'g-1', 'd@example.com', 'x', 'y', 'youtube.readonly')`)
    upsertSubscription(db, {
      googleAccountId: 'acct-1', channelId: 'UCaaaaaaa000000000000aab',
      channelTitle: 'Explainers', channelThumbnailUrl: null,
      subscribedAt: '2026-01-01T00:00:00.000Z',
    })
    videoId = insertVideo(db, {
      videoId: 'dQw4w9WgXcQ', channelId: 'UCaaaaaaa000000000000aab',
      title: 'Useful explainer', publishedAt: '2026-07-16T00:00:00.000Z',
      thumbnailUrl: null, link: 'https://youtube.test/watch?v=dQw4w9WgXcQ',
    }).id
  })

  afterEach(() => db.close())

  function addTranscript(): void {
    db.run(`INSERT INTO video_transcripts
      (video_id, status, language, requested_at, fetched_at, error_message, updated_at)
      VALUES (?, 'ready', 'en', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:01.000Z', NULL, '2026-07-16T00:00:01.000Z')`, [videoId])
    db.run(`INSERT INTO video_transcript_segments
      (video_id, position, start_ms, duration_ms, text) VALUES (?, 0, 0, 1000, 'Opening')`, [videoId])
    db.run(`INSERT INTO video_transcript_segments
      (video_id, position, start_ms, duration_ms, text) VALUES (?, 1, 10000, 1000, 'Use SQLite')`, [videoId])
  }

  function summarizer(): VideoSummarizer {
    return {
      model: 'MiniMax-M2.7',
      summarize: vi.fn().mockResolvedValue({
        tldr: 'A practical local-first explanation.',
        keyPoints: [{ text: 'SQLite is enough.', startMs: 10000 }],
        worthWatching: 'Watch the implementation section.',
        actionItems: [{ text: 'Try the schema.', startMs: 10000 }],
        mentioned: ['SQLite'],
      }),
    }
  }

  it('requires a ready transcript', () => {
    const service = new YouTubeVideoSummaryService({ db, summarizer: summarizer() })
    expect(service.request(videoId)).toEqual({ kind: 'transcript_required' })
    expect(getVideoSummary(db, videoId)).toBeNull()
  })

  it('queues, stores, and reuses an Insight Card', async () => {
    addTranscript()
    const generator = summarizer()
    const service = new YouTubeVideoSummaryService({ db, summarizer: generator, nowMs: () => 1000 })
    expect(service.request(videoId)).toMatchObject({ kind: 'summary', summary: { status: 'pending' } })
    await service.whenIdle()
    expect(getVideoSummary(db, videoId)).toMatchObject({
      status: 'ready',
      tldr: 'A practical local-first explanation.',
      keyPoints: [{ text: 'SQLite is enough.', startMs: 10000 }],
      mentioned: ['SQLite'],
      model: 'MiniMax-M2.7',
    })
    service.request(videoId)
    expect(generator.summarize).toHaveBeenCalledOnce()
  })

  it('records a failure and allows regeneration', async () => {
    addTranscript()
    const failed: VideoSummarizer = {
      model: 'MiniMax-M2.7',
      summarize: vi.fn().mockRejectedValue(new Error('temporary provider failure')),
    }
    const first = new YouTubeVideoSummaryService({ db, summarizer: failed })
    first.request(videoId)
    await first.whenIdle()
    expect(getVideoSummary(db, videoId)).toMatchObject({ status: 'failed', errorMessage: 'temporary provider failure' })

    const retry = new YouTubeVideoSummaryService({ db, summarizer: summarizer() })
    retry.request(videoId, { force: true })
    await retry.whenIdle()
    expect(getVideoSummary(db, videoId)?.status).toBe('ready')
  })

  it('resumes persisted pending work after restart', async () => {
    addTranscript()
    db.run(`INSERT INTO video_summaries
      (video_id, status, model, prompt_version, requested_at, updated_at)
      VALUES (?, 'pending', 'MiniMax-M2.7', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, [videoId])
    const service = new YouTubeVideoSummaryService({ db, summarizer: summarizer() })
    expect(service.resumePending()).toBe(1)
    await service.whenIdle()
    expect(getVideoSummary(db, videoId)?.status).toBe('ready')
  })
})

describe('parseGeneratedSummary', () => {
  it('strips MiniMax reasoning and snaps citations to real transcript segments', () => {
    const result = parseGeneratedSummary(`<think>private reasoning</think>\n\n\`\`\`json
      {"tldr":"Short.","key_points":[{"text":"Point","start_ms":9300}],"worth_watching":"Watch it.","action_items":[],"mentioned":["SQLite"]}
      \`\`\``, [
      { position: 0, startMs: 0, durationMs: 1000, text: 'Opening' },
      { position: 1, startMs: 10000, durationMs: 1000, text: 'Point' },
    ])
    expect(result.keyPoints).toEqual([{ text: 'Point', startMs: 10000 }])
  })
})
