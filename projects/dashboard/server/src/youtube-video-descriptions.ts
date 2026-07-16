import { createHash } from 'node:crypto'
import type { Database } from './db.js'
import {
  MAX_VIDEO_METADATA_BATCH,
  YouTubeVideoMetadataError,
  YouTubeVideoMetadataFetcher,
  type VideoMetadataFetcher,
  type VideoMetadataResult,
} from './youtube-video-metadata-fetcher.js'
import { reconcileVideoDescriptionResources } from './youtube-description-resources.js'

export type VideoDescriptionStatus =
  | 'pending'
  | 'ready'
  | 'stale'
  | 'unavailable'
  | 'failed'

export interface VideoDescription {
  readonly videoId: string
  readonly status: VideoDescriptionStatus
  readonly description: string | null
  readonly fingerprint: string | null
  readonly unavailableReason: 'not_found' | 'no_description' | null
  readonly truncated: boolean
  readonly requestedAt: string
  readonly fetchedAt: string | null
  readonly lastAttemptedAt: string | null
  readonly attemptCount: number
  readonly nextRetryAt: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly updatedAt: string
}

interface DescriptionRow {
  video_id: string
  status: VideoDescriptionStatus
  description: string | null
  fingerprint: string | null
  unavailable_reason: 'not_found' | 'no_description' | null
  is_truncated: number | bigint
  requested_at: string
  fetched_at: string | null
  last_attempted_at: string | null
  attempt_count: number | bigint
  next_retry_at: string | null
  error_code: string | null
  error_message: string | null
  updated_at: string
}

interface PendingVideoRow {
  id: string
  video_id: string
}

export function getVideoDescription(
  db: Database,
  videoId: string,
): VideoDescription | null {
  const row = db.get<DescriptionRow>(`${DESCRIPTION_SELECT} WHERE video_id = ?`, [videoId])
  return row ? toDescription(row) : null
}

export interface YouTubeVideoDescriptionServiceDeps {
  readonly db: Database
  /** Returns a short-lived authenticated token. The service never persists it. */
  readonly accessToken: () => Promise<string>
  readonly fetcher?: VideoMetadataFetcher
  readonly concurrency?: number
  readonly maxAttempts?: number
  readonly retryDelayMs?: (attempt: number) => number
  readonly nowMs?: () => number
}

/**
 * Persisted metadata queue shared by RSS, playlist, backfill, and explicit API
 * requests. Provider calls only happen in the asynchronous drain, never in an
 * ingestion transaction or a detail-page read.
 */
export class YouTubeVideoDescriptionService {
  readonly #db: Database
  readonly #accessToken: () => Promise<string>
  readonly #fetcher: VideoMetadataFetcher
  readonly #concurrency: number
  readonly #maxAttempts: number
  readonly #retryDelayMs: (attempt: number) => number
  readonly #nowMs: () => number
  readonly #queue: string[] = []
  readonly #queued = new Set<string>()
  readonly #idleWaiters = new Set<() => void>()
  #active = 0
  #scheduledRetries = 0

  constructor(deps: YouTubeVideoDescriptionServiceDeps) {
    this.#db = deps.db
    this.#accessToken = deps.accessToken
    this.#fetcher = deps.fetcher ?? new YouTubeVideoMetadataFetcher()
    this.#concurrency = Math.max(1, Math.floor(deps.concurrency ?? 2))
    this.#maxAttempts = Math.min(10, Math.max(1, Math.floor(deps.maxAttempts ?? 3)))
    this.#retryDelayMs = deps.retryDelayMs ?? ((attempt) => attempt === 1 ? 1_000 : 5_000)
    this.#nowMs = deps.nowMs ?? (() => Date.now())
  }

  /** Explicit refresh. Existing content remains available while pending. */
  request(videoId: string): VideoDescription | null {
    const exists = this.#db.get<{ id: string }>('SELECT id FROM videos WHERE id = ?', [videoId])
    if (!exists) return null
    const now = this.#nowIso()
    this.#db.run(
      `INSERT INTO video_descriptions
         (video_id, status, requested_at, attempt_count, updated_at)
       VALUES (?, 'pending', ?, 0, ?)
       ON CONFLICT(video_id) DO UPDATE SET
         status = 'pending', requested_at = excluded.requested_at,
         last_attempted_at = NULL, attempt_count = 0, next_retry_at = NULL,
         unavailable_reason = NULL, error_code = NULL, error_message = NULL,
         updated_at = excluded.updated_at`,
      [videoId, now, now],
    )
    this.#enqueue(videoId)
    return getVideoDescription(this.#db, videoId)
  }

