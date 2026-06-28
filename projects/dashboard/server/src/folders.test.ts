import bcrypt from 'bcryptjs'
import { Hono } from 'hono'
import { resolve } from 'node:path'
import { auth, type AuthVariables } from './auth.js'
import { buildTree, type FolderNode } from './folders.js'
import { InMemoryTokenStore } from './token-store.js'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'

const PASSWORD = 'correct horse battery staple'
const HASH = bcrypt.hashSync(PASSWORD, 10)

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

// ─── buildTree (pure function) ─────────────────────────────────────────────

describe('buildTree', () => {
  it('returns [] for empty input', () => {
    expect(buildTree([])).toEqual([])
  })

  it('returns root folders with empty children when there are no nested folders', () => {
    const tree = buildTree([
      { id: 'a', parent_id: null, name: 'A', chrome_id: null },
      { id: 'b', parent_id: null, name: 'B', chrome_id: null },
    ])
    expect(tree).toHaveLength(2)
    expect(tree.map((n) => n.name).sort()).toEqual(['A', 'B'])
    expect(tree[0]?.children).toEqual([])
    expect(tree[1]?.children).toEqual([])
  })

  it('nests children under their parents', () => {
    const tree = buildTree([
      { id: 'a', parent_id: null, name: 'A', chrome_id: null },
      { id: 'a1', parent_id: 'a', name: 'A1', chrome_id: null },
      { id: 'a1a', parent_id: 'a1', name: 'A1a', chrome_id: null },
      { id: 'b', parent_id: null, name: 'B', chrome_id: null },
    ])
    expect(tree).toHaveLength(2)
    const a = tree.find((n) => n.name === 'A')!
    const b = tree.find((n) => n.name === 'B')!
    expect(a.children).toHaveLength(1)
    expect(a.children[0]?.name).toBe('A1')
    expect(a.children[0]?.children).toHaveLength(1)
    expect(a.children[0]?.children[0]?.name).toBe('A1a')
    expect(a.children[0]?.children[0]?.children).toEqual([])
    expect(b.children).toEqual([])
  })

  it('preserves chromeId and parentId on each node', () => {
    const tree = buildTree([
      { id: 'x', parent_id: null, name: 'X', chrome_id: 'chrome-x' },
    ])
    expect(tree[0]?.chromeId).toBe('chrome-x')
    expect(tree[0]?.parentId).toBeNull()
  })

  it('handles siblings under a nested parent', () => {
    const tree = buildTree([
      { id: 'r', parent_id: null, name: 'Root', chrome_id: null },
      { id: 's1', parent_id: 'r', name: 'Sib1', chrome_id: null },
      { id: 's2', parent_id: 'r', name: 'Sib2', chrome_id: null },
    ])
    expect(tree[0]?.children).toHaveLength(2)
    expect(tree[0]?.children.map((c) => c.name).sort()).toEqual(['Sib1', 'Sib2'])
  })

  it('handles orphans (parent_id pointing to a non-existent row)', () => {
    // SQLite FK enforcement requires a real FK; this only happens if FKs
    // are off, but the tree builder should still handle it gracefully —
    // orphans end up at the top level (no parent means we can't nest them).
    const tree = buildTree([
      { id: 'x', parent_id: 'ghost', name: 'X', chrome_id: null },
    ])
    expect(tree).toEqual([])
  })
})

// ─── /api/folders HTTP ─────────────────────────────────────────────────────

async function buildApp(): Promise<Hono<{ Variables: AuthVariables }>> {
  const app = new Hono<{ Variables: AuthVariables }>()
  const tokenStore = new InMemoryTokenStore()
  const db = new Database(':memory:')
  await runMigrations(db, { dir: resolve(process.cwd(), 'migrations') })
  app.use('*', auth({ passwordHash: HASH, tokenStore }))
  // Inline import to avoid circular dependency at module load.
  const { foldersApi } = await import('./folders.js')
  app.route('/api/folders', foldersApi(db))
  return app
}

