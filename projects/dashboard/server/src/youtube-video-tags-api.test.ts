// youtube-video-tags-api.test.ts — issue YT-005
//
// HTTP-boundary tests for the tag sub-resource endpoints.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { auth, type AuthVariables } from './auth.js'
import { InMemoryTokenStore } from './token-store.js'
import { youtubeVideoTagsApi } from './youtube-video-tags-api.js'
import {
  insertVideo,
  type VideoInsertInput,
} from './youtube-videos.js'
import { upsertSubscription } from './youtube-subscriptions.js'

const PASSWORD = 'secret'
const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

interface TestEnv {
  db: Database
  app: Hono<{ Variables: AuthVariables }>
  seedVideo(overrides?: Partial<VideoInsertInput>): string
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
  const api = youtubeVideoTagsApi({ db })
  const app = new Hono<{ Variables: AuthVariables }>()
  app.use('*', auth({ passwordHash, tokenStore }))
  // Mount at /api/videos/* so path params resolve like `/api/videos/:id/tags`.
  app.route('/api/videos', api)
  env = {
    db,
    app,
    seedVideo(overrides: Partial<VideoInsertInput> = {}) {
      return insertVideo(db, {
        videoId: overrides.videoId ?? 'dQw4w9WgXcQ',
        channelId: overrides.channelId ?? 'UCaaaaaaa000000000000aab',
        title: overrides.title ?? 'Never Gonna Give You Up',
        publishedAt: overrides.publishedAt ?? '2009-10-25T06:57:33.000Z',
        thumbnailUrl:
          overrides.thumbnailUrl !== undefined
            ? overrides.thumbnailUrl
            : 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        link: overrides.link ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      }).id
    },
  }
})

afterEach(() => {
  env.db.close()
})

function basic(p: string): string {
  return `Basic ${Buffer.from(`david:${p}`).toString('base64')}`
}

// ─── POST /:id/tags ─────────────────────────────────────────────────────

describe('POST /api/videos/:id/tags', () => {
  it('returns 401 unauthenticated', async () => {
    const id = env.seedVideo()
    const res = await env.app.request(`/api/videos/${id}/tags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'launch' }),
    })
    expect(res.status).toBe(401)
  })

  it('attaches a new tag and returns 201 + the tag', async () => {
    const id = env.seedVideo()
    const res = await env.app.request(`/api/videos/${id}/tags`, {
      method: 'POST',
      headers: { authorization: basic(PASSWORD), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'launch' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; name: string }
    expect(body.name).toBe('launch')
    expect(body.id).toBeTruthy()
  })

  it('lowercases on the server (matches existing tag, no duplicate row)', async () => {
    const id = env.seedVideo()
    // First call
    let res = await env.app.request(`/api/videos/${id}/tags`, {
      method: 'POST',
      headers: { authorization: basic(PASSWORD), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Postgres' }),
    })
    expect(res.status).toBe(201)
    const tagId = ((await res.json()) as { id: string }).id

    // Second call with different case should return the SAME id
    res = await env.app.request(`/api/videos/${id}/tags`, {
      method: 'POST',
      headers: { authorization: basic(PASSWORD), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'POSTGRES' }),
    })
    expect(res.status).toBe(201)
    const sameId = ((await res.json()) as { id: string }).id
    expect(sameId).toBe(tagId)

    // Confirm exactly one row in tags table
    const count = env.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM tags`)?.c
    expect(count).toBe(1)
  })

  it('returns 400 when name is missing or empty', async () => {
    const id = env.seedVideo()
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 42 }]) {
      const res = await env.app.request(`/api/videos/${id}/tags`, {
        method: 'POST',
        headers: { authorization: basic(PASSWORD), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(400)
    }
  })

  it('returns 400 on malformed JSON', async () => {
    const id = env.seedVideo()
    const res = await env.app.request(`/api/videos/${id}/tags`, {
      method: 'POST',
      headers: { authorization: basic(PASSWORD), 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 for an unknown video id', async () => {
    const res = await env.app.request(`/api/videos/no-such/tags`, {
      method: 'POST',
      headers: { authorization: basic(PASSWORD), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'launch' }),
    })
    expect(res.status).toBe(404)
  })
})

// ─── DELETE /:id/tags/:tagId ───────────────────────────────────────────

describe('DELETE /api/videos/:id/tags/:tagId', () => {
  it('returns 401 unauthenticated', async () => {
    const id = env.seedVideo()
    const res = await env.app.request(`/api/videos/${id}/tags/any-tag-id`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(401)
  })

  it('removes an existing link and returns 204', async () => {
    const id = env.seedVideo()
    // Create a tag and attach it
    env.db.run(`INSERT INTO tags (id, name) VALUES ('tt-1', 'launch')`)
    env.db.run(`INSERT INTO video_tags (video_id, tag_id) VALUES (?, 'tt-1')`, [id])
    const res = await env.app.request(`/api/videos/${id}/tags/tt-1`, {
      method: 'DELETE',
      headers: { authorization: basic(PASSWORD) },
    })
    expect(res.status).toBe(204)
    // Confirm gone
    const remaining = env.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM video_tags WHERE video_id = ?`,
      [id],
    )
    expect(remaining?.c).toBe(0)
  })

  it('returns 204 (no-op) when the link did not exist', async () => {
    const id = env.seedVideo()
    const res = await env.app.request(`/api/videos/${id}/tags/no-such-tag-id`, {
      method: 'DELETE',
      headers: { authorization: basic(PASSWORD) },
    })
    expect(res.status).toBe(204)
  })

  it('returns 404 for an unknown video id', async () => {
    const res = await env.app.request(`/api/videos/no-such/tags/any-tag-id`, {
      method: 'DELETE',
      headers: { authorization: basic(PASSWORD) },
    })
    expect(res.status).toBe(404)
  })

  it('only removes the one (video, tag) link', async () => {
    const id = env.seedVideo()
    // Two distinct tags attached
    env.db.run(
      `INSERT INTO tags (id, name) VALUES ('tt-1', 'one')`,
    )
    env.db.run(`INSERT INTO tags (id, name) VALUES ('tt-2', 'two')`)
    env.db.run(`INSERT INTO video_tags (video_id, tag_id) VALUES (?, 'tt-1')`, [id])
    env.db.run(`INSERT INTO video_tags (video_id, tag_id) VALUES (?, 'tt-2')`, [id])
    const res = await env.app.request(`/api/videos/${id}/tags/tt-1`, {
      method: 'DELETE',
      headers: { authorization: basic(PASSWORD) },
    })
    expect(res.status).toBe(204)
    const remaining = env.db.all<{ id: string }>(
      `SELECT t.id FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id = ?`,
      [id],
    )
    expect(remaining).toEqual([{ id: 'tt-2' }])
  })
})
