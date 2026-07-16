import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { createTokenCipher } from './token-encryption.js'
import { YouTubeOAuthClient } from './youtube-oauth.js'
import { YouTubeApiError } from './youtube-backfill-fetcher.js'
import type { FetchedYouTubePlaylist, FetchedYouTubePlaylistItem } from './youtube-playlists-fetcher.js'
import { YouTubePlaylistsSync, type PlaylistsFetcher } from './youtube-playlists-sync.js'
import { getYouTubePlaylist } from './youtube-playlists.js'
import { upsertYouTubeVideo } from './youtube-video-upsert.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')
const NOW = Date.parse('2026-07-16T12:00:00.000Z')

describe('YouTubePlaylistsSync', () => {
  let db: Database
  let accountId: string
  let cipher: ReturnType<typeof createTokenCipher>
  let oauthClient: YouTubeOAuthClient

  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    cipher = createTokenCipher(Buffer.from('d'.repeat(64), 'hex'))
    accountId = randomUUID()
    db.run(
      `INSERT INTO youtube_accounts
       (id, provider, google_user_id, email_address, access_token_enc,
        refresh_token_enc, token_expires_at, scopes)
       VALUES (?, 'youtube', 'g', 'd@example.com', ?, ?,
        '2099-01-01T00:00:00.000Z', 'youtube.readonly')`,
      [accountId, cipher.encrypt('access'), cipher.encrypt('refresh')],
    )
    oauthClient = new YouTubeOAuthClient({
      db, cipher, oauthClientId: 'id', oauthClientSecret: 'secret',
      redirectUri: 'http://localhost/callback', nowMs: () => NOW,
    })
  })

  afterEach(() => db.close())

  function service(fetcher: PlaylistsFetcher): YouTubePlaylistsSync {
    return new YouTubePlaylistsSync({ db, cipher, oauthClient, fetcher, nowMs: () => NOW })
  }

  it('discovers playlists excluded by default and preserves inclusion on refresh', async () => {
    const fetcher = fakeFetcher([
      [playlist('PL1', { privacyStatus: 'private' })],
      [playlist('PL1', { privacyStatus: 'private' })],
    ], [])
    const sync = service(fetcher)
    await sync.sync(accountId)
    expect(getYouTubePlaylist(db, 'PL1')).toMatchObject({ isIncluded: false, privacyStatus: 'private' })
    db.run(`UPDATE youtube_playlists SET is_included = 1 WHERE playlist_id = 'PL1'`)
    await sync.sync(accountId)
    expect(getYouTubePlaylist(db, 'PL1')?.isIncluded).toBe(true)
  })

  it('transactionally diffs removals and reorder while preserving canonical videos', async () => {
    const fetcher = fakeFetcher(
      [[playlist('PL1')], [playlist('PL1')], [playlist('PL1')], []],
      [[item('item-a', 'video-a', 0), item('item-b', 'video-b', 1)], [item('item-b', 'video-b', 0)]],
    )
    const sync = service(fetcher)
    await sync.sync(accountId)
    db.run(`UPDATE youtube_playlists SET is_included = 1 WHERE playlist_id = 'PL1'`)
    const imported = await sync.sync(accountId)
    const diffed = await sync.sync(accountId)
    expect(imported).toMatchObject({ addedCount: 2, updatedCount: 0, removedCount: 0 })
    expect(diffed).toMatchObject({ addedCount: 0, updatedCount: 1, removedCount: 1 })
    expect(db.all('SELECT playlist_item_id, position FROM youtube_playlist_items')).toEqual([
      { playlist_item_id: 'item-b', position: 0 },
    ])
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM videos')?.count).toBe(2)
    await sync.sync(accountId)
    expect(db.get('SELECT * FROM youtube_playlist_items')).toBeUndefined()
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM videos')?.count).toBe(2)
  })

  it('reuses a canonical RSS video across playlists without triggering AI work', async () => {
    upsertYouTubeVideo(db, { ...item('rss-item', 'shared', 0), origin: { type: 'subscription_rss', sourceId: 'sub' } }, () => NOW)
    const fetcher = fakeFetcher([[playlist('PL1'), playlist('PL2')]], [
      [item('one', 'shared', 0)], [item('two', 'shared', 0)],
    ])
    const sync = service(fetcher)
    await sync.sync(accountId)
    db.run('UPDATE youtube_playlists SET is_included = 1')
    await sync.sync(accountId)
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM videos')?.count).toBe(1)
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM youtube_playlist_items')?.count).toBe(2)
    expect(db.get('SELECT * FROM video_transcripts')).toBeUndefined()
    expect(db.get('SELECT * FROM video_summaries')).toBeUndefined()
  })

  it('keeps the last complete membership snapshot after a partial/API failure', async () => {
    let itemCall = 0
    const fetcher: PlaylistsFetcher = {
      fetchAll: async () => [playlist('PL1')],
      fetchItems: async () => {
        if (++itemCall === 1) return { items: [item('old', 'video-old', 0)], skipped: 0 }
        throw new YouTubeApiError('playlistItems.list', 503)
      },
    }
    const sync = service(fetcher)
    await sync.sync(accountId)
    db.run(`UPDATE youtube_playlists SET is_included = 1 WHERE playlist_id = 'PL1'`)
    await sync.sync(accountId)
    const failed = await sync.sync(accountId)
    expect(failed.failedPlaylistCount).toBe(1)
    expect(db.all('SELECT playlist_item_id FROM youtube_playlist_items')).toEqual([{ playlist_item_id: 'old' }])
    expect(getYouTubePlaylist(db, 'PL1')).toMatchObject({ syncStatus: 'failed', syncRetryable: true, localItemCount: 1 })
  })

  it('isolates per-playlist failures and records unsupported Watch Later/History', async () => {
    const fetcher: PlaylistsFetcher = {
      fetchAll: async () => [
        playlist('good'), playlist('bad'),
        playlist('WL', { specialType: 'watch_later', liveSyncSupported: false }),
        playlist('HL', { specialType: 'history', liveSyncSupported: false }),
      ],
      fetchItems: async (_token, id) => {
        if (id === 'bad') throw new YouTubeApiError('playlistItems.list', 403)
        return { items: [item(`item-${id}`, `video-${id}`, 0)], skipped: 0 }
      },
    }
    const sync = service(fetcher)
    await sync.sync(accountId)
    db.run(`UPDATE youtube_playlists SET is_included = 1 WHERE playlist_id IN ('good', 'bad', 'WL', 'HL')`)
    const result = await sync.sync(accountId)
    expect(result.failedPlaylistCount).toBe(1)
    expect(getYouTubePlaylist(db, 'good')?.syncStatus).toBe('completed')
    expect(getYouTubePlaylist(db, 'bad')).toMatchObject({ syncStatus: 'failed', syncRetryable: true })
    expect(getYouTubePlaylist(db, 'WL')).toMatchObject({ syncStatus: 'unsupported', liveSyncSupported: false })
    expect(getYouTubePlaylist(db, 'HL')?.syncError).toContain('Google Takeout')
  })

  it('enabling starts an initial item sync while disabling retains cached membership', async () => {
    const fetcher = fakeFetcher([[playlist('PL1')]], [[item('one', 'video', 0)]])
    const fetchItems = vi.spyOn(fetcher, 'fetchItems')
    const sync = service(fetcher)
    await sync.sync(accountId)
    sync.setIncluded('PL1', true)
    await vi.waitFor(() => expect(fetchItems).toHaveBeenCalled())
    await vi.waitFor(() => expect(getYouTubePlaylist(db, 'PL1')?.localItemCount).toBe(1))
    sync.setIncluded('PL1', false)
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM youtube_playlist_items')?.count).toBe(1)
  })

  it('marks interrupted work as retryable during boot recovery', () => {
    db.run(`INSERT INTO youtube_playlist_sync_state (google_account_id, status) VALUES (?, 'running')`, [accountId])
    service(fakeFetcher([], [])).recoverInterrupted()
    expect(db.get('SELECT status, retryable FROM youtube_playlist_sync_state')).toEqual({ status: 'failed', retryable: 1 })
  })
})

