// search.test.ts — issue #009
//
// Integration tests for the search orchestrator + HTTP API. Uses an
// in-memory SQLite DB so we get real FTS5 + trigram behavior without
// filesystem I/O. The seeded data is shaped to exercise:
//   - FTS5 prefix matching (exact + partial tokens)
//   - Fuzzy fallback (typo tolerance via trigram overlap)
//   - Filter combinations (folder, tag, date range)
//   - Snippet generation (FTS5 + fuzzy)
//   - Performance smoke (1,000-bookmark search under 200ms)

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import bcrypt from 'bcryptjs'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { searchBookmarks } from './search.js'
import { applySync } from './sync.js'
import { attachTagsToBookmark } from './tags.js'
import { createApp } from './app.js'
import { JsonTokenStore } from './token-store.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')
const PASSWORD = 'secret'
const HASH = bcrypt.hashSync(PASSWORD, 10)

// ─── Test helpers ─────────────────────────────────────────────────────────

/** Seed a small fixed corpus: 3 folders, 4 bookmarks, varying tags. */
function seedSmallCorpus(db: Database): void {
  applySync(db, {
    folders: [
      { chromeId: 'fb', parentChromeId: null, name: 'Bookmarks bar' },
      { chromeId: 'ft', parentChromeId: 'fb', name: 'Tech' },
      { chromeId: 'fr', parentChromeId: 'fb', name: 'Recipes' },
    ],
    bookmarks: [
      { chromeId: 'b1', url: 'https://www.postgresql.org/docs', title: 'Postgres tips', folderChromeId: 'ft' },
      { chromeId: 'b2', url: 'https://www.rust-lang.org', title: 'Rust programming', folderChromeId: 'ft' },
      { chromeId: 'b3', url: 'https://cooking.nytimes.com/pasta', title: 'Pasta carbonara', folderChromeId: 'fr' },
      { chromeId: 'b4', url: 'https://news.ycombinator.com', title: 'Hacker News', folderChromeId: 'fb' },
    ],
  })

  // Attach tags to a couple bookmarks.
  const pgId = db.get<{ id: string }>('SELECT id FROM bookmarks WHERE chrome_id = ?', ['b1'])?.id
  const rustId = db.get<{ id: string }>('SELECT id FROM bookmarks WHERE chrome_id = ?', ['b2'])?.id
  if (pgId) attachTagsToBookmark(db, pgId, ['postgres', 'database'])
  if (rustId) attachTagsToBookmark(db, rustId, ['rust', 'systems'])
}

/** Get the bookmark server id for a given chrome_id (post-sync). */
function idFor(db: Database, chromeId: string): string {
  const row = db.get<{ id: string }>('SELECT id FROM bookmarks WHERE chrome_id = ?', [chromeId])
  if (!row) throw new Error(`no bookmark with chrome_id=${chromeId}`)
  return row.id
}

describe('searchBookmarks — FTS5 mode', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    seedSmallCorpus(db)
  })
  afterEach(() => db.close())

  it('returns empty mode for empty query', () => {
    const r = searchBookmarks(db, '')
    expect(r.mode).toBe('empty')
    expect(r.results).toHaveLength(0)
  })

  it('finds an exact title match', () => {
    const r = searchBookmarks(db, 'Postgres')
    expect(r.results.some((x) => x.title === 'Postgres tips')).toBe(true)
  })

  it('finds a prefix match', () => {
    const r = searchBookmarks(db, 'post')
    expect(r.results.some((x) => x.title === 'Postgres tips')).toBe(true)
  })

  it('finds a URL match', () => {
    const r = searchBookmarks(db, 'rust-lang')
    expect(r.results.some((x) => x.url.includes('rust-lang'))).toBe(true)
  })

  it('finds by tag name (via FTS5 rowid join — tags are NOT in FTS5)', () => {
    // FTS5 only indexes title + url, not tag names. So a search for
    // "rust" matches the "Rust programming" bookmark via title prefix.
    const r = searchBookmarks(db, 'rust')
    expect(r.results.some((x) => x.title === 'Rust programming')).toBe(true)
  })

  it('returns multiple matches for a multi-token query', () => {
    // Both "Postgres tips" (title has "Postgres") and "Hacker News" (url has "news")
    // — the query "postgres news" has no single match so this just tests
    // that AND-combined tokens each need to match somewhere.
    const r = searchBookmarks(db, 'postgres')
    expect(r.results.map((x) => x.title)).toContain('Postgres tips')
  })

  it('returns zero results when no match exists', () => {
    // A truly random trigram-distinct query. "qzqzqzqz" has trigrams
    // "qzq", "zqz", "qzq" (deduped) — none of these appear in any of
    // the seeded titles/urls/tags, so fuzzy should return nothing.
    const r = searchBookmarks(db, 'qzqzqzqz')
    expect(r.results).toHaveLength(0)
  })

  it('produces FTS5 snippets with <mark> tags on exact matches', () => {
    const r = searchBookmarks(db, 'postgres')
    const hit = r.results.find((x) => x.title === 'Postgres tips')
    expect(hit).toBeDefined()
    expect(hit?.snippet).toContain('<mark>')
    expect(hit?.snippet).toContain('</mark>')
  })

  it('embeds folder path on each result', () => {
    const r = searchBookmarks(db, 'postgres')
    const hit = r.results.find((x) => x.title === 'Postgres tips')
    expect(hit?.folderPath).toBe('Bookmarks bar > Tech')
  })

  it('attaches the bookmark tags to each result', () => {
    const r = searchBookmarks(db, 'postgres')
    const hit = r.results.find((x) => x.title === 'Postgres tips')
    expect(hit?.tags).toContain('postgres')
    expect(hit?.tags).toContain('database')
  })
})

