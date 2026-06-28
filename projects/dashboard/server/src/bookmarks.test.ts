import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import bcrypt from 'bcryptjs'
import { Hono } from 'hono'
import { resolve } from 'node:path'
import { auth, type AuthVariables } from './auth.js'
import { InMemoryTokenStore } from './token-store.js'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { bookmarksApi } from './bookmarks.js'
import { applySync, type SyncInput } from './sync.js'

// ─── Test fixture ──────────────────────────────────────────────────────────

const PASSWORD = 'correct horse battery staple'
const HASH = bcrypt.hashSync(PASSWORD, 10)

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

async function buildApp(): Promise<{
  app: Hono<{ Variables: AuthVariables }>
  tokenStore: InMemoryTokenStore
  db: Database
}> {
  const app = new Hono<{ Variables: AuthVariables }>()
  const tokenStore = new InMemoryTokenStore()
  const db = new Database(':memory:')
  await runMigrations(db, { dir: resolve(process.cwd(), 'migrations') })
  app.use('*', auth({ passwordHash: HASH, tokenStore }))
  app.route('/api/bookmarks', bookmarksApi(db))
  return { app, tokenStore, db }
}

// ─── POST /api/bookmarks/sync ──────────────────────────────────────────────

describe('POST /api/bookmarks/sync', () => {
  let app: Hono<{ Variables: AuthVariables }>
  let tokenStore: InMemoryTokenStore
  let db: Database

  beforeEach(async () => {
    const built = await buildApp()
    app = built.app
    tokenStore = built.tokenStore
    db = built.db
  })

  afterEach(() => {
    db.close()
  })

  it('writes folders + bookmarks to the DB and returns 200 with idMap', async () => {
    const { plaintext } = await tokenStore.create('extension')
    const payload = {
      folders: [
        { chromeId: 'f1', parentChromeId: null, name: 'Bookmarks bar' },
        { chromeId: 'f2', parentChromeId: 'f1', name: 'News' },
      ],
      bookmarks: [
        {
          chromeId: 'b1',
          url: 'https://example.com/a',
          title: 'A',
          folderChromeId: 'f2',
        },
      ],
    }

    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      received: boolean
      idMap: { folders: Record<string, string>; bookmarks: Record<string, string> }
      counts: {
        foldersCreated: number
        foldersUpdated: number
        bookmarksCreated: number
        bookmarksUpdated: number
      }
    }
    expect(body.ok).toBe(true)
    expect(body.received).toBe(true)
    expect(body.idMap.folders).toEqual({ f1: expect.any(String), f2: expect.any(String) })
    expect(body.idMap.bookmarks).toEqual({ b1: expect.any(String) })
    expect(body.counts.foldersCreated).toBe(2)
    expect(body.counts.foldersUpdated).toBe(0)
    expect(body.counts.bookmarksCreated).toBe(1)
    expect(body.counts.bookmarksUpdated).toBe(0)

    // Verify the DB actually has the rows.
    expect(db.get('SELECT id FROM folders WHERE chrome_id = ?', ['f1'])).toBeDefined()
    expect(db.get('SELECT id FROM bookmarks WHERE chrome_id = ?', ['b1'])).toBeDefined()
  })

  it('returns 200 with received:false for an empty body (no DB writes)', async () => {
    const { plaintext } = await tokenStore.create('extension')
    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: { authorization: `Bearer ${plaintext}` },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; received: boolean; reason: string }
    expect(body.ok).toBe(true)
    expect(body.received).toBe(false)
    expect(body.reason).toBe('empty_body')

    // No rows in the DB.
    expect(db.all('SELECT id FROM folders')).toEqual([])
    expect(db.all('SELECT id FROM bookmarks')).toEqual([])
  })

  it('returns 200 with empty arrays payload', async () => {
    const { plaintext } = await tokenStore.create('extension')
    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ folders: [], bookmarks: [] }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      received: boolean
      counts: {
        foldersCreated: number
        bookmarksCreated: number
      }
    }
    expect(body.received).toBe(true)
    expect(body.counts.foldersCreated).toBe(0)
    expect(body.counts.bookmarksCreated).toBe(0)
  })

  it('returns 400 for malformed JSON', async () => {
    const { plaintext } = await tokenStore.create('extension')
    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: '{not valid json,,,',
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toBe('malformed_json')
  })

  it('returns 400 for valid JSON with wrong top-level shape', async () => {
    const { plaintext } = await tokenStore.create('extension')
    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ whatever: 'the extension sends' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.error).toBe('malformed_payload')
  })

  it('returns 400 with structured error code for duplicate folder chromeIds', async () => {
    const { plaintext } = await tokenStore.create('extension')
    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        folders: [
          { chromeId: 'dup', parentChromeId: null, name: 'A' },
          { chromeId: 'dup', parentChromeId: null, name: 'B' },
        ],
        bookmarks: [],
      }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean; error: string; message: string }
    expect(body.ok).toBe(false)
    expect(body.error).toBe('duplicate_folder_id')
    expect(body.message).toContain('dup')

    // No rows written — validation happens before any DB writes.
    expect(db.all('SELECT id FROM folders')).toEqual([])
  })

  it('returns 400 for cycles in folder references', async () => {
    const { plaintext } = await tokenStore.create('extension')
    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        folders: [
          { chromeId: 'a', parentChromeId: 'b', name: 'A' },
          { chromeId: 'b', parentChromeId: 'a', name: 'B' },
        ],
        bookmarks: [],
      }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('cycle_detected')
  })

  it('returns 400 for bookmarks referencing unknown folders', async () => {
    const { plaintext } = await tokenStore.create('extension')
    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        folders: [{ chromeId: 'f1', parentChromeId: null, name: 'F1' }],
        bookmarks: [
          { chromeId: 'b1', folderChromeId: 'nonexistent', url: 'https://x', title: 'X' },
        ],
      }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('unknown_bookmark_folder')
  })

  it('returns 200 for a 100-bookmark bulk sync', async () => {
    const { plaintext } = await tokenStore.create('extension')

    // 5 folders, 20 bookmarks each = 100 bookmarks.
    const folders = Array.from({ length: 5 }, (_, i) => ({
      chromeId: `f${i}`,
      parentChromeId: null,
      name: `Folder ${i}`,
    }))
    const bookmarks = Array.from({ length: 100 }, (_, i) => ({
      chromeId: `b${i}`,
      folderChromeId: `f${i % 5}`,
      url: `https://example.com/${i}`,
      title: `Bookmark ${i}`,
    }))

    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ folders, bookmarks }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      counts: {
        foldersCreated: number
        bookmarksCreated: number
      }
    }
    expect(body.counts.foldersCreated).toBe(5)
    expect(body.counts.bookmarksCreated).toBe(100)

    // Verify in the DB.
    expect(db.all('SELECT id FROM bookmarks')).toHaveLength(100)
  })

  it('is idempotent: re-running with the same input reports zero creates', async () => {
    const { plaintext } = await tokenStore.create('extension')
    const payload = {
      folders: [{ chromeId: 'f1', parentChromeId: null, name: 'F1' }],
      bookmarks: [{ chromeId: 'b1', folderChromeId: 'f1', url: 'https://x', title: 'X' }],
    }

    // First sync: creates.
    const r1 = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    const body1 = (await r1.json()) as {
      counts: { foldersCreated: number; bookmarksCreated: number }
    }
    expect(body1.counts.foldersCreated).toBe(1)
    expect(body1.counts.bookmarksCreated).toBe(1)

    // Second sync: same input. The differ detects no change and
    // emits zero ops, so the second sync is a true no-op (zero
    // INSERT/UPDATE statements). counts.all = 0.
    const r2 = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    const body2 = (await r2.json()) as {
      counts: {
        foldersCreated: number
        foldersUpdated: number
        foldersDeleted: number
        bookmarksCreated: number
        bookmarksUpdated: number
        bookmarksDeleted: number
      }
    }
    expect(body2.counts.foldersCreated).toBe(0)
    expect(body2.counts.foldersUpdated).toBe(0)
    expect(body2.counts.foldersDeleted).toBe(0)
    expect(body2.counts.bookmarksCreated).toBe(0)
    expect(body2.counts.bookmarksUpdated).toBe(0)
    expect(body2.counts.bookmarksDeleted).toBe(0)
  })

  it('rejects unauthenticated requests with 401 (Basic challenge present)', async () => {
    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folders: [], bookmarks: [] }),
    })

    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="Dashboard"')
  })

  it('rejects requests with an invalid Bearer token with 401 (no Basic challenge)', async () => {
    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: 'Bearer obviously-not-a-real-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ folders: [], bookmarks: [] }),
    })

    expect(res.status).toBe(401)
    // Bearer-failed path MUST NOT include `WWW-Authenticate: Basic` —
    // Chrome's fetch() interprets that as "ask the user for Basic
    // credentials" and pops an interactive dialog even though the
    // request was Bearer-authenticated.
    expect(res.headers.get('WWW-Authenticate')).toBeNull()
  })

  it('rejects requests with wrong Basic password with 401 (Basic challenge present)', async () => {
    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', 'wrong'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ folders: [], bookmarks: [] }),
    })

    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="Dashboard"')
  })

  it('accepts sync requests authenticated with Basic (UI smoke test path)', async () => {
    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        folders: [{ chromeId: 'f', parentChromeId: null, name: 'F' }],
        bookmarks: [],
      }),
    })

    expect(res.status).toBe(200)
    expect(db.get('SELECT id FROM folders WHERE chrome_id = ?', ['f'])).toBeDefined()
  })
})

