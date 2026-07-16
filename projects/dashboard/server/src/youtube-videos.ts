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
import { normalize } from './tag-normalizer.js'

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

/** Filter + paging options for `searchVideos`. Any of `channelId`,
 *  `folderId`, `unfoldered`, and `tagId` may be set; missing/absent
 *  filters are no-ops. Paging is offset-based (matches YT-003's
 *  subscriptions list — dashboard has one user, ~hundreds of rows,
 *  the simplicity wins out over cursor stability). */
export interface SearchVideosOptions {
  readonly channelId?: string
  readonly folderId?: string
  /** When `true`, filters to videos with `folder_id IS NULL`.
   *  Combines well with the folder filter — if you want to see
   *  "uncategorized videos for channel X" you set both
   *  `channelId` and `unfoldered: true`. */
  readonly unfoldered?: boolean
  readonly tagId?: string
  readonly page?: number
  readonly limit?: number
  /** Optional injected clock to make `discovered_at` ordering
   *  deterministic in tests (the default is fine at runtime). */
  readonly nowMs?: () => number
}

export interface SearchVideosResult {
  readonly items: VideoListItem[]
  readonly total: number
  readonly page: number
  readonly limit: number
}

/** Extended item shape returned by `searchVideos` and `getVideoDetail`.
 *  Joins in channel + folder + tag info so the API layer doesn't have
 *  to issue N+1 queries per row. */
export interface VideoListItem {
  readonly id: string
  readonly videoId: string
  readonly channelId: string
  readonly channelTitle: string
  readonly channelThumbnailUrl: string | null
  readonly title: string
  readonly publishedAt: string
  readonly thumbnailUrl: string | null
  readonly link: string
  readonly discoveredAt: string
  readonly folderId: string | null
  readonly folderName: string | null
  readonly tags: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

export interface VideoDetail extends VideoListItem {
  /** `discovered_at` ordering is sensitive to clock skew between
   *  you and YouTube; here for completeness, not used by the UI. */
  readonly channelIsIncluded: boolean
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

// ─── Search / list ───────────────────────────────────────────────────────

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200

/**
 * Paginated, filterable list of videos for `GET /api/videos`.
 *
 * Sort order: `discovered_at DESC, id ASC`. The `id ASC` tiebreaker
 * keeps pagination stable when many videos share the same
 * `discovered_at` second (RSS feeds can land dozens at once).
 *
 * `tagId` filtering is a `JOIN video_tags` — distinct because a
 * single video can have multiple tags and the filter must be
 * "this video has this tag" not "this row's tag_id matches".
 *
 * Limits: defaults to 50, capped at 200 (matches the subscriptions
 * pattern from YT-003; `clampLimit` lives in subscriptions.ts,
 * but we duplicate it locally to keep this module independent).
 */
export function searchVideos(
  db: Database,
  options: SearchVideosOptions = {},
): SearchVideosResult {
  const limit = clamp(options.limit ?? DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT)
  const page = options.page !== undefined && options.page >= 1 ? Math.floor(options.page) : 1
  const offset = (page - 1) * limit

  // ─── WHERE assembly ────────────────────────────────────────────────
  const where: string[] = []
  const params: Array<string | number> = []
  if (options.channelId) {
    where.push('v.channel_id = ?')
    params.push(options.channelId)
  }
  if (options.folderId) {
    where.push('v.folder_id = ?')
    params.push(options.folderId)
  } else if (options.unfoldered) {
    where.push('v.folder_id IS NULL')
  }
  if (options.tagId) {
    // DISTINCT because JOIN video_tags would otherwise multiply
    // rows for videos that have multiple tags.
    where.push('EXISTS (SELECT 1 FROM video_tags vt WHERE vt.video_id = v.id AND vt.tag_id = ?)')
    params.push(options.tagId)
  }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''

  // Total count uses the same WHERE (subquery wrapper around
  // DISTINCT base) so the `total` matches the filtered query.
  const totalRow = db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM (
       SELECT DISTINCT v.id FROM videos v${whereSql}
     )`,
    params,
  )
  const total = totalRow?.c ?? 0

  // ─── Page ──────────────────────────────────────────────────────────
  const rows = db.all<VideoListItemRow>(
    `SELECT DISTINCT v.id, v.video_id, v.channel_id,
            s.channel_title, s.channel_thumbnail_url,
            v.title, v.published_at, v.thumbnail_url,
            v.link, v.discovered_at, v.folder_id, f.name AS folder_name,
            s.is_included AS channel_is_included
       FROM videos v
            JOIN subscriptions s ON s.channel_id = v.channel_id
            LEFT JOIN folders f ON f.id = v.folder_id${whereSql}
      ORDER BY v.discovered_at DESC, v.id ASC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )

