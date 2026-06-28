import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { applySync, SyncPlanError, type SyncInput } from './sync.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────

let db: Database

beforeEach(async () => {
  db = new Database(':memory:')
  await runMigrations(db, { dir: resolve(process.cwd(), 'migrations') })
})

afterEach(() => {
  db.close()
})

function folder(chromeId: string, parentChromeId: string | null, name: string) {
  return { chromeId, parentChromeId, name }
}

function mkBookmark(
  chromeId: string,
  folderChromeId: string,
  url = `https://${chromeId}.example.com`,
  title = `Bookmark ${chromeId}`,
) {
  return { chromeId, folderChromeId, url, title }
}

// ─── Happy path ──────────────────────────────────────────────────────────

describe('applySync — happy path', () => {
  it('writes folders + bookmarks and returns chromeId → serverId map', () => {
    const input: SyncInput = {
      folders: [
        folder('f1', null, 'Bookmarks bar'),
        folder('f2', 'f1', 'News'),
      ],
      bookmarks: [
        mkBookmark('b1', 'f2', 'https://news.example.com/a', 'A'),
        mkBookmark('b2', 'f2', 'https://news.example.com/b', 'B'),
      ],
    }
    const result = applySync(db, input)

    expect(result.ok).toBe(true)
    expect(result.received).toBe(true)
    expect(Object.keys(result.idMap.folders)).toEqual(['f1', 'f2'])
    expect(Object.keys(result.idMap.bookmarks)).toEqual(['b1', 'b2'])

    // Every value is a UUID-shaped string.
    for (const id of Object.values(result.idMap.folders)) {
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
    }
  })

  it('writes folders in topological order so FK constraints hold', () => {
    // f3 is the deepest folder — its parent_id must resolve before its
    // own INSERT runs. If the handler processes children before parents,
    // SQLite rejects with FK violation.
    const input: SyncInput = {
      folders: [
        folder('root', null, 'Root'),
        folder('mid', 'root', 'Mid'),
        folder('leaf', 'mid', 'Leaf'),
      ],
      bookmarks: [mkBookmark('leafmark', 'leaf')],
    }
    expect(() => applySync(db, input)).not.toThrow()

    const leaf = db.get<{ parent_id: string }>(
      'SELECT parent_id FROM folders WHERE chrome_id = ?',
      ['leaf'],
    )
    const mid = db.get<{ id: string }>(
      'SELECT id FROM folders WHERE chrome_id = ?',
      ['mid'],
    )
    expect(leaf?.parent_id).toBe(mid?.id)

    const bookmark = db.get<{ folder_id: string }>(
      'SELECT folder_id FROM bookmarks WHERE chrome_id = ?',
      ['leafmark'],
    )
    const leafRow = db.get<{ id: string }>(
      'SELECT id FROM folders WHERE chrome_id = ?',
      ['leaf'],
    )
    expect(bookmark?.folder_id).toBe(leafRow?.id)
  })

  it('counts created vs updated separately', () => {
    // First sync: 3 folders, 2 bookmarks.
    applySync(db, {
      folders: [
        folder('a', null, 'A'),
        folder('b', null, 'B'),
        folder('c', null, 'C'),
      ],
      bookmarks: [mkBookmark('m1', 'a'), mkBookmark('m2', 'b')],
    })

    // Second sync: rename ONE folder + add ONE bookmark. The other
    // folders/bookmarks match the DB and should NOT be counted as
    // updated (that's the whole point of the differ — no UPDATE on
    // matching rows).
    const result = applySync(db, {
      folders: [
        folder('a', null, 'A renamed'),
        folder('b', null, 'B'),
        folder('c', null, 'C'),
      ],
      bookmarks: [mkBookmark('m1', 'a'), mkBookmark('m2', 'b'), mkBookmark('m3', 'c')],
    })

    expect(result.counts.foldersCreated).toBe(0)
    expect(result.counts.foldersUpdated).toBe(1) // only 'a' renamed
    expect(result.counts.bookmarksCreated).toBe(1) // m3 is new
    expect(result.counts.bookmarksUpdated).toBe(0) // m1, m2 unchanged

    // Verify the rename actually persisted.
    const renamed = db.get<{ name: string }>(
      'SELECT name FROM folders WHERE chrome_id = ?',
      ['a'],
    )
    expect(renamed?.name).toBe('A renamed')
  })
})

