// tags.test.ts — issue #008 unit + HTTP tests
//
// Exercises the tag CRUD layer + the /api/tags endpoint against an
// in-memory SQLite. Covers the edge cases that the AC list calls out:
// mixed case, whitespace, dedupe, normalization, idempotency.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import bcrypt from 'bcryptjs'
import { Hono } from 'hono'
import { resolve } from 'node:path'
import { auth, type AuthVariables } from './auth.js'
import { InMemoryTokenStore } from './token-store.js'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { applySync, type SyncInput } from './sync.js'
import {
  listAllTags,
  listAllTagsWithUsage,
  attachTagsToBookmark,
  replaceTagsForBookmark,
  detachTagFromBookmark,
  getTagsForBookmark,
  tagsApi,
} from './tags.js'

const PASSWORD = 'correct horse battery staple'
const HASH = bcrypt.hashSync(PASSWORD, 10)
function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

let db: Database
let tokenStore: InMemoryTokenStore
let app: Hono<{ Variables: AuthVariables }>

beforeEach(async () => {
  db = new Database(':memory:')
  await runMigrations(db, { dir: resolve(process.cwd(), 'migrations') })
  tokenStore = new InMemoryTokenStore()
  app = new Hono<{ Variables: AuthVariables }>()
  app.use('*', auth({ passwordHash: HASH, tokenStore }))
  app.route('/api/tags', tagsApi(db))
})

afterEach(() => {
  db.close()
})

// ─── Fixtures ─────────────────────────────────────────────────────────────

function seedBookmark(): string {
  const input: SyncInput = {
    folders: [
      { chromeId: 'f1', parentChromeId: null, name: 'Bar' },
      { chromeId: 'f2', parentChromeId: 'f1', name: 'Tech' },
    ],
    bookmarks: [
      { chromeId: 'b1', url: 'https://a.com', title: 'A', folderChromeId: 'f2' },
      { chromeId: 'b2', url: 'https://b.com', title: 'B', folderChromeId: 'f2' },
    ],
  }
  applySync(db, input)
  return db.get<{ id: string }>('SELECT id FROM bookmarks WHERE chrome_id = ?', ['b1'])!.id
}

// ─── attachTagsToBookmark ─────────────────────────────────────────────────

describe('attachTagsToBookmark', () => {
  it('normalizes and attaches a single tag', () => {
    const id = seedBookmark()
    const result = attachTagsToBookmark(db, id, ['Postgres'])
    expect(result.map((t) => t.name)).toEqual(['postgres'])
  })

  it('normalizes mixed case + whitespace', () => {
    const id = seedBookmark()
    const result = attachTagsToBookmark(db, id, ['  PostgreSQL  ', 'Database & SQL'])
    expect(result.map((t) => t.name).sort()).toEqual(['database-sql', 'postgresql'])
  })

  it('dedupes case-insensitively within one call', () => {
    const id = seedBookmark()
    const result = attachTagsToBookmark(db, id, ['Postgres', 'POSTGRES', '  postgres '])
    expect(result.map((t) => t.name)).toEqual(['postgres'])
  })

  it('is idempotent: re-running with the same inputs is a no-op', () => {
    const id = seedBookmark()
    attachTagsToBookmark(db, id, ['postgres', 'database'])
    const before = listAllTags(db).map((t) => t.id).sort()
    const result = attachTagsToBookmark(db, id, ['postgres', 'database'])
    const after = listAllTags(db).map((t) => t.id).sort()
    expect(result.map((t) => t.name).sort()).toEqual(['database', 'postgres'])
    expect(after).toEqual(before) // no duplicate tag rows
  })

  it('creates new tag rows for unknown names (and reuses existing for known)', () => {
    const id = seedBookmark()
    attachTagsToBookmark(db, id, ['postgres'])
    const beforeTagCount = listAllTags(db).length

    attachTagsToBookmark(db, id, ['postgres', 'rust'])
    const after = listAllTags(db)
    expect(after.length).toBe(beforeTagCount + 1) // only "rust" is new
    expect(after.map((t) => t.name).sort()).toEqual(['postgres', 'rust'])
  })

  it('skips names that normalize to empty (e.g. "---")', () => {
    const id = seedBookmark()
    const result = attachTagsToBookmark(db, id, ['!!!', '  ', '---', 'postgres'])
    expect(result.map((t) => t.name)).toEqual(['postgres'])
  })

  it('returns the post-state sorted by name', () => {
    const id = seedBookmark()
    const result = attachTagsToBookmark(db, id, ['zebra', 'apple', 'mango'])
    expect(result.map((t) => t.name)).toEqual(['apple', 'mango', 'zebra'])
  })

  it('attaches the same tag to multiple bookmarks without duplicating tag rows', () => {
    const a = seedBookmark()
    const b = db.get<{ id: string }>('SELECT id FROM bookmarks WHERE chrome_id = ?', ['b2'])!.id
    attachTagsToBookmark(db, a, ['shared'])
    attachTagsToBookmark(db, b, ['shared'])
    const all = listAllTags(db)
    expect(all).toHaveLength(1)
    expect(all[0]?.name).toBe('shared')
    // The bookmark_tags rows do exist for each, though.
    const linkCount = db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM bookmark_tags',
    )?.c
    expect(linkCount).toBe(2)
  })
})

