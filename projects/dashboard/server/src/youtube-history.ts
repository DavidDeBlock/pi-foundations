import type { Database } from './db.js'
import { listTagsForVideos, type EffectiveVideoTag } from './youtube-videos.js'

export interface WatchHistoryEvent {
  readonly id: string
  readonly videoId: string | null
  readonly youtubeVideoId: string | null
  readonly title: string
  readonly channelId: string | null
  readonly channelTitle: string | null
  readonly thumbnailUrl: string | null
  readonly watchedAt: string
  readonly watchCount: number
  readonly source: 'takeout' | 'search' | 'playlist' | 'subscription' | 'embedded_player'
  readonly tags: readonly EffectiveVideoTag[]
}

export interface WatchHistoryResult {
  readonly items: readonly WatchHistoryEvent[]
  readonly total: number
  readonly uniqueVideos: number
  readonly page: number
  readonly limit: number
}

export type WatchHistoryAvailability = 'all' | 'library' | 'snapshot'
export type WatchHistorySort = 'newest' | 'oldest'

export interface SearchWatchHistoryOptions {
  readonly query?: string
  readonly channelId?: string
  readonly tagId?: string
  readonly watchedFrom?: string
  readonly watchedTo?: string
  readonly availability?: WatchHistoryAvailability
  readonly sort?: WatchHistorySort
  readonly page?: number
  readonly limit?: number
}

export interface WatchHistoryOverview {
  readonly total: number
  readonly uniqueVideos: number
  readonly replayEvents: number
  readonly libraryVideos: number
}

export interface WatchHistoryFacet {
  readonly id: string
  readonly name: string
  readonly count: number
}

interface WatchHistoryRow {
  id: string
  video_id: string | null
  youtube_video_id: string | null
  title: string
  channel_id: string | null
  channel_title: string | null
  thumbnail_url: string | null
  watched_at: string
  watch_count: number | bigint
  source: WatchHistoryEvent['source']
}