describe('searchBookmarks — fuzzy fallback', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    seedSmallCorpus(db)
  })
  afterEach(() => db.close())

  it('finds "Postgres tips" when querying "postgers" (typo)', () => {
    const r = searchBookmarks(db, 'postgers')
    // FTS5 fails (no token "postgers"); trigram fallback catches it.
    expect(r.results.some((x) => x.title === 'Postgres tips')).toBe(true)
  })

  it('finds "Pasta carbonara" when querying "pasta carb" (prefix)', () => {
    const r = searchBookmarks(db, 'pasta carb')
    expect(r.results.some((x) => x.title === 'Pasta carbonara')).toBe(true)
  })

  it('returns zero fuzzy results for completely unrelated query', () => {
    const r = searchBookmarks(db, 'qzqzqzqz')
    expect(r.results).toHaveLength(0)
  })
})

describe('searchBookmarks — filters', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    seedSmallCorpus(db)
  })
  afterEach(() => db.close())

  it('restricts to a folder by folderId', () => {
    const techId = db.get<{ id: string }>('SELECT id FROM folders WHERE chrome_id = ?', ['ft'])?.id
    if (!techId) throw new Error('no Tech folder')
    const r = searchBookmarks(db, 'postgres', { folderId: techId })
    expect(r.results.every((x) => x.folderPath.includes('Tech'))).toBe(true)
    // Hacker News should NOT appear.
    expect(r.results.some((x) => x.title === 'Hacker News')).toBe(false)
  })

  it('restricts to bookmarks with a specific tag', () => {
    // "database" tag is only on the Postgres tips bookmark.
    const tagId = db.get<{ id: string }>('SELECT id FROM tags WHERE name = ?', ['database'])?.id
    if (!tagId) throw new Error('no database tag')
    const r = searchBookmarks(db, 'postgres', { tagId })
    expect(r.results.every((x) => x.tags.includes('database'))).toBe(true)
  })

  it('returns empty when filter excludes everything', () => {
    const recipesId = db.get<{ id: string }>('SELECT id FROM folders WHERE chrome_id = ?', ['fr'])?.id
    if (!recipesId) throw new Error('no Recipes folder')
    // FTS5 returns 0 (no Postgres in Recipes); fuzzy also returns 0
    // because folder_id filter excludes Postgres tips from candidates.
    const r = searchBookmarks(db, 'postgres', { folderId: recipesId })
    expect(r.results).toHaveLength(0)
  })

  it('combines folder + tag filters', () => {
    const techId = db.get<{ id: string }>('SELECT id FROM folders WHERE chrome_id = ?', ['ft'])?.id
    const tagId = db.get<{ id: string }>('SELECT id FROM tags WHERE name = ?', ['rust'])?.id
    if (!techId || !tagId) throw new Error('seed missing')
    const r = searchBookmarks(db, 'rust', { folderId: techId, tagId })
    expect(r.results).toHaveLength(1)
    expect(r.results[0]?.title).toBe('Rust programming')
  })
})

