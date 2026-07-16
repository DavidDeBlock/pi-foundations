import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import bcrypt from 'bcryptjs'
import { Hono } from 'hono'
import { resolve } from 'node:path'
import { auth, type AuthVariables } from './auth.js'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { InMemoryTokenStore } from './token-store.js'
import { subscriptionsApi } from './youtube-subscriptions-list-api.js'
import {
  attachTagByNameToSubscription,
  detachTagFromSubscription,
  getSubscriptionByChannelId,
  upsertSubscription,
} from './youtube-subscriptions.js'
import {
  attachTagByNameToVideo,
  insertVideo,
  listTagsForVideo,
  searchVideos,
} from './youtube-videos.js'

const PASSWORD = 'secret'
const AUTH = `Basic ${Buffer.from(`david:${PASSWORD}`).toString('base64')}`
const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

let db: Database
let app: Hono<{ Variables: AuthVariables }>
let alphaId: string
let betaId: string

beforeEach(async () => {
  db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  db.run(`INSERT INTO youtube_accounts
    (id, provider, google_user_id, email_address, access_token_enc, refresh_token_enc, scopes)
    VALUES ('acct', 'youtube', 'google', 'd@example.com', 'x', 'y', 'youtube.readonly')`)
  alphaId = upsertSubscription(db, {
    googleAccountId: 'acct', channelId: 'UC-alpha', channelTitle: 'Alpha Science',
    channelThumbnailUrl: null, subscribedAt: '2026-01-01T00:00:00.000Z',
  }).id
  betaId = upsertSubscription(db, {
    googleAccountId: 'acct', channelId: 'UC-beta', channelTitle: 'Beta Gaming',
    channelThumbnailUrl: null, subscribedAt: '2026-01-01T00:00:00.000Z',
  }).id
  const passwordHash = bcrypt.hashSync(PASSWORD, 4)
  app = new Hono<{ Variables: AuthVariables }>()
  app.use('*', auth({ passwordHash, tokenStore: new InMemoryTokenStore() }))
  app.route('/api/subscriptions', subscriptionsApi({ db }))
})

afterEach(() => db.close())

function seedVideo(channelId = 'UC-alpha', videoId = 'video-a'): string {
  return insertVideo(db, {
    videoId, channelId, title: `Title ${videoId}`,
    publishedAt: '2026-01-02T00:00:00.000Z', thumbnailUrl: null,
    link: `https://youtube.com/watch?v=${videoId}`,
  }).id
}

describe('subscription tag API', () => {
  it('requires auth and returns 404 for an unknown subscription', async () => {
    expect((await app.request(`/api/subscriptions/${alphaId}/tags`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'science' }),
    })).status).toBe(401)
    expect((await app.request('/api/subscriptions/missing/tags', {
      method: 'POST', headers: { authorization: AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'science' }),
    })).status).toBe(404)
  })

  it('normalizes and idempotently attaches a shared tag', async () => {
    const request = (name: string) => app.request(`/api/subscriptions/${alphaId}/tags`, {
      method: 'POST', headers: { authorization: AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const first = await request('  Data & Science  ')
    const second = await request('DATA-SCIENCE')
    expect(first.status).toBe(201)
    expect(await first.json()).toMatchObject({ name: 'data-science' })
    expect(await second.json()).toMatchObject({ name: 'data-science' })
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM subscription_tags')?.count).toBe(1)
  })

  it('lists tags and composes tag, inclusion, and tag-name search filters', async () => {
    const tag = attachTagByNameToSubscription(db, alphaId, 'Research')!
    attachTagByNameToSubscription(db, betaId, 'research')
    db.run('UPDATE subscriptions SET is_included = 0 WHERE id = ?', [betaId])
    const res = await app.request(`/api/subscriptions?filter=included&search=RESEARCH&tag_id=${tag.id}`, {
      headers: { authorization: AUTH },
    })
    const body = await res.json() as { total: number; items: Array<{ title: string; tags: unknown[] }> }
    expect(body.total).toBe(1)
    expect(body.items[0]).toMatchObject({ title: 'Alpha Science', tags: [{ id: tag.id, name: 'research' }] })
  })

  it('deletes only the relationship and is idempotent', async () => {
    const tag = attachTagByNameToSubscription(db, alphaId, 'science')!
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await app.request(`/api/subscriptions/${alphaId}/tags/${tag.id}`, {
        method: 'DELETE', headers: { authorization: AUTH },
      })
      expect(res.status).toBe(204)
    }
    expect(db.get('SELECT id FROM tags WHERE id = ?', [tag.id])).toEqual({ id: tag.id })
  })
})

describe('effective video tags', () => {
  it('applies subscription tags retroactively and to future videos', () => {
    const oldVideo = seedVideo()
    const tag = attachTagByNameToSubscription(db, alphaId, 'science')!
    const futureVideo = seedVideo('UC-alpha', 'video-new')
    for (const id of [oldVideo, futureVideo]) {
      expect(listTagsForVideo(db, id)).toEqual([{
        id: tag.id, name: 'science', source: 'subscription', sources: ['subscription'],
      }])
    }
  })

  it('deduplicates manual and inherited tags while reporting both sources', () => {
    const videoId = seedVideo()
    const inherited = attachTagByNameToSubscription(db, alphaId, 'science')!
    const manual = attachTagByNameToVideo(db, videoId, 'SCIENCE')!
    expect(manual.id).toBe(inherited.id)
    expect(listTagsForVideo(db, videoId)).toEqual([{
      id: inherited.id, name: 'science', source: 'both', sources: ['manual', 'subscription'],
    }])
  })

  it('removing inheritance preserves the manual video relationship', () => {
    const videoId = seedVideo()
    const tag = attachTagByNameToSubscription(db, alphaId, 'science')!
    attachTagByNameToVideo(db, videoId, 'science')
    detachTagFromSubscription(db, alphaId, tag.id)
    expect(listTagsForVideo(db, videoId)).toEqual([{
      id: tag.id, name: 'science', source: 'manual', sources: ['manual'],
    }])
  })

  it('filters by inherited tag without making an excluded channel visible', () => {
    const videoId = seedVideo()
    const tag = attachTagByNameToSubscription(db, alphaId, 'science')!
    expect(searchVideos(db, { tagId: tag.id }).items.map((item) => item.id)).toEqual([videoId])
    db.run('UPDATE subscriptions SET is_included = 0 WHERE id = ?', [alphaId])
    expect(searchVideos(db, { tagId: tag.id }).items).toEqual([])
  })

  it('cascades subscription links and retains the shared tag row', () => {
    const tag = attachTagByNameToSubscription(db, alphaId, 'science')!
    db.run('DELETE FROM subscriptions WHERE id = ?', [alphaId])
    expect(db.get('SELECT * FROM subscription_tags WHERE subscription_id = ?', [alphaId])).toBeUndefined()
    expect(db.get('SELECT id FROM tags WHERE id = ?', [tag.id])).toEqual({ id: tag.id })
    expect(getSubscriptionByChannelId(db, 'UC-alpha')).toBeNull()
  })
})
