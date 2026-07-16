import { Hono } from 'hono'
import type { Database } from './db.js'
import {
  getYouTubePlaylist,
  listYouTubePlaylists,
  searchYouTubePlaylistVideos,
  type YouTubePlaylistVideoItem,
  type YouTubePlaylistView,
} from './youtube-playlists.js'
import {
  NoYouTubePlaylistAccountError,
  type YouTubePlaylistsSync,
} from './youtube-playlists-sync.js'

export function youtubePlaylistsApi(deps: {
  readonly db: Database
  readonly sync: YouTubePlaylistsSync
}): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    const items = listYouTubePlaylists(deps.db).map(playlistJson)
    const sync = deps.db.get<SyncStateRow>(
      `SELECT status, playlist_count, included_count, synced_item_count,
       failed_playlist_count, requested_at, started_at, completed_at, error, retryable
       FROM youtube_playlist_sync_state ORDER BY completed_at DESC LIMIT 1`,
    )
    return c.json({ items, total: items.length, sync: sync ? syncStateJson(sync) : null })
  })

  app.patch('/:id', async (c) => {
    const body = await readJson(c.req.raw)
    if (!body || typeof body.is_included !== 'boolean' || Object.keys(body).some((key) => key !== 'is_included')) {
      return c.json({ error: 'Body must contain only is_included as a boolean.' }, 400)
    }
    const playlist = deps.sync.setIncluded(c.req.param('id'), body.is_included)
    if (!playlist) return c.json({ error: 'Playlist not found.' }, 404)
    return c.json({ playlist: playlistJson(playlist) })
  })

  app.post('/sync', async (c) => {
    const body = await readOptionalJson(c.req.raw)
    if (body === null) return c.json({ error: 'Request body must be valid JSON.' }, 400)
    const playlistId = body.playlist_id
    if (playlistId !== undefined && (typeof playlistId !== 'string' || !playlistId.trim())) {
      return c.json({ error: 'playlist_id must be a non-empty string.' }, 400)
    }
    if (Object.keys(body).some((key) => key !== 'playlist_id')) {
      return c.json({ error: 'Unknown sync option.' }, 400)
    }
    try {
      if (typeof playlistId === 'string') {
        const result = await deps.sync.syncPlaylist(playlistId)
        if (!result) return c.json({ error: 'Playlist not found.' }, 404)
        return c.json({ ok: result.status !== 'failed', playlist: result }, result.status === 'failed' ? 502 : 200)
      }
      return c.json({ ok: true, sync: await deps.sync.sync() })
    } catch (error: unknown) {
      if (error instanceof NoYouTubePlaylistAccountError) {
        return c.json({ error: error.message }, 409)
      }
      return c.json({ error: 'Playlist metadata sync failed; the last complete snapshot was preserved.' }, 502)
    }
  })

  app.get('/:id/videos', (c) => {
    const playlist = getYouTubePlaylist(deps.db, c.req.param('id'))
    if (!playlist) return c.json({ error: 'Playlist not found.' }, 404)
    const page = positiveInt(c.req.query('page'), 1, 1_000_000)
    const limit = positiveInt(c.req.query('limit'), 50, 100)
    if (page === null || limit === null) return c.json({ error: 'Invalid page or limit.' }, 400)
    const filters = readFilters(c.req.query())
    if ('error' in filters) return c.json({ error: filters.error }, 400)
    const result = searchYouTubePlaylistVideos(deps.db, playlist, {
      ...filters, page, limit,
    })
    return c.json({
      playlist: playlistJson(playlist),
      items: result.items.map(videoJson), total: result.total,
      page: result.page, limit: result.limit,
      watched_available: result.watchedAvailable,
    })
  })

  return app
}

interface SyncStateRow {
  status: string
  playlist_count: number | bigint
  included_count: number | bigint
  synced_item_count: number | bigint
  failed_playlist_count: number | bigint
  requested_at: string | null
  started_at: string | null
  completed_at: string | null
  error: string | null
  retryable: number | bigint
}

function playlistJson(p: YouTubePlaylistView): Record<string, unknown> {
  return {
    id: p.playlistId, account_id: p.accountId, title: p.title,
    description: p.description, thumbnail_url: p.thumbnailUrl,
    privacy_status: p.privacyStatus, remote_item_count: p.remoteItemCount,
    local_item_count: p.localItemCount, is_included: p.isIncluded,
    special_type: p.specialType, live_sync_supported: p.liveSyncSupported,
    sync_status: p.syncStatus, last_synced_at: p.lastSyncedAt,
    sync_started_at: p.syncStartedAt, sync_completed_at: p.syncCompletedAt,
    sync_error: p.syncError, sync_retryable: p.syncRetryable,
  }
}

function syncStateJson(row: SyncStateRow): Record<string, unknown> {
  return {
    status: row.status, playlist_count: Number(row.playlist_count),
    included_count: Number(row.included_count), synced_item_count: Number(row.synced_item_count),
    failed_playlist_count: Number(row.failed_playlist_count), requested_at: row.requested_at,
    started_at: row.started_at, completed_at: row.completed_at,
    error: row.error, retryable: Boolean(row.retryable),
  }
}

function videoJson(row: YouTubePlaylistVideoItem): Record<string, unknown> {
  return {
    playlist_item_id: row.playlistItemId, position: row.position,
    added_at: row.addedAt, synced_at: row.syncedAt,
    id: row.id, video_id: row.videoId, channel_id: row.channelId,
    channel_title: row.channelTitle, title: row.title,
    published_at: row.publishedAt, thumbnail_url: row.thumbnailUrl,
    link: row.link, folder_id: row.folderId, folder_name: row.folderName,
    transcript_status: row.transcriptStatus, summary_status: row.summaryStatus,
    watched: row.watched, tags: row.tags,
  }
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json() as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null
  } catch { return null }
}

async function readOptionalJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text()
  if (!text.trim()) return {}
  try {
    const value = JSON.parse(text) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null
  } catch { return null }
}

function positiveInt(raw: string | undefined, fallback: number, max: number): number | null {
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return value >= 1 && value <= max ? value : null
}

function readFilters(query: Record<string, string>): {
  channelId?: string; folderId?: string; unfoldered?: boolean; tagId?: string
  transcript?: 'ready' | 'missing'; summary?: 'ready' | 'missing'
  watched?: 'watched' | 'unwatched'
} | { error: string } {
  const transcript = query.transcript
  const summary = query.summary
  const watched = query.watched
  if (transcript && transcript !== 'ready' && transcript !== 'missing') return { error: 'Invalid transcript filter.' }
  if (summary && summary !== 'ready' && summary !== 'missing') return { error: 'Invalid summary filter.' }
  if (watched && watched !== 'watched' && watched !== 'unwatched') return { error: 'Invalid watched filter.' }
  return {
    ...(query.channel_id ? { channelId: query.channel_id } : {}),
    ...(query.folder_id && query.folder_id !== 'none' && query.folder_id !== 'all' ? { folderId: query.folder_id } : {}),
    ...(query.folder_id === 'none' ? { unfoldered: true } : {}),
    ...(query.tag_id ? { tagId: query.tag_id } : {}),
    ...(transcript ? { transcript: transcript as 'ready' | 'missing' } : {}),
    ...(summary ? { summary: summary as 'ready' | 'missing' } : {}),
    ...(watched ? { watched: watched as 'watched' | 'unwatched' } : {}),
  }
}
