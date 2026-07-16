import type { Database } from './db.js'
import type { TokenCipher } from './token-encryption.js'
import { getMostRecentYouTubeAccountId, getYouTubeAccount } from './youtube-accounts.js'
import type { YouTubeOAuthClient } from './youtube-oauth.js'
import { YouTubeApiError } from './youtube-backfill-fetcher.js'
import {
  YouTubePlaylistsFetcher,
  type FetchedYouTubePlaylist,
  type FetchedYouTubePlaylistItem,
} from './youtube-playlists-fetcher.js'
import { getYouTubePlaylist, type YouTubePlaylistView } from './youtube-playlists.js'
import { upsertYouTubeVideo } from './youtube-video-upsert.js'

export interface PlaylistsFetcher {
  fetchAll(accessToken: string): Promise<readonly FetchedYouTubePlaylist[]>
  fetchItems(accessToken: string, playlistId: string): Promise<{
    readonly items: readonly FetchedYouTubePlaylistItem[]
    readonly skipped: number
  }>
}

export interface PlaylistItemSyncResult {
  readonly playlistId: string
  readonly status: 'completed' | 'failed' | 'unsupported'
  readonly itemCount: number
  readonly skipped: number
  readonly added: number
  readonly updated: number
  readonly removed: number
  readonly error: string | null
}

export interface PlaylistsSyncResult {
  readonly accountId: string
  readonly playlistCount: number
  readonly includedCount: number
  readonly syncedItemCount: number
  readonly failedPlaylistCount: number
  readonly addedCount: number
  readonly updatedCount: number
  readonly removedCount: number
  readonly playlists: readonly PlaylistItemSyncResult[]
  readonly ranAt: string
}

export class NoYouTubePlaylistAccountError extends Error {
  constructor() {
    super('No YouTube account connected')
    this.name = 'NoYouTubePlaylistAccountError'
  }
}

export class YouTubePlaylistsSync {
  readonly #db: Database
  readonly #cipher: TokenCipher
  readonly #oauthClient: YouTubeOAuthClient
  readonly #fetcher: PlaylistsFetcher
  readonly #nowMs: () => number
  #activeFullSync: Promise<PlaylistsSyncResult> | null = null

  constructor(deps: {
    readonly db: Database
    readonly cipher: TokenCipher
    readonly oauthClient: YouTubeOAuthClient
    readonly fetcher?: PlaylistsFetcher
    readonly nowMs?: () => number
  }) {
    this.#db = deps.db
    this.#cipher = deps.cipher
    this.#oauthClient = deps.oauthClient
    this.#fetcher = deps.fetcher ?? new YouTubePlaylistsFetcher()
    this.#nowMs = deps.nowMs ?? (() => Date.now())
  }

