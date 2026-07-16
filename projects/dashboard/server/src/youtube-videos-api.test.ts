// youtube-videos-api.test.ts — issue YT-005
//
// HTTP-boundary tests for `youtubeVideosApi`. Coverage:
//   * 401 unauthenticated on every verb
//   * GET /  — pagination, filters, defaults, response shape
//   * GET /:id — 200 vs 404, full body shape
//   * PATCH /:id — partial update, validation errors, 404
//
// The tag sub-resource routes are covered in
// `youtube-video-tags-api.test.ts`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { auth, type AuthVariables } from './auth.js'
import { InMemoryTokenStore } from './token-store.js'
import { youtubeVideosApi } from './youtube-videos-api.js'
import { insertVideo, getVideoByVideoId, type VideoInsertInput } from './youtube-videos.js'
import { upsertSubscription } from './youtube-subscriptions.js'

const PASSWORD = 'secret'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

interface TestEnv {
  db: Database
  app: Hono<{ Variables: AuthVariables }>
  /** Insert one video + return the dashboard id, with opts. */
  seed(overrides?: Partial<VideoInsertInput>): string
}

let env: TestEnv

beforeEach(async () => {
  const db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  db.run(
    `INSERT INTO youtube_accounts
       (id, provider, google_user_id, email_address,
        access_token_enc, refresh_token_enc, scopes)
     VALUES (?, 'youtube', 'g-1', 'd@example.com', 'x', 'y', 'youtube.readonly')`,
    ['acct-1'],
  )
  upsertSubscription(db, {
    googleAccountId: 'acct-1',
    channelId: 'UCaaaaaaa000000000000aab',
    channelTitle: 'Alpha',
    channelThumbnailUrl: null,
    subscribedAt: '2024-01-01T00:00:00.000Z',
  })

  const passwordHash = await bcrypt.hash(PASSWORD, 4)
  const tokenStore = new InMemoryTokenStore()
  const api = youtubeVideosApi({ db })
  const app = new Hono<{ Variables: AuthVariables }>()
  app.use('*', auth({ passwordHash, tokenStore }))
  app.route('/api/videos', api)
  env = {
    db,
    app,
    seed(overrides: Partial<VideoInsertInput> = {}) {
      const input: VideoInsertInput = {
        videoId: overrides.videoId ?? 'dQw4w9WgXcQ',
        channelId: overrides.channelId ?? 'UCaaaaaaa000000000000aab',
        title: overrides.title ?? 'Never Gonna Give You Up',
        publishedAt: overrides.publishedAt ?? '2009-10-25T06:57:33.000Z',
        thumbnailUrl:
          overrides.thumbnailUrl !== undefined
            ? overrides.thumbnailUrl
            : 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        link: overrides.link ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      }
      return insertVideo(db, input).id
    },
  }
})

afterEach(() => {
  env.db.close()
})

function basic(p: string): string {
  return `Basic ${Buffer.from(`david:${p}`).toString('base64')}`
}

async function req(
  app: Hono<{ Variables: AuthVariables }>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return app.request(path, init)
}

function asJson<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

// ─── Auth gate ──────────────────────────────────────────────────────────