// ─── BookmarkDiffer integration: delete + move through HTTP (issue #006) ─

describe('POST /api/bookmarks/sync — differ-driven updates (issue #006)', () => {
  let app: Hono<{ Variables: AuthVariables }>
  let tokenStore: InMemoryTokenStore
  let db: Database

  beforeEach(async () => {
    const built = await buildApp()
    app = built.app
    tokenStore = built.tokenStore
    db = built.db
  })

  afterEach(() => {
    db.close()
  })

  it('deletes a bookmark when it\'s removed from the incoming tree', async () => {
    const { plaintext } = await tokenStore.create('extension')
    const initial = {
      folders: [{ chromeId: 'f1', parentChromeId: null, name: 'F1' }],
      bookmarks: [
        { chromeId: 'm1', folderChromeId: 'f1', url: 'https://a', title: 'A' },
        { chromeId: 'm2', folderChromeId: 'f1', url: 'https://b', title: 'B' },
      ],
    }

    // Initial sync: 2 bookmarks created.
    await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(initial),
    })
    expect(db.get('SELECT id FROM bookmarks WHERE chrome_id = ?', ['m2'])).toBeDefined()

    // Second sync: m2 removed. Differ emits delete_bookmark(m2).
    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        folders: initial.folders,
        bookmarks: [initial.bookmarks[0]],
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      counts: {
        bookmarksDeleted: number
        bookmarksCreated: number
        foldersDeleted: number
      }
    }
    expect(body.counts.bookmarksDeleted).toBe(1)
    expect(body.counts.bookmarksCreated).toBe(0)
    expect(body.counts.foldersDeleted).toBe(0)

    // Verify in DB.
    expect(db.get('SELECT id FROM bookmarks WHERE chrome_id = ?', ['m1'])).toBeDefined()
    expect(db.get('SELECT id FROM bookmarks WHERE chrome_id = ?', ['m2'])).toBeUndefined()
  })

  it('cascade-deletes child folders + bookmarks when a parent folder is removed', async () => {
    const { plaintext } = await tokenStore.create('extension')
    const initial = {
      folders: [
        { chromeId: 'parent', parentChromeId: null, name: 'Parent' },
        { chromeId: 'child', parentChromeId: 'parent', name: 'Child' },
      ],
      bookmarks: [
        { chromeId: 'm1', folderChromeId: 'parent', url: 'https://p', title: 'P' },
        { chromeId: 'm2', folderChromeId: 'child', url: 'https://c', title: 'C' },
      ],
    }

    // Initial sync.
    await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(initial),
    })
    expect(db.get('SELECT id FROM folders WHERE chrome_id = ?', ['parent'])).toBeDefined()
    expect(db.get('SELECT id FROM folders WHERE chrome_id = ?', ['child'])).toBeDefined()
    expect(db.get('SELECT id FROM bookmarks WHERE chrome_id = ?', ['m2'])).toBeDefined()

    // Second sync: parent folder removed (and everything in it).
    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ folders: [], bookmarks: [] }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      counts: {
        foldersDeleted: number
        bookmarksDeleted: number
      }
    }
    expect(body.counts.foldersDeleted).toBe(2) // parent + child
    // No explicit delete_bookmark ops because cascade handled them.
    expect(body.counts.bookmarksDeleted).toBe(0)

    // Verify in DB.
    expect(db.get('SELECT id FROM folders WHERE chrome_id = ?', ['parent'])).toBeUndefined()
    expect(db.get('SELECT id FROM folders WHERE chrome_id = ?', ['child'])).toBeUndefined()
    expect(db.get('SELECT id FROM bookmarks WHERE chrome_id = ?', ['m1'])).toBeUndefined()
    expect(db.get('SELECT id FROM bookmarks WHERE chrome_id = ?', ['m2'])).toBeUndefined()
  })

  it('moves a bookmark between folders via sync', async () => {
    const { plaintext } = await tokenStore.create('extension')
    const initial = {
      folders: [
        { chromeId: 'a', parentChromeId: null, name: 'A' },
        { chromeId: 'b', parentChromeId: null, name: 'B' },
      ],
      bookmarks: [
        { chromeId: 'm1', folderChromeId: 'a', url: 'https://x', title: 'X' },
      ],
    }

    await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(initial),
    })

    // Verify m1 starts in folder a.
    const aBefore = db.get<{ id: string }>(
      'SELECT id FROM folders WHERE chrome_id = ?',
      ['a'],
    )
    const m1Before = db.get<{ folder_id: string }>(
      'SELECT folder_id FROM bookmarks WHERE chrome_id = ?',
      ['m1'],
    )
    expect(m1Before?.folder_id).toBe(aBefore?.id)

    // Move m1 to folder b.
    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        folders: initial.folders,
        bookmarks: [{ chromeId: 'm1', folderChromeId: 'b', url: 'https://x', title: 'X' }],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      counts: { bookmarksUpdated: number; bookmarksCreated: number }
    }
    expect(body.counts.bookmarksUpdated).toBe(1)
    expect(body.counts.bookmarksCreated).toBe(0)

    // Verify m1 is now in folder b.
    const bAfter = db.get<{ id: string }>(
      'SELECT id FROM folders WHERE chrome_id = ?',
      ['b'],
    )
    const m1After = db.get<{ folder_id: string }>(
      'SELECT folder_id FROM bookmarks WHERE chrome_id = ?',
      ['m1'],
    )
    expect(m1After?.folder_id).toBe(bAfter?.id)
  })

  it('echoes back the syncedFrom marker when the extension sends one', async () => {
    const { plaintext } = await tokenStore.create('extension')
    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        folders: [{ chromeId: 'f', parentChromeId: null, name: 'F' }],
        bookmarks: [],
        syncedFrom: 'extension_event',
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { syncedFrom?: string }
    expect(body.syncedFrom).toBe('extension_event')
  })

  it('omits syncedFrom from the response when the extension doesn\'t send one', async () => {
    const { plaintext } = await tokenStore.create('extension')
    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        folders: [{ chromeId: 'f', parentChromeId: null, name: 'F' }],
        bookmarks: [],
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { syncedFrom?: string }
    expect(body.syncedFrom).toBeUndefined()
  })

  it('reports all four counts (created/updated/deleted) for a mixed-op sync', async () => {
    const { plaintext } = await tokenStore.create('extension')
    const initial = {
      folders: [
        { chromeId: 'a', parentChromeId: null, name: 'A' },
        { chromeId: 'b', parentChromeId: null, name: 'B' },
      ],
      bookmarks: [
        { chromeId: 'm1', folderChromeId: 'a', url: 'https://1', title: 'One' },
        { chromeId: 'm2', folderChromeId: 'b', url: 'https://2', title: 'Two' },
      ],
    }
    await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(initial),
    })

    // Mixed: rename a (update), add new folder c with bookmark m3 (create),
    // delete m2 (delete), keep m1 (no-op).
    const res = await app.request('/api/bookmarks/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        folders: [
          { chromeId: 'a', parentChromeId: null, name: 'A renamed' },
          { chromeId: 'b', parentChromeId: null, name: 'B' },
          { chromeId: 'c', parentChromeId: null, name: 'C' },
        ],
        bookmarks: [
          { chromeId: 'm1', folderChromeId: 'a', url: 'https://1', title: 'One' },
          { chromeId: 'm3', folderChromeId: 'c', url: 'https://3', title: 'Three' },
        ],
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      counts: {
        foldersCreated: number
        foldersUpdated: number
        foldersDeleted: number
        bookmarksCreated: number
        bookmarksUpdated: number
        bookmarksDeleted: number
      }
    }
    expect(body.counts.foldersCreated).toBe(1) // c
    expect(body.counts.foldersUpdated).toBe(1) // a renamed
    expect(body.counts.foldersDeleted).toBe(0) // b kept
    expect(body.counts.bookmarksCreated).toBe(1) // m3
    expect(body.counts.bookmarksUpdated).toBe(0) // m1 unchanged
    expect(body.counts.bookmarksDeleted).toBe(1) // m2
  })
})

