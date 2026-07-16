import type { Database } from './db.js'
import { listTagsForVideos, type EffectiveVideoTag } from './youtube-videos.js'

export type PlaylistSyncStatus =
  | 'idle' | 'pending' | 'running' | 'completed' | 'failed' | 'unsupported'

interface PlaylistRow {
  google_account_id: string
  playlist_id: string
  title: string
  description: string
  thumbnail_url: string | null
  privacy_status: string
  remote_item_count: number | bigint
  local_item_count: number | bigint
  is_included: number | bigint
  special_type: string | null
  live_sync_supported: number | bigint
  sync_status: PlaylistSyncStatus
  last_synced_at: string | null
  sync_started_at: string | null
  sync_completed_at: string | null
  sync_error: string | null
  sync_retryable: number | bigint
  created_at: string
  updated_at: string
}

export interface YouTubePlaylistView {
  readonly accountId: string
  readonly playlistId: string
  readonly title: string
  readonly description: string
  readonly thumbnailUrl: string | null
  readonly privacyStatus: string
  readonly remoteItemCount: number
  readonly localItemCount: number
  readonly isIncluded: boolean
  readonly specialType: string | null
  readonly liveSyncSupported: boolean
  readonly syncStatus: PlaylistSyncStatus
  readonly lastSyncedAt: string | null
  readonly syncStartedAt: string | null
  readonly syncCompletedAt: string | null
  readonly syncError: string | null
  readonly syncRetryable: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

export type PlaylistReadinessFilter = 'ready' | 'missing'
export type PlaylistWatchedFilter = 'watched' | 'unwatched'

export interface YouTubePlaylistVideoFilters {
  readonly channelId?: string
  readonly folderId?: string
  readonly unfoldered?: boolean
  readonly tagId?: string
  readonly transcript?: PlaylistReadinessFilter
  readonly summary?: PlaylistReadinessFilter
  readonly watched?: PlaylistWatchedFilter
  readonly page?: number
  readonly limit?: number
}

export interface YouTubePlaylistVideoItem {
  readonly playlistItemId: string
  readonly position: number
  readonly addedAt: string | null
  readonly syncedAt: string
  readonly id: string
  readonly videoId: string
  readonly channelId: string
  readonly channelTitle: string
  readonly title: string
  readonly publishedAt: string
  readonly thumbnailUrl: string | null
  readonly link: string
  readonly folderId: string | null
  readonly folderName: string | null
  readonly transcriptStatus: string | null
  readonly summaryStatus: string | null
  readonly watched: boolean | null
  readonly watchCount: number
  readonly lastWatchedAt: string | null
  readonly tags: ReadonlyArray<EffectiveVideoTag>
}

export interface YouTubePlaylistVideosResult {
  readonly items: readonly YouTubePlaylistVideoItem[]
  readonly total: number
  readonly page: number
  readonly limit: number
  readonly watchedAvailable: boolean
}

const SELECT = `SELECT google_account_id, playlist_id, title, description,
  thumbnail_url, privacy_status, remote_item_count, local_item_count,
  is_included, special_type, live_sync_supported, sync_status,
  last_synced_at, sync_started_at, sync_completed_at, sync_error,
  sync_retryable, created_at, updated_at FROM youtube_playlists`

export function listYouTubePlaylists(
  db: Database,
  accountId?: string,
): YouTubePlaylistView[] {
  const rows = accountId
    ? db.all<PlaylistRow>(`${SELECT} WHERE google_account_id = ? ORDER BY special_type IS NULL, title COLLATE NOCASE, playlist_id`, [accountId])
    : db.all<PlaylistRow>(`${SELECT} ORDER BY special_type IS NULL, title COLLATE NOCASE, playlist_id`)
  return rows.map(toView)
}

export function getYouTubePlaylist(
  db: Database,
  playlistId: string,
  accountId?: string,
): YouTubePlaylistView | null {
  const row = accountId
    ? db.get<PlaylistRow>(`${SELECT} WHERE google_account_id = ? AND playlist_id = ?`, [accountId, playlistId])
    : db.get<PlaylistRow>(`${SELECT} WHERE playlist_id = ? ORDER BY updated_at DESC LIMIT 1`, [playlistId])
  return row ? toView(row) : null
}

interface PlaylistVideoRow {
  playlist_item_id: string
  position: number | bigint
  added_at: string | null
  synced_at: string
  id: string
  video_id: string
  channel_id: string
  channel_title: string
  title: string
  published_at: string
  thumbnail_url: string | null
  link: string
  folder_id: string | null
  folder_name: string | null
  transcript_status: string | null
  summary_status: string | null
  watched: number | bigint | null
  watch_count: number | bigint
  last_watched_at: string | null
}

export function searchYouTubePlaylistVideos(
  db: Database,
  playlist: YouTubePlaylistView,
  filters: YouTubePlaylistVideoFilters = {},
): YouTubePlaylistVideosResult {
  const page = Math.max(1, Math.floor(filters.page ?? 1))
  const limit = Math.min(100, Math.max(1, Math.floor(filters.limit ?? 50)))
  const watchedAvailable = tableExists(db, 'youtube_watch_events')
  const where = ['pi.google_account_id = ?', 'pi.playlist_id = ?']
  const params: unknown[] = [playlist.accountId, playlist.playlistId]
  if (filters.channelId) { where.push('v.channel_id = ?'); params.push(filters.channelId) }
  if (filters.folderId) { where.push('v.folder_id = ?'); params.push(filters.folderId) }
  else if (filters.unfoldered) where.push('v.folder_id IS NULL')
  if (filters.tagId) {
    where.push(`(
      EXISTS (SELECT 1 FROM video_tags vtag WHERE vtag.video_id = v.id AND vtag.tag_id = ?)
      OR EXISTS (
        SELECT 1 FROM subscriptions filter_s
        JOIN subscription_tags filter_st ON filter_st.subscription_id = filter_s.id
        WHERE filter_s.channel_id = v.channel_id AND filter_st.tag_id = ?
      )
    )`)
    params.push(filters.tagId, filters.tagId)
  }
  if (filters.transcript === 'ready') where.push(`EXISTS (SELECT 1 FROM video_transcripts vt WHERE vt.video_id = v.id AND vt.status = 'ready')`)
  if (filters.transcript === 'missing') where.push(`NOT EXISTS (SELECT 1 FROM video_transcripts vt WHERE vt.video_id = v.id AND vt.status = 'ready')`)
  if (filters.summary === 'ready') where.push(`(EXISTS (SELECT 1 FROM video_summary_runs vsr WHERE vsr.video_id = v.id AND vsr.status = 'ready') OR EXISTS (SELECT 1 FROM video_summaries vs WHERE vs.video_id = v.id AND vs.status = 'ready'))`)
  if (filters.summary === 'missing') where.push(`NOT EXISTS (SELECT 1 FROM video_summary_runs vsr WHERE vsr.video_id = v.id AND vsr.status = 'ready') AND NOT EXISTS (SELECT 1 FROM video_summaries vs WHERE vs.video_id = v.id AND vs.status = 'ready')`)
  if (watchedAvailable && filters.watched === 'watched') {
    where.push('EXISTS (SELECT 1 FROM youtube_watch_events we WHERE we.video_id = v.id)')
  }
  if (watchedAvailable && filters.watched === 'unwatched') {
    where.push('NOT EXISTS (SELECT 1 FROM youtube_watch_events we WHERE we.video_id = v.id)')
  }
  const whereSql = where.join(' AND ')
  const total = Number(db.get<{ total: number | bigint }>(
    `SELECT COUNT(*) AS total FROM youtube_playlist_items pi
     JOIN videos v ON v.id = pi.video_id WHERE ${whereSql}`,
    params,
  )?.total ?? 0)
  const watchedSql = watchedAvailable
    ? 'EXISTS (SELECT 1 FROM youtube_watch_events we WHERE we.video_id = v.id)'
    : 'NULL'
  const watchCountSql = watchedAvailable
    ? '(SELECT COUNT(*) FROM youtube_watch_events we WHERE we.video_id = v.id)'
    : '0'
  const lastWatchedSql = watchedAvailable
    ? '(SELECT MAX(we.watched_at) FROM youtube_watch_events we WHERE we.video_id = v.id)'
    : 'NULL'
  const rows = db.all<PlaylistVideoRow>(
    `SELECT pi.playlist_item_id, pi.position, pi.added_at, pi.synced_at,
       v.id, v.video_id, v.channel_id, COALESCE(v.local_title_override, v.title) AS title,
       v.published_at, v.thumbnail_url, v.link, v.folder_id, f.name AS folder_name,
       yc.title AS channel_title,
       (SELECT status FROM video_transcripts WHERE video_id = v.id) AS transcript_status,
       COALESCE(
         (SELECT vsr.status FROM video_summary_runs vsr LEFT JOIN video_preferred_summary_runs psr ON psr.run_id = vsr.id
           WHERE vsr.video_id = v.id ORDER BY CASE WHEN psr.run_id IS NOT NULL THEN 0 ELSE 1 END, vsr.requested_at DESC LIMIT 1),
         (SELECT status FROM video_summaries WHERE video_id = v.id)
       ) AS summary_status,
       ${watchedSql} AS watched, ${watchCountSql} AS watch_count,
       ${lastWatchedSql} AS last_watched_at
       FROM youtube_playlist_items pi
       JOIN videos v ON v.id = pi.video_id
       JOIN youtube_channels yc ON yc.channel_id = v.channel_id
       LEFT JOIN folders f ON f.id = v.folder_id
       WHERE ${whereSql}
       ORDER BY pi.position ASC, pi.playlist_item_id ASC LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit],
  )
  const tagMap = listTagsForVideos(db, rows.map((row) => row.id))
  return {
    items: rows.map((row) => ({
      playlistItemId: row.playlist_item_id,
      position: Number(row.position),
      addedAt: row.added_at,
      syncedAt: row.synced_at,
      id: row.id,
      videoId: row.video_id,
      channelId: row.channel_id,
      channelTitle: row.channel_title,
      title: row.title,
      publishedAt: row.published_at,
      thumbnailUrl: row.thumbnail_url,
      link: row.link,
      folderId: row.folder_id,
      folderName: row.folder_name,
      transcriptStatus: row.transcript_status,
      summaryStatus: row.summary_status,
      watched: row.watched === null ? null : Boolean(row.watched),
      watchCount: Number(row.watch_count),
      lastWatchedAt: row.last_watched_at,
      tags: tagMap.get(row.id) ?? [],
    })),
    total, page, limit, watchedAvailable,
  }
}

export function listYouTubePlaylistChannels(
  db: Database,
  playlist: YouTubePlaylistView,
): Array<{ readonly id: string; readonly title: string }> {
  return db.all<{ id: string; title: string }>(
    `SELECT DISTINCT yc.channel_id AS id, yc.title
       FROM youtube_playlist_items pi
       JOIN videos v ON v.id = pi.video_id
       JOIN youtube_channels yc ON yc.channel_id = v.channel_id
      WHERE pi.google_account_id = ? AND pi.playlist_id = ?
      ORDER BY yc.title COLLATE NOCASE, yc.channel_id`,
    [playlist.accountId, playlist.playlistId],
  )
}

function tableExists(db: Database, table: string): boolean {
  return db.get<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [table],
  ) !== undefined
}

function toView(row: PlaylistRow): YouTubePlaylistView {
  return {
    accountId: row.google_account_id,
    playlistId: row.playlist_id,
    title: row.title,
    description: row.description,
    thumbnailUrl: row.thumbnail_url,
    privacyStatus: row.privacy_status,
    remoteItemCount: Number(row.remote_item_count),
    localItemCount: Number(row.local_item_count),
    isIncluded: Boolean(row.is_included),
    specialType: row.special_type,
    liveSyncSupported: Boolean(row.live_sync_supported),
    syncStatus: row.sync_status,
    lastSyncedAt: row.last_synced_at,
    syncStartedAt: row.sync_started_at,
    syncCompletedAt: row.sync_completed_at,
    syncError: row.sync_error,
    syncRetryable: Boolean(row.sync_retryable),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
