import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
import { auth, type AuthVariables } from './auth.js'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { InMemoryTokenStore } from './token-store.js'
import { createTokenCipher } from './token-encryption.js'
import { YouTubeOAuthClient } from './youtube-oauth.js'
import { youtubePlaylistsApi } from './youtube-playlists-api.js'
import { YouTubePlaylistsSync } from './youtube-playlists-sync.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')
const PASSWORD = 'secret'

describe('YT-010 playlist APIs', () => {
  let db: Database
  let app: Hono<{ Variables: AuthVariables }>
  let sync: YouTubePlaylistsSync

  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    const cipher = createTokenCipher(Buffer.from('e'.repeat(64), 'hex'))
    const accountId = randomUUID()
    db.run(
      `INSERT INTO youtube_accounts
       (id, provider, google_user_id, email_address, access_token_enc,
        refresh_token_enc, token_expires_at, scopes)
       VALUES (?, 'youtube', 'g', 'd@example.com', ?, ?,
        '2099-01-01T00:00:00.000Z', 'youtube.readonly')`,
      [accountId, cipher.encrypt('access'), cipher.encrypt('refresh')],
    )
    const oauthClient = new YouTubeOAuthClient({
      db, cipher, oauthClientId: 'id', oauthClientSecret: 'secret',
      redirectUri: 'http://localhost/callback',
    })
    sync = new YouTubePlaylistsSync({
      db, cipher, oauthClient,
      fetcher: {
        fetchAll: async () => [{
          playlistId: 'PL1', title: 'Research', description: 'Saved talks',
          thumbnailUrl: null, privacyStatus: 'private', remoteItemCount: 1,
          specialType: null, liveSyncSupported: true,
        }],
        fetchItems: async () => ({ items: [{
          playlistItemId: 'PLI1', position: 0, addedAt: '2026-07-15T00:00:00Z',
          videoId: 'video-1', channelId: 'UC1', channelTitle: 'Channel',
          title: 'Useful talk', publishedAt: '2026-07-14T00:00:00Z',
          thumbnailUrl: null, link: 'https://youtube.com/watch?v=video-1',
        }], skipped: 0 }),
      },
    })
    app = new Hono<{ Variables: AuthVariables }>()
    app.use('*', auth({
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      tokenStore: new InMemoryTokenStore(),
    }))
    app.route('/api/youtube/playlists', youtubePlaylistsApi({ db, sync }))
  })

  afterEach(() => db.close())

  const headers = (): Record<string, string> => ({
    authorization: `Basic ${Buffer.from(`david:${PASSWORD}`).toString('base64')}`,
    'content-type': 'application/json',
  })

  it('requires authentication and manually syncs/lists playlist metadata', async () => {
    expect((await app.request('/api/youtube/playlists')).status).toBe(401)
    const synced = await app.request('/api/youtube/playlists/sync', {
      method: 'POST', headers: headers(), body: '{}',
    })
    expect(synced.status).toBe(200)
    expect(await synced.json()).toMatchObject({ ok: true, sync: { playlistCount: 1 } })
    const list = await app.request('/api/youtube/playlists', { headers: headers() })
    expect(await list.json()).toMatchObject({
      total: 1, items: [{ id: 'PL1', is_included: false, privacy_status: 'private' }],
      sync: { status: 'completed', playlist_count: 1 },
    })
  })

  it('validates PATCH and enabling triggers the initial import', async () => {
    await sync.sync()
    const invalid = await app.request('/api/youtube/playlists/PL1', {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ is_included: 'yes' }),
    })
    expect(invalid.status).toBe(400)
    const enabled = await app.request('/api/youtube/playlists/PL1', {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ is_included: true }),
    })
    expect(enabled.status).toBe(200)
    await sync.syncPlaylist('PL1')
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM youtube_playlist_items')?.count).toBe(1)
  })

  it('supports targeted sync and paginated video reads with validation', async () => {
    await sync.sync()
    db.run(`UPDATE youtube_playlists SET is_included = 1 WHERE playlist_id = 'PL1'`)
    const targeted = await app.request('/api/youtube/playlists/sync', {
      method: 'POST', headers: headers(), body: JSON.stringify({ playlist_id: 'PL1' }),
    })
    expect(targeted.status).toBe(200)
    const videos = await app.request('/api/youtube/playlists/PL1/videos?page=1&limit=20&transcript=missing', { headers: headers() })
    expect(await videos.json()).toMatchObject({
      total: 1, page: 1, limit: 20,
      items: [{ playlist_item_id: 'PLI1', video_id: 'video-1', channel_title: 'Channel' }],
    })
    const invalid = await app.request('/api/youtube/playlists/PL1/videos?limit=500', { headers: headers() })
    expect(invalid.status).toBe(400)
  })

  it('returns clear not-found and malformed request errors', async () => {
    const patch = await app.request('/api/youtube/playlists/missing', {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ is_included: true }),
    })
    expect(patch.status).toBe(404)
    const syncResponse = await app.request('/api/youtube/playlists/sync', {
      method: 'POST', headers: headers(), body: JSON.stringify({ playlist_id: 3 }),
    })
    expect(syncResponse.status).toBe(400)
  })
})
