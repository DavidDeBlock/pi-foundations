// news/news-fetch-job.test.ts — issue NW-002
//
// Unit tests for the orchestrator. The fetchers are injected
// as stubs so we can exercise the full run() pipeline against
// an in-memory DB without touching the network.
//
// Coverage map (per AC):
//   * Happy path (RSS) → { ok: true, inserted: N }
//   * Happy path (Atom) → { ok: true, inserted: N }
//   * Happy path (json_api) → { ok: true, inserted: 0 } (weather)
//   * Empty normalized list → { ok: true, inserted: 0 }
//   * Fetcher throws → { ok: false, error: <message> }
//   * Unknown source type → { ok: false, error }
//   * lastFetchedAt is updated on every attempt, even failures
//   * lastError is updated on failure, cleared on success

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Database } from '../db.js'
import { runMigrations } from '../migrations.js'
import { NewsFetchJob } from './news-fetch-job.js'
import { NewsStore } from './news-store.js'
import { FetchError, type RawArticle, type Source, type WeatherSnapshot } from './types.js'
import { NewsRssFetcher } from './news-rss-fetcher.js'
import { NewsAtomFetcher } from './news-atom-fetcher.js'

// ─── Setup ────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../migrations')

let db: Database
let store: NewsStore
let now: number
let job: NewsFetchJob
let stubRssFetcher: NewsRssFetcher
let stubAtomFetcher: NewsAtomFetcher
let stubOpenMeteoFetcher: OpenMeteoFetcherLike

class WeatherFetcherStub {
  async fetch(): Promise<WeatherSnapshot> {
    return {
      fetchedAt: '2024-07-16T12:00:00.000Z',
      current: { temperature_2m: 20 },
      daily: [],
      hourly: [],
    }
  }
}

/** Fetcher type used by the stubs. The job only ever calls
 *  `fetch(url)` on whatever it was given; we don't need
 *  the real class's constructor signature. The cast
 *  to `as never` at the Job's constructor boundary sidesteps
 *  the ECMAScript private-field-quirk. */
type AnyArticleFetcher = { fetch(url: string): Promise<RawArticle[]> }
type OpenMeteoFetcherLike = { fetch(url: string): Promise<WeatherSnapshot> }

beforeEach(async () => {
  db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  // Wipe the seed sources from 025_news.sql — these tests
  // use controlled fixtures, not the production seed.
  db.run('DELETE FROM news_sources')
  store = new NewsStore(db)
  now = Date.parse('2024-07-16T12:00:00.000Z')
  // The job accepts any of the three fetchers for injection
  // (it doesn't care which type they are — it just calls
  // .fetch() on them). The stubs have the same shape as
  // the real fetchers' fetch() method, but the constructor
  // signature differs. We work around that by using a thin
  // duck-typed wrapper: see the `as never` casts below.
  const rssStub: AnyArticleFetcher = makeStubFetcher([
    {
      id: 'rss-1',
      url: 'https://example.com/posts/1',
      title: 'RSS one',
      description: 'body 1',
      publishedAt: '2024-07-16T11:00:00.000Z',
    },
    {
      id: 'rss-2',
      url: 'https://example.com/posts/2',
      title: 'RSS two',
      description: 'body 2',
      publishedAt: '2024-07-16T12:00:00.000Z',
    },
  ])
  const atomStub: AnyArticleFetcher = makeStubFetcher([
    {
      id: 'atom-1',
      url: 'https://example.com/atom/1',
      title: 'Atom one',
      description: 'a body',
      publishedAt: '2024-07-16T10:00:00.000Z',
    },
  ])
  stubRssFetcher = rssStub as never
  stubAtomFetcher = atomStub as never
  stubOpenMeteoFetcher = new WeatherFetcherStub()
  job = new NewsFetchJob({
    store,
    rssFetcher: stubRssFetcher,
    atomFetcher: stubAtomFetcher,
    openMeteoFetcher: stubOpenMeteoFetcher as never,
    nowMs: () => now,
  })
})

afterEach(() => {
  db.close()
})

/**
 * Build a fake `NewsRssFetcher`-shaped object whose fetch()
 * returns the given articles. We use this in tests because
 * the real fetchers' constructors take an `httpFetcher` —
 * but the job only ever calls `.fetch(url)`, so a thin
 * duck-typed stub is enough.
 */
