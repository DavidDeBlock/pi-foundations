import type { Database } from './db.js'

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
}

export interface WatchHistoryResult {
  readonly items: readonly WatchHistoryEvent[]
  readonly total: number
  readonly uniqueVideos: number
  readonly page: number
  readonly limit: number
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
}

export function searchWatchHistory(
  db: Database,
  options: { readonly page?: number; readonly limit?: number } = {},
): WatchHistoryResult {
  const page = Math.max(1, Math.floor(options.page ?? 1))
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)))
  const offset = (page - 1) * limit
  const totals = db.get<{ total: number | bigint; unique_videos: number | bigint }>(
    `SELECT COUNT(*) AS total,
            COUNT(DISTINCT COALESCE(video_id, youtube_video_id)) AS unique_videos
       FROM youtube_watch_events`,
  )
  const rows = db.all<WatchHistoryRow>(
    `SELECT we.id, we.video_id, we.youtube_video_id,
            COALESCE(v.local_title_override, v.title, we.title_snapshot) AS title,
            COALESCE(v.channel_id, we.channel_id_snapshot) AS channel_id,
            COALESCE(yc.title, we.channel_title_snapshot) AS channel_title,
            v.thumbnail_url,
            we.watched_at,
            (SELECT COUNT(*) FROM youtube_watch_events repeated
              WHERE (we.video_id IS NOT NULL AND repeated.video_id = we.video_id)
                 OR (we.video_id IS NULL AND we.youtube_video_id IS NOT NULL
                     AND repeated.video_id IS NULL AND repeated.youtube_video_id = we.youtube_video_id)
                 OR (we.video_id IS NULL AND we.youtube_video_id IS NULL AND repeated.id = we.id)
            ) AS watch_count
       FROM youtube_watch_events we
       LEFT JOIN videos v ON v.id = we.video_id
       LEFT JOIN youtube_channels yc ON yc.channel_id = v.channel_id
      ORDER BY we.watched_at DESC, we.id ASC
      LIMIT ? OFFSET ?`,
    [limit, offset],
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
    })),
    total: Number(totals?.total ?? 0),
    uniqueVideos: Number(totals?.unique_videos ?? 0),
    page,
    limit,
  }
}
