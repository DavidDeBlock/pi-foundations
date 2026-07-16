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
    expect(body.tags).toEqual([{ id: 'tt-1', name: 'launch' }])
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
