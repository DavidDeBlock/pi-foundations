import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { Database } from './db.js'
import {
  TakeoutHistoryFormatError,
  TakeoutHistorySizeError,
  TakeoutWatchHistoryParser,
  type ParsedWatchEvent,
} from './youtube-history-parser.js'
import { upsertYouTubeVideo } from './youtube-video-upsert.js'

export const DEFAULT_HISTORY_STAGE_TTL_MS = 24 * 60 * 60 * 1000

export class HistoryImportNotFoundError extends Error {}
export class HistoryImportExpiredError extends Error {}
export class HistoryImportAlreadyCommittedError extends Error {}
export class HistoryImportIntegrityError extends Error {}

export interface HistoryPreview {
  readonly token: string
  readonly filename: string
  readonly totalCount: number
  readonly newEventCount: number
  readonly duplicateCount: number
  readonly malformedCount: number
  readonly uniqueVideoCount: number
  readonly newVideoCount: number
  readonly oldestWatchedAt: string | null
  readonly newestWatchedAt: string | null
  readonly expiresAt: string
}

export interface HistoryCommitResult {
  readonly token: string
  readonly committedEventCount: number
  readonly duplicateCount: number
  readonly malformedCount: number
  readonly insertedVideoCount: number
  readonly existingVideoCount: number
  readonly snapshotOnlyCount: number
  readonly committedAt: string
}

export interface HistoryImportAudit {
  readonly token: string
  readonly filename: string
  readonly fileHash: string
  readonly status: 'previewed' | 'committed' | 'expired' | 'failed'
  readonly totalCount: number
  readonly newEventCount: number
  readonly duplicateCount: number
  readonly malformedCount: number
  readonly uniqueVideoCount: number
  readonly newVideoCount: number
  readonly committedEventCount: number | null
  readonly oldestWatchedAt: string | null
  readonly newestWatchedAt: string | null
  readonly createdAt: string
  readonly expiresAt: string
  readonly committedAt: string | null
}

interface HistoryImportRow {
  id: string
  file_hash: string
  original_filename: string
  staged_filename: string
  status: HistoryImportAudit['status']
  total_count: number | bigint
  new_event_count: number | bigint
  duplicate_count: number | bigint
  malformed_count: number | bigint
  unique_video_count: number | bigint
  new_video_count: number | bigint
  committed_event_count: number | bigint | null
  oldest_watched_at: string | null
  newest_watched_at: string | null
  created_at: string
  expires_at: string
  committed_at: string | null
}

export class YouTubeHistoryImports {
  readonly #db: Database
  readonly #parser: TakeoutWatchHistoryParser
  readonly #stageDir: string
  readonly #ttlMs: number
  readonly #nowMs: () => number
  readonly #beforeEventCommit?: (event: ParsedWatchEvent, index: number) => void

