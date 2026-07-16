import {
  fetchTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptVideoUnavailableError,
  type TranscriptResponse,
} from 'youtube-transcript'
import type { Database } from './db.js'

export type TranscriptStatus = 'pending' | 'ready' | 'unavailable' | 'failed'

export interface TranscriptSegment {
  readonly position: number
  readonly startMs: number
  readonly durationMs: number
  readonly text: string
}

export interface VideoTranscript {
  readonly videoId: string
  readonly status: TranscriptStatus
  readonly language: string | null
  readonly requestedAt: string
  readonly fetchedAt: string | null
  readonly errorMessage: string | null
  readonly segments: readonly TranscriptSegment[]
}

interface TranscriptRow {
  video_id: string
  status: TranscriptStatus
  language: string | null
  requested_at: string
  fetched_at: string | null
  error_message: string | null
}

interface SegmentRow {
  position: number
  start_ms: number
  duration_ms: number
  text: string
}

export interface TranscriptFetcher {
  fetch(videoId: string): Promise<{
    readonly language: string | null
    readonly segments: readonly Omit<TranscriptSegment, 'position'>[]
  }>
}

export class YouTubeCaptionFetcher implements TranscriptFetcher {
  async fetch(videoId: string): Promise<{
    readonly language: string | null
    readonly segments: readonly Omit<TranscriptSegment, 'position'>[]
  }> {
    const rows: TranscriptResponse[] = await fetchTranscript(videoId)
    return {
      language: rows.find((row) => row.lang)?.lang ?? null,
      segments: rows.map((row) => ({
        startMs: Math.max(0, Math.round(row.offset)),
        durationMs: Math.max(0, Math.round(row.duration)),
        text: row.text.trim(),
      })).filter((row) => row.text !== ''),
    }
  }
}

export function getVideoTranscript(db: Database, videoId: string): VideoTranscript | null {
  const row = db.get<TranscriptRow>(
    `SELECT video_id, status, language, requested_at, fetched_at, error_message
       FROM video_transcripts WHERE video_id = ?`,
    [videoId],
  )
  if (!row) return null
  const segments = db.all<SegmentRow>(
    `SELECT position, start_ms, duration_ms, text
       FROM video_transcript_segments
      WHERE video_id = ? ORDER BY position`,
    [videoId],
  ).map((segment) => ({
    position: segment.position,
    startMs: segment.start_ms,
    durationMs: segment.duration_ms,
    text: segment.text,
  }))
  return {
    videoId: row.video_id,
    status: row.status,
    language: row.language,
    requestedAt: row.requested_at,
    fetchedAt: row.fetched_at,
    errorMessage: row.error_message,
    segments,
  }
}

export interface TranscriptServiceDeps {
  readonly db: Database
  readonly fetcher?: TranscriptFetcher
  readonly concurrency?: number
  readonly nowMs?: () => number
}

/**
 * Small persisted, in-process transcript queue. Requests return immediately
 * after recording `pending`; extraction runs separately with a conservative
 * concurrency cap so RSS polling and page requests are never held open.
 */
export class YouTubeTranscriptService {
  readonly #db: Database
  readonly #fetcher: TranscriptFetcher
  readonly #concurrency: number
  readonly #nowMs: () => number
  readonly #queue: string[] = []
  readonly #queued = new Set<string>()
  readonly #idleWaiters = new Set<() => void>()
  #active = 0

  constructor(deps: TranscriptServiceDeps) {
    this.#db = deps.db
    this.#fetcher = deps.fetcher ?? new YouTubeCaptionFetcher()
    this.#concurrency = Math.max(1, Math.floor(deps.concurrency ?? 2))
    this.#nowMs = deps.nowMs ?? (() => Date.now())
  }

  request(videoId: string): VideoTranscript | null {
    const video = this.#db.get<{ video_id: string }>(
      'SELECT video_id FROM videos WHERE id = ?',
      [videoId],
    )
    if (!video) return null