function makeStubFetcher(items: RawArticle[]): {
  fetch: (url: string) => Promise<RawArticle[]>
} {
  return {
    fetch: async (_url: string) => items,
  }
}

/** A fetcher that throws. Used to exercise the failure path. */
function makeThrowingFetcher(message: string): {
  fetch: (url: string) => Promise<RawArticle[]>
} {
  return {
    fetch: async () => {
      throw new FetchError(message, 'network')
    },
  }
}

/** A fetcher that returns an empty list. */
function makeEmptyFetcher(): {
  fetch: (url: string) => Promise<RawArticle[]>
} {
  return {
    fetch: async () => [],
  }
}

function insertSource(fields: Partial<{
  name: string
  category: string
  type: string
  url: string
  enabled: number
  refresh_interval_min: number
}> = {}): Source {
  const r = db.run(
    `INSERT INTO news_sources
       (name, category, type, url, enabled, refresh_interval_min, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.name ?? 'Test',
      fields.category ?? 'General',
      fields.type ?? 'rss',
      fields.url ?? 'https://example.com/feed.xml',
      fields.enabled ?? 1,
      fields.refresh_interval_min ?? 30,
      '2024-07-16T12:00:00.000Z',
    ],
  )
  return {
    id: Number(r.lastInsertRowid),
    name: fields.name ?? 'Test',
    category: fields.category ?? 'General',
    type: (fields.type ?? 'rss') as Source['type'],
    url: fields.url ?? 'https://example.com/feed.xml',
    enabled: (fields.enabled ?? 1) === 1,
    refreshIntervalMin: fields.refresh_interval_min ?? 30,
    lastFetchedAt: null,
    lastSuccessfulFetchAt: null,
    lastError: null,
    createdAt: '2024-07-16T12:00:00.000Z',
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('NewsFetchJob', () => {
  describe('happy path', () => {
    it('dispatches RSS → fetcher, normalizes, inserts; returns { ok, inserted }', async () => {
      const source = insertSource({ type: 'rss' })
      const out = await job.run(source)
      expect(out).toEqual({ ok: true, inserted: 2 })
      const rows = db.all<{ id: string }>(
        'SELECT id FROM news_articles WHERE source_id = ?',
        [source.id],
      )
      expect(rows.map((r) => r.id).sort()).toEqual(['rss-1', 'rss-2'])
    })

    it('dispatches Atom → fetcher, normalizes, inserts', async () => {
      const source = insertSource({ type: 'atom' })
      const out = await job.run(source)
      expect(out).toEqual({ ok: true, inserted: 1 })
    })

    it('dispatches json_api → weather fetcher, upserts snapshot, returns ok: true', async () => {
      const source = insertSource({ type: 'json_api', category: 'Weather' })
      const out = await job.run(source)
      expect(out.ok).toBe(true)
      // `inserted` is 0 on the weather path — the row was
      // either new or replaced; the job doesn't surface a
      // count for that.
      expect('inserted' in out ? out.inserted : 0).toBe(0)
      const snap = store.getWeatherSnapshot(source.id)
      expect(snap?.current.temperature_2m).toBe(20)
    })

    it('updates lastFetchedAt and lastSuccessfulFetchAt on success', async () => {
      const source = insertSource({ type: 'rss' })
      await job.run(source)
      const after = store.listEnabledSources().find((s) => s.id === source.id)!
      expect(after.lastFetchedAt).toBe('2024-07-16T12:00:00.000Z')
      expect(after.lastSuccessfulFetchAt).toBe('2024-07-16T12:00:00.000Z')
      expect(after.lastError).toBeNull()
    })
  })

  describe('empty result', () => {
    it('returns { ok: true, inserted: 0 } when the fetcher returns []', async () => {
      const stub = makeEmptyFetcher() as never
      const j = new NewsFetchJob({
        store,
        rssFetcher: stub,
        atomFetcher: stub,
        openMeteoFetcher: stubOpenMeteoFetcher as never,
        nowMs: () => now,
      })
      const source = insertSource({ type: 'rss' })
      const out = await j.run(source)
      expect(out).toEqual({ ok: true, inserted: 0 })
    })
  })

  describe('failure paths', () => {
    it('returns { ok: false, error } when the fetcher throws', async () => {
      const stub = makeThrowingFetcher('boom: connection reset') as never
      const j = new NewsFetchJob({
        store,
        rssFetcher: stub,
        atomFetcher: stub,
        openMeteoFetcher: stubOpenMeteoFetcher as never,
        nowMs: () => now,
      })
      const source = insertSource({ type: 'rss' })
      const out = await j.run(source)
      expect(out.ok).toBe(false)
      if (!out.ok) {
        expect(out.error).toContain('boom: connection reset')
      }
    })

    it('updates lastError on the source row when the fetcher throws', async () => {
      const stub = makeThrowingFetcher('404 not found') as never
      const j = new NewsFetchJob({
        store,
        rssFetcher: stub,
        atomFetcher: stub,
        openMeteoFetcher: stubOpenMeteoFetcher as never,
        nowMs: () => now,
      })
      const source = insertSource({ type: 'rss' })
      await j.run(source)
      const after = store.listEnabledSources().find((s) => s.id === source.id)!
      expect(after.lastError).toContain('404 not found')
    })

    it('updates lastFetchedAt even on failure (the due-check reflects "we tried")', async () => {
      const stub = makeThrowingFetcher('timeout') as never
      const j = new NewsFetchJob({
        store,
        rssFetcher: stub,
        atomFetcher: stub,
        openMeteoFetcher: stubOpenMeteoFetcher as never,
        nowMs: () => now,
      })
      const source = insertSource({ type: 'rss' })
      await j.run(source)
      const after = store.listEnabledSources().find((s) => s.id === source.id)!
      expect(after.lastFetchedAt).toBe('2024-07-16T12:00:00.000Z')
    })

    it('returns { ok: false, error } for an unknown source type', async () => {
      const source = insertSource({ type: 'rss' })
      // Force a bad type via a manual UPDATE — the type
      // discriminator has no CHECK constraint, so this is
      // how a real "misconfigured row" would look.
      db.run(`UPDATE news_sources SET type = 'magic' WHERE id = ?`, [source.id])
      const corrupted: Source = { ...source, type: 'magic' as Source['type'] }
      const out = await job.run(corrupted)
      expect(out.ok).toBe(false)
      if (!out.ok) {
        expect(out.error).toContain('unsupported source type')
      }
    })

    it('never throws — even when the store update itself fails', async () => {
      // Drop the news_sources table to force store.updateSourceState to throw.
      db.exec('DROP TABLE news_sources')
      const stub = makeStubFetcher([]) as never
      const j = new NewsFetchJob({
        store,
        rssFetcher: stub,
        atomFetcher: stub,
        openMeteoFetcher: stubOpenMeteoFetcher as never,
        nowMs: () => now,
      })
      const source: Source = {
        id: 999,
        name: 'X',
        category: 'General',
        type: 'rss',
        url: 'https://example.com',
        enabled: true,
        refreshIntervalMin: 30,
        lastFetchedAt: null,
        lastSuccessfulFetchAt: null,
        lastError: null,
        createdAt: '2024-07-16T12:00:00.000Z',
      }
      // The fetcher returns [] so the "happy empty" path
      // runs, but the post-success state update on the
      // dropped table will throw. The job must still return
      // a result rather than crashing the test runner.
      const out = await j.run(source)
      expect(out.ok).toBe(false)
    })
  })

  describe('normalizer integration', () => {
    it('drops items where both id and url are missing (returns null)', async () => {
      // Two items: one good, one with no id and no url.
      const stub = makeStubFetcher([
        {
          id: 'good',
          url: 'https://example.com/good',
          title: 'Good',
          description: '',
          publishedAt: '2024-07-16T12:00:00.000Z',
        },
        {
          id: '',
          url: '',
          title: 'Bad',
          description: '',
          publishedAt: '2024-07-16T12:00:00.000Z',
        },
      ]) as never
      const j = new NewsFetchJob({
        store,
        rssFetcher: stub,
        atomFetcher: stub,
        openMeteoFetcher: stubOpenMeteoFetcher as never,
        nowMs: () => now,
      })
      const source = insertSource({ type: 'rss' })
      const out = await j.run(source)
      // One row inserted, the bad one dropped by the
      // normalizer.
      expect(out).toEqual({ ok: true, inserted: 1 })
    })
  })
})
