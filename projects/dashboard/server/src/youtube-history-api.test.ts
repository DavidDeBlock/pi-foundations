import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import bcrypt from 'bcryptjs'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auth, type AuthVariables } from './auth.js'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { InMemoryTokenStore } from './token-store.js'
import { youtubeHistoryApi } from './youtube-history-api.js'
import { YouTubeHistoryImports } from './youtube-history-imports.js'
import { TakeoutWatchHistoryParser } from './youtube-history-parser.js'
import type { VideoDurationFetcher } from './youtube-video-duration-fetcher.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')
const FIXTURE = resolve(process.cwd(), 'src/fixtures/youtube-watch-history.sanitized.json')
const PASSWORD = 'secret'

describe('YT-012 history import API', () => {
  let db: Database
  let dataDir: string
  let imports: YouTubeHistoryImports
  let app: Hono<{ Variables: AuthVariables }>
  let now: number

  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    dataDir = await mkdtemp(join(tmpdir(), 'dashboard-history-'))
    now = Date.parse('2026-07-16T12:00:00.000Z')
    imports = new YouTubeHistoryImports({ db, dataDir, nowMs: () => now, ttlMs: 60_000 })
    await imports.initialize()
    app = await buildApp(imports, db)
  })

  afterEach(() => db.close())

  it('requires auth and previews multipart Takeout counts without importing', async () => {
    const fixture = await readFile(FIXTURE)
    expect((await app.request('/api/youtube/history/imports')).status).toBe(401)
    const response = await previewRequest(app, fixture)
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      filename: 'watch-history.json', total_count: 4, new_event_count: 3,
      duplicate_count: 0, malformed_count: 1, unique_video_count: 1,
      new_video_count: 1, oldest_watched_at: '2026-07-10T10:30:00.000Z',
      newest_watched_at: '2026-07-12T08:00:00.000Z',
    })
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM youtube_watch_events')?.count).toBe(0)
  })

  it('commits once, canonical-upserts known videos, and retains removed snapshots', async () => {
    const preview = await previewJson(app, await readFile(FIXTURE))
    const committed = await app.request(`/api/youtube/history/imports/${preview.token}/commit`, {
      method: 'POST', headers: authHeaders(),
    })
    expect(await committed.json()).toMatchObject({
      committed_event_count: 3, duplicate_count: 0, malformed_count: 1,
      inserted_video_count: 1, existing_video_count: 0, snapshot_only_count: 1,
    })
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM videos')?.count).toBe(1)
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM youtube_watch_events')?.count).toBe(3)
    expect(db.get('SELECT video_id, title_snapshot FROM youtube_watch_events WHERE video_id IS NULL')).toEqual({
      video_id: null, title_snapshot: 'a video that has been removed',
    })
    const second = await app.request(`/api/youtube/history/imports/${preview.token}/commit`, {
      method: 'POST', headers: authHeaders(),
    })
    expect(second.status).toBe(409)
  })

  it('imports Takeout HTML while excluding videos up to three minutes and retaining unavailable snapshots', async () => {
    const durations: VideoDurationFetcher = {
      fetch: async (_token, ids) => new Map(ids.map((id) => [id,
        id === 'short123XYZ' ? { status: 'ready' as const, durationSeconds: 180 }
          : id === 'long123XYZ' ? { status: 'ready' as const, durationSeconds: 181 }
            : { status: 'unavailable' as const },
      ])),
    }
    const classified = new YouTubeHistoryImports({
      db, dataDir: join(dataDir, 'html'), durationFetcher: durations,
      accessToken: async () => 'access-token', nowMs: () => now,
    })
    await classified.initialize()
    const classifiedApp = await buildApp(classified, db)
    const html = Buffer.from(`<html><head><title>My Activity History</title></head><body>
      ${htmlActivity('Watched', 'short123XYZ', 'Short', 'Jul 16, 2026, 10:00:00 AM CEST')}
      ${htmlActivity('Watched', 'long123XYZ', 'Long', 'Jul 16, 2026, 9:00:00 AM CEST')}
      ${htmlActivity('Watched', 'gone123XYZ', 'Unavailable', 'Jul 15, 2026, 9:00:00 AM CEST')}
      ${htmlActivity('Viewed', 'ignored123X', 'History', 'Jul 14, 2026, 9:00:00 AM CEST')}
      </body></html>`)
    const preview = await previewJson(classifiedApp, html, 'watch-history.html')
    expect(preview).toMatchObject({
      filename: 'watch-history.html', total_count: 4, new_event_count: 2,
      malformed_count: 1, unique_video_count: 2, new_video_count: 1,
      shorts_excluded_event_count: 1, shorts_excluded_video_count: 1,
      unavailable_video_count: 1,
    })
    expect(await commit(classifiedApp, preview.token)).toMatchObject({
      committed_event_count: 2, inserted_video_count: 1, snapshot_only_count: 1,
      shorts_excluded_event_count: 1,
    })
    expect(db.get('SELECT 1 FROM videos WHERE video_id = ?', ['short123XYZ'])).toBeUndefined()
    expect(db.get('SELECT 1 FROM youtube_watch_events WHERE youtube_video_id = ?', ['short123XYZ'])).toBeUndefined()
    expect(db.get<{ video_id: string | null }>(
      'SELECT video_id FROM youtube_watch_events WHERE youtube_video_id = ?', ['gone123XYZ'],
    )?.video_id).toBeNull()
  })

  it('refuses HTML preview without YouTube metadata access instead of importing unclassified Shorts', async () => {
    const html = Buffer.from(`<html><head><title>My Activity History</title></head><body>
      ${htmlActivity('Watched', 'video123XYZ', 'Video', 'Jul 16, 2026, 9:00:00 AM CEST')}
      </body></html>`)
    const response = await previewRequest(app, html, 'watch-history.html')
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('Connect YouTube') })
  })

  it('deduplicates duplicate and overlapping exports while retaining later watches', async () => {
    const first = await previewJson(app, await readFile(FIXTURE))
    await commit(app, first.token)

    const duplicate = await previewJson(app, await readFile(FIXTURE))
    expect(duplicate).toMatchObject({ new_event_count: 0, duplicate_count: 3 })
    expect(await commit(app, duplicate.token)).toMatchObject({ committed_event_count: 0, duplicate_count: 3 })

    const overlap = Buffer.from(JSON.stringify([
      takeout('abc123XYZ_0', '2026-07-11T11:45:00.000Z'),
      takeout('abc123XYZ_0', '2026-07-14T11:45:00.000Z'),
      takeout('new789XYZ_2', '2026-07-15T09:00:00.000Z'),
    ]))
    const overlapping = await previewJson(app, overlap)
    expect(overlapping).toMatchObject({ new_event_count: 2, duplicate_count: 1, unique_video_count: 2, new_video_count: 1 })
    expect(await commit(app, overlapping.token)).toMatchObject({ committed_event_count: 2, duplicate_count: 1 })
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM youtube_watch_events')?.count).toBe(5)
  })

  it('sanitizes hostile filenames and never exposes staging paths or contents in audit data', async () => {
    const preview = await previewJson(app, Buffer.from(JSON.stringify([takeout('abc123XYZ_0', '2026-07-10T00:00:00Z')])), '../../private/watch-history.json')
    expect(preview.filename).toBe('watch-history.json')
    const staged = await readdir(join(dataDir, 'youtube-history-imports'))
    expect(staged).toEqual([`${preview.token}.json`])
    expect((await stat(join(dataDir, 'youtube-history-imports', staged[0]!))).mode & 0o777).toBe(0o600)
    const audit = await (await app.request('/api/youtube/history/imports', { headers: authHeaders() })).json() as { items: Array<Record<string, unknown>> }
    expect(audit.items[0]).not.toHaveProperty('staged_filename')
    expect(JSON.stringify(audit)).not.toContain(dataDir)
    expect(JSON.stringify(audit)).not.toContain('Watched Video')
  })

  it('rejects malformed JSON, unsupported roots, missing files, and oversized uploads clearly', async () => {
    expect((await previewRequest(app, Buffer.from('{bad'))).status).toBe(400)
    expect((await previewRequest(app, Buffer.from('{}'))).status).toBe(400)
    const emptyForm = new FormData()
    emptyForm.set('note', 'no file')
    expect((await app.request('/api/youtube/history/preview', { method: 'POST', headers: authOnly(), body: emptyForm })).status).toBe(400)

    const small = new YouTubeHistoryImports({
      db, dataDir: join(dataDir, 'small'), parser: new TakeoutWatchHistoryParser({ maxBytes: 32 }),
    })
    await small.initialize()
    const smallApp = await buildApp(small, db)
    const tooLarge = await previewRequest(smallApp, Buffer.from(' '.repeat(33)))
    expect(tooLarge.status).toBe(413)
    expect((await tooLarge.json() as { error: string }).error).toContain('32-byte')
  })

  it('rolls the entire commit back when one event fails', async () => {
    const failing = new YouTubeHistoryImports({
      db, dataDir, nowMs: () => now,
      beforeEventCommit: (_event, index) => { if (index === 1) throw new Error('simulated failure') },
    })
    const failingApp = await buildApp(failing, db)
    const preview = await previewJson(failingApp, Buffer.from(JSON.stringify([
      takeout('abc123XYZ_0', '2026-07-10T00:00:00Z'),
      takeout('new789XYZ_2', '2026-07-11T00:00:00Z'),
    ])))
    const response = await failingApp.request(`/api/youtube/history/imports/${preview.token}/commit`, {
      method: 'POST', headers: authHeaders(),
    })
    expect(response.status).toBe(500)
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM youtube_watch_events')?.count).toBe(0)
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM videos')?.count).toBe(0)
    expect(db.get<{ status: string }>('SELECT status FROM youtube_history_imports WHERE id = ?', [preview.token])?.status).toBe('previewed')
  })

  it('expires previews, deletes staged files, and returns gone on commit', async () => {
    const preview = await previewJson(app, Buffer.from(JSON.stringify([takeout('abc123XYZ_0', '2026-07-10T00:00:00Z')])))
    now += 60_001
    const response = await app.request(`/api/youtube/history/imports/${preview.token}/commit`, {
      method: 'POST', headers: authHeaders(),
    })
    expect(response.status).toBe(410)
    expect(await readdir(join(dataDir, 'youtube-history-imports'))).toEqual([])
    expect(db.get<{ status: string }>('SELECT status FROM youtube_history_imports WHERE id = ?', [preview.token])?.status).toBe('expired')
  })

  it('can commit a staged preview after the importer is recreated on restart', async () => {
    const preview = await previewJson(app, Buffer.from(JSON.stringify([takeout('abc123XYZ_0', '2026-07-10T00:00:00Z')])))
    const restarted = new YouTubeHistoryImports({ db, dataDir, nowMs: () => now, ttlMs: 60_000 })
    await restarted.initialize()
    const restartedApp = await buildApp(restarted, db)
    expect(await commit(restartedApp, preview.token)).toMatchObject({ committed_event_count: 1 })
  })
})

