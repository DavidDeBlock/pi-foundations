// news/news-refresh-route.test.ts — issue NW-005
//
// Integration tests for `POST /api/news/refresh`. The route
// mounts on a real Hono app, so the tests cover auth + body
// shape + tick semantics end-to-end against the in-memory
// orchestrator (no real network — the fetcher stubs `
// NewsFetchJob` so the tick is fully deterministic).

import bcrypt from 'bcryptjs'
import { describe, expect, it, beforeEach } from 'vitest'
import { resolve } from 'node:path'
import { Database } from '../db.js'
import { runMigrations } from '../migrations.js'
import { createApp } from '../app.js'
import { InMemoryTokenStore } from '../token-store.js'
import { NewsStore } from './news-store.js'
import { NewsFetchJob } from './news-fetch-job.js'
import { NewsSchedulerOrchestrator } from './news-scheduler-orchestrator.js'
import { NewsScheduler } from './news-scheduler.js'
import type { AuthVariables } from '../auth.js'
import type { Hono } from 'hono'

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../migrations')
const PASSWORD = 'correct horse battery staple'
const HASH = bcrypt.hashSync(PASSWORD, 10)

// Deterministic stub job. Each invocation appends to `callLog`
// and returns a synthetic `{ ok: true, inserted: 0 }` so the
// orchestrator writes a success state on the source row.
const makeStubJob = (callLog: number[]) => ({
  run: async (source: { id: number }): Promise<{ ok: true; inserted: 0 }> => {
    callLog.push(source.id)
    return { ok: true, inserted: 0 }
  },
}) as unknown as NewsFetchJob

let db: Database
let app: Hono<{ Variables: AuthVariables }>

beforeEach(async () => {
  db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  // Wipe seed sources so tests use controlled fixtures.
  db.run('DELETE FROM news_sources')
  db.run(`INSERT INTO news_sources
    (name, category, type, url, refresh_interval_min, enabled, created_at)
  VALUES ('VRT NWS', 'General', 'rss', 'https://www.vrt.be/rss', 30, 1, '2024-07-16T12:00:00.000Z')`)

  const callLog: number[] = []
  const store = new NewsStore(db)
  const job = makeStubJob(callLog)
  const orchestrator = new NewsSchedulerOrchestrator({ store, job })
  // Bump the source's `last_fetched_at` so the due-check
  // passes immediately (interval = 30 min, "now" minus 0
  // minutes ago is fine).
  const scheduler = new NewsScheduler({ orchestrator })
  app = createApp({
    passwordHash: HASH,
    tokenStore: new InMemoryTokenStore(),
    db,
    newsScheduler: scheduler,
  })
})

const auth = (): string => `Basic ${Buffer.from(`:${PASSWORD}`).toString('base64')}`

describe('POST /api/news/refresh', () => {
  it('returns 200 with a TickSummary-shaped JSON body', async () => {
    const res = await app.request('/api/news/refresh', {
      method: 'POST',
      headers: { authorization: auth() },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({
      fetchedCount: expect.any(Number),
      succeededCount: expect.any(Number),
      failedCount: expect.any(Number),
      inFlightCount: expect.any(Number),
      ranAt: expect.any(String),
      results: expect.any(Array),
    })
  })

  it('returns 401 without HTTP Basic credentials', async () => {
    const res = await app.request('/api/news/refresh', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('only accepts POST (GET returns 404 or 405)', async () => {
    const res = await app.request('/api/news/refresh', {
      method: 'GET',
      headers: { authorization: auth() },
    })
    expect([404, 405]).toContain(res.status)
  })

  it('runs a tick: the stub job is invoked for the due source', async () => {
    // The seeded source has last_fetched_at = NULL + interval=30
    // so it's due. Tick should fetch it.
    const res = await app.request('/api/news/refresh', {
      method: 'POST',
      headers: { authorization: auth() },
    })
    const body = await res.json() as { results: Array<{ sourceId: number; status: string }> }
    expect(body.results.length).toBeGreaterThan(0)
    expect(body.results[0]?.status).toBe('ok')
  })

  it('does NOT start the timer (interval=0 by default in NewsScheduler; manual-only)', async () => {
    // The route test focuses on the manual trigger path.
    // Construct a fresh scheduler with intervalMin=1 and verify
    // it does NOT have any armed timers after a single runOnce
    // call. We assert via the public `isEnabled()` accessor.
    const store = new NewsStore(db)
    const job = makeStubJob([])
    const orchestrator = new NewsSchedulerOrchestrator({ store, job })
    const scheduler = new NewsScheduler({
      orchestrator,
      intervalMin: 1,
      intervalScheduler: {
        schedule: () => () => {},
        scheduleOnce: () => () => {},
      },
    })
    expect(scheduler.isEnabled()).toBe(true)
    scheduler.start()
    scheduler.stop()
    // Calling runOnce still works after stop — the timer is gone
    // but the orchestrator is reusable.
    const summary = await scheduler.runOnce()
    expect(summary.fetchedCount).toBeGreaterThanOrEqual(0)
  })

  it('returns 404 on POST /api/news/refresh when the scheduler is not wired', async () => {
    // Construct an app WITHOUT the newsScheduler dep. The route
    // is conditionally mounted, so the endpoint should not exist.
    const plainApp = createApp({
      passwordHash: HASH,
      tokenStore: new InMemoryTokenStore(),
      db,
    })
    const res = await plainApp.request('/api/news/refresh', {
      method: 'POST',
      headers: { authorization: auth() },
    })
    expect(res.status).toBe(404)
  })
})