describe('auth', () => {
  it('returns 401 for unauthenticated GET', async () => {
    const res = await req(env.app, '/api/videos')
    expect(res.status).toBe(401)
  })

  it('returns 401 for unauthenticated GET /:id', async () => {
    const id = env.seed()
    const res = await req(env.app, `/api/videos/${id}`)
    expect(res.status).toBe(401)
  })

  it('returns 401 for unauthenticated PATCH /:id', async () => {
    const id = env.seed()
    const res = await req(env.app, `/api/videos/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(401)
  })
})

// ─── GET / ──────────────────────────────────────────────────────────────

describe('GET /api/videos', () => {
  function markWatched(videoId: string, suffix = '1', watchedAt = '2026-07-15T09:30:00Z'): void {
    env.db.run(`INSERT OR IGNORE INTO youtube_history_imports
      (id,file_hash,original_filename,staged_filename,status,total_count,new_event_count,
       duplicate_count,malformed_count,unique_video_count,new_video_count,committed_event_count,
       created_at,expires_at,committed_at)
      VALUES ('api-import','hash','history.json','gone.json','committed',1,1,0,0,1,0,1,
       '2026-07-16T00:00:00Z','2026-07-17T00:00:00Z','2026-07-16T00:00:00Z')`)
    env.db.run(`INSERT INTO youtube_watch_events
      (id,video_id,youtube_video_id,watched_at,title_snapshot,event_fingerprint,history_import_id,created_at)
      VALUES (?,?,?,?,?,?, 'api-import','2026-07-16T00:00:00Z')`,
    [`watch-${suffix}`, videoId, `youtube-${suffix}`, watchedAt, 'Snapshot', `fingerprint-${suffix}`])
  }

  it('returns the documented envelope shape', async () => {
    env.seed()
    const res = await req(env.app, '/api/videos', {
      headers: { authorization: basic(PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await asJson<{
      items: Array<{
        id: string
        video_id: string
        title: string
        tags: unknown[]
      }>
      total: number
      page: number
      limit: number
    }>(res))
    expect(body.total).toBe(1)
    expect(body.page).toBe(1)
    expect(body.limit).toBe(50)
    expect(body.items[0]!.title).toBe('Never Gonna Give You Up')
    expect(Array.isArray(body.items[0]!.tags)).toBe(true)
  })

  it('returns empty items when no videos exist', async () => {
    const res = await req(env.app, '/api/videos', {
      headers: { authorization: basic(PASSWORD) },
    })
    const body = (await asJson<{ items: unknown[]; total: number }>(res))
    expect(body.items).toEqual([])
    expect(body.total).toBe(0)
  })

  it('does not list videos from an excluded subscription', async () => {
    env.seed()
    env.db.run(
      `UPDATE subscriptions SET is_included = 0 WHERE channel_id = 'UCaaaaaaa000000000000aab'`,
    )

    const res = await req(env.app, '/api/videos', {
      headers: { authorization: basic(PASSWORD) },
    })
    const body = await asJson<{ items: unknown[]; total: number }>(res)

    expect(body.items).toEqual([])
    expect(body.total).toBe(0)
  })

  it('paginates with page + limit', async () => {
    for (let i = 0; i < 5; i++) env.seed({ videoId: `vv${i}`, title: `Title ${i}` })
    const res = await req(env.app, '/api/videos?page=2&limit=2', {
      headers: { authorization: basic(PASSWORD) },
    })
    const body = (await asJson<{ items: { title: string }[]; total: number; page: number; limit: number }>(res))
    expect(body.page).toBe(2)
    expect(body.limit).toBe(2)
    expect(body.total).toBe(5)
    expect(body.items).toHaveLength(2)
  })

  it('caps limit at 200', async () => {
    const res = await req(env.app, '/api/videos?limit=9999', {
      headers: { authorization: basic(PASSWORD) },
    })
    const body = (await asJson<{ limit: number }>(res))
    expect(body.limit).toBe(200)
  })

  it('treats invalid page=0 as page=1', async () => {
    const res = await req(env.app, '/api/videos?page=0', {
      headers: { authorization: basic(PASSWORD) },
    })
    const body = (await asJson<{ page: number }>(res))
    expect(body.page).toBe(1)
  })

  it.each([
    ['/api/videos?sort=drop_table', 'sort must be one of'],
    ['/api/videos?order=sideways', 'order must be asc or desc'],
    ['/api/videos?published_from=2026%2F07%2F01', 'published_from must be a valid date'],
    ['/api/videos?published_from=2025-02-29', 'published_from must be a valid date'],
    ['/api/videos?published_to=2026-13-01', 'published_to must be a valid date'],
    ['/api/videos?published_from=2026-07-10&published_to=2026-07-01', 'published_from must be on or before'],
    ['/api/videos?exclude_shorts=false', 'exclude_shorts must be true'],
  ])('rejects invalid discovery query %s', async (path, message) => {
    const response = await req(env.app, path, { headers: { authorization: basic(PASSWORD) } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining(message) })
  })

  it('applies an inclusive publication range and requested ordering server-side', async () => {
    env.seed({ videoId: 'range-before', title: 'Before', publishedAt: '2024-02-28T23:59:59Z' })
    env.seed({ videoId: 'range-late', title: 'Zed', publishedAt: '2024-02-29T23:59:59.999Z' })
    env.seed({ videoId: 'range-early', title: 'Alpha', publishedAt: '2024-02-29T00:00:00Z' })
    env.seed({ videoId: 'range-after', title: 'After', publishedAt: '2024-03-01T00:00:00Z' })
    const response = await req(
      env.app,
      '/api/videos?published_from=2024-02-29&published_to=2024-02-29&sort=title&order=asc',
      { headers: { authorization: basic(PASSWORD) } },
    )
    expect(response.status).toBe(200)
    const body = await asJson<{ items: Array<{ video_id: string }> }>(response)
    expect(body.items.map((item) => item.video_id)).toEqual(['range-early', 'range-late'])
  })

  it('returns an empty successful result for a valid range with no matches', async () => {
    env.seed({ videoId: 'outside-range', publishedAt: '2020-01-01T00:00:00Z' })
    const response = await req(env.app, '/api/videos?published_from=2026-01-01', {
      headers: { authorization: basic(PASSWORD) },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ items: [], total: 0 })
  })

  it('filters out canonical Shorts when requested', async () => {
    env.seed({ videoId: 'short-one', link: 'https://www.youtube.com/shorts/short-one' })
    env.seed({ videoId: 'regular-one', link: 'https://www.youtube.com/watch?v=regular-one' })
    const response = await req(env.app, '/api/videos?exclude_shorts=true', {
      headers: { authorization: basic(PASSWORD) },
    })
    const body = await asJson<{ items: Array<{ video_id: string }>; total: number }>(response)
    expect(body.total).toBe(1)
    expect(body.items.map((item) => item.video_id)).toEqual(['regular-one'])
  })

  it('filters by channel_id', async () => {
    upsertSubscription(env.db, {
      googleAccountId: 'acct-1',
      channelId: 'UCbbbbbbb000000000000bab',
      channelTitle: 'Beta',
      channelThumbnailUrl: null,
      subscribedAt: '2024-01-01T00:00:00.000Z',
    })
    env.seed({ videoId: 'aaa-aaa' })
    env.seed({ videoId: 'bbb-bbb', channelId: 'UCbbbbbbb000000000000bab' })
    const res = await req(env.app, '/api/videos?channel_id=UCbbbbbbb000000000000bab', {
      headers: { authorization: basic(PASSWORD) },
    })
    const body = (await asJson<{ items: unknown[]; total: number }>(res))
    expect(body.total).toBe(1)
  })

  it('filters by folder_id', async () => {
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`)
    const a = env.seed({ videoId: 'aaa-aaa' })
    env.seed({ videoId: 'bbb-bbb' })
    env.db.run(`UPDATE videos SET folder_id = 'f-1' WHERE id = ?`, [a])
    const res = await req(env.app, '/api/videos?folder_id=f-1', {
      headers: { authorization: basic(PASSWORD) },
    })
    const body = (await asJson<{ items: { id: string }[]; total: number }>(res))
    expect(body.total).toBe(1)
    expect(body.items[0]!.id).toBe(a)
  })

  it('folder_id=none returns the unfoldered set', async () => {
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`)
    const a = env.seed({ videoId: 'aaa-aaa' })
    env.db.run(`UPDATE videos SET folder_id = 'f-1' WHERE id = ?`, [a])
    env.seed({ videoId: 'bbb-bbb' })
    const res = await req(env.app, '/api/videos?folder_id=none', {
      headers: { authorization: basic(PASSWORD) },
    })
    const body = (await asJson<{ items: { id: string }[]; total: number }>(res))
    expect(body.total).toBe(1)
    expect(body.items[0]!.id).not.toBe(a)
  })

  it('folder_id=all returns everything (no filter)', async () => {
    env.seed({ videoId: 'aaa-aaa' })
    env.seed({ videoId: 'bbb-bbb' })
    const res = await req(env.app, '/api/videos?folder_id=all', {
      headers: { authorization: basic(PASSWORD) },
    })
    const body = (await asJson<{ total: number }>(res))
    expect(body.total).toBe(2)
  })

  it('filters by tag_id', async () => {
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`)
    env.db.run(`INSERT INTO tags (id, name) VALUES ('tt-launch', 'launch')`)
    const a = env.seed({ videoId: 'aaa-aaa' })
    env.seed({ videoId: 'bbb-bbb' })
    env.db.run(`INSERT INTO video_tags (video_id, tag_id) VALUES (?, 'tt-launch')`, [a])
    const res = await req(env.app, `/api/videos?tag_id=tt-launch`, {
      headers: { authorization: basic(PASSWORD) },
    })
    const body = (await asJson<{ items: { id: string }[]; total: number }>(res))
    expect(body.total).toBe(1)
    expect(body.items[0]!.id).toBe(a)
  })

  it('filters the canonical library by playlist source/id without duplicating cards', async () => {
    const id = env.seed({ videoId: 'playlist-video' })
    env.db.run(`UPDATE subscriptions SET is_included = 0`)
    for (const [playlistId, title] of [['PL-one', 'One'], ['PL-two', 'Two']]) {
      env.db.run(
        `INSERT INTO youtube_playlists
         (google_account_id, playlist_id, title, privacy_status, is_included)
         VALUES ('acct-1', ?, ?, 'private', 1)`,
        [playlistId, title],
      )
      env.db.run(
        `INSERT INTO youtube_playlist_items
         (google_account_id, playlist_id, playlist_item_id, video_id, position, synced_at)
         VALUES ('acct-1', ?, ?, ?, 0, '2026-07-16T00:00:00Z')`,
        [playlistId, `item-${playlistId}`, id],
      )
    }

    const defaultResult = await req(env.app, '/api/videos', {
      headers: { authorization: basic(PASSWORD) },
    })
    expect((await asJson<{ total: number }>(defaultResult)).total).toBe(0)

    const sourceResult = await req(env.app, '/api/videos?source=playlist', {
      headers: { authorization: basic(PASSWORD) },
    })
    const sourceBody = await asJson<{
      total: number
      items: Array<{ id: string; playlists: Array<{ id: string; title: string }> }>
    }>(sourceResult)
    expect(sourceBody.total).toBe(1)
    expect(sourceBody.items).toHaveLength(1)
    expect(sourceBody.items[0]).toMatchObject({
      id,
      playlists: [{ id: 'PL-one', title: 'One' }, { id: 'PL-two', title: 'Two' }],
    })

    const onePlaylist = await req(env.app, '/api/videos?playlist_id=PL-two', {
      headers: { authorization: basic(PASSWORD) },
    })
    expect((await asJson<{ total: number }>(onePlaylist)).total).toBe(1)
    const missingPlaylist = await req(env.app, '/api/videos?playlist_id=missing', {
      headers: { authorization: basic(PASSWORD) },
    })
    expect((await asJson<{ total: number }>(missingPlaylist)).total).toBe(0)
  })

  it('returns derived watched metadata and supports watched, unwatched, and history source filters', async () => {
    const watchedId = env.seed({ videoId: 'watched-one' })
    const unwatchedId = env.seed({ videoId: 'unwatched-one' })
    markWatched(watchedId)
    markWatched(watchedId, '2', '2026-07-16T09:30:00Z')

    const watched = await asJson<{ items: Array<{ id: string; watched: boolean; watch_count: number; last_watched_at: string }> }>(await req(env.app, '/api/videos?watched=true', { headers: { authorization: basic(PASSWORD) } }))
    expect(watched.items).toEqual([expect.objectContaining({ id: watchedId, watched: true, watch_count: 2, last_watched_at: '2026-07-16T09:30:00Z' })])
    const unwatched = await asJson<{ items: Array<{ id: string }> }>(await req(env.app, '/api/videos?unwatched=true', { headers: { authorization: basic(PASSWORD) } }))
    expect(unwatched.items.map((item) => item.id)).toEqual([unwatchedId])
    const history = await asJson<{ items: Array<{ id: string }> }>(await req(env.app, '/api/videos?source=history', { headers: { authorization: basic(PASSWORD) } }))
    expect(history.items.map((item) => item.id)).toEqual([watchedId])
  })

  it('rejects contradictory watch filters', async () => {
    const response = await req(env.app, '/api/videos?watched=true&unwatched=true', { headers: { authorization: basic(PASSWORD) } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('contradictory') })
  })
})

