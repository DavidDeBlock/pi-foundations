// youtube-videos.ts — issue YT-004
//
// Storage helpers for the `videos` table populated by the RSS
// poller. Pure data layer: no HTTP, no Atom parsing, no scheduler.
// Mirrors `youtube-subscriptions.ts`'s flat-namespace pattern: each
// function takes `Database` first and the lookup key(s) second.
//
// Identity is `video_id` (YouTube's 11-char ID, UNIQUE in the
// schema). The dashboard-side `id` is the FK target for the
// `video_tags` join table and any other dashboard-side joins
// (e.g. folder moves in YT-005).
//
// FK cascade behavior (per migration `010_videos.sql`):
//   * `videos.channel_id → subscriptions.channel_id ON DELETE
//     RESTRICT` — deleting a subscription requires first deleting
//     its videos. The disconnect flow must clear videos for the
//     account before deleting subscriptions (which auto-cascade
//     from `youtube_accounts`).
//   * `videos.folder_id → folders(id) ON DELETE SET NULL` — videos
//     that lived in a deleted folder become unfoldered, not deleted.
//   * `video_tags` rows cascade on video or tag delete.
//
// All read functions convert SQLite's `0/1` integers into booleans
// and rename the snake_case columns to the camelCase the rest of
// the codebase uses.

import { randomUUID } from 'node:crypto'
import type { Database } from './db.js'

// ─── Types ────────────────────────────────────────────────────────────────

/** UI/API view of one video. One row per YouTube video discovered
 *  via RSS polling. `folderId` is nullable (uncategorized is
 *  allowed); `discoveredAt` is when we saw it, distinct from
 *  `publishedAt` (when it went live on YouTube). */