async function buildApp(service: YouTubeHistoryImports, db: Database): Promise<Hono<{ Variables: AuthVariables }>> {
  const result = new Hono<{ Variables: AuthVariables }>()
  result.use('*', auth({ passwordHash: await bcrypt.hash(PASSWORD, 4), tokenStore: new InMemoryTokenStore() }))
  result.route('/api/youtube/history', youtubeHistoryApi({ imports: service, db }))
  return result
}

function authOnly(): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`david:${PASSWORD}`).toString('base64')}` }
}

function authHeaders(): Record<string, string> {
  return { ...authOnly(), 'content-type': 'application/json' }
}

async function previewRequest(app: Hono<{ Variables: AuthVariables }>, data: Buffer, filename = 'watch-history.json'): Promise<Response> {
  const form = new FormData()
  form.set('file', new Blob([data], { type: 'application/json' }), filename)
  return app.request('/api/youtube/history/preview', { method: 'POST', headers: authOnly(), body: form })
}

async function previewJson(app: Hono<{ Variables: AuthVariables }>, data: Buffer, filename?: string): Promise<Record<string, unknown>> {
  const response = await previewRequest(app, data, filename)
  expect(response.status).toBe(201)
  return await response.json() as Record<string, unknown>
}

async function commit(app: Hono<{ Variables: AuthVariables }>, token: unknown): Promise<Record<string, unknown>> {
  const response = await app.request(`/api/youtube/history/imports/${String(token)}/commit`, {
    method: 'POST', headers: authHeaders(),
  })
  expect(response.status).toBe(200)
  return await response.json() as Record<string, unknown>
}

function takeout(videoId: string, time: string): Record<string, unknown> {
  return {
    header: 'YouTube', title: 'Watched Video',
    titleUrl: `https://www.youtube.com/watch?v=${videoId}`,
    subtitles: [{ name: 'Channel', url: 'https://www.youtube.com/channel/UCchannel123' }],
    time, products: ['YouTube'],
  }
}

function htmlActivity(action: string, videoId: string, title: string, timestamp: string): string {
  return `<div class="outer-cell mdl-cell mdl-cell--12-col"><div class="mdl-grid"><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">${action} <a href="https://www.youtube.com/watch?v=${videoId}">${title}</a><br><a href="https://www.youtube.com/channel/UCchannel123">Channel</a><br>${timestamp}<br></div></div></div>`
}
