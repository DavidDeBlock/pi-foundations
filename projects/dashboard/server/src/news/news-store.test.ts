// news/news-store.test.ts — issue NW-002
//
// Unit tests for the typed DB wrapper. Uses an in-memory
// SQLite via the project's `Database` class; the migration
// runner applies `025_news.sql` so the schema is real.
//
// Coverage map (per AC):
//   * `listEnabledSources` returns only enabled rows
//   * `listDueSources` due-check math: never-fetched, fresh,
//     and stale sources
//   * `updateSourceState` updates one or more fields
//   * `insertArticles` INSERT OR IGNORE on duplicate (source_id, id)
//   * `listArticlesByCategory` newest first, NULLS LAST
//   * `upsertWeatherSnapshot` REPLACE on PK conflict
//   * `getWeatherSnapshot` returns null when none exists

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Database } from '../db.js'
import { runMigrations } from '../migrations.js'
import { resolve } from 'node:path'
import { NewsStore } from './news-store.js'
import type {
  NormalizedArticle,
  Source,
  WeatherSnapshot,
} from './types.js'

// ─── Setup helpers ────────────────────────────────────────────────────────

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../migrations')

let db: Database
let store: NewsStore

beforeEach(async () => {
  db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  // Wipe the seed sources from 025_news.sql — these tests
  // exercise the store against a controlled fixture set,
  // not the production seed.
  db.run('DELETE FROM news_sources')
  store = new NewsStore(db)
})

afterEach(() => {
  db.close()
})

/** Insert one source row with controlled fields; returns the id. */
function insertSource(
  fields: Partial<{
    name: string
    category: string
    type: string
    url: string
    enabled: number
    refresh_interval_min: number
    last_fetched_at: string | null
    last_successful_fetch_at: string | null
    last_error: string | null
  }> = {},
): number {
  const now = '2024-07-16T12:00:00.000Z'
  const r = db.run(
    `INSERT INTO news_sources
       (name, category, type, url, enabled, refresh_interval_min,
        last_fetched_at, last_successful_fetch_at, last_error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.name ?? 'Test source',
      fields.category ?? 'General',
      fields.type ?? 'rss',
      fields.url ?? `https://example.com/${Math.random()}`,
      fields.enabled ?? 1,
      fields.refresh_interval_min ?? 30,
      fields.last_fetched_at ?? null,
      fields.last_successful_fetch_at ?? null,
      fields.last_error ?? null,
      now,
    ],
  )
  return Number(r.lastInsertRowid)
}

function makeArticle(overrides: Partial<NormalizedArticle> = {}): NormalizedArticle {
  return {
    id: overrides.id ?? 'https://example.com/posts/1',
    title: overrides.title ?? 'A headline',
    description: overrides.description ?? 'Body',
    url: overrides.url ?? 'https://example.com/posts/1',
    publishedAt: overrides.publishedAt ?? '2024-07-16T12:00:00.000Z',
  }
}

function makeSnapshot(): WeatherSnapshot {
  return {
    fetchedAt: '2024-07-16T12:00:00.000Z',
    current: { temperature_2m: 20 },
    daily: [{ time: '2024-07-16', temperature_2m_max: 22 }],
    hourly: [{ time: '2024-07-16T12:00', temperature_2m: 20 }],
  }
}

// ─── listEnabledSources ───────────────────────────────────────────────────

describe('NewsStore.listEnabledSources', () => {
  it('returns only enabled=1 sources, ordered by id', () => {
    insertSource({ name: 'A', enabled: 1 })
    insertSource({ name: 'B', enabled: 0 })
    insertSource({ name: 'C', enabled: 1 })
    const out = store.listEnabledSources()
    expect(out.map((s: Source) => s.name)).toEqual(['A', 'C'])
  })

  it('maps the row shape to the typed Source view', () => {
    insertSource({
      name: 'VRT',
      category: 'General',
      type: 'rss',
      url: 'https://vrt.example/rss',
      enabled: 1,
      refresh_interval_min: 30,
    })
    const out = store.listEnabledSources()
    expect(out[0]).toMatchObject({
      name: 'VRT',
      category: 'General',
      type: 'rss',
      url: 'https://vrt.example/rss',
      enabled: true,
      refreshIntervalMin: 30,
    })
  })
})

// ─── listDueSources ───────────────────────────────────────────────────────