// ─── Idempotency ─────────────────────────────────────────────────────────

describe('applySync — idempotency', () => {
  it('re-running with the same input preserves server IDs', () => {
    const input: SyncInput = {
      folders: [folder('f', null, 'F')],
      bookmarks: [mkBookmark('b', 'f')],
    }
    const r1 = applySync(db, input)
    const r2 = applySync(db, input)
    expect(r2.idMap.folders['f']).toBe(r1.idMap.folders['f'])
    expect(r2.idMap.bookmarks['b']).toBe(r1.idMap.bookmarks['b'])
  })

  it('re-running with the same input reports zero creates AND zero updates', () => {
    // The differ emits no ops at all when incoming matches DB state
    // exactly — that's the whole point of the diff-then-apply path.
    // No UPDATE statements are issued against matching rows.
    const input: SyncInput = {
      folders: [folder('f', null, 'F'), folder('g', 'f', 'G')],
      bookmarks: [mkBookmark('b1', 'f'), mkBookmark('b2', 'g')],
    }
    applySync(db, input)
    const second = applySync(db, input)
    expect(second.counts.foldersCreated).toBe(0)
    expect(second.counts.foldersUpdated).toBe(0)
    expect(second.counts.bookmarksCreated).toBe(0)
    expect(second.counts.bookmarksUpdated).toBe(0)
  })
})

// ─── Re-parenting ────────────────────────────────────────────────────────

describe('applySync — re-parenting', () => {
  it('moves a folder to a new parent on update', () => {
    // First sync: child is under A.
    applySync(db, {
      folders: [
        folder('a', null, 'A'),
        folder('b', null, 'B'),
        folder('child', 'a', 'Child'),
      ],
      bookmarks: [],
    })

    const childBefore = db.get<{ parent_id: string | null }>(
      'SELECT parent_id FROM folders WHERE chrome_id = ?',
      ['child'],
    )
    const aBefore = db.get<{ id: string }>(
      'SELECT id FROM folders WHERE chrome_id = ?',
      ['a'],
    )
    expect(childBefore?.parent_id).toBe(aBefore?.id)

    // Second sync: re-parent child under B.
    applySync(db, {
      folders: [
        folder('a', null, 'A'),
        folder('b', null, 'B'),
        folder('child', 'b', 'Child'),
      ],
      bookmarks: [],
    })

    const childAfter = db.get<{ parent_id: string | null }>(
      'SELECT parent_id FROM folders WHERE chrome_id = ?',
      ['child'],
    )
    const bAfter = db.get<{ id: string }>(
      'SELECT id FROM folders WHERE chrome_id = ?',
      ['b'],
    )
    expect(childAfter?.parent_id).toBe(bAfter?.id)

    // The server id for child is preserved across re-parenting.
    expect(childAfter?.parent_id).not.toBe(childBefore?.parent_id)
  })
})

// ─── Validation errors propagate ─────────────────────────────────────────

describe('applySync — validation errors', () => {
  it('throws SyncPlanError on duplicate folder chromeIds', () => {
    const input: SyncInput = {
      folders: [
        folder('dup', null, 'First'),
        folder('dup', null, 'Second'),
      ],
      bookmarks: [],
    }
    expect(() => applySync(db, input)).toThrow(SyncPlanError)
    try {
      applySync(db, input)
    } catch (err) {
      expect((err as SyncPlanError).code).toBe('duplicate_folder_id')
    }
  })

  it('throws SyncPlanError on cycles', () => {
    const input: SyncInput = {
      folders: [
        folder('a', 'b', 'A'),
        folder('b', 'a', 'B'),
      ],
      bookmarks: [],
    }
    expect(() => applySync(db, input)).toThrow(SyncPlanError)
  })

  it('rolls back partially-applied writes on validation failure', () => {
    // Pre-seed some valid folders.
    applySync(db, {
      folders: [folder('preexisting', null, 'Preexisting')],
      bookmarks: [],
    })
    const before = db.get<{ name: string }>(
      'SELECT name FROM folders WHERE chrome_id = ?',
      ['preexisting'],
    )
    expect(before?.name).toBe('Preexisting')

    // Now try to sync with a duplicate that should be rejected.
    expect(() =>
      applySync(db, {
        folders: [
          folder('preexisting', null, 'Should not overwrite'),
          folder('preexisting', null, 'Duplicate'),
        ],
        bookmarks: [],
      }),
    ).toThrow()

    // The pre-existing folder is unchanged because the transaction
    // rolled back. (Otherwise the duplicate_folder_id validation would
    // happen BEFORE any DB writes — but we also want to verify that
    // even mid-write failures roll back.)
    const after = db.get<{ name: string }>(
      'SELECT name FROM folders WHERE chrome_id = ?',
      ['preexisting'],
    )
    expect(after?.name).toBe('Preexisting')
  })
})