    const current = getVideoTranscript(this.#db, videoId)
    if (current?.status === 'ready') return current

    const now = this.#nowIso()
    this.#db.run(
      `INSERT INTO video_transcripts
         (video_id, status, language, requested_at, fetched_at, error_message, updated_at)
       VALUES (?, 'pending', NULL, ?, NULL, NULL, ?)
       ON CONFLICT(video_id) DO UPDATE SET
         status = 'pending', requested_at = excluded.requested_at,
         fetched_at = NULL, error_message = NULL, updated_at = excluded.updated_at`,
      [videoId, now, now],
    )
    this.#enqueue(videoId)
    return getVideoTranscript(this.#db, videoId)
  }

  requestAutomatically(videoId: string): boolean {
    const eligible = this.#db.get<{ id: string }>(
      `SELECT v.id
         FROM videos v
         JOIN subscriptions s ON s.channel_id = v.channel_id
        WHERE v.id = ?
          AND s.is_included = 1
          AND s.auto_fetch_transcripts = 1`,
      [videoId],
    )
    if (!eligible) return false
    this.request(videoId)
    return true
  }

  resumePending(): number {
    const rows = this.#db.all<{ video_id: string }>(
      `SELECT video_id FROM video_transcripts
        WHERE status = 'pending' ORDER BY requested_at`,
    )
    for (const row of rows) this.#enqueue(row.video_id)
    return rows.length
  }

  whenIdle(): Promise<void> {
    if (this.#active === 0 && this.#queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.#idleWaiters.add(resolve))
  }

  #enqueue(videoId: string): void {
    if (this.#queued.has(videoId)) return
    this.#queued.add(videoId)
    this.#queue.push(videoId)
    this.#drain()
  }

  #drain(): void {
    while (this.#active < this.#concurrency && this.#queue.length > 0) {
      const videoId = this.#queue.shift()!
      this.#active++
      void this.#process(videoId).finally(() => {
        this.#active--
        this.#queued.delete(videoId)
        this.#drain()
        if (this.#active === 0 && this.#queue.length === 0) {
          for (const resolve of this.#idleWaiters) resolve()
          this.#idleWaiters.clear()
        }
      })
    }
  }

  async #process(videoId: string): Promise<void> {
    const video = this.#db.get<{ video_id: string }>(
      'SELECT video_id FROM videos WHERE id = ?',
      [videoId],
    )
    if (!video) return
    try {
      const fetched = await this.#fetcher.fetch(video.video_id)
      if (fetched.segments.length === 0) {
        this.#saveFailure(videoId, 'unavailable', 'No caption text was returned')
        return
      }
      const now = this.#nowIso()
      this.#db.transaction(() => {
        this.#db.run('DELETE FROM video_transcript_segments WHERE video_id = ?', [videoId])
        for (let position = 0; position < fetched.segments.length; position++) {
          const segment = fetched.segments[position]!
          this.#db.run(
            `INSERT INTO video_transcript_segments
               (video_id, position, start_ms, duration_ms, text)
             VALUES (?, ?, ?, ?, ?)`,
            [videoId, position, segment.startMs, segment.durationMs, segment.text],
          )
        }
        this.#db.run(
          `UPDATE video_transcripts
              SET status = 'ready', language = ?, fetched_at = ?,
                  error_message = NULL, updated_at = ?
            WHERE video_id = ?`,
          [fetched.language, now, now, videoId],
        )
      })
    } catch (error: unknown) {
      const unavailable =
        error instanceof YoutubeTranscriptDisabledError ||
        error instanceof YoutubeTranscriptNotAvailableError ||
        error instanceof YoutubeTranscriptVideoUnavailableError
      const message = error instanceof Error ? error.message : String(error)
      this.#saveFailure(videoId, unavailable ? 'unavailable' : 'failed', message)
    }
  }

  #saveFailure(
    videoId: string,
    status: Extract<TranscriptStatus, 'unavailable' | 'failed'>,
    message: string,
  ): void {
    const now = this.#nowIso()
    this.#db.run('DELETE FROM video_transcript_segments WHERE video_id = ?', [videoId])
    this.#db.run(
      `UPDATE video_transcripts
          SET status = ?, fetched_at = ?, error_message = ?, updated_at = ?
        WHERE video_id = ?`,
      [status, now, message.slice(0, 500), now, videoId],
    )
  }

  #nowIso(): string {
    return new Date(this.#nowMs()).toISOString()
  }
}