// ─── replaceTagsForBookmark ────────────────────────────────────────────────

describe('replaceTagsForBookmark', () => {
  it('removes tags not in the new set and adds new ones', () => {
    const id = seedBookmark()
    attachTagsToBookmark(db, id, ['postgres', 'database', 'old'])
    const result = replaceTagsForBookmark(db, id, ['postgres', 'rust'])
    expect(result.map((t) => t.name).sort()).toEqual(['postgres', 'rust'])
    // 'old' and 'database' are gone from this bookmark.
    expect(getTagsForBookmark(db, id).map((t) => t.name).sort()).toEqual([
      'postgres',
      'rust',
    ])
  })

  it('normalizes the new set (case-insensitive dedupe)', () => {
    const id = seedBookmark()
    const result = replaceTagsForBookmark(db, id, ['Postgres', 'POSTGRES', '  rust  '])
    expect(result.map((t) => t.name).sort()).toEqual(['postgres', 'rust'])
  })

  it('with [] clears all tags on the bookmark', () => {
    const id = seedBookmark()
    attachTagsToBookmark(db, id, ['postgres', 'rust'])
    const result = replaceTagsForBookmark(db, id, [])
    expect(result).toEqual([])
  })

  it('is idempotent for the same final set', () => {
    const id = seedBookmark()
    replaceTagsForBookmark(db, id, ['postgres', 'rust'])
    const before = listAllTags(db).map((t) => t.id).sort()
    const result = replaceTagsForBookmark(db, id, ['postgres', 'rust'])
    const after = listAllTags(db).map((t) => t.id).sort()
    expect(result.map((t) => t.name).sort()).toEqual(['postgres', 'rust'])
    expect(after).toEqual(before)
  })

  it('does not delete tag rows that are still used by other bookmarks', () => {
    const a = seedBookmark()
    const b = db.get<{ id: string }>('SELECT id FROM bookmarks WHERE chrome_id = ?', ['b2'])!.id
    attachTagsToBookmark(db, a, ['shared', 'a-only'])
    attachTagsToBookmark(db, b, ['shared'])

    replaceTagsForBookmark(db, a, ['shared'])
    // 'a-only' is no longer referenced anywhere → still kept around
    // (we don't garbage-collect tags in v1; user might re-tag).
    // (If we add GC later, this assertion can flip.)
    expect(listAllTags(db).map((t) => t.name).sort()).toEqual(['a-only', 'shared'])
  })
})

// ─── detachTagFromBookmark ─────────────────────────────────────────────────

describe('detachTagFromBookmark', () => {
  it('returns true when a link is removed', () => {
    const id = seedBookmark()
    const [tag] = attachTagsToBookmark(db, id, ['postgres'])
    expect(detachTagFromBookmark(db, id, tag!.id)).toBe(true)
    expect(getTagsForBookmark(db, id)).toEqual([])
  })

  it('returns false when no such link exists', () => {
    const id = seedBookmark()
    expect(detachTagFromBookmark(db, id, 'does-not-exist')).toBe(false)
  })

  it('does not delete the tag row, only the bookmark_tag link', () => {
    const id = seedBookmark()
    const [tag] = attachTagsToBookmark(db, id, ['postgres'])
    detachTagFromBookmark(db, id, tag!.id)
    expect(listAllTags(db).map((t) => t.name)).toEqual(['postgres'])
  })
})

// ─── listAllTagsWithUsage ─────────────────────────────────────────────────

describe('listAllTagsWithUsage', () => {
  it('returns 0 for unused tags', () => {
    db.run('INSERT INTO tags (id, name) VALUES (?, ?)', ['t1', 'unused'])
    const tags = listAllTagsWithUsage(db)
    expect(tags).toEqual([{ id: 't1', name: 'unused', usageCount: 0 }])
  })

  it('counts bookmark_tags links correctly', () => {
    const a = seedBookmark()
    const b = db.get<{ id: string }>('SELECT id FROM bookmarks WHERE chrome_id = ?', ['b2'])!.id
    attachTagsToBookmark(db, a, ['postgres', 'shared'])
    attachTagsToBookmark(db, b, ['shared'])

    const tags = listAllTagsWithUsage(db)
    const postgres = tags.find((t) => t.name === 'postgres')
    const shared = tags.find((t) => t.name === 'shared')
    expect(postgres?.usageCount).toBe(1)
    expect(shared?.usageCount).toBe(2)
  })
})

// ─── GET /api/tags ────────────────────────────────────────────────────────

describe('GET /api/tags', () => {
  it('returns [] when no tags exist', async () => {
    const res = await app.request('/api/tags', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('returns tags with usage counts', async () => {
    const id = seedBookmark()
    attachTagsToBookmark(db, id, ['postgres', 'rust'])

    const res = await app.request('/api/tags', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as Array<{ name: string; usageCount: number }>
    expect(body).toHaveLength(2)
    expect(body.find((t) => t.name === 'postgres')?.usageCount).toBe(1)
    expect(body.find((t) => t.name === 'rust')?.usageCount).toBe(1)
  })

  it('requires auth (401)', async () => {
    const res = await app.request('/api/tags')
    expect(res.status).toBe(401)
  })
})