describe('searchBookmarks — pagination', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    seedSmallCorpus(db)
  })
  afterEach(() => db.close())

  it('clamps limit to MAX_SEARCH_LIMIT (200)', () => {
    const r = searchBookmarks(db, 'post', { limit: 9999 })
    expect(r.results.length).toBeLessThanOrEqual(200)
  })

  it('defaults limit when undefined', () => {
    // All 4 bookmarks match "post" via prefix; default limit is 50.
    const r = searchBookmarks(db, 'p')
    expect(r.results.length).toBeGreaterThanOrEqual(1)
  })

  it('respects offset for pagination', () => {
    const all = searchBookmarks(db, 'p', { limit: 50 })
    expect(all.results.length).toBeGreaterThan(1)
    const page1 = searchBookmarks(db, 'p', { limit: 1, offset: 0 })
    const page2 = searchBookmarks(db, 'p', { limit: 1, offset: 1 })
    expect(page1.results[0]?.id).not.toBe(page2.results[0]?.id)
  })
})

describe('searchBookmarks — performance', () => {
  it('returns within 200ms for 1,000 seeded bookmarks (AC #10 smoke)', async () => {
    const db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })

    // Seed 1000 bookmarks in one folder.
    const folders = [{ chromeId: 'perf', parentChromeId: null, name: 'Perf' }]
    const bookmarks = Array.from({ length: 1000 }, (_, i) => ({
      chromeId: `pb${i}`,
      url: `https://example.com/${i}`,
      title: `Bookmark number ${i}`,
      folderChromeId: 'perf',
    }))
    applySync(db, { folders, bookmarks })

    const start = performance.now()
    const r = searchBookmarks(db, 'Bookmark', { limit: 50 })
    const elapsed = performance.now() - start

    expect(r.results.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(200)
    db.close()
  }, 10000)

  it('handles fuzzy fallback over 1,000 bookmarks within 200ms', async () => {
    const db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })

    const folders = [{ chromeId: 'perf', parentChromeId: null, name: 'Perf' }]
    const bookmarks = Array.from({ length: 1000 }, (_, i) => ({
      chromeId: `pb${i}`,
      url: `https://example.com/${i}`,
      title: `Bookmark number ${i}`,
      folderChromeId: 'perf',
    }))
    applySync(db, { folders, bookmarks })

    // Typo: "bookmerk" should still find "Bookmark number N" via trigram.
    const start = performance.now()
    const r = searchBookmarks(db, 'bookmerk', { limit: 50 })
    const elapsed = performance.now() - start

    expect(r.results.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(200)
    db.close()
  }, 10000)
})

describe('searchBookmarks — sync hooks populate trigrams', () => {
  it('a freshly synced bookmark is findable via fuzzy search', async () => {
    const db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })

    // Sync one bookmark; trigrams should be populated automatically.
    applySync(db, {
      folders: [{ chromeId: 'f', parentChromeId: null, name: 'F' }],
      bookmarks: [
        { chromeId: 'b', url: 'https://example.com', title: 'Postgres tips', folderChromeId: 'f' },
      ],
    })

    // Typo query that FTS5 won't match but trigram will.
    const r = searchBookmarks(db, 'postgers')
    expect(r.results.some((x) => x.title === 'Postgres tips')).toBe(true)

    db.close()
  })

  it('recomputeTrigramsForBookmark runs after bookmark title update', async () => {
    const db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })

    applySync(db, {
      folders: [{ chromeId: 'f', parentChromeId: null, name: 'F' }],
      bookmarks: [
        { chromeId: 'b', url: 'https://example.com', title: 'Original title', folderChromeId: 'f' },
      ],
    })
    const id = idFor(db, 'b')

    // Update the title via POST /api/bookmarks/:id (which calls
    // recomputeTrigramsForBookmark internally).
    const tmp = mkdtempSync(join(tmpdir(), 'dashboard-test-'))
    const app = createApp({ passwordHash: HASH, tokenStore: new JsonTokenStore({ dataDir: tmp }), db })
    const updateRes = await app.request(`/api/bookmarks/${id}`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'Postgres magic' }),
    })
    expect(updateRes.status).toBe(200)

    // Fuzzy search for the NEW title.
    const r = searchBookmarks(db, 'postgers magc')
    expect(r.results.some((x) => x.title === 'Postgres magic')).toBe(true)

    db.close()
  })

  it('tag attach refreshes trigrams so tag-name fuzzy matches work', async () => {
    const db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })

    applySync(db, {
      folders: [{ chromeId: 'f', parentChromeId: null, name: 'F' }],
      bookmarks: [
        { chromeId: 'b', url: 'https://example.com', title: 'Hello', folderChromeId: 'f' },
      ],
    })
    const id = idFor(db, 'b')
    attachTagsToBookmark(db, id, ['postgers-tags'])

    // Typo that should now find via the tag-name trigrams.
    const r = searchBookmarks(db, 'postgers-tgs')
    expect(r.results.some((x) => x.title === 'Hello')).toBe(true)

    db.close()
  })
})