  constructor(options: {
    readonly db: Database
    readonly dataDir: string
    readonly parser?: TakeoutWatchHistoryParser
    readonly ttlMs?: number
    readonly nowMs?: () => number
    /** Test seam used to prove transaction rollback; production leaves it unset. */
    readonly beforeEventCommit?: (event: ParsedWatchEvent, index: number) => void
  }) {
    this.#db = options.db
    this.#parser = options.parser ?? new TakeoutWatchHistoryParser()
    this.#stageDir = resolve(options.dataDir, 'youtube-history-imports')
    this.#ttlMs = options.ttlMs ?? DEFAULT_HISTORY_STAGE_TTL_MS
    this.#nowMs = options.nowMs ?? (() => Date.now())
    this.#beforeEventCommit = options.beforeEventCommit
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1) throw new Error('History staging TTL must be positive.')
  }

  get maxBytes(): number { return this.#parser.maxBytes }

  async initialize(): Promise<void> {
    await mkdir(this.#stageDir, { recursive: true, mode: 0o700 })
    await this.cleanupExpired()
  }

  async preview(input: Buffer, originalFilename: string): Promise<HistoryPreview> {
    await this.cleanupExpired()
    const parsed = this.#parser.parse(input)
    const token = randomUUID()
    const stagedFilename = `${token}.json`
    const stagedPath = this.#stagedPath(stagedFilename)
    const now = new Date(this.#nowMs()).toISOString()
    const expiresAt = new Date(this.#nowMs() + this.#ttlMs).toISOString()
    const filename = safeFilename(originalFilename)
    const fileHash = createHash('sha256').update(input).digest('hex')

    const knownFingerprints = new Set<string>()
    for (const event of parsed.events) {
      if (knownFingerprints.has(event.fingerprint)) continue
      if (this.#db.get('SELECT 1 FROM youtube_watch_events WHERE event_fingerprint = ?', [event.fingerprint])) continue
      knownFingerprints.add(event.fingerprint)
    }
    const duplicateCount = parsed.events.length - knownFingerprints.size
    let newVideoCount = 0
    for (const videoId of parsed.uniqueVideoIds) {
      if (!this.#db.get('SELECT 1 FROM videos WHERE video_id = ?', [videoId])) newVideoCount += 1
    }

    await mkdir(this.#stageDir, { recursive: true, mode: 0o700 })
    await writeFile(stagedPath, input, { flag: 'wx', mode: 0o600 })
    try {
      this.#db.run(
        `INSERT INTO youtube_history_imports
         (id, file_hash, original_filename, staged_filename, status, total_count,
          new_event_count, duplicate_count, malformed_count, unique_video_count,
          new_video_count, oldest_watched_at, newest_watched_at, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'previewed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [token, fileHash, filename, stagedFilename, parsed.totalCount,
          knownFingerprints.size, duplicateCount, parsed.malformed.length,
          parsed.uniqueVideoIds.size, newVideoCount, parsed.oldestWatchedAt,
          parsed.newestWatchedAt, now, expiresAt],
      )
    } catch (error: unknown) {
      await unlink(stagedPath).catch(() => undefined)
      throw error
    }

    return {
      token, filename, totalCount: parsed.totalCount,
      newEventCount: knownFingerprints.size, duplicateCount,
      malformedCount: parsed.malformed.length,
      uniqueVideoCount: parsed.uniqueVideoIds.size, newVideoCount,
      oldestWatchedAt: parsed.oldestWatchedAt,
      newestWatchedAt: parsed.newestWatchedAt, expiresAt,
    }
  }

  async commit(token: string): Promise<HistoryCommitResult> {
    await this.cleanupExpired()
    const row = this.#getRow(token)
    if (!row) throw new HistoryImportNotFoundError('History import token was not found.')
    if (row.status === 'expired') throw new HistoryImportExpiredError('History import preview has expired.')
    if (row.status === 'committed') throw new HistoryImportAlreadyCommittedError('History import was already committed.')
    if (row.status !== 'previewed') throw new HistoryImportIntegrityError('History import is not commit-ready.')

    const stagedPath = this.#stagedPath(row.staged_filename)
    let input: Buffer
    try {
      input = await readFile(stagedPath)
    } catch {
      throw new HistoryImportIntegrityError('Staged history file is missing.')
    }
    if (createHash('sha256').update(input).digest('hex') !== row.file_hash) {
      throw new HistoryImportIntegrityError('Staged history file failed its integrity check.')
    }
    const parsed = this.#parser.parse(input)
    const committedAt = new Date(this.#nowMs()).toISOString()

    const result = this.#db.transaction(() => {
      const current = this.#getRow(token)
      if (current?.status === 'committed') throw new HistoryImportAlreadyCommittedError('History import was already committed.')
      if (current?.status !== 'previewed') throw new HistoryImportIntegrityError('History import is not commit-ready.')
      let committedEventCount = 0
      let duplicateCount = 0
      let insertedVideoCount = 0
      let existingVideoCount = 0
      let snapshotOnlyCount = 0
      const canonicalVideos = new Map<string, string>()

      parsed.events.forEach((event, index) => {
        this.#beforeEventCommit?.(event, index)
        if (this.#db.get('SELECT 1 FROM youtube_watch_events WHERE event_fingerprint = ?', [event.fingerprint])) {
          duplicateCount += 1
          return
        }

        let canonicalId: string | null = null
        if (event.videoId) {
          canonicalId = canonicalVideos.get(event.videoId) ?? null
          if (!canonicalId) {
            const existing = this.#db.get<{ id: string; channel_id: string }>(
              'SELECT id, channel_id FROM videos WHERE video_id = ?', [event.videoId],
            )
            const channelId = existing?.channel_id ?? event.channelId ?? syntheticChannelId(event)
            const upserted = upsertYouTubeVideo(this.#db, {
              videoId: event.videoId,
              channelId,
              channelTitle: event.channelTitle ?? (existing ? undefined : 'Unknown YouTube channel'),
              title: event.title,
              publishedAt: event.watchedAt,
              thumbnailUrl: null,
              link: `https://www.youtube.com/watch?v=${encodeURIComponent(event.videoId)}`,
              origin: null,
              preserveExistingMetadata: true,
            }, this.#nowMs)
            canonicalId = upserted.id
            canonicalVideos.set(event.videoId, canonicalId)
            if (upserted.outcome === 'inserted') insertedVideoCount += 1
            else existingVideoCount += 1
          }
        } else {
          snapshotOnlyCount += 1
        }

        this.#db.run(
          `INSERT INTO youtube_watch_events
           (id, video_id, youtube_video_id, watched_at, title_snapshot,
            channel_id_snapshot, channel_title_snapshot, event_fingerprint,
            history_import_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [randomUUID(), canonicalId, event.videoId, event.watchedAt, event.title,
            event.channelId, event.channelTitle, event.fingerprint, token, committedAt],
        )
        committedEventCount += 1
      })

      this.#db.run(
        `UPDATE youtube_history_imports
            SET status = 'committed', committed_event_count = ?, committed_at = ?
          WHERE id = ? AND status = 'previewed'`,
        [committedEventCount, committedAt, token],
      )
      return { committedEventCount, duplicateCount, malformedCount: parsed.malformed.length,
        insertedVideoCount, existingVideoCount, snapshotOnlyCount }
    })

    await unlink(stagedPath).catch(() => undefined)
    return { token, ...result, committedAt }
  }

  async list(): Promise<ReadonlyArray<HistoryImportAudit>> {
    await this.cleanupExpired()
    return this.#db.all<HistoryImportRow>(
      `SELECT * FROM youtube_history_imports ORDER BY created_at DESC, id DESC`,
    ).map(auditJson)
  }

  async cleanupExpired(): Promise<number> {
    const now = new Date(this.#nowMs()).toISOString()
    const expired = this.#db.all<{ id: string; staged_filename: string }>(
      `SELECT id, staged_filename FROM youtube_history_imports
        WHERE status = 'previewed' AND expires_at <= ?`, [now],
    )
    if (expired.length === 0) return 0
    this.#db.transaction(() => {
      for (const row of expired) {
        this.#db.run(`UPDATE youtube_history_imports SET status = 'expired' WHERE id = ? AND status = 'previewed'`, [row.id])
      }
    })
    await Promise.all(expired.map((row) => unlink(this.#stagedPath(row.staged_filename)).catch(() => undefined)))
    return expired.length
  }

  #getRow(token: string): HistoryImportRow | undefined {
    return this.#db.get<HistoryImportRow>('SELECT * FROM youtube_history_imports WHERE id = ?', [token])
  }

  #stagedPath(stagedFilename: string): string {
    if (!/^[0-9a-f-]{36}\.json$/i.test(stagedFilename)) throw new HistoryImportIntegrityError('Unsafe staged history filename.')
    const path = resolve(this.#stageDir, stagedFilename)
    if (dirname(path) !== this.#stageDir) throw new HistoryImportIntegrityError('Unsafe staged history path.')
    return path
  }
}

function safeFilename(value: string): string {
  const name = basename(value.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return name.slice(0, 255) || 'watch-history.json'
}

function syntheticChannelId(event: ParsedWatchEvent): string {
  return `takeout-${createHash('sha256').update(event.channelTitle ?? event.videoId ?? 'unknown').digest('hex').slice(0, 24)}`
}

function auditJson(row: HistoryImportRow): HistoryImportAudit {
  return {
    token: row.id, filename: row.original_filename, fileHash: row.file_hash,
    status: row.status, totalCount: Number(row.total_count),
    newEventCount: Number(row.new_event_count), duplicateCount: Number(row.duplicate_count),
    malformedCount: Number(row.malformed_count), uniqueVideoCount: Number(row.unique_video_count),
    newVideoCount: Number(row.new_video_count),
    committedEventCount: row.committed_event_count === null ? null : Number(row.committed_event_count),
    oldestWatchedAt: row.oldest_watched_at, newestWatchedAt: row.newest_watched_at,
    createdAt: row.created_at, expiresAt: row.expires_at, committedAt: row.committed_at,
  }
}

export { TakeoutHistoryFormatError, TakeoutHistorySizeError }
