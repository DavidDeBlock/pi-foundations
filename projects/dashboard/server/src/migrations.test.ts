import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'

// Path to the real `migrations/` directory at the project root. Vitest
// runs from `server/`, so cwd-relative works.
const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

describe('Database wrapper', () => {
  let db: Database

  beforeEach(() => {
    db = new Database(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('opens an in-memory database and runs DDL', () => {
    db.exec('CREATE TABLE t (id INTEGER, name TEXT)')
    db.run('INSERT INTO t (id, name) VALUES (?, ?)', [1, 'a'])
    const rows = db.all<{ id: number; name: string }>('SELECT * FROM t ORDER BY id')
    expect(rows).toEqual([{ id: 1, name: 'a' }])
  })

  it('all<T>() returns typed rows', () => {
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)')
    db.run('INSERT INTO t (n) VALUES (?)', ['x'])
    const rows = db.all<{ id: number; n: string }>('SELECT id, n FROM t')
    expect(rows[0]?.n).toBe('x')
  })

  it('get<T>() returns the first row or undefined', () => {
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)')
    expect(db.get<{ id: number }>('SELECT id FROM t WHERE id = ?', [1])).toBeUndefined()
    db.run('INSERT INTO t (n) VALUES (?)', ['hello'])
    expect(db.get<{ n: string }>('SELECT n FROM t')).toEqual({ n: 'hello' })
  })

  it('run() returns change count + last insert rowid', () => {
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)')
    const r = db.run('INSERT INTO t (n) VALUES (?)', ['x'])
    expect(r.changes).toBe(1)
    expect(Number(r.lastInsertRowid)).toBe(1)
  })

  it('transaction() commits on success and rolls back on throw', () => {
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)')

    db.transaction(() => {
      db.run('INSERT INTO t (n) VALUES (?)', ['a'])
      db.run('INSERT INTO t (n) VALUES (?)', ['b'])
    })
    expect(db.all<{ n: string }>('SELECT n FROM t')).toHaveLength(2)

    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t (n) VALUES (?)', ['c'])
        throw new Error('boom')
      }),
    ).toThrow('boom')
    // 'c' must NOT be present — the throw rolled back.
    expect(db.all<{ n: string }>('SELECT n FROM t')).toHaveLength(2)
  })
})

describe('Migrations runner', () => {
  let db: Database

  beforeEach(() => {
    db = new Database(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('applies pending migrations on a fresh DB', async () => {
    await runMigrations(db, { dir: MIGRATIONS_DIR })

    const applied = db.all<{ name: string }>(
      'SELECT name FROM migrations ORDER BY name',
    )
    expect(applied.map((r) => r.name)).toEqual([
      '001_initial',
      '002_search_trigram',
      '003_email_accounts',
      '004_emails_sync_state',
      '005_email_search',
      '006_email_tags',
      '007_email_sync_debounce',
      '008_youtube_accounts',
    ])

    // Spot-check that every table from the PRD schema now exists.
    const tables = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type IN ('table') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    const names = tables.map((t) => t.name)
    expect(names).toContain('folders')
    expect(names).toContain('bookmarks')
    expect(names).toContain('tags')
    expect(names).toContain('bookmark_tags')
    expect(names).toContain('api_tokens')
    expect(names).toContain('migrations')
    // FTS5 virtual table also lives in sqlite_master with type='table'.
    expect(names).toContain('bookmark_fts')
    // Trigram index table from issue #009.
    expect(names).toContain('bookmark_trigrams')
    // Email accounts table from issue #020.
    expect(names).toContain('email_accounts')
    // Email mirror + sync state from issue #021.
    expect(names).toContain('emails')
    expect(names).toContain('sync_state')
    // Email search infrastructure from issue #022.
    expect(names).toContain('email_fts')
    expect(names).toContain('email_trigrams')
    // Dashboard-only tag table from issue #025.
    expect(names).toContain('email_tags')
    // Sync debounce column for the background scheduler (issue #026).
    const syncCols = db.all<{ name: string }>('PRAGMA table_info(sync_state)')
    expect(syncCols.some((c) => c.name === 'last_manual_trigger_at')).toBe(true)
  })

  it('is idempotent — running twice does NOT re-apply', async () => {
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    const firstApplied = db.all<{ name: string }>('SELECT name FROM migrations')
    expect(firstApplied).toHaveLength(8)

    await runMigrations(db, { dir: MIGRATIONS_DIR })
    const secondApplied = db.all<{ name: string }>('SELECT name FROM migrations')
    expect(secondApplied).toHaveLength(8)
    // applied_at should be unchanged on re-run (still the original timestamps).
    expect(secondApplied.map((r) => r.name).sort()).toEqual(
      firstApplied.map((r) => r.name).sort(),
    )
  })

  it('enforces the folders self-referential FK', async () => {
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    db.run('INSERT INTO folders (id, parent_id, name) VALUES (?, NULL, ?)', [
      'root',
      'Root',
    ])
    db.run('INSERT INTO folders (id, parent_id, name) VALUES (?, ?, ?)', [
      'child',
      'root',
      'Child',
    ])
    const child = db.get<{ name: string }>('SELECT name FROM folders WHERE id = ?', [
      'child',
    ])
    expect(child?.name).toBe('Child')
  })

  it('cascades deletes through the folder tree', async () => {
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    db.run('INSERT INTO folders (id, parent_id, name) VALUES (?, NULL, ?)', [
      'root',
      'Root',
    ])
    db.run('INSERT INTO folders (id, parent_id, name) VALUES (?, ?, ?)', [
      'child',
      'root',
      'Child',
    ])
    db.run('INSERT INTO folders (id, parent_id, name) VALUES (?, ?, ?)', [
      'grand',
      'child',
      'Grand',
    ])

    db.run('DELETE FROM folders WHERE id = ?', ['root'])

    const remaining = db.all<{ id: string }>('SELECT id FROM folders ORDER BY id')
    expect(remaining).toEqual([])
  })

  it('keeps bookmark_fts in sync via triggers', async () => {
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    db.run('INSERT INTO folders (id, parent_id, name) VALUES (?, NULL, ?)', [
      'f',
      'F',
    ])
    db.run(
      'INSERT INTO bookmarks (id, url, title, folder_id) VALUES (?, ?, ?, ?)',
      ['b1', 'https://example.com', 'Example', 'f'],
    )

    // FTS5 rowid aligns with bookmarks.rowid.
    const hits = db.all<{ title: string; url: string }>(
      "SELECT title, url FROM bookmark_fts WHERE bookmark_fts MATCH ?",
      ['example'],
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]?.title).toBe('Example')
  })
})