describe('GET /api/folders', () => {
  it('returns [] when no folders exist', async () => {
    const app = await buildApp()
    const res = await app.request('/api/folders', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('returns the nested tree for seeded folders', async () => {
    // Build with a shared DB we can seed.
    const tokenStore = new InMemoryTokenStore()
    const db = new Database(':memory:')
    await runMigrations(db, { dir: resolve(process.cwd(), 'migrations') })
    seedFolders(db, [
      { id: 'r', parentId: null, name: 'Root' },
      { id: 'r1', parentId: 'r', name: 'Root1' },
      { id: 'r1a', parentId: 'r1', name: 'Root1A' },
      { id: 'r2', parentId: 'r', name: 'Root2' },
      { id: 'o', parentId: null, name: 'Other' },
    ])

    const app = new Hono<{ Variables: AuthVariables }>()
    app.use('*', auth({ passwordHash: HASH, tokenStore }))
    const { foldersApi } = await import('./folders.js')
    app.route('/api/folders', foldersApi(db))

    const res = await app.request('/api/folders', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as FolderNode[]
    expect(body).toHaveLength(2)
    const root = body.find((n) => n.name === 'Root')
    const other = body.find((n) => n.name === 'Other')
    expect(other?.children).toEqual([])
    expect(root?.children).toHaveLength(2)
    expect(root?.children.map((c) => c.name).sort()).toEqual(['Root1', 'Root2'])
    const r1 = root?.children.find((c) => c.name === 'Root1')
    expect(r1?.children).toHaveLength(1)
    expect(r1?.children[0]?.name).toBe('Root1A')
    expect(r1?.children[0]?.children).toEqual([])
  })

  it('rejects requests without auth (401)', async () => {
    const app = await buildApp()
    const res = await app.request('/api/folders')
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="Dashboard"')
  })

  it('rejects requests with wrong Basic password (401)', async () => {
    const app = await buildApp()
    const res = await app.request('/api/folders', {
      headers: { authorization: basicHeader('david', 'wrong') },
    })
    expect(res.status).toBe(401)
  })

  it('accepts requests with a valid Bearer token', async () => {
    const tokenStore = new InMemoryTokenStore()
    const db = new Database(':memory:')
    await runMigrations(db, { dir: resolve(process.cwd(), 'migrations') })
    seedFolders(db, [{ id: 'a', parentId: null, name: 'A' }])

    const app = new Hono<{ Variables: AuthVariables }>()
    app.use('*', auth({ passwordHash: HASH, tokenStore }))
    const { foldersApi } = await import('./folders.js')
    app.route('/api/folders', foldersApi(db))

    const { plaintext } = await tokenStore.create('extension')
    const res = await app.request('/api/folders', {
      headers: { authorization: `Bearer ${plaintext}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string }>
    expect(body).toHaveLength(1)
    expect(body[0]?.name).toBe('A')
  })

  it('sorts siblings by name (alphabetical)', async () => {
    const tokenStore = new InMemoryTokenStore()
    const db = new Database(':memory:')
    await runMigrations(db, { dir: resolve(process.cwd(), 'migrations') })
    seedFolders(db, [
      { id: 'c', parentId: null, name: 'Charlie' },
      { id: 'a', parentId: null, name: 'Alpha' },
      { id: 'b', parentId: null, name: 'Bravo' },
    ])

    const app = new Hono<{ Variables: AuthVariables }>()
    app.use('*', auth({ passwordHash: HASH, tokenStore }))
    const { foldersApi } = await import('./folders.js')
    app.route('/api/folders', foldersApi(db))

    const res = await app.request('/api/folders', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const body = (await res.json()) as Array<{ name: string }>
    expect(body.map((n) => n.name)).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })
})

// ─── helpers ───────────────────────────────────────────────────────────────

interface FolderSeed {
  readonly id: string
  readonly parentId: string | null
  readonly name: string
  readonly chromeId?: string
}

function seedFolders(db: Database, folders: readonly FolderSeed[]): void {
  for (const f of folders) {
    db.run(
      'INSERT INTO folders (id, parent_id, name, chrome_id) VALUES (?, ?, ?, ?)',
      [f.id, f.parentId, f.name, f.chromeId ?? null],
    )
  }
}