// ─── GET /:id ────────────────────────────────────────────────────────────

describe('GET /api/videos/:id', () => {
  it('returns 200 with full detail (channel + folder + tags)', async () => {
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`)
    const id = env.seed()
    env.db.run(`UPDATE videos SET folder_id = 'f-1' WHERE id = ?`, [id])
    env.db.run(
      `INSERT INTO tags (id, name) VALUES ('tt-1', 'launch')`,
    )
    env.db.run(`INSERT INTO video_tags (video_id, tag_id) VALUES (?, 'tt-1')`, [id])
    const res = await req(env.app, `/api/videos/${id}`, {
      headers: { authorization: basic(PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await asJson<{
      id: string
      folder_id: string
      folder_name: string
      channel_title: string
      channel_is_included: boolean
      tags: { id: string; name: string }[]
    }>(res))
    expect(body.id).toBe(id)
    expect(body.folder_id).toBe('f-1')
    expect(body.folder_name).toBe('Work')
    expect(body.channel_title).toBe('Alpha')
    expect(body.channel_is_included).toBe(true)
    expect(body.tags).toEqual([{
      id: 'tt-1',
      name: 'launch',
      source: 'manual',
      sources: ['manual'],
    }])
  })

  it('returns 404 for an unknown id', async () => {
    const res = await req(env.app, '/api/videos/no-such-id', {
      headers: { authorization: basic(PASSWORD) },
    })
    expect(res.status).toBe(404)
  })
})

// ─── PATCH /:id ─────────────────────────────────────────────────────────

describe('PATCH /api/videos/:id', () => {
  it('updates title only (folder untouched)', async () => {
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`)
    const id = env.seed()
    env.db.run(`UPDATE videos SET folder_id = 'f-1' WHERE id = ?`, [id])
    const res = await req(env.app, `/api/videos/${id}`, {
      method: 'PATCH',
      headers: { authorization: basic(PASSWORD), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'New title' }),
    })
    expect(res.status).toBe(200)
    expect(getVideoByVideoId(env.db, 'dQw4w9WgXcQ')!.title).toBe('New title')
    // folder preserved
    expect(getVideoByVideoId(env.db, 'dQw4w9WgXcQ')!.folderId).toBe('f-1')
  })

  it('updates folder_id only and supports null (unfolder)', async () => {
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`)
    const id = env.seed()
    env.db.run(`UPDATE videos SET folder_id = 'f-1' WHERE id = ?`, [id])
    // Move
    let res = await req(env.app, `/api/videos/${id}`, {
      method: 'PATCH',
      headers: { authorization: basic(PASSWORD), 'content-type': 'application/json' },
      body: JSON.stringify({ folder_id: 'f-1' }),
    })
    expect(res.status).toBe(200)
    expect(getVideoByVideoId(env.db, 'dQw4w9WgXcQ')!.folderId).toBe('f-1')
    // Unfolder via null
    res = await req(env.app, `/api/videos/${id}`, {
      method: 'PATCH',
      headers: { authorization: basic(PASSWORD), 'content-type': 'application/json' },
      body: JSON.stringify({ folder_id: null }),
    })
    expect(res.status).toBe(200)
    expect(getVideoByVideoId(env.db, 'dQw4w9WgXcQ')!.folderId).toBeNull()
  })

  it('updates both folder_id and title in one PATCH', async () => {
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`)
    const id = env.seed()
    const res = await req(env.app, `/api/videos/${id}`, {
      method: 'PATCH',
      headers: { authorization: basic(PASSWORD), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Both', folder_id: 'f-1' }),
    })
    expect(res.status).toBe(200)
    const v = getVideoByVideoId(env.db, 'dQw4w9WgXcQ')!
    expect(v.title).toBe('Both')
    expect(v.folderId).toBe('f-1')
  })

  it('returns 400 on empty body', async () => {
    const id = env.seed()
    const res = await req(env.app, `/api/videos/${id}`, {
      method: 'PATCH',
      headers: { authorization: basic(PASSWORD), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 on malformed JSON', async () => {
    const id = env.seed()
    const res = await req(env.app, `/api/videos/${id}`, {
      method: 'PATCH',
      headers: { authorization: basic(PASSWORD), 'content-type': 'application/json' },
      body: '{this is not json',
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 on folder_id wrong type (number)', async () => {
    const id = env.seed()
    const res = await req(env.app, `/api/videos/${id}`, {
      method: 'PATCH',
      headers: { authorization: basic(PASSWORD), 'content-type': 'application/json' },
      body: JSON.stringify({ folder_id: 42 }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 on title wrong type (number)', async () => {
    const id = env.seed()
    const res = await req(env.app, `/api/videos/${id}`, {
      method: 'PATCH',
      headers: { authorization: basic(PASSWORD), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 42 }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 on empty title', async () => {
    const id = env.seed()
    const res = await req(env.app, `/api/videos/${id}`, {
      method: 'PATCH',
      headers: { authorization: basic(PASSWORD), 'content-type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 for an unknown id', async () => {
    const res = await req(env.app, '/api/videos/no-such-id', {
      method: 'PATCH',
      headers: { authorization: basic(PASSWORD), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns the updated row on success', async () => {
    const id = env.seed()
    const res = await req(env.app, `/api/videos/${id}`, {
      method: 'PATCH',
      headers: { authorization: basic(PASSWORD), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Reflected back' }),
    })
    const body = (await asJson<{ id: string; title: string }>(res))
    expect(body.id).toBe(id)
    expect(body.title).toBe('Reflected back')
  })
})