  recoverInterrupted(): void {
    const now = this.#nowIso()
    this.#db.run(
      `UPDATE youtube_playlist_sync_state SET status = 'failed', completed_at = ?,
       error = 'Playlist sync was interrupted; retry is available.', retryable = 1
       WHERE status = 'running'`, [now],
    )
    this.#db.run(
      `UPDATE youtube_playlists SET sync_status = 'failed', sync_completed_at = ?,
       sync_error = 'Playlist sync was interrupted; retry is available.', sync_retryable = 1
       WHERE sync_status IN ('pending', 'running')`, [now],
    )
  }

  sync(accountId?: string): Promise<PlaylistsSyncResult> {
    if (this.#activeFullSync) return this.#activeFullSync
    this.#activeFullSync = this.#sync(accountId).finally(() => {
      this.#activeFullSync = null
    })
    return this.#activeFullSync
  }

  async syncPlaylist(playlistId: string): Promise<PlaylistItemSyncResult | null> {
    const playlist = getYouTubePlaylist(this.#db, playlistId)
    if (!playlist) return null
    const token = await this.#accessToken(playlist.accountId)
    return await this.#syncItems(token, playlist)
  }

  setIncluded(playlistId: string, isIncluded: boolean): YouTubePlaylistView | null {
    const playlist = getYouTubePlaylist(this.#db, playlistId)
    if (!playlist) return null
    const now = this.#nowIso()
    this.#db.run(
      `UPDATE youtube_playlists SET is_included = ?, updated_at = ?,
       sync_status = CASE
         WHEN ? = 1 AND live_sync_supported = 1 THEN 'pending'
         WHEN live_sync_supported = 0 THEN 'unsupported'
         ELSE sync_status END
       WHERE google_account_id = ? AND playlist_id = ?`,
      [isIncluded ? 1 : 0, now, isIncluded ? 1 : 0, playlist.accountId, playlistId],
    )
    if (isIncluded && playlist.liveSyncSupported) {
      queueMicrotask(() => {
        void this.syncPlaylist(playlistId).catch((error: unknown) => {
          this.#failPlaylist(playlist.accountId, playlistId, error)
        })
      })
    }
    return getYouTubePlaylist(this.#db, playlistId, playlist.accountId)
  }

  async #sync(accountId?: string): Promise<PlaylistsSyncResult> {
    const id = accountId ?? getMostRecentYouTubeAccountId(this.#db)
    if (!id) throw new NoYouTubePlaylistAccountError()
    const startedAt = this.#nowIso()
    this.#db.run(
      `INSERT INTO youtube_playlist_sync_state
         (google_account_id, status, requested_at, started_at, completed_at, error, retryable)
       VALUES (?, 'running', ?, ?, NULL, NULL, 0)
       ON CONFLICT(google_account_id) DO UPDATE SET status = 'running',
         requested_at = excluded.requested_at, started_at = excluded.started_at,
         completed_at = NULL, error = NULL, retryable = 0`,
      [id, startedAt, startedAt],
    )
    try {
      const accessToken = await this.#accessToken(id)
      const remote = await this.#fetcher.fetchAll(accessToken)
      this.#replaceMetadata(id, remote)
      const included = this.#db.all<{ playlist_id: string }>(
        `SELECT playlist_id FROM youtube_playlists
         WHERE google_account_id = ? AND is_included = 1
         ORDER BY title COLLATE NOCASE`, [id],
      )
      const itemResults: PlaylistItemSyncResult[] = []
      for (const row of included) {
        const playlist = getYouTubePlaylist(this.#db, row.playlist_id, id)
        if (!playlist) continue
        itemResults.push(await this.#syncItems(accessToken, playlist))
      }
      const syncedItemCount = itemResults
        .filter((result) => result.status === 'completed')
        .reduce((total, result) => total + result.itemCount, 0)
      const failedPlaylistCount = itemResults
        .filter((result) => result.status === 'failed').length
      const completedAt = this.#nowIso()
      this.#db.run(
        `UPDATE youtube_playlist_sync_state SET status = 'completed',
         playlist_count = ?, included_count = ?, synced_item_count = ?,
         failed_playlist_count = ?, completed_at = ?, error = NULL, retryable = 0
         WHERE google_account_id = ?`,
        [remote.length, included.length, syncedItemCount, failedPlaylistCount, completedAt, id],
      )
      return {
        accountId: id, playlistCount: remote.length, includedCount: included.length,
        syncedItemCount, failedPlaylistCount,
        addedCount: itemResults.reduce((sum, result) => sum + result.added, 0),
        updatedCount: itemResults.reduce((sum, result) => sum + result.updated, 0),
        removedCount: itemResults.reduce((sum, result) => sum + result.removed, 0),
        playlists: itemResults, ranAt: completedAt,
      }
    } catch (error: unknown) {
      const safe = safePlaylistError(error)
      this.#db.run(
        `UPDATE youtube_playlist_sync_state SET status = 'failed', completed_at = ?,
         error = ?, retryable = ? WHERE google_account_id = ?`,
        [this.#nowIso(), safe.message, safe.retryable ? 1 : 0, id],
      )
      throw error
    }
  }

  #replaceMetadata(accountId: string, playlists: readonly FetchedYouTubePlaylist[]): void {
    const now = this.#nowIso()
    this.#db.transaction(() => {
      for (const playlist of playlists) {
        this.#db.run(
          `INSERT INTO youtube_playlists
             (google_account_id, playlist_id, title, description, thumbnail_url,
              privacy_status, remote_item_count, special_type, live_sync_supported,
              sync_status, sync_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(google_account_id, playlist_id) DO UPDATE SET
             title = excluded.title, description = excluded.description,
             thumbnail_url = excluded.thumbnail_url,
             privacy_status = excluded.privacy_status,
             remote_item_count = excluded.remote_item_count,
             special_type = excluded.special_type,
             live_sync_supported = excluded.live_sync_supported,
             sync_status = CASE WHEN excluded.live_sync_supported = 0
               THEN 'unsupported' ELSE youtube_playlists.sync_status END,
             sync_error = CASE WHEN excluded.live_sync_supported = 0
               THEN excluded.sync_error ELSE youtube_playlists.sync_error END,
             updated_at = excluded.updated_at`,
          [accountId, playlist.playlistId, playlist.title, playlist.description,
            playlist.thumbnailUrl, playlist.privacyStatus, playlist.remoteItemCount,
            playlist.specialType, playlist.liveSyncSupported ? 1 : 0,
            playlist.liveSyncSupported ? 'idle' : 'unsupported',
            playlist.liveSyncSupported ? null : unsupportedMessage(playlist.specialType),
            now, now],
        )
      }
      const ids = playlists.map((playlist) => playlist.playlistId)
      if (ids.length === 0) {
        this.#db.run('DELETE FROM youtube_playlists WHERE google_account_id = ?', [accountId])
      } else {
        this.#db.run(
          `DELETE FROM youtube_playlists WHERE google_account_id = ?
           AND playlist_id NOT IN (${ids.map(() => '?').join(',')})`,
          [accountId, ...ids],
        )
      }
    })
  }

  async #syncItems(
    accessToken: string,
    playlist: YouTubePlaylistView,
  ): Promise<PlaylistItemSyncResult> {
    if (!playlist.liveSyncSupported) {
      return { playlistId: playlist.playlistId, status: 'unsupported', itemCount: playlist.localItemCount, skipped: 0, added: 0, updated: 0, removed: 0, error: playlist.syncError }
    }
    this.#db.run(
      `UPDATE youtube_playlists SET sync_status = 'running', sync_started_at = ?,
       sync_completed_at = NULL, sync_error = NULL, sync_retryable = 0
       WHERE google_account_id = ? AND playlist_id = ?`,
      [this.#nowIso(), playlist.accountId, playlist.playlistId],
    )
    try {
      const fetched = await this.#fetcher.fetchItems(accessToken, playlist.playlistId)
      const syncedAt = this.#nowIso()
      const existing = this.#db.all<{
        playlist_item_id: string
        video_id: string
        youtube_video_id: string
        channel_id: string
        title: string
        published_at: string
        thumbnail_url: string | null
        link: string
        position: number | bigint
        added_at: string | null
      }>(
        `SELECT pi.playlist_item_id, pi.video_id, pi.position, pi.added_at,
                v.video_id AS youtube_video_id, v.channel_id, v.title,
                v.published_at, v.thumbnail_url, v.link
           FROM youtube_playlist_items pi
           JOIN videos v ON v.id = pi.video_id
          WHERE google_account_id = ? AND playlist_id = ?`,
        [playlist.accountId, playlist.playlistId],
      )
      const existingByItem = new Map(existing.map((item) => [item.playlist_item_id, item]))
      const remoteIds = new Set(fetched.items.map((item) => item.playlistItemId))
      const added = fetched.items.filter((item) => !existingByItem.has(item.playlistItemId)).length
      const updated = fetched.items.filter((item) => {
        const previous = existingByItem.get(item.playlistItemId)
        if (!previous) return false
        return previous.youtube_video_id !== item.videoId
          || previous.channel_id !== item.channelId
          || previous.title !== item.title
          || previous.published_at !== item.publishedAt
          || previous.thumbnail_url !== item.thumbnailUrl
          || previous.link !== item.link
          || Number(previous.position) !== item.position
          || previous.added_at !== item.addedAt
      }).length
      const removed = existing.filter((item) => !remoteIds.has(item.playlist_item_id)).length
      this.#db.transaction(() => {
        const remoteItemIds: string[] = []
        for (const item of fetched.items) {
          const canonical = upsertYouTubeVideo(
            this.#db,
            { ...item, origin: null },
            this.#nowMs,
          )
          remoteItemIds.push(item.playlistItemId)
          this.#db.run(
            `INSERT INTO youtube_playlist_items
               (google_account_id, playlist_id, playlist_item_id, video_id,
                position, added_at, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(google_account_id, playlist_id, playlist_item_id) DO UPDATE SET
               video_id = excluded.video_id, position = excluded.position,
               added_at = excluded.added_at, synced_at = excluded.synced_at`,
            [playlist.accountId, playlist.playlistId, item.playlistItemId,
              canonical.id, item.position, item.addedAt, syncedAt],
          )
        }
        if (remoteItemIds.length === 0) {
          this.#db.run(
            'DELETE FROM youtube_playlist_items WHERE google_account_id = ? AND playlist_id = ?',
            [playlist.accountId, playlist.playlistId],
          )
        } else {
          this.#db.run(
            `DELETE FROM youtube_playlist_items WHERE google_account_id = ?
             AND playlist_id = ? AND playlist_item_id NOT IN (${remoteItemIds.map(() => '?').join(',')})`,
            [playlist.accountId, playlist.playlistId, ...remoteItemIds],
          )
        }
        this.#db.run(
          `UPDATE youtube_playlists SET local_item_count = ?, sync_status = 'completed',
           last_synced_at = ?, sync_completed_at = ?, sync_error = NULL,
           sync_retryable = 0, updated_at = ?
           WHERE google_account_id = ? AND playlist_id = ?`,
          [fetched.items.length, syncedAt, syncedAt, syncedAt,
            playlist.accountId, playlist.playlistId],
        )
      })
      return { playlistId: playlist.playlistId, status: 'completed', itemCount: fetched.items.length, skipped: fetched.skipped, added, updated, removed, error: null }
    } catch (error: unknown) {
      this.#failPlaylist(playlist.accountId, playlist.playlistId, error)
      const safe = safePlaylistError(error)
      return { playlistId: playlist.playlistId, status: 'failed', itemCount: playlist.localItemCount, skipped: 0, added: 0, updated: 0, removed: 0, error: safe.message }
    }
  }

  #failPlaylist(accountId: string, playlistId: string, error: unknown): void {
    const safe = safePlaylistError(error)
    this.#db.run(
      `UPDATE youtube_playlists SET sync_status = 'failed', sync_completed_at = ?,
       sync_error = ?, sync_retryable = ?
       WHERE google_account_id = ? AND playlist_id = ?`,
      [this.#nowIso(), safe.message, safe.retryable ? 1 : 0, accountId, playlistId],
    )
  }

  async #accessToken(accountId: string): Promise<string> {
    const account = getYouTubeAccount(this.#db, this.#cipher, accountId)
    if (!account) throw new NoYouTubePlaylistAccountError()
    return (await this.#oauthClient.refreshIfNeeded(account)).accessToken
  }

  #nowIso(): string {
    return new Date(this.#nowMs()).toISOString()
  }
}

function unsupportedMessage(specialType: string | null): string {
  if (specialType === 'watch_later') return 'YouTube does not support live Watch Later sync through this API.'
  if (specialType === 'history') return 'YouTube does not expose live Watch History; use Google Takeout instead.'
  return 'This playlist is not available for live sync.'
}

export function safePlaylistError(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof YouTubeApiError) {
    return {
      message: `YouTube API request failed (HTTP ${error.status}).${error.retryable ? ' Try again later.' : ''}`,
      retryable: error.retryable,
    }
  }
  if (error instanceof NoYouTubePlaylistAccountError) return { message: error.message, retryable: false }
  return { message: 'Playlist sync failed. Retry to keep the last complete snapshot.', retryable: true }
}