  /** Queue newly discovered videos without disturbing an existing lifecycle. */
  requestMany(videoIds: readonly string[]): number {
    const unique = [...new Set(videoIds)]
    if (unique.length === 0) return 0
    const now = this.#nowIso()
    let added = 0
    const pendingVideoIds: string[] = []
    this.#db.transaction(() => {
      for (const videoId of unique) {
        const result = this.#db.run(
          `INSERT OR IGNORE INTO video_descriptions
             (video_id, status, requested_at, attempt_count, updated_at)
           SELECT id, 'pending', ?, 0, ? FROM videos WHERE id = ?`,
          [now, now, videoId],
        )
        if (result.changes > 0) {
          added++
          pendingVideoIds.push(videoId)
          continue
        }
        const current = this.#db.get<{ status: VideoDescriptionStatus }>(
          'SELECT status FROM video_descriptions WHERE video_id = ?',
          [videoId],
        )
        if (current?.status === 'pending') pendingVideoIds.push(videoId)
      }
    })
    for (const pendingVideoId of pendingVideoIds) this.#enqueue(pendingVideoId)
    return added
  }

  /** Resume persisted work after a process restart, including delayed retries. */
  resumePending(): number {
    const rows = this.#db.all<DescriptionRow>(
      `${DESCRIPTION_SELECT} WHERE status = 'pending' ORDER BY requested_at, video_id`,
    )
    const now = this.#nowMs()
    for (const row of rows) {
      if (Number(row.attempt_count) >= this.#maxAttempts) {
        this.#saveFailure(row.video_id, {
          code: row.error_code ?? 'retry_exhausted',
          message: row.error_message ?? 'YouTube metadata refresh did not complete before restart',
          retryable: false,
        })
        continue
      }
      const retryAt = row.next_retry_at ? Date.parse(row.next_retry_at) : Number.NaN
      const delay = Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : 0
      if (delay > 0) this.#scheduleRetry(row.video_id, delay)
      else this.#enqueue(row.video_id)
    }
    return rows.length
  }

  whenIdle(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve()
    return new Promise((resolve) => this.#idleWaiters.add(resolve))
  }

  #enqueue(videoId: string): void {
    if (this.#queued.has(videoId)) return
    this.#queued.add(videoId)
    this.#queue.push(videoId)
    queueMicrotask(() => this.#drain())
  }

  #drain(): void {
    while (this.#active < this.#concurrency && this.#queue.length > 0) {
      const batch = this.#queue.splice(0, MAX_VIDEO_METADATA_BATCH)
      this.#active++
      void this.#processBatch(batch).finally(() => {
        this.#active--
        for (const videoId of batch) this.#queued.delete(videoId)
        this.#drain()
        this.#resolveIdle()
      })
    }
  }

  async #processBatch(videoIds: readonly string[]): Promise<void> {
    const placeholders = videoIds.map(() => '?').join(',')
    const rows = this.#db.all<PendingVideoRow>(
      `SELECT v.id, v.video_id
         FROM videos v JOIN video_descriptions d ON d.video_id = v.id
        WHERE v.id IN (${placeholders}) AND d.status = 'pending'`,
      videoIds,
    )
    if (rows.length === 0) return
    const attemptedAt = this.#nowIso()
    this.#db.run(
      `UPDATE video_descriptions SET attempt_count = attempt_count + 1,
         last_attempted_at = ?, next_retry_at = NULL, updated_at = ?
       WHERE video_id IN (${rows.map(() => '?').join(',')}) AND status = 'pending'`,
      [attemptedAt, attemptedAt, ...rows.map((row) => row.id)],
    )

    try {
      const token = await this.#accessToken()
      const results = await this.#fetcher.fetch(token, rows.map((row) => row.video_id))
      for (const row of rows) {
        const result = results.get(row.video_id) ?? {
          status: 'failed' as const,
          code: 'invalid_response' as const,
          message: 'YouTube omitted a metadata result',
          retryable: false as const,
        }
        this.#saveResult(row.id, result)
      }
    } catch (error: unknown) {
      const safe = safeError(error)
      for (const row of rows) this.#retryOrFail(row.id, safe)
    }
  }

  #saveResult(videoId: string, result: VideoMetadataResult): void {
    if (result.status === 'failed') {
      this.#retryOrFail(videoId, result)
      return
    }
    const now = this.#nowIso()
    if (result.status === 'unavailable') {
      this.#db.transaction(() => {
        this.#db.run(
          `UPDATE video_descriptions SET status = 'unavailable', description = NULL,
             fingerprint = NULL, unavailable_reason = ?, is_truncated = 0,
             fetched_at = ?, next_retry_at = NULL, error_code = NULL,
             error_message = NULL, updated_at = ? WHERE video_id = ?`,
          [result.reason, now, now, videoId],
        )
        reconcileVideoDescriptionResources(this.#db, videoId, null, now)
      })
      return
    }

    const fingerprint = createHash('sha256').update(result.description, 'utf8').digest('hex')
    const existing = this.#db.get<{ fingerprint: string | null }>(
      'SELECT fingerprint FROM video_descriptions WHERE video_id = ?',
      [videoId],
    )
    if (existing?.fingerprint === fingerprint) {
      // Intentionally omit description/fingerprint assignments for unchanged content.
      // Reconcile anyway so descriptions stored before YT-023 are backfilled and
      // future deterministic rule improvements can rebuild derived fields.
      this.#db.transaction(() => {
        this.#db.run(
          `UPDATE video_descriptions SET status = 'ready', unavailable_reason = NULL,
             is_truncated = ?, fetched_at = ?, next_retry_at = NULL,
             error_code = NULL, error_message = NULL, updated_at = ?
           WHERE video_id = ?`,
          [result.truncated ? 1 : 0, now, now, videoId],
        )
        reconcileVideoDescriptionResources(this.#db, videoId, result.description, now)
      })
      return
    }
    this.#db.transaction(() => {
      this.#db.run(
        `UPDATE video_descriptions SET status = 'ready', description = ?,
           fingerprint = ?, unavailable_reason = NULL, is_truncated = ?,
           fetched_at = ?, next_retry_at = NULL, error_code = NULL,
           error_message = NULL, updated_at = ? WHERE video_id = ?`,
        [result.description, fingerprint, result.truncated ? 1 : 0, now, now, videoId],
      )
      reconcileVideoDescriptionResources(this.#db, videoId, result.description, now)
    })
  }

  #retryOrFail(
    videoId: string,
    error: { readonly code: string; readonly message: string; readonly retryable: boolean },
  ): void {
    const row = this.#db.get<{ attempt_count: number | bigint }>(
      'SELECT attempt_count FROM video_descriptions WHERE video_id = ? AND status = \'pending\'',
      [videoId],
    )
    if (!row) return
    const attempts = Number(row.attempt_count)
    if (error.retryable && attempts < this.#maxAttempts) {
      const delay = Math.max(0, this.#retryDelayMs(attempts))
      const now = this.#nowMs()
      this.#db.run(
        `UPDATE video_descriptions SET next_retry_at = ?, error_code = ?,
           error_message = ?, updated_at = ? WHERE video_id = ?`,
        [new Date(now + delay).toISOString(), bounded(error.code, 64),
          bounded(error.message, 500), new Date(now).toISOString(), videoId],
      )
      this.#scheduleRetry(videoId, delay)
      return
    }
    this.#saveFailure(videoId, error)
  }

  #saveFailure(
    videoId: string,
    error: { readonly code: string; readonly message: string; readonly retryable: boolean },
  ): void {
    const now = this.#nowIso()
    this.#db.run(
      `UPDATE video_descriptions SET
         status = CASE WHEN description IS NOT NULL AND fingerprint IS NOT NULL
           THEN 'stale' ELSE 'failed' END,
         next_retry_at = NULL, error_code = ?, error_message = ?, updated_at = ?
       WHERE video_id = ?`,
      [bounded(error.code, 64), bounded(error.message, 500), now, videoId],
    )
  }

  #scheduleRetry(videoId: string, delayMs: number): void {
    this.#scheduledRetries++
    setTimeout(() => {
      this.#scheduledRetries--
      this.#enqueue(videoId)
      this.#resolveIdle()
    }, delayMs)
  }

  #isIdle(): boolean {
    return this.#active === 0 && this.#queue.length === 0 && this.#scheduledRetries === 0
  }

  #resolveIdle(): void {
    if (!this.#isIdle()) return
    for (const resolve of this.#idleWaiters) resolve()
    this.#idleWaiters.clear()
  }

  #nowIso(): string {
    return new Date(this.#nowMs()).toISOString()
  }
}