describe('NewsStore.listDueSources', () => {
  it('includes sources with last_fetched_at IS NULL', () => {
    insertSource({ name: 'Never polled', last_fetched_at: null })
    const out = store.listDueSources(new Date('2024-07-16T12:00:00Z'))
    expect(out.map((s: Source) => s.name)).toEqual(['Never polled'])
  })

  it('excludes sources polled within their interval', () => {
    // Polled 5 min ago, interval 30 min → not due.
    insertSource({
      name: 'Fresh',
      last_fetched_at: '2024-07-16T11:55:00.000Z',
      refresh_interval_min: 30,
    })
    const out = store.listDueSources(new Date('2024-07-16T12:00:00Z'))
    expect(out).toEqual([])
  })

  it('includes sources polled past their interval', () => {
    // Polled 60 min ago, interval 30 min → due.
    insertSource({
      name: 'Stale',
      last_fetched_at: '2024-07-16T11:00:00.000Z',
      refresh_interval_min: 30,
    })
    const out = store.listDueSources(new Date('2024-07-16T12:00:00Z'))
    expect(out.map((s: Source) => s.name)).toEqual(['Stale'])
  })

  it('skips disabled sources regardless of staleness', () => {
    insertSource({
      name: 'Disabled',
      enabled: 0,
      last_fetched_at: '2024-01-01T00:00:00.000Z',
    })
    const out = store.listDueSources(new Date('2024-07-16T12:00:00Z'))
    expect(out).toEqual([])
  })

  it('uses a mocked now to drive the due-check deterministically', () => {
    insertSource({
      name: 'Boundary',
      last_fetched_at: '2024-07-16T11:30:00.000Z',
      refresh_interval_min: 30,
    })
    // Exactly 30 min after last_fetched_at → not due
    // (the AC says <, not ≤). Using a `now` slightly before
    // proves the boundary is strict.
    const notDue = store.listDueSources(new Date('2024-07-16T12:00:00.000Z'))
    expect(notDue).toEqual([])
    // One second past the boundary → due.
    const due = store.listDueSources(new Date('2024-07-16T12:00:01.000Z'))
    expect(due.map((s: Source) => s.name)).toEqual(['Boundary'])
  })
})

// ─── updateSourceState ────────────────────────────────────────────────────

describe('NewsStore.updateSourceState', () => {
  it('updates only the fields provided', () => {
    const id = insertSource({ name: 'X' })
    store.updateSourceState(id, { lastError: 'boom' })
    const out = store.listEnabledSources().find((s: Source) => s.id === id)!
    expect(out.lastError).toBe('boom')
    expect(out.lastFetchedAt).toBeNull()
  })

  it('clears lastError when set to null (vs. undefined = no-op)', () => {
    const id = insertSource({ name: 'X', last_error: 'prior error' })
    store.updateSourceState(id, { lastError: null })
    const out = store.listEnabledSources().find((s: Source) => s.id === id)!
    expect(out.lastError).toBeNull()
  })

  it('is a no-op when given an empty update', () => {
    const id = insertSource({ name: 'X' })
    store.updateSourceState(id, {})
    // Doesn't throw; the row is unchanged.
    const out = store.listEnabledSources().find((s: Source) => s.id === id)!
    expect(out.name).toBe('X')
  })
})

// ─── insertArticles ───────────────────────────────────────────────────────