export function searchWatchHistory(
  db: Database,
  options: SearchWatchHistoryOptions = {},
): WatchHistoryResult {
  const page = Math.max(1, Math.floor(options.page ?? 1))
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)))
  const offset = (page - 1) * limit
  const where: string[] = []
  const params: Array<string | number> = []
  const query = options.query?.trim()
  if (query) {
    where.push(`(COALESCE(v.local_title_override, v.title, we.title_snapshot) LIKE ? ESCAPE '\\'
      OR COALESCE(yc.title, we.channel_title_snapshot, '') LIKE ? ESCAPE '\\')`)
    const pattern = `%${escapeLike(query)}%`
    params.push(pattern, pattern)
  }
  if (options.channelId) {
    where.push('COALESCE(v.channel_id, we.channel_id_snapshot) = ?')
    params.push(options.channelId)
  }
  if (options.tagId) {
    where.push(`we.video_id IS NOT NULL AND (
      EXISTS (SELECT 1 FROM video_tags filter_vt WHERE filter_vt.video_id = we.video_id AND filter_vt.tag_id = ?)
      OR EXISTS (
        SELECT 1 FROM subscriptions filter_s
        JOIN subscription_tags filter_st ON filter_st.subscription_id = filter_s.id
        WHERE filter_s.channel_id = v.channel_id AND filter_st.tag_id = ?
      )
    )`)
    params.push(options.tagId, options.tagId)
  }
  if (options.watchedFrom) {
    where.push('julianday(we.watched_at) >= julianday(?)')
    params.push(`${options.watchedFrom}T00:00:00.000Z`)
  }
  if (options.watchedTo) {
    where.push("julianday(we.watched_at) < julianday(?, '+1 day')")
    params.push(`${options.watchedTo}T00:00:00.000Z`)
  }
  if (options.availability === 'library') where.push('we.video_id IS NOT NULL')
  if (options.availability === 'snapshot') where.push('we.video_id IS NULL')
  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  const totals = db.get<{ total: number | bigint; unique_videos: number | bigint }>(
    `SELECT COUNT(*) AS total,
            COUNT(DISTINCT COALESCE(we.video_id, we.youtube_video_id)) AS unique_videos
       FROM youtube_watch_events we
       LEFT JOIN videos v ON v.id = we.video_id
       LEFT JOIN youtube_channels yc ON yc.channel_id = v.channel_id${whereSql}`,
    params,
  )
  const order = options.sort === 'oldest' ? 'ASC' : 'DESC'
  const rows = db.all<WatchHistoryRow>(
    `SELECT we.id, we.video_id, we.youtube_video_id,
            COALESCE(v.local_title_override, v.title, we.title_snapshot) AS title,
            COALESCE(v.channel_id, we.channel_id_snapshot) AS channel_id,
            COALESCE(yc.title, we.channel_title_snapshot) AS channel_title,
            v.thumbnail_url,
            we.watched_at, we.source,
            (SELECT COUNT(*) FROM youtube_watch_events repeated
              WHERE (we.video_id IS NOT NULL AND repeated.video_id = we.video_id)
                 OR (we.video_id IS NULL AND we.youtube_video_id IS NOT NULL
                     AND repeated.video_id IS NULL AND repeated.youtube_video_id = we.youtube_video_id)
                 OR (we.video_id IS NULL AND we.youtube_video_id IS NULL AND repeated.id = we.id)
            ) AS watch_count
       FROM youtube_watch_events we
       LEFT JOIN videos v ON v.id = we.video_id
       LEFT JOIN youtube_channels yc ON yc.channel_id = v.channel_id
       ${whereSql}
      ORDER BY we.watched_at ${order}, we.id ASC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )
  const tagMap = listTagsForVideos(
    db,
    rows.flatMap((row) => row.video_id === null ? [] : [row.video_id]),
  )
  return {
    items: rows.map((row) => ({
      id: row.id,
      videoId: row.video_id,
      youtubeVideoId: row.youtube_video_id,
      title: row.title,
      channelId: row.channel_id,
      channelTitle: row.channel_title,
      thumbnailUrl: row.thumbnail_url,
      watchedAt: row.watched_at,
      watchCount: Number(row.watch_count),
      source: row.source,
      tags: row.video_id === null ? [] : tagMap.get(row.video_id) ?? [],
    })),
    total: Number(totals?.total ?? 0),
    uniqueVideos: Number(totals?.unique_videos ?? 0),
    page,
    limit,
  }
}

export function getWatchHistoryOverview(db: Database): WatchHistoryOverview {
  const row = db.get<{
    total: number | bigint
    unique_videos: number | bigint
    library_videos: number | bigint
  }>(`SELECT COUNT(*) AS total,
             COUNT(DISTINCT COALESCE(video_id, youtube_video_id)) AS unique_videos,
             COUNT(DISTINCT video_id) AS library_videos
        FROM youtube_watch_events`)
  const total = Number(row?.total ?? 0)
  const uniqueVideos = Number(row?.unique_videos ?? 0)
  return {
    total,
    uniqueVideos,
    replayEvents: Math.max(0, total - uniqueVideos),
    libraryVideos: Number(row?.library_videos ?? 0),
  }
}

export function listWatchHistoryChannels(db: Database, limit = 250): WatchHistoryFacet[] {
  return db.all<{ id: string; name: string; count: number | bigint }>(
    `SELECT id, name, count FROM (
       SELECT COALESCE(v.channel_id, we.channel_id_snapshot) AS id,
              COALESCE(yc.title, we.channel_title_snapshot, 'Unknown channel') AS name,
              COUNT(*) AS count
         FROM youtube_watch_events we
         LEFT JOIN videos v ON v.id = we.video_id
         LEFT JOIN youtube_channels yc ON yc.channel_id = v.channel_id
        WHERE COALESCE(v.channel_id, we.channel_id_snapshot) IS NOT NULL
        GROUP BY 1, 2
        ORDER BY count DESC, name COLLATE NOCASE
        LIMIT ?
     ) ORDER BY name COLLATE NOCASE, id`,
    [Math.min(500, Math.max(1, Math.floor(limit)))],
  ).map((row) => ({ ...row, count: Number(row.count) }))
}

export function listWatchHistoryTags(db: Database): WatchHistoryFacet[] {
  return db.all<{ id: string; name: string; count: number | bigint }>(
    `WITH tagged_history AS (
       SELECT we.id AS event_id, vt.tag_id
         FROM youtube_watch_events we
         JOIN video_tags vt ON vt.video_id = we.video_id
       UNION
       SELECT we.id AS event_id, st.tag_id
         FROM youtube_watch_events we
         JOIN videos v ON v.id = we.video_id
         JOIN subscriptions s ON s.channel_id = v.channel_id
         JOIN subscription_tags st ON st.subscription_id = s.id
     )
     SELECT t.id, t.name, COUNT(th.event_id) AS count
       FROM tagged_history th
       JOIN tags t ON t.id = th.tag_id
      GROUP BY t.id, t.name
      ORDER BY t.name COLLATE NOCASE, t.id`,
  ).map((row) => ({ ...row, count: Number(row.count) }))
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}