export interface Video {
  readonly id: string
  readonly videoId: string
  readonly channelId: string
  readonly title: string
  readonly publishedAt: string
  readonly thumbnailUrl: string | null
  readonly link: string
  readonly discoveredAt: string
  readonly folderId: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** Input to `insertVideo` — the fields the RSS poller supplies.
 *  `id`, `discoveredAt`, `createdAt`, `updatedAt` are
 *  server-generated. */
export interface VideoInsertInput {
  readonly videoId: string
  readonly channelId: string
  readonly title: string
  readonly publishedAt: string
  readonly thumbnailUrl: string | null
  readonly link: string
}

/** Raw row shape, as returned by `SELECT *`. SQLite returns `0/1`
 *  for booleans + ISO strings for timestamps — both get converted
 *  by `rowToVideo`. */
interface VideoRow {
  id: string
  video_id: string
  channel_id: string
  title: string
  published_at: string
  thumbnail_url: string | null
  link: string
  discovered_at: string
  folder_id: string | null
  created_at: string
  updated_at: string
}

// ─── Reads ────────────────────────────────────────────────────────────────

/** Find one video by its dashboard id. Returns `null` when no row
 *  matches. Used by the API layer (PATCH/GET /api/videos/:id) when
 *  the row id is in the URL path. */
export function getVideoById(db: Database, id: string): Video | null {
  const row = db.get<VideoRow>('SELECT * FROM videos WHERE id = ?', [id])
  return row === undefined ? null : rowToVideo(row)
}

/** Find one video by its YouTube-side `video_id` (the 11-char
 *  string in the URL). Used by the poller's duplicate-detection
 *  logic and by tests. */
export function getVideoByVideoId(db: Database, videoId: string): Video | null {
  const row = db.get<VideoRow>(
    'SELECT * FROM videos WHERE video_id = ?',
    [videoId],
  )
  return row === undefined ? null : rowToVideo(row)
}

/** Total number of rows in `videos`. Cheap; used by health-checks
 *  and dashboards. */
export function countVideos(db: Database): number {
  const result = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM videos')
  return result?.c ?? 0
}

/** List every `videoId` we know about for one channel. Used by
 *  the RSS poller's "what have we seen?" lookup when the entry
 *  list is small (under 100 per channel — a fan-out query is
 *  overkill). Returns the YouTube-side id strings only; the
 *  dashboard uuid is irrelevant for dedupe. */
export function listVideoIdsForChannel(
  db: Database,
  channelId: string,
): string[] {
  return db.all<{ video_id: string }>(
    'SELECT video_id FROM videos WHERE channel_id = ?',
    [channelId],
  ).map((r) => r.video_id)
}

// ─── Writes ───────────────────────────────────────────────────────────────

/**
 * Insert a single video row, no-op when `videoId` already exists.
 *
 * Why `INSERT OR IGNORE` instead of an upsert: the RSS poller's
 * contract is "new entries get inserted, duplicates are skipped".
 * Re-discovering a video should NEVER update the row — `title`
 * is locally-mutable in YT-005 (operator rename), and a re-poll
 * overwriting it would undo the operator's work. `INSERT OR
 * IGNORE` enforces idempotency without an UPDATE branch.
 *
 * Returns:
 *   * `'inserted'` — a new row was created.
 *   * `'duplicate'` — a row with the same `video_id` already
 *     existed and was left untouched.
 *
 * The `nowMs` injection lets tests drive `discovered_at` /
 * `created_at` deterministically without sleeping.
 */
export function insertVideo(
  db: Database,
  input: VideoInsertInput,
  nowMs?: () => number,
): { outcome: 'inserted' | 'duplicate'; id: string } {
  const id = randomUUID()
  const result = db.run(
    `INSERT OR IGNORE INTO videos (
       id, video_id, channel_id, title, published_at,
       thumbnail_url, link, discovered_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.videoId,
      input.channelId,
      input.title,
      input.publishedAt,
      input.thumbnailUrl,
      input.link,
      isoNow(nowMs),
    ],
  )
  if (result.changes === 0) {
    // The id we generated isn't in the DB — fetch the real row's
    // id so callers can log / dedupe against it.
    const existing = db.get<{ id: string }>(
      'SELECT id FROM videos WHERE video_id = ?',
      [input.videoId],
    )
    return { outcome: 'duplicate', id: existing?.id ?? id }
  }
  return { outcome: 'inserted', id }
}

/** Touch the `last_polled_at` column for one subscription row.
 *  Called by the RSS poller for every channel it attempted,
 *  regardless of whether the fetch succeeded or failed — that's
 *  the AC's "stale because we stopped polling" vs "stale
 *  because nothing's new" disambiguation. */
export function touchVideoLastPolledAt(
  db: Database,
  channelId: string,
  nowMs?: () => number,
): void {
  db.run(
    `UPDATE subscriptions SET last_polled_at = ?, updated_at = ?
       WHERE channel_id = ?`,
    [isoNow(nowMs), isoNow(nowMs), channelId],
  )
}

/**
 * Update the `folder_id` for one video. Pass `null` to unfolder.
 * Used by `PATCH /api/videos/:id {folder_id}` in YT-005.
 *
 * Returns `true` on success, `false` when the row id doesn't
 * exist (so the API can return 404 without a separate SELECT).
 */
export function updateVideoFolder(
  db: Database,
  id: string,
  folderId: string | null,
  nowMs?: () => number,
): boolean {
  const result = db.run(
    `UPDATE videos SET folder_id = ?, updated_at = ? WHERE id = ?`,
    [folderId, isoNow(nowMs), id],
  )
  return result.changes > 0
}

/** Rename a video's title locally. Used by `PATCH /api/videos/:id
 *  {title}` in YT-005. Returns `true` on success, `false` when
 *  the row id doesn't exist. */
export function renameVideoTitle(
  db: Database,
  id: string,
  title: string,
  nowMs?: () => number,
): boolean {
  const result = db.run(
    `UPDATE videos SET title = ?, updated_at = ? WHERE id = ?`,
    [title, isoNow(nowMs), id],
  )
  return result.changes > 0
}

// ─── Row mapping ──────────────────────────────────────────────────────────

function rowToVideo(row: VideoRow): Video {
  return {
    id: row.id,
    videoId: row.video_id,
    channelId: row.channel_id,
    title: row.title,
    publishedAt: row.published_at,
    thumbnailUrl: row.thumbnail_url,
    link: row.link,
    discoveredAt: row.discovered_at,
    folderId: row.folder_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function isoNow(nowMs?: () => number): string {
  const ms = nowMs?.() ?? Date.now()
  return new Date(ms).toISOString()
}