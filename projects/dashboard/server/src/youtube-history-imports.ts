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
import type { VideoDurationFetcher, VideoDurationResult } from './youtube-video-duration-fetcher.js'

export const DEFAULT_HISTORY_STAGE_TTL_MS = 24 * 60 * 60 * 1000

export class HistoryImportNotFoundError extends Error {}
export class HistoryImportExpiredError extends Error {}
export class HistoryImportAlreadyCommittedError extends Error {}
export class HistoryImportIntegrityError extends Error {}
export class HistoryImportClassificationError extends Error {}

export const HISTORY_SHORT_MAX_SECONDS = 180

export interface HistoryPreview {
  readonly token: string
  readonly filename: string
  readonly totalCount: number
  readonly newEventCount: number
  readonly duplicateCount: number
  readonly malformedCount: number
  readonly uniqueVideoCount: number
  readonly newVideoCount: number
  readonly shortsExcludedEventCount: number
  readonly shortsExcludedVideoCount: number
  readonly unavailableVideoCount: number
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
  readonly shortsExcludedEventCount: number
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
  readonly sourceFormat: 'json' | 'html'
  readonly shortsExcludedEventCount: number
  readonly shortsExcludedVideoCount: number
  readonly unavailableVideoCount: number
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
  source_format: 'json' | 'html'
  shorts_excluded_event_count: number | bigint
  shorts_excluded_video_count: number | bigint
  unavailable_video_count: number | bigint
}

type HistoryVideoClassification = 'long' | 'short' | 'unavailable'

export class YouTubeHistoryImports {
  readonly #db: Database
  readonly #parser: TakeoutWatchHistoryParser
  readonly #stageDir: string
  readonly #ttlMs: number
  readonly #nowMs: () => number
  readonly #beforeEventCommit?: (event: ParsedWatchEvent, index: number) => void
  readonly #durationFetcher?: VideoDurationFetcher
  readonly #accessToken?: () => Promise<string>

