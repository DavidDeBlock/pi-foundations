import { resolve } from 'node:path'
import bcrypt from 'bcryptjs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { auth, type AuthVariables } from './auth.js'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { InMemoryTokenStore } from './token-store.js'
import { upsertYouTubeVideo } from './youtube-video-upsert.js'
import { youtubePlaylistsView } from './youtube-playlists-view.js'

const PASSWORD = 'secret'
const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

describe('YT-011 playlist views', () => {
  let db: Database
  let app: Hono<{ Variables: AuthVariables }>

  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    db.run(
      `INSERT INTO youtube_accounts
       (id, provider, google_user_id, email_address, access_token_enc, refresh_token_enc, scopes)
       VALUES ('acct', 'youtube', 'google', 'd@example.com', 'x', 'y', 'youtube.readonly')`,
    )
    app = new Hono<{ Variables: AuthVariables }>()
    app.use('*', auth({
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      tokenStore: new InMemoryTokenStore(),
    }))
    app.route('/playlists', youtubePlaylistsView({ db }))
  })

  afterEach(() => db.close())

  const request = (path: string) => app.request(path, {
    headers: { authorization: `Basic ${Buffer.from(`david:${PASSWORD}`).toString('base64')}` },
  })

  function seedPlaylist(overrides: Partial<{
    id: string; title: string; included: number; supported: number; status: string; error: string
  }> = {}): string {
    const id = overrides.id ?? 'PL-research'
    db.run(
      `INSERT INTO youtube_playlists
       (google_account_id, playlist_id, title, description, thumbnail_url,
        privacy_status, remote_item_count, local_item_count, is_included,
        special_type, live_sync_supported, sync_status, last_synced_at, sync_error)
       VALUES ('acct', ?, ?, '', 'https://img.example/thumb.jpg', 'private', 2, 2, ?,
        ?, ?, ?, '2026-07-16T08:00:00.000Z', ?)`,
      [id, overrides.title ?? 'Research', overrides.included ?? 1,
        overrides.supported === 0 ? 'watch_later' : null, overrides.supported ?? 1,
        overrides.status ?? 'completed', overrides.error ?? null],
    )
    return id
  }

  function seedVideo(input: { videoId: string; channelId: string; channelTitle: string; title: string; position: number }): string {
    const video = upsertYouTubeVideo(db, {
      videoId: input.videoId, channelId: input.channelId, channelTitle: input.channelTitle,
      title: input.title, publishedAt: `2026-07-${10 + input.position}T00:00:00.000Z`,
      thumbnailUrl: null, link: `https://youtube.com/watch?v=${input.videoId}`, origin: null,
    })
    db.run(
      `INSERT INTO youtube_playlist_items
       (google_account_id, playlist_id, playlist_item_id, video_id, position, added_at, synced_at)
       VALUES ('acct', 'PL-research', ?, ?, ?, NULL, '2026-07-16T08:00:00.000Z')`,
      [`item-${input.position}`, video.id, input.position],
    )
    return video.id
  }

  it('requires auth and exposes the complete YouTube contextual navigation', async () => {
    expect((await app.request('/playlists')).status).toBe(401)
    const html = await (await request('/playlists')).text()
    expect(html).toMatch(/context-link context-link-active[^>]*href="\/playlists"/)
    expect(html).toContain('href="/videos"')
    expect(html).toContain('href="/history"')
    expect(html).toContain('href="/subscriptions"')
  })

  it('explains disconnected and empty states with their next actions', async () => {
    let html = await (await request('/playlists')).text()
    expect(html).toContain('No playlists mirrored yet')
    expect(html).toContain('Sync playlists')
    db.run(`DELETE FROM youtube_accounts`)
    html = await (await request('/playlists')).text()
    expect(html).toContain('Disconnected')
    expect(html).toContain('Open YouTube settings')
  })

  it('escapes playlist data and renders counts, privacy, sync state, and no-reload controls', async () => {
    seedPlaylist({ title: '<script>alert(1)</script>' })
    const html = await (await request('/playlists')).text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('private')
    expect(html).toContain('2 on YouTube · 2 local')
    expect(html).toContain('data-playlist-toggle')
    expect(html).toContain("method: 'PATCH'")
    expect(html).toContain('addedCount')
    expect(html).toContain('updatedCount')
    expect(html).toContain('removedCount')
    expect(html).toContain('failedPlaylistCount')
    expect(html).toContain("var notice = 'Found ' + sync.playlistCount")
    expect(html).toContain('Choose the collections to include')
    expect(html).toContain("sessionStorage.setItem('playlist-sync-notice'")
    expect(html).toContain('window.location.reload()')
  })

  it('shows a safe unsupported Watch Later explanation', async () => {
    seedPlaylist({ id: 'WL', title: 'Watch Later', supported: 0, status: 'unsupported', error: 'Live sync is unavailable.' })
    const html = await (await request('/playlists')).text()
    expect(html).toContain('Watch Later')
    expect(html).toContain('Live sync is unavailable')
    expect(html).toMatch(/data-playlist-toggle[^>]*disabled/)
    const detail = await (await request('/playlists/WL')).text()
    expect(detail).toContain('Live sync is unavailable')
  })

  it('preserves YouTube order, renders non-subscribed channel metadata, badges, and enrichment links', async () => {
    seedPlaylist()
    seedVideo({ videoId: 'video-b', channelId: 'UC-b', channelTitle: 'Second & safe', title: 'Second', position: 1 })
    seedVideo({ videoId: 'video-a', channelId: 'UC-a', channelTitle: '<Channel>', title: '<First>', position: 0 })
    const html = await (await request('/playlists/PL-research')).text()
    expect(html.indexOf('data-position="0"')).toBeLessThan(html.indexOf('data-position="1"'))
    expect(html).toContain('&lt;Channel&gt;')
    expect(html).toContain('Second &amp; safe')
    expect(html).toContain('class="playlist-badge"')
    expect(html).toContain('href="/videos/')
    expect(html).toContain('Transcript')
    expect(html).toContain('Insight')
  })

  it('filters canonical cards by channel, tag, transcript, and summary without changing position order', async () => {
    seedPlaylist()
    const first = seedVideo({ videoId: 'video-a', channelId: 'UC-a', channelTitle: 'Alpha', title: 'Ready talk', position: 0 })
    seedVideo({ videoId: 'video-b', channelId: 'UC-b', channelTitle: 'Beta', title: 'Missing talk', position: 1 })
    db.run(`INSERT INTO tags (id, name) VALUES ('tag-1', 'learning')`)
    db.run(`INSERT INTO video_tags (video_id, tag_id) VALUES (?, 'tag-1')`, [first])
    db.run(
      `INSERT INTO video_transcripts
       (video_id, status, language, requested_at, fetched_at, error_message, updated_at)
       VALUES (?, 'ready', 'en', '2026-07-16T00:00:00Z', '2026-07-16T00:00:00Z', NULL, '2026-07-16T00:00:00Z')`,
      [first],
    )
    db.run(
      `INSERT INTO video_summaries
       (video_id, status, model, prompt_version, requested_at, updated_at)
       VALUES (?, 'ready', 'minimax', 1, '2026-07-16T00:00:00Z', '2026-07-16T00:00:00Z')`,
      [first],
    )
    const path = '/playlists/PL-research?channel_id=UC-a&tag_id=tag-1&transcript=ready&summary=ready'
    const html = await (await request(path)).text()
    expect(html).toContain('Ready talk')
    expect(html).not.toContain('Missing talk')
    expect(html).toContain('value="UC-a" selected')
    expect(html).toContain('value="tag-1" selected')
    expect(html).toContain('value="ready" selected')
  })

  it('offers watched/unwatched filtering once watch history storage is available', async () => {
    seedPlaylist()
    const watched = seedVideo({ videoId: 'watched', channelId: 'UC-a', channelTitle: 'Alpha', title: 'Already watched', position: 0 })
    seedVideo({ videoId: 'fresh', channelId: 'UC-a', channelTitle: 'Alpha', title: 'Still fresh', position: 1 })
    db.run(`CREATE TABLE youtube_watch_events (video_id TEXT NOT NULL)`)
    db.run(`INSERT INTO youtube_watch_events (video_id) VALUES (?)`, [watched])
    const html = await (await request('/playlists/PL-research?watched=unwatched')).text()
    expect(html).toContain('name="watched"')
    expect(html).toContain('value="unwatched" selected')
    expect(html).toContain('Still fresh')
    expect(html).not.toContain('Already watched')
  })
})