describe('NewsStore.insertArticles', () => {
  it('inserts a fresh batch and returns the count', () => {
    const id = insertSource({ name: 'X' })
    const out = store.insertArticles(id, [
      makeArticle({ id: 'a' }),
      makeArticle({ id: 'b' }),
      makeArticle({ id: 'c' }),
    ])
    expect(out.inserted).toBe(3)
  })

  it('skips duplicates by (source_id, id) on the second batch', () => {
    const id = insertSource({ name: 'X' })
    // First batch: 3 articles, all new.
    const first = store.insertArticles(id, [
      makeArticle({ id: 'a' }),
      makeArticle({ id: 'b' }),
      makeArticle({ id: 'c' }),
    ])
    expect(first.inserted).toBe(3)
    // Second batch: overlap on a + b, plus a new d.
    const second = store.insertArticles(id, [
      makeArticle({ id: 'a' }),
      makeArticle({ id: 'b' }),
      makeArticle({ id: 'd' }),
    ])
    // Two duplicates silently skipped, one new row inserted.
    expect(second.inserted).toBe(1)
    // Total in DB: 4 unique rows.
    const all = db.all<{ id: string }>(
      'SELECT id FROM news_articles WHERE source_id = ?',
      [id],
    )
    expect(all.map((r) => r.id).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('treats the same id in two different sources as distinct', () => {
    const a = insertSource({ name: 'A' })
    const b = insertSource({ name: 'B' })
    store.insertArticles(a, [makeArticle({ id: 'shared' })])
    const out = store.insertArticles(b, [makeArticle({ id: 'shared' })])
    expect(out.inserted).toBe(1)
  })

  it('handles an empty batch as a no-op returning { inserted: 0 }', () => {
    const id = insertSource({ name: 'X' })
    expect(store.insertArticles(id, [])).toEqual({ inserted: 0 })
  })

  it('stores null published_at when the article has no publishedAt', () => {
    const id = insertSource({ name: 'X' })
    // Build the article directly (not via makeArticle) so the
    // publishedAt field is genuinely undefined, not the
    // makeArticle helper's default.
    const article: NormalizedArticle = {
      id: 'a',
      title: 'T',
      description: '',
      url: 'https://example.com/a',
      publishedAt: undefined,
    }
    store.insertArticles(id, [article])
    const row = db.get<{ published_at: string | null }>(
      'SELECT published_at FROM news_articles WHERE source_id = ?',
      [id],
    )
    expect(row?.published_at).toBeNull()
  })
})

// ─── listArticlesByCategory ───────────────────────────────────────────────

describe('NewsStore.listArticlesByCategory', () => {
  it('joins on source.category and orders newest first (NULLS LAST)', () => {
    const gen = insertSource({ name: 'Gen', category: 'General' })
    const eco = insertSource({ name: 'Eco', category: 'Economy' })
    // g3 has no publishedAt — build it directly so the
    // makeArticle default doesn't fill in a date.
    const g3: NormalizedArticle = {
      id: 'g3',
      title: 'g3',
      description: '',
      url: 'https://example.com/g3',
      publishedAt: undefined,
    }
    store.insertArticles(gen, [
      makeArticle({ id: 'g1', publishedAt: '2024-07-15T00:00:00.000Z' }),
      makeArticle({ id: 'g2', publishedAt: '2024-07-16T00:00:00.000Z' }),
      g3,
    ])
    store.insertArticles(eco, [
      makeArticle({ id: 'e1', publishedAt: '2024-07-16T01:00:00.000Z' }),
    ])
    const out = store.listArticlesByCategory('General', 10)
    // Expected order: g2 (Jul 16), g1 (Jul 15), g3 (NULL, last).
    expect(out.map((a) => a.id)).toEqual(['g2', 'g1', 'g3'])
  })

  it('respects the limit parameter', () => {
    const gen = insertSource({ name: 'Gen', category: 'General' })
    const many = Array.from({ length: 25 }, (_, i) =>
      makeArticle({ id: `a${i}`, publishedAt: `2024-07-${(i + 1).toString().padStart(2, '0')}T00:00:00.000Z` }),
    )
    store.insertArticles(gen, many)
    const out = store.listArticlesByCategory('General', 10)
    expect(out).toHaveLength(10)
  })

  it('returns [] for an unknown category', () => {
    expect(store.listArticlesByCategory('NoSuchCategory', 10)).toEqual([])
  })
})

// ─── upsertWeatherSnapshot ────────────────────────────────────────────────

describe('NewsStore.upsertWeatherSnapshot', () => {
  it('inserts a fresh snapshot', () => {
    const id = insertSource({ name: 'Wx', type: 'json_api', category: 'Weather' })
    store.upsertWeatherSnapshot(id, makeSnapshot())
    const out = store.getWeatherSnapshot(id)
    expect(out).not.toBeNull()
    expect(out?.current.temperature_2m).toBe(20)
  })

  it('replaces an existing snapshot (REPLACE on PK conflict)', () => {
    const id = insertSource({ name: 'Wx', type: 'json_api', category: 'Weather' })
    const s1 = { ...makeSnapshot(), current: { temperature_2m: 20 } }
    const s2 = { ...makeSnapshot(), current: { temperature_2m: 30 } }
    store.upsertWeatherSnapshot(id, s1)
    store.upsertWeatherSnapshot(id, s2)
    const out = store.getWeatherSnapshot(id)
    expect(out?.current.temperature_2m).toBe(30)
    // One row per source — REPLACE keeps the table bounded.
    const count = db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM weather_snapshots WHERE source_id = ?',
      [id],
    )
    expect(count?.c).toBe(1)
  })
})

// ─── getWeatherSnapshot ───────────────────────────────────────────────────

describe('NewsStore.getWeatherSnapshot', () => {
  it('returns null when no snapshot exists', () => {
    const id = insertSource({ name: 'Wx', type: 'json_api', category: 'Weather' })
    expect(store.getWeatherSnapshot(id)).toBeNull()
  })
})