function playlist(id: string, overrides: Partial<FetchedYouTubePlaylist> = {}): FetchedYouTubePlaylist {
  return {
    playlistId: id, title: `Playlist ${id}`, description: '', thumbnailUrl: null,
    privacyStatus: 'public', remoteItemCount: 1, specialType: null,
    liveSyncSupported: true, ...overrides,
  }
}

function item(playlistItemId: string, videoId: string, position: number): FetchedYouTubePlaylistItem {
  return {
    playlistItemId, videoId, position, addedAt: '2026-07-15T00:00:00Z',
    channelId: 'UC-owner', channelTitle: 'Owner', title: `Video ${videoId}`,
    publishedAt: '2026-07-14T00:00:00Z', thumbnailUrl: null,
    link: `https://youtube.com/watch?v=${videoId}`,
  }
}

function fakeFetcher(
  metadataResponses: ReadonlyArray<readonly FetchedYouTubePlaylist[]>,
  itemResponses: ReadonlyArray<readonly FetchedYouTubePlaylistItem[]>,
): PlaylistsFetcher {
  let metadataCall = 0
  let itemCall = 0
  return {
    fetchAll: async () => metadataResponses[metadataCall++] ?? metadataResponses.at(-1) ?? [],
    fetchItems: async () => ({ items: itemResponses[itemCall++] ?? [], skipped: 0 }),
  }
}