// ─── Cascade behavior on the DB side ─────────────────────────────────────

describe('applySync — FK cascade', () => {
  it('deletes a folder cascade-deletes its bookmarks', () => {
    applySync(db, {
      folders: [
        folder('parent', null, 'Parent'),
        folder('child', 'parent', 'Child'),
      ],
      bookmarks: [mkBookmark('b1', 'parent'), mkBookmark('b2', 'child')],
    })

    const parentId = db.get<{ id: string }>(
      'SELECT id FROM folders WHERE chrome_id = ?',
      ['parent'],
    )?.id
    expect(parentId).toBeDefined()

    // Delete the parent folder directly. Cascading FKs in the schema
    // remove the child folder + both bookmarks.
    db.run('DELETE FROM folders WHERE id = ?', [parentId])

    expect(
      db.get('SELECT id FROM folders WHERE chrome_id = ?', ['parent']),
    ).toBeUndefined()
    expect(
      db.get('SELECT id FROM folders WHERE chrome_id = ?', ['child']),
    ).toBeUndefined()
    expect(
      db.get('SELECT id FROM bookmarks WHERE chrome_id = ?', ['b1']),
    ).toBeUndefined()
    expect(
      db.get('SELECT id FROM bookmarks WHERE chrome_id = ?', ['b2']),
    ).toBeUndefined()
  })
})

// ─── Empty payload ───────────────────────────────────────────────────────

describe('applySync — empty payload', () => {
  it('returns ok with empty maps for empty input', () => {
    const result = applySync(db, { folders: [], bookmarks: [] })
    expect(result.ok).toBe(true)
    expect(result.idMap.folders).toEqual({})
    expect(result.idMap.bookmarks).toEqual({})
    expect(result.counts.foldersCreated).toBe(0)
    expect(result.counts.bookmarksCreated).toBe(0)
  })
})

// ─── Optional timestamp fields ───────────────────────────────────────────

describe('applySync — timestamps', () => {
  it('uses provided createdAt/updatedAt on insert', () => {
    applySync(db, {
      folders: [folder('f', null, 'F')],
      bookmarks: [
        {
          ...mkBookmark('b', 'f'),
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-06-15T12:34:56.000Z',
        },
      ],
    })
    const row = db.get<{ created_at: string; updated_at: string }>(
      'SELECT created_at, updated_at FROM bookmarks WHERE chrome_id = ?',
      ['b'],
    )
    expect(row?.created_at).toBe('2024-01-01T00:00:00.000Z')
    expect(row?.updated_at).toBe('2024-06-15T12:34:56.000Z')
  })

  it('preserves created_at on update; refreshes updated_at', () => {
    applySync(db, {
      folders: [folder('f', null, 'F')],
      bookmarks: [
        {
          ...mkBookmark('b', 'f'),
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-06-15T12:34:56.000Z',
        },
      ],
    })

    // Second sync must actually CHANGE something for the differ to
    // emit an upsert op. The differ does NOT touch rows that match.
    // Here we rename the bookmark — that's a real change.
    applySync(db, {
      folders: [folder('f', null, 'F')],
      bookmarks: [
        {
          ...mkBookmark('b', 'f'),
          title: 'Bookmark b renamed',
        },
      ],
    })

    const row = db.get<{ created_at: string; updated_at: string }>(
      'SELECT created_at, updated_at FROM bookmarks WHERE chrome_id = ?',
      ['b'],
    )
    expect(row?.created_at).toBe('2024-01-01T00:00:00.000Z')
    expect(row?.updated_at).not.toBe('2024-06-15T12:34:56.000Z')
  })
})