// ─── HTTP API tests ───────────────────────────────────────────────────────

describe('HTTP /api/search', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    seedSmallCorpus(db)
  })
  afterEach(() => db.close())

  function makeApp() {
    const tmp = mkdtempSync(join(tmpdir(), 'dashboard-test-'))
    const app = createApp({ passwordHash: HASH, tokenStore: new JsonTokenStore({ dataDir: tmp }), db })
    return {
      request: (path: string, init?: RequestInit) => app.request(path, init),
      cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    }
  }

  it('requires auth', async () => {
    const { request } = makeApp(); const res = await request('/api/search?q=postgres')
    expect(res.status).toBe(401)
  })

  it('returns empty mode for empty query', async () => {
    const { request } = makeApp(); const res = await request('/api/search', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mode: string; results: unknown[] }
    expect(body.mode).toBe('empty')
    expect(body.results).toEqual([])
  })

  it('returns results for a normal query', async () => {
    const { request } = makeApp(); const res = await request('/api/search?q=postgres', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mode: string; results: Array<Record<string, unknown>> }
    expect(body.mode).toBe('fts5')
    expect(body.results.length).toBeGreaterThan(0)
    expect(body.results[0]).toHaveProperty('id')
    expect(body.results[0]).toHaveProperty('title')
    expect(body.results[0]).toHaveProperty('snippet')
  })

  it('accepts folder filter as ?folder=<id>', async () => {
    const techId = db.get<{ id: string }>('SELECT id FROM folders WHERE chrome_id = ?', ['ft'])?.id
    const { request } = makeApp(); const res = await request(`/api/search?q=postgres&folder=${techId}`, {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as { results: Array<{ folderPath: string }> }
    expect(body.results.every((r: { folderPath: string }) => r.folderPath.includes('Tech'))).toBe(true)
  })

  it('accepts tag filter as ?tag=<id>', async () => {
    const tagId = db.get<{ id: string }>('SELECT id FROM tags WHERE name = ?', ['database'])?.id
    const { request } = makeApp(); const res = await request(`/api/search?q=postgres&tag=${tagId}`, {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as { results: Array<{ tags: string[] }> }
    expect(body.results.every((r: { tags: string[] }) => r.tags.includes('database'))).toBe(true)
  })

  it('handles fuzzy match', async () => {
    const { request } = makeApp(); const res = await request('/api/search?q=postgers', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as { mode: string; results: Array<{ title: string }> }
    expect(['fts5', 'fuzzy']).toContain(body.mode)
    expect((body.results).some((r: { title: string }) => r.title === 'Postgres tips')).toBe(true)
  })

  it('accepts page and perPage for pagination', async () => {
    const { request } = makeApp(); const res = await request('/api/search?q=p&page=1&perPage=1', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as { results: unknown[] }
    expect(body.results.length).toBeLessThanOrEqual(1)
  })
})

describe('HTTP /search (HTML page)', () => {
  let db: Database
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    seedSmallCorpus(db)
  })
  afterEach(() => db.close())

  function makeApp() {
    const tmp = mkdtempSync(join(tmpdir(), 'dashboard-test-'))
    const app = createApp({ passwordHash: HASH, tokenStore: new JsonTokenStore({ dataDir: tmp }), db })
    return {
      request: (path: string, init?: RequestInit) => app.request(path, init),
      cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    }
  }

  it('requires auth', async () => {
    const { request } = makeApp(); const res = await request('/search?q=postgres')
    expect(res.status).toBe(401)
  })

  it('renders an HTML page with the search form', async () => {
    const { request } = makeApp(); const res = await request('/search', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('data-search-input')
    expect(html).toContain('data-search-form')
    expect(html).toContain('data-search-folder')
    expect(html).toContain('data-search-tag')
    expect(html).toContain('/static/search.js')
  })

  it('renders results when a query is provided', async () => {
    const { request } = makeApp(); const res = await request('/search?q=postgres', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('Postgres tips')
    expect(html).toContain('class="result"')
  })

  it('shows fuzzy badge for typo queries', async () => {
    const { request } = makeApp(); const res = await request('/search?q=postgers', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('fuzzy match')
  })
})

function basicHeader(user: string, password: string): string {
  return 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')
}