const DESCRIPTION_SELECT = `SELECT video_id, status, description, fingerprint,
  unavailable_reason, is_truncated, requested_at, fetched_at, last_attempted_at,
  attempt_count, next_retry_at, error_code, error_message, updated_at
  FROM video_descriptions`

function toDescription(row: DescriptionRow): VideoDescription {
  return {
    videoId: row.video_id,
    status: row.status,
    description: row.description,
    fingerprint: row.fingerprint,
    unavailableReason: row.unavailable_reason,
    truncated: Boolean(row.is_truncated),
    requestedAt: row.requested_at,
    fetchedAt: row.fetched_at,
    lastAttemptedAt: row.last_attempted_at,
    attemptCount: Number(row.attempt_count),
    nextRetryAt: row.next_retry_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    updatedAt: row.updated_at,
  }
}

function safeError(error: unknown): {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
} {
  if (error instanceof YouTubeVideoMetadataError) {
    return { code: error.code, message: error.message, retryable: error.retryable }
  }
  // OAuth implementations can include sensitive provider payloads in thrown
  // errors. Do not persist or log those details.
  return {
    code: 'authentication_failed',
    message: 'YouTube authentication failed; reconnect the account and retry',
    retryable: false,
  }
}

function bounded(value: string, length: number): string {
  return value.slice(0, length)
}