  constructor(options: {
    readonly db: Database
    readonly dataDir: string
    readonly parser?: TakeoutWatchHistoryParser
    readonly ttlMs?: number
    readonly nowMs?: () => number
    readonly durationFetcher?: VideoDurationFetcher
    readonly accessToken?: () => Promise<string>
    /** Test seam used to prove transaction rollback; production leaves it unset. */
    readonly beforeEventCommit?: (event: ParsedWatchEvent, index: number) => void
  }) {
    this.#db = options.db
    this.#parser = options.parser ?? new TakeoutWatchHistoryParser()
    this.#stageDir = resolve(options.dataDir, 'youtube-history-imports')
    this.#ttlMs = options.ttlMs ?? DEFAULT_HISTORY_STAGE_TTL_MS
    this.#nowMs = options.nowMs ?? (() => Date.now())
    this.#beforeEventCommit = options.beforeEventCommit
    this.#durationFetcher = options.durationFetcher
    this.#accessToken = options.accessToken
    if ((this.#durationFetcher === undefined) !== (this.#accessToken === undefined)) {
      throw new Error('History duration fetcher and access token provider must be configured together.')
    }
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
    const classifications = await this.#classify(parsed.events, parsed.format === 'html')
    const importableEvents = parsed.events.filter((event) =>
      !event.videoId || classifications.get(event.videoId)?.classification !== 'short')
    const importableVideoIds = new Set(importableEvents.flatMap((event) => event.videoId ? [event.videoId] : []))
    const shortsExcludedEvents = parsed.events.filter((event) =>
      event.videoId && classifications.get(event.videoId)?.classification === 'short').length
    const shortsExcludedVideos = [...classifications.values()].filter((value) => value.classification === 'short').length
    const unavailableVideoCount = [...classifications.values()].filter((value) => value.classification === 'unavailable').length
    const token = randomUUID()
    const stagedFilename = `${token}.json`
    const stagedPath = this.#stagedPath(stagedFilename)
    const now = new Date(this.#nowMs()).toISOString()
    const expiresAt = new Date(this.#nowMs() + this.#ttlMs).toISOString()
    const filename = safeFilename(originalFilename)
    const fileHash = createHash('sha256').update(input).digest('hex')

    const knownFingerprints = new Set<string>()
    for (const event of importableEvents) {
      if (knownFingerprints.has(event.fingerprint)) continue
      if (this.#db.get('SELECT 1 FROM youtube_watch_events WHERE event_fingerprint = ?', [event.fingerprint])) continue
      knownFingerprints.add(event.fingerprint)
    }
    const duplicateCount = importableEvents.length - knownFingerprints.size
    let newVideoCount = 0
    for (const videoId of importableVideoIds) {
      if (classifications.get(videoId)?.classification === 'unavailable') continue
      if (!this.#db.get('SELECT 1 FROM videos WHERE video_id = ?', [videoId])) newVideoCount += 1
    }
    const { oldestWatchedAt, newestWatchedAt } = eventDateRange(importableEvents)

    await mkdir(this.#stageDir, { recursive: true, mode: 0o700 })
    await writeFile(stagedPath, input, { flag: 'wx', mode: 0o600 })
    try {
      this.#db.transaction(() => {
        this.#db.run(
          `INSERT INTO youtube_history_imports
           (id, file_hash, original_filename, staged_filename, status, total_count,
            new_event_count, duplicate_count, malformed_count, unique_video_count,
            new_video_count, oldest_watched_at, newest_watched_at, created_at, expires_at,
            source_format, shorts_excluded_event_count, shorts_excluded_video_count,
            unavailable_video_count)
           VALUES (?, ?, ?, ?, 'previewed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [token, fileHash, filename, stagedFilename, parsed.totalCount,
            knownFingerprints.size, duplicateCount, parsed.malformed.length,
            importableVideoIds.size, newVideoCount, oldestWatchedAt,
            newestWatchedAt, now, expiresAt, parsed.format, shortsExcludedEvents,
            shortsExcludedVideos, unavailableVideoCount],
        )
        for (const [videoId, value] of classifications) {
          this.#db.run(
            `INSERT INTO youtube_history_video_classifications
             (history_import_id, youtube_video_id, classification, duration_seconds)
             VALUES (?, ?, ?, ?)`,
            [token, videoId, value.classification, value.durationSeconds],
          )
        }
      })
    } catch (error: unknown) {
      await unlink(stagedPath).catch(() => undefined)
      throw error
    }

    return {
      token, filename, totalCount: parsed.totalCount,
      newEventCount: knownFingerprints.size, duplicateCount,
      malformedCount: parsed.malformed.length,
      uniqueVideoCount: importableVideoIds.size, newVideoCount,
      shortsExcludedEventCount: shortsExcludedEvents,
      shortsExcludedVideoCount: shortsExcludedVideos,
      unavailableVideoCount,
      oldestWatchedAt, newestWatchedAt, expiresAt,
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
    const classifications = new Map(this.#db.all<{
      youtube_video_id: string
      classification: HistoryVideoClassification
    }>(
      `SELECT youtube_video_id, classification
         FROM youtube_history_video_classifications WHERE history_import_id = ?`, [token],
    ).map((item) => [item.youtube_video_id, item.classification] as const))
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
        const classification = event.videoId ? classifications.get(event.videoId) : undefined
        if (classification === 'short') return
        this.#beforeEventCommit?.(event, index)
        if (this.#db.get('SELECT 1 FROM youtube_watch_events WHERE event_fingerprint = ?', [event.fingerprint])) {
          duplicateCount += 1
          return
        }

        let canonicalId: string | null = null
        if (event.videoId && classification !== 'unavailable') {
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
        insertedVideoCount, existingVideoCount, snapshotOnlyCount,
        shortsExcludedEventCount: Number(row.shorts_excluded_event_count) }
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

  async #classify(events: readonly ParsedWatchEvent[], requireDurationLookup: boolean): Promise<Map<string, {
    readonly classification: HistoryVideoClassification
    readonly durationSeconds: number | null
  }>> {
    const values = new Map<string, { classification: HistoryVideoClassification; durationSeconds: number | null }>()
    for (const event of events) {
      if (event.videoId && event.knownShort) values.set(event.videoId, { classification: 'short', durationSeconds: null })
    }
    const remaining = [...new Set(events.flatMap((event) =>
      event.videoId && !values.has(event.videoId) ? [event.videoId] : []))]
    if (remaining.length === 0) return values
    if (!this.#durationFetcher || !this.#accessToken) {
      if (requireDurationLookup) {
        throw new HistoryImportClassificationError('Connect YouTube before importing HTML so Shorts can be excluded safely.')
      }
      for (const videoId of remaining) values.set(videoId, { classification: 'long', durationSeconds: null })
      return values
    }
    let fetched: ReadonlyMap<string, VideoDurationResult>
    try {
      fetched = await this.#durationFetcher.fetch(await this.#accessToken(), remaining)
    } catch (error: unknown) {
      const detail = error instanceof Error ? ` ${error.message}` : ''
      throw new HistoryImportClassificationError(`Could not classify Shorts before import.${detail}`)
    }
    for (const videoId of remaining) {
      const result = fetched.get(videoId)
      if (!result) throw new HistoryImportClassificationError('YouTube duration lookup returned an incomplete result.')
      values.set(videoId, result.status === 'unavailable'
        ? { classification: 'unavailable', durationSeconds: null }
        : {
            classification: result.durationSeconds <= HISTORY_SHORT_MAX_SECONDS ? 'short' : 'long',
            durationSeconds: result.durationSeconds,
          })
    }
    return values
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
    sourceFormat: row.source_format,
    shortsExcludedEventCount: Number(row.shorts_excluded_event_count),
    shortsExcludedVideoCount: Number(row.shorts_excluded_video_count),
    unavailableVideoCount: Number(row.unavailable_video_count),
    committedEventCount: row.committed_event_count === null ? null : Number(row.committed_event_count),
    oldestWatchedAt: row.oldest_watched_at, newestWatchedAt: row.newest_watched_at,
    createdAt: row.created_at, expiresAt: row.expires_at, committedAt: row.committed_at,
  }
}

function eventDateRange(events: readonly ParsedWatchEvent[]): {
  readonly oldestWatchedAt: string | null
  readonly newestWatchedAt: string | null
} {
  let oldestWatchedAt: string | null = null
  let newestWatchedAt: string | null = null
  for (const event of events) {
    if (oldestWatchedAt === null || event.watchedAt < oldestWatchedAt) oldestWatchedAt = event.watchedAt
    if (newestWatchedAt === null || event.watchedAt > newestWatchedAt) newestWatchedAt = event.watchedAt
  }
  return { oldestWatchedAt, newestWatchedAt }
}

export { TakeoutHistoryFormatError, TakeoutHistorySizeError }