  const items = rows.map(rowToVideoListItem)
  // Hydrate tags in a single follow-up query — N+1 would be
  // expensive for the operator's `All` filter (hundreds of rows
  // potentially).
  const tagMap = listTagsForVideos(
    db,
    items.map((it) => it.id),
  )
  const hydrated = items.map((it) => ({ ...it, tags: tagMap.get(it.id) ?? [] }))
  return { items: hydrated, total, page, limit }
}

/**
 * Single-video detail with joined channel + folder + tag info.
 * Returns `null` when the id doesn't exist (the route layer
 * translates that to 404). Distinct from `getVideoById` because:
 *   * the list path needs channel + folder + tags (otherwise the
 *     operator would see "Video X, folder_id=f-1, no name");
 *   * the detail page may show channel-toggled state too, so we
 *     also return `channel_is_included`.
 */
export function getVideoDetail(db: Database, id: string): VideoDetail | null {
  const row = db.get<VideoListItemRow & { channel_is_included: number }>(
    `SELECT v.id, v.video_id, v.channel_id,
            s.channel_title, s.channel_thumbnail_url,
            v.title, v.published_at, v.thumbnail_url,
            v.link, v.discovered_at, v.folder_id, f.name AS folder_name,
            s.is_included AS channel_is_included
       FROM videos v
            JOIN subscriptions s ON s.channel_id = v.channel_id
            LEFT JOIN folders f ON f.id = v.folder_id
      WHERE v.id = ?`,
    [id],
  )
  if (row === undefined) return null
  const item = rowToVideoListItem(row)
  const tags = listTagsForVideo(db, id)
  return {
    ...item,
    tags,
    channelIsIncluded: row.channel_is_included === 1,
  }
}

/** List all tags attached to a single video (alphabetical, same
 *  shape as `tags.ts`'s `getTagsForBookmark`). Used by the API
 *  layer for the tag add/remove endpoints' response bodies. */
export function listTagsForVideo(
  db: Database,
  videoId: string,
): ReadonlyArray<{ readonly id: string; readonly name: string }> {
  return db.all<{ id: string; name: string }>(
    `SELECT t.id, t.name
       FROM tags t
       JOIN video_tags vt ON vt.tag_id = t.id
      WHERE vt.video_id = ?
      ORDER BY t.name`,
    [videoId],
  )
}

/** Attach a tag (by canonical name) to a video, creating the tag
 *  row when missing. Idempotent. Returns the tag row that's now
 *  attached. Used by `POST /api/videos/:id/tags {name}`.
 *
 *  Reuses `tags.ts`'s storage helpers indirectly: we call
 *  `normalize(name)` + an `INSERT OR IGNORE INTO tags` pattern
 *  identical to `attachTagsToBookmark`, but for `video_tags`
 *  instead. Kept local rather than factored out because the
 *  two join tables have different FK semantics (videos have
 *  `ON DELETE RESTRICT` on `videos.channel_id`, bookmarks have
 *  a different set of cascades — no shared abstraction worthy).
 */
export function attachTagByNameToVideo(
  db: Database,
  videoId: string,
  rawName: string,
): { readonly id: string; readonly name: string } | null {
  const canonical = normalize(rawName)
  if (canonical === '') return null
  return db.transaction(() => {
    let row = db.get<{ id: string }>(
      'SELECT id FROM tags WHERE name = ?',
      [canonical],
    )
    if (row === undefined) {
      const newId = crypto.randomUUID()
      db.run('INSERT INTO tags (id, name) VALUES (?, ?)', [newId, canonical])
      row = { id: newId }
    }
    db.run(
      `INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)`,
      [videoId, row.id],
    )
    return { id: row.id, name: canonical }
  })
}

/** Remove a tag from a video. Returns `true` when a row was
 *  deleted (the link existed), `false` otherwise. Mirrors
 *  `tags.ts`'s `detachTagFromBookmark`. */
export function detachTagFromVideo(
  db: Database,
  videoId: string,
  tagId: string,
): boolean {
  const result = db.run(
    'DELETE FROM video_tags WHERE video_id = ? AND tag_id = ?',
    [videoId, tagId],
  )
  return result.changes > 0
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

// ─── List-row mapping ────────────────────────────────────────────────────

interface VideoListItemRow {
  id: string
  video_id: string
  channel_id: string
  channel_title: string | null
  channel_thumbnail_url: string | null
  title: string
  published_at: string
  thumbnail_url: string | null
  link: string
  discovered_at: string
  folder_id: string | null
  folder_name: string | null
}

function rowToVideoListItem(
  row: VideoListItemRow,
): VideoListItem {
  // Tag hydration is a separate query in `searchVideos`'s caller
  // — done in batch outside this mapping so we don't N+1 per
  // row. For a single detail fetch (GET /api/videos/:id) it's
  // OK to round-trip since there's only one row.
  return {
    id: row.id,
    videoId: row.video_id,
    channelId: row.channel_id,
    channelTitle: row.channel_title ?? row.channel_id,
    channelThumbnailUrl: row.channel_thumbnail_url,
    title: row.title,
    publishedAt: row.published_at,
    thumbnailUrl: row.thumbnail_url,
    link: row.link,
    discoveredAt: row.discovered_at,
    folderId: row.folder_id,
    folderName: row.folder_name,
    tags: [],
  }
}

/** Fetch tags for many videos in one query, indexed by video id.
 *  Used by `searchVideos` to avoid N+1 on the list path. */
export function listTagsForVideos(
  db: Database,
  videoIds: readonly string[],
): Map<string, Array<{ readonly id: string; readonly name: string }>> {
  if (videoIds.length === 0) return new Map()
  const placeholders = videoIds.map(() => '?').join(',')
  const rows = db.all<{ video_id: string; id: string; name: string }>(
    `SELECT vt.video_id, t.id, t.name
       FROM video_tags vt
       JOIN tags t ON t.id = vt.tag_id
      WHERE vt.video_id IN (${placeholders})
      ORDER BY t.name`,
    videoIds,
  )
  const out = new Map<string, Array<{ id: string; name: string }>>()
  for (const row of rows) {
    const list = out.get(row.video_id) ?? []
    list.push({ id: row.id, name: row.name })
    out.set(row.video_id, list)
  }
  return out
}

function isoNow(nowMs?: () => number): string {
  const ms = nowMs?.() ?? Date.now()
  return new Date(ms).toISOString()
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}