// ─── POST /api/bookmarks/:id (update title + tags) ─────────────────────────

describe('POST /api/bookmarks/:id (update)', () => {
  let app: Hono<{ Variables: AuthVariables }>
  let db: Database
  let bookmarkId: string

  beforeEach(async () => {
    const built = await buildApp()
    app = built.app
    db = built.db
    // Seed one bookmark.
    const input: SyncInput = {
      folders: [
        { chromeId: 'f1', parentChromeId: null, name: 'Bar' },
      ],
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'Original', folderChromeId: 'f1' },
      ],
    }
    applySync(db, input)
    bookmarkId = db.get<{ id: string }>('SELECT id FROM bookmarks WHERE chrome_id = ?', ['b1'])!.id
  })

  afterEach(() => {
    db.close()
  })

  it('updates the title', async () => {
    const res = await app.request(`/api/bookmarks/${bookmarkId}`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'Renamed' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; bookmark: { title: string } }
    expect(body.ok).toBe(true)
    expect(body.bookmark.title).toBe('Renamed')
    // Persisted in DB
    expect(db.get<{ title: string }>('SELECT title FROM bookmarks WHERE id = ?', [bookmarkId])?.title).toBe('Renamed')
  })

  it('trims whitespace from the new title', async () => {
    const res = await app.request(`/api/bookmarks/${bookmarkId}`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: '  Trimmed  ' }),
    })
    const body = (await res.json()) as { bookmark: { title: string } }
    expect(body.bookmark.title).toBe('Trimmed')
  })

  it('rejects empty title (400 invalid_title)', async () => {
    const res = await app.request(`/api/bookmarks/${bookmarkId}`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: '   ' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_title' })
  })

  it('attaches tags (additive, no tagReplace)', async () => {
    const res = await app.request(`/api/bookmarks/${bookmarkId}`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tags: ['Postgres', 'POSTGRES', '  database  '] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { bookmark: { tags: Array<{ name: string }> } }
    expect(body.bookmark.tags.map((t) => t.name).sort()).toEqual(['database', 'postgres'])
  })

  it('replaces the tag set when tagReplace: true', async () => {
    // First add a tag
    await app.request(`/api/bookmarks/${bookmarkId}`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tags: ['to-be-removed'] }),
    })

    const res = await app.request(`/api/bookmarks/${bookmarkId}`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tags: ['rust'], tagReplace: true }),
    })
    const body = (await res.json()) as { bookmark: { tags: Array<{ name: string }> } }
    expect(body.bookmark.tags.map((t) => t.name)).toEqual(['rust'])
  })

  it('updates title and tags in one call', async () => {
    const res = await app.request(`/api/bookmarks/${bookmarkId}`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'New', tags: ['alpha'] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { bookmark: { title: string; tags: Array<{ name: string }> } }
    expect(body.bookmark.title).toBe('New')
    expect(body.bookmark.tags.map((t) => t.name)).toEqual(['alpha'])
  })

  it('refreshes updated_at on title change', async () => {
    const before = db.get<{ updated_at: string }>('SELECT updated_at FROM bookmarks WHERE id = ?', [bookmarkId])?.updated_at
    expect(before).toBeTruthy()
    await new Promise((r) => setTimeout(r, 5))
    await app.request(`/api/bookmarks/${bookmarkId}`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'Renamed' }),
    })
    const after = db.get<{ updated_at: string }>('SELECT updated_at FROM bookmarks WHERE id = ?', [bookmarkId])?.updated_at
    expect(after).not.toEqual(before)
  })

  it('returns 404 for unknown id', async () => {
    const res = await app.request('/api/bookmarks/does-not-exist', {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'X' }),
    })
    expect(res.status).toBe(404)
  })

  it('rejects malformed JSON (400)', async () => {
    const res = await app.request(`/api/bookmarks/${bookmarkId}`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: '{not json',
    })
    expect(res.status).toBe(400)
  })

  it('requires auth (401)', async () => {
    const res = await app.request(`/api/bookmarks/${bookmarkId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'X' }),
    })
    expect(res.status).toBe(401)
  })
})

// ─── POST /api/bookmarks/:id/move ─────────────────────────────────────────

describe('POST /api/bookmarks/:id/move', () => {
  let app: Hono<{ Variables: AuthVariables }>
  let db: Database
  let bookmarkId: string
  let oldFolderId: string
  let newFolderId: string

  beforeEach(async () => {
    const built = await buildApp()
    app = built.app
    db = built.db
    const input: SyncInput = {
      folders: [
        { chromeId: 'f1', parentChromeId: null, name: 'Old' },
        { chromeId: 'f2', parentChromeId: null, name: 'New' },
      ],
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'A', folderChromeId: 'f1' },
      ],
    }
    applySync(db, input)
    bookmarkId = db.get<{ id: string }>('SELECT id FROM bookmarks WHERE chrome_id = ?', ['b1'])!.id
    oldFolderId = db.get<{ id: string }>('SELECT id FROM folders WHERE chrome_id = ?', ['f1'])!.id
    newFolderId = db.get<{ id: string }>('SELECT id FROM folders WHERE chrome_id = ?', ['f2'])!.id
  })

  afterEach(() => {
    db.close()
  })

  it('moves the bookmark to the new folder', async () => {
    const res = await app.request(`/api/bookmarks/${bookmarkId}/move`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ folderId: newFolderId }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; bookmark: { folderId: string } }
    expect(body.ok).toBe(true)
    expect(body.bookmark.folderId).toBe(newFolderId)
    // Persisted.
    expect(db.get<{ folder_id: string }>('SELECT folder_id FROM bookmarks WHERE id = ?', [bookmarkId])?.folder_id).toBe(newFolderId)
  })

  it('preserves tags on move', async () => {
    // First attach a tag.
    await app.request(`/api/bookmarks/${bookmarkId}`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tags: ['postgres'] }),
    })
    const res = await app.request(`/api/bookmarks/${bookmarkId}/move`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ folderId: newFolderId }),
    })
    const body = (await res.json()) as { bookmark: { tags: Array<{ name: string }>; folderId: string } }
    expect(body.bookmark.tags.map((t) => t.name)).toEqual(['postgres'])
    expect(body.bookmark.folderId).toBe(newFolderId)
  })

  it('returns 404 when bookmark does not exist', async () => {
    const res = await app.request('/api/bookmarks/does-not-exist/move', {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ folderId: newFolderId }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 when target folder does not exist', async () => {
    const res = await app.request(`/api/bookmarks/${bookmarkId}/move`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ folderId: 'does-not-exist' }),
    })
    expect(res.status).toBe(404)
    // Bookmark stays in old folder.
    expect(db.get<{ folder_id: string }>('SELECT folder_id FROM bookmarks WHERE id = ?', [bookmarkId])?.folder_id).toBe(oldFolderId)
  })

  it('rejects missing/non-string folderId (400)', async () => {
    const res = await app.request(`/api/bookmarks/${bookmarkId}/move`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ folderId: 123 }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects malformed JSON (400)', async () => {
    const res = await app.request(`/api/bookmarks/${bookmarkId}/move`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: '{not json',
    })
    expect(res.status).toBe(400)
  })

  it('requires auth (401)', async () => {
    const res = await app.request(`/api/bookmarks/${bookmarkId}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: newFolderId }),
    })
    expect(res.status).toBe(401)
  })
})

