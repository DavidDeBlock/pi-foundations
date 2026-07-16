import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import bcrypt from 'bcryptjs'
import { Hono } from 'hono'
import { auth, type AuthVariables } from './auth.js'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { InMemoryTokenStore } from './token-store.js'
import { youtubeVideoDescriptionsApi } from './youtube-video-descriptions-api.js'
import { YouTubeVideoDescriptionService } from './youtube-video-descriptions.js'
import type { VideoMetadataFetcher, VideoMetadataResult } from './youtube-video-metadata-fetcher.js'
import { upsertYouTubeVideo } from './youtube-video-upsert.js'
import { reconcileVideoDescriptionResources } from './youtube-description-resources.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')
const PASSWORD = 'secret'

describe('video description API', () => {
  let db: Database
  let app: Hono<{ Variables: AuthVariables }>
  let service: YouTubeVideoDescriptionService
  let videoId: string
  let finishFetch: ((result: ReadonlyMap<string, VideoMetadataResult>) => void) | undefined

  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    videoId = upsertYouTubeVideo(db, {
      videoId: 'remote-api', channelId: 'UCapi', channelTitle: 'API channel',
      title: 'API video', publishedAt: '2026-07-16T00:00:00.000Z',
      thumbnailUrl: null, link: 'https://youtube.com/watch?v=remote-api',
      origin: { type: 'manual' },
    }).id
    const fetcher: VideoMetadataFetcher = {
      fetch: async () => await new Promise((resolveFetch) => { finishFetch = resolveFetch }),
    }
    service = new YouTubeVideoDescriptionService({
      db, accessToken: async () => 'token', fetcher,
    })
    app = new Hono<{ Variables: AuthVariables }>()
    app.use('*', auth({
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      tokenStore: new InMemoryTokenStore(),
    }))
    app.route('/api/videos', youtubeVideoDescriptionsApi({ db, service }))
  })

  afterEach(() => db.close())

  const headers = (): Record<string, string> => ({
    authorization: `Basic ${Buffer.from(`david:${PASSWORD}`).toString('base64')}`,
  })

  it('requires dashboard authentication', async () => {
    const response = await app.request(`/api/videos/${videoId}/description`)
    expect(response.status).toBe(401)
  })

  it('returns null before request, then typed pending and ready states', async () => {
    const initial = await app.request(`/api/videos/${videoId}/description`, { headers: headers() })
    expect(await initial.json()).toEqual({ ok: true, description: null })

    const queued = await app.request(`/api/videos/${videoId}/description/refresh`, {
      method: 'POST', headers: headers(),
    })
    expect(queued.status).toBe(202)
    expect(await queued.json()).toMatchObject({
      ok: true, description: { status: 'pending', description: null, attempt_count: 0 },
    })

    await Promise.resolve()
    const pending = await app.request(`/api/videos/${videoId}/description`, { headers: headers() })
    expect(await pending.json()).toMatchObject({ description: { status: 'pending' } })

    finishFetch?.(new Map([['remote-api', {
      status: 'ready',
      description: '<img src=x onerror=alert(1)> useful text',
      truncated: false,
    }]]))
    await service.whenIdle()
    const ready = await app.request(`/api/videos/${videoId}/description`, { headers: headers() })
    const body = await ready.json() as { description: Record<string, unknown> }
    expect(body.description).toMatchObject({
      status: 'ready',
      description: '<img src=x onerror=alert(1)> useful text',
      error_message: null,
      unavailable_reason: null,
    })
    expect(body.description).not.toHaveProperty('access_token')
    expect(body.description).not.toHaveProperty('provider_response')
  })

  it('returns typed 404s for reads and refreshes', async () => {
    const read = await app.request('/api/videos/missing/description', { headers: headers() })
    expect(read.status).toBe(404)
    expect(await read.json()).toEqual({ ok: false, error: 'not_found' })
    const refresh = await app.request('/api/videos/missing/description/refresh', {
      method: 'POST', headers: headers(),
    })
    expect(refresh.status).toBe(404)
  })

  it('returns persisted resources in stable effective-visibility groups without external work', async () => {
    reconcileVideoDescriptionResources(db, videoId,
      'Code https://github.com/acme/project\nUnknown https://example.com\nSponsor https://shop.example/?aff=1')
    const response = await app.request(`/api/videos/${videoId}/resources`, { headers: headers() })
    expect(response.status).toBe(200)
    const body = await response.json() as {
      resources: Array<Record<string, unknown>>
      groups: Record<string, Array<Record<string, unknown>>>
      counts: Record<string, number>
    }
    expect(body.resources.map((resource) => resource.category)).toEqual(['repository', 'other', 'promotional'])
    expect(body.groups.featured).toHaveLength(1)
    expect(body.groups.normal).toHaveLength(1)
    expect(body.groups.hidden).toHaveLength(1)
    expect(body.counts).toEqual({ total: 3, featured: 1, normal: 1, hidden: 1 })
    expect(body.resources[0]).toMatchObject({
      classification_source: 'deterministic', source_positions: [5],
    })

    const missing = await app.request('/api/videos/missing/resources', { headers: headers() })
    expect(missing.status).toBe(404)
  })
})