// ─── DELETE /api/bookmarks/:id ─────────────────────────────────────────────

describe('DELETE /api/bookmarks/:id', () => {
  let app: Hono<{ Variables: AuthVariables }>
  let db: Database
  let bookmarkId: string

  beforeEach(async () => {
    const built = await buildApp()
    app = built.app
    db = built.db
    const input: SyncInput = {
      folders: [
        { chromeId: 'f1', parentChromeId: null, name: 'Bar' },
      ],
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'A', folderChromeId: 'f1' },
      ],
    }
    applySync(db, input)
    bookmarkId = db.get<{ id: string }>('SELECT id FROM bookmarks WHERE chrome_id = ?', ['b1'])!.id
  })

  afterEach(() => {
    db.close()
  })

  it('deletes an existing bookmark (204)', async () => {
    const res = await app.request(`/api/bookmarks/${bookmarkId}`, {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(204)
    expect(db.get<{ id: string }>('SELECT id FROM bookmarks WHERE id = ?', [bookmarkId])).toBeUndefined()
  })

  it('also detaches the bookmark\'s tags', async () => {
    // Attach a tag first.
    await app.request(`/api/bookmarks/${bookmarkId}`, {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tags: ['postgres'] }),
    })
    const links = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM bookmark_tags WHERE bookmark_id = ?', [bookmarkId])?.c
    expect(links).toBe(1)

    await app.request(`/api/bookmarks/${bookmarkId}`, {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const afterLinks = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM bookmark_tags WHERE bookmark_id = ?', [bookmarkId])?.c
    expect(afterLinks).toBe(0)
  })

  it('returns 404 for unknown id', async () => {
    const res = await app.request('/api/bookmarks/does-not-exist', {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(404)
  })

  it('requires auth (401)', async () => {
    const res = await app.request(`/api/bookmarks/${bookmarkId}`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(401)
  })
})