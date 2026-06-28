import { describe, expect, it } from 'vitest'
import {
  diffIncoming,
  DiffError,
  type DbFolderState,
  type DbBookmarkState,
  type DbState,
} from './bookmark-differ.js'
import { SyncPlanError, type SyncInput } from './folder-tree-builder.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────

const SERVER_ID_PREFIX = 'srv-'

function f(
  chromeId: string,
  parentChromeId: string | null,
  name: string,
): { chromeId: string; parentChromeId: string | null; name: string } {
  return { chromeId, parentChromeId, name }
}

function b(
  chromeId: string,
  folderChromeId: string,
  url = `https://${chromeId}.example.com`,
  title = `Bookmark ${chromeId}`,
) {
  return { chromeId, folderChromeId, url, title }
}

function dbFolder(
  chromeId: string,
  opts: Partial<{ parentChromeId: string | null; name: string }> = {},
): DbFolderState {
  return {
    id: `${SERVER_ID_PREFIX}folder-${chromeId}`,
    chromeId,
    parentChromeId: opts.parentChromeId ?? null,
    name: opts.name ?? `Folder ${chromeId}`,
  }
}

function dbBookmark(
  chromeId: string,
  opts: Partial<{ folderChromeId: string; url: string; title: string }> = {},
): DbBookmarkState {
  return {
    id: `${SERVER_ID_PREFIX}bookmark-${chromeId}`,
    chromeId,
    folderChromeId: opts.folderChromeId ?? 'f1',
    url: opts.url ?? `https://${chromeId}.example.com`,
    title: opts.title ?? `Bookmark ${chromeId}`,
  }
}

function emptyDb(): DbState {
  return {
    folders: new Map(),
    bookmarks: new Map(),
  }
}

function dbFrom(state: {
  folders?: DbFolderState[]
  bookmarks?: DbBookmarkState[]
}): DbState {
  return {
    folders: new Map((state.folders ?? []).map((f) => [f.chromeId, f])),
    bookmarks: new Map((state.bookmarks ?? []).map((b) => [b.chromeId, b])),
  }
}

// ─── No-op (same tree) ────────────────────────────────────────────────────

describe('diffIncoming — no-op', () => {
  it('returns empty ops when incoming exactly matches DB state', () => {
    const input: SyncInput = {
      folders: [f('f1', null, 'Folder f1'), f('f2', 'f1', 'Folder f2')],
      bookmarks: [b('m1', 'f1'), b('m2', 'f2')],
    }
    const db: DbState = dbFrom({
      folders: [dbFolder('f1'), dbFolder('f2', { parentChromeId: 'f1' })],
      bookmarks: [
        dbBookmark('m1', { folderChromeId: 'f1' }),
        dbBookmark('m2', { folderChromeId: 'f2' }),
      ],
    })

    const result = diffIncoming(input, db)
    expect(result.ops).toEqual([])
    expect(result.counts).toEqual({
      foldersUpserted: 0,
      foldersDeleted: 0,
      bookmarksUpserted: 0,
      bookmarksDeleted: 0,
    })
  })

  it('handles empty input against empty DB', () => {
    const result = diffIncoming({ folders: [], bookmarks: [] }, emptyDb())
    expect(result.ops).toEqual([])
  })

  it('handles empty input against populated DB (all deletes)', () => {
    const db: DbState = dbFrom({
      folders: [dbFolder('f1'), dbFolder('f2', { parentChromeId: 'f1' })],
      bookmarks: [
        dbBookmark('m1', { folderChromeId: 'f1' }),
        dbBookmark('m2', { folderChromeId: 'f2' }),
      ],
    })

    const result = diffIncoming({ folders: [], bookmarks: [] }, db)
    expect(result.counts.foldersDeleted).toBe(2)
    // Only f1 has bookmarks directly — f2 is in f1, cascade deletes it.
    // f1 itself is also deleted (cascade removes its bookmarks too).
    // So we emit 2 delete_folder ops + 0 explicit delete_bookmark ops.
    expect(result.counts.bookmarksDeleted).toBe(0)
    const deleteFolderOps = result.ops.filter((o) => o.kind === 'delete_folder')
    expect(deleteFolderOps).toHaveLength(2)
  })
})

// ─── Pure add ─────────────────────────────────────────────────────────────

describe('diffIncoming — pure add', () => {
  it('emits upsert ops for new folders and bookmarks not in DB', () => {
    const input: SyncInput = {
      folders: [f('f1', null, 'F1')],
      bookmarks: [b('m1', 'f1')],
    }
    const result = diffIncoming(input, emptyDb())

    expect(result.ops).toHaveLength(2)
    expect(result.counts.foldersUpserted).toBe(1)
    expect(result.counts.bookmarksUpserted).toBe(1)
    expect(result.counts.foldersDeleted).toBe(0)
    expect(result.counts.bookmarksDeleted).toBe(0)

    const upsertFolder = result.ops.find((o) => o.kind === 'upsert_folder')
    expect(upsertFolder).toEqual({
      kind: 'upsert_folder',
      chromeId: 'f1',
      parentChromeId: null,
      name: 'F1',
    })

    const upsertBookmark = result.ops.find(
      (o) => o.kind === 'upsert_bookmark',
    )
    expect(upsertBookmark).toMatchObject({
      kind: 'upsert_bookmark',
      chromeId: 'm1',
      folderChromeId: 'f1',
    })
  })

  it('adds a deeply nested folder chain', () => {
    const input: SyncInput = {
      folders: [
        f('a', null, 'A'),
        f('b', 'a', 'B'),
        f('c', 'b', 'C'),
        f('d', 'c', 'D'),
      ],
      bookmarks: [],
    }
    const result = diffIncoming(input, emptyDb())
    expect(result.counts.foldersUpserted).toBe(4)
    expect(result.ops.filter((o) => o.kind === 'upsert_folder')).toHaveLength(4)
  })
})

// ─── Pure delete ──────────────────────────────────────────────────────────

describe('diffIncoming — pure delete', () => {
  it('emits delete_folder for DB folders not in incoming', () => {
    const db: DbState = dbFrom({
      folders: [dbFolder('f1'), dbFolder('f2', { parentChromeId: 'f1' })],
      bookmarks: [],
    })
    const result = diffIncoming({ folders: [], bookmarks: [] }, db)
    expect(result.counts.foldersDeleted).toBe(2)
    const deleteOps = result.ops.filter((o) => o.kind === 'delete_folder')
    expect(deleteOps.map((o) => o.chromeId).sort()).toEqual(['f1', 'f2'])
  })

  it('emits delete_bookmark for bookmarks not in incoming (folder survives)', () => {
    const db: DbState = dbFrom({
      folders: [dbFolder('f1')],
      bookmarks: [
        dbBookmark('m1', { folderChromeId: 'f1' }),
        dbBookmark('m2', { folderChromeId: 'f1' }),
      ],
    })
    const input: SyncInput = {
      folders: [f('f1', null, 'F1')],
      bookmarks: [b('m1', 'f1')], // only m1 stays
    }
    const result = diffIncoming(input, db)
    expect(result.counts.bookmarksDeleted).toBe(1)
    expect(result.counts.foldersDeleted).toBe(0)
    const deleteOps = result.ops.filter((o) => o.kind === 'delete_bookmark')
    expect(deleteOps).toHaveLength(1)
    expect(deleteOps[0]).toEqual({
      kind: 'delete_bookmark',
      chromeId: 'm2',
    })
  })

  it('does NOT emit delete_bookmark when the bookmark\'s folder is being deleted (cascade handles it)', () => {
    // DB has folder f1 with bookmark m1. Incoming has nothing.
    // Expected: 1 delete_folder (cascade removes m1).
    // We should NOT also emit delete_bookmark(m1) — cascade does the work.
    const db: DbState = dbFrom({
      folders: [dbFolder('f1')],
      bookmarks: [dbBookmark('m1', { folderChromeId: 'f1' })],
    })
    const result = diffIncoming({ folders: [], bookmarks: [] }, db)

    expect(result.counts.foldersDeleted).toBe(1)
    expect(result.counts.bookmarksDeleted).toBe(0)
    expect(result.ops.filter((o) => o.kind === 'delete_folder')).toHaveLength(1)
    expect(result.ops.filter((o) => o.kind === 'delete_bookmark')).toHaveLength(
      0,
    )
  })

  it('cascade-eliminates nested folders when a top folder is deleted', () => {
    // DB has: a → b → c (folder tree), plus bookmarks in each
    const db: DbState = dbFrom({
      folders: [
        dbFolder('a'),
        dbFolder('b', { parentChromeId: 'a' }),
        dbFolder('c', { parentChromeId: 'b' }),
      ],
      bookmarks: [
        dbBookmark('m1', { folderChromeId: 'a' }),
        dbBookmark('m2', { folderChromeId: 'b' }),
        dbBookmark('m3', { folderChromeId: 'c' }),
      ],
    })
    const result = diffIncoming({ folders: [], bookmarks: [] }, db)

    // 3 folder deletes. All bookmarks cascade away — no explicit
    // delete_bookmark ops because their folders are all being deleted.
    expect(result.counts.foldersDeleted).toBe(3)
    expect(result.counts.bookmarksDeleted).toBe(0)
  })
})

// ─── Pure move ────────────────────────────────────────────────────────────

describe('diffIncoming — pure move (re-parenting)', () => {
  it('emits upsert_folder when a folder changes parent', () => {
    const db: DbState = dbFrom({
      folders: [
        dbFolder('a'),
        dbFolder('b'),
        dbFolder('child', { parentChromeId: 'a' }),
      ],
      bookmarks: [],
    })
    // Move child from a to b
    const input: SyncInput = {
      folders: [
        f('a', null, 'Folder a'),
        f('b', null, 'Folder b'),
        f('child', 'b', 'Folder child'),
      ],
      bookmarks: [],
    }
    const result = diffIncoming(input, db)

    expect(result.counts.foldersUpserted).toBe(1)
    expect(result.counts.foldersDeleted).toBe(0)
    const upsertOps = result.ops.filter((o) => o.kind === 'upsert_folder')
    expect(upsertOps).toHaveLength(1)
    expect(upsertOps[0]).toEqual({
      kind: 'upsert_folder',
      chromeId: 'child',
      parentChromeId: 'b',
      name: 'Folder child',
    })
  })

  it('emits upsert_bookmark when a bookmark changes folder', () => {
    const db: DbState = dbFrom({
      folders: [dbFolder('a'), dbFolder('b')],
      bookmarks: [dbBookmark('m1', { folderChromeId: 'a' })],
    })
    const input: SyncInput = {
      folders: [f('a', null, 'Folder a'), f('b', null, 'Folder b')],
      bookmarks: [b('m1', 'b')],
    }
    const result = diffIncoming(input, db)

    expect(result.counts.bookmarksUpserted).toBe(1)
    const upsertOps = result.ops.filter((o) => o.kind === 'upsert_bookmark')
    expect(upsertOps).toHaveLength(1)
    expect(upsertOps[0]).toMatchObject({
      kind: 'upsert_bookmark',
      chromeId: 'm1',
      folderChromeId: 'b',
    })
  })
})

// ─── Update in place ──────────────────────────────────────────────────────

describe('diffIncoming — update in place (rename / retitle / change URL)', () => {
  it('emits upsert_folder when folder name changes', () => {
    const db: DbState = dbFrom({
      folders: [dbFolder('f1', { name: 'Old' })],
      bookmarks: [],
    })
    const input: SyncInput = {
      folders: [f('f1', null, 'New')],
      bookmarks: [],
    }
    const result = diffIncoming(input, db)
    expect(result.counts.foldersUpserted).toBe(1)
  })

  it('emits upsert_bookmark when bookmark title changes', () => {
    const db: DbState = dbFrom({
      folders: [dbFolder('f1')],
      bookmarks: [dbBookmark('m1', { folderChromeId: 'f1', title: 'Old' })],
    })
    const input: SyncInput = {
      folders: [f('f1', null, 'F1')],
      bookmarks: [b('m1', 'f1', 'https://m1.example.com', 'New')],
    }
    const result = diffIncoming(input, db)
    expect(result.counts.bookmarksUpserted).toBe(1)
    const upsertOps = result.ops.filter((o) => o.kind === 'upsert_bookmark')
    expect(upsertOps[0]).toMatchObject({
      kind: 'upsert_bookmark',
      chromeId: 'm1',
      title: 'New',
    })
  })
})

// ─── Conflict: chrome_id ↔ URL ────────────────────────────────────────────

describe('diffIncoming — chrome_id ↔ URL conflict', () => {
  it('treats a URL change for an existing chromeId as an update, not an error', () => {
    // The issue spec calls this out: a bookmark with the same chromeId
    // but different URL between DB and incoming. This is a normal
    // bookmark edit (user changed the URL via Chrome's edit dialog).
    // The differ produces an upsert with the new URL; the bookmark
    // keeps its server id.
    const db: DbState = dbFrom({
      folders: [dbFolder('f1')],
      bookmarks: [
        dbBookmark('m1', { folderChromeId: 'f1', url: 'https://OLD.example.com' }),
      ],
    })
    const input: SyncInput = {
      folders: [f('f1', null, 'F1')],
      bookmarks: [
        b('m1', 'f1', 'https://NEW.example.com', 'Title'),
      ],
    }

    const result = diffIncoming(input, db)

    expect(result.counts.bookmarksUpserted).toBe(1)
    expect(result.counts.bookmarksDeleted).toBe(0)
    expect(result.counts.foldersDeleted).toBe(0)
    const upsertOps = result.ops.filter((o) => o.kind === 'upsert_bookmark')
    expect(upsertOps).toHaveLength(1)
    expect(upsertOps[0]).toMatchObject({
      kind: 'upsert_bookmark',
      chromeId: 'm1',
      url: 'https://NEW.example.com',
    })
  })
})

// ─── Mixed ops ────────────────────────────────────────────────────────────

describe('diffIncoming — mixed operations', () => {
  it('emits correct mix of upsert/delete for a complex reconciliation', () => {
    // DB: folders {a, b, c} where b is child of a; bookmarks {m1 in a, m2 in b, m3 in c}
    // Incoming: folders {a (renamed), d (new)}; bookmarks {m1 in a (unchanged), m2 in a (moved), m4 in d (new)}
    // Expected:
    //   - upsert_folder(a) — renamed
    //   - upsert_folder(d) — new
    //   - delete_folder(b) — gone, cascade removes m2 if not re-added
    //   - delete_folder(c) — gone, cascade removes m3
    //   - upsert_bookmark(m2) — moved from b to a
    //   - upsert_bookmark(m4) — new
    //   - delete_bookmark is NOT needed for m2 because m2 was re-added (folder b is gone but m2 moved to a)
    //   - delete_bookmark is NOT needed for m3 because c is deleted (cascade)
    const db: DbState = dbFrom({
      folders: [
        dbFolder('a', { name: 'A old' }),
        dbFolder('b', { parentChromeId: 'a' }),
        dbFolder('c'),
      ],
      bookmarks: [
        dbBookmark('m1', { folderChromeId: 'a' }),
        dbBookmark('m2', { folderChromeId: 'b' }),
        dbBookmark('m3', { folderChromeId: 'c' }),
      ],
    })
    const input: SyncInput = {
      folders: [f('a', null, 'A new'), f('d', null, 'D')],
      bookmarks: [b('m1', 'a'), b('m2', 'a'), b('m4', 'd')],
    }
    const result = diffIncoming(input, db)

    expect(result.counts.foldersUpserted).toBe(2) // a renamed + d new
    expect(result.counts.foldersDeleted).toBe(2) // b + c gone
    expect(result.counts.bookmarksUpserted).toBe(2) // m2 moved, m4 new
    expect(result.counts.bookmarksDeleted).toBe(0) // m3 cascades with c

    // Total ops: 2 folder upserts + 2 folder deletes + 2 bookmark upserts
    expect(result.ops).toHaveLength(6)
  })

  it('handles a folder rename + child bookmark moving away', () => {
    // Rename folder + move a bookmark out of it (now empty)
    const db: DbState = dbFrom({
      folders: [dbFolder('a'), dbFolder('b')],
      bookmarks: [dbBookmark('m1', { folderChromeId: 'a' })],
    })
    const input: SyncInput = {
      folders: [f('a', null, 'A renamed'), f('b', null, 'Folder b')],
      bookmarks: [b('m1', 'b')],
    }
    const result = diffIncoming(input, db)

    expect(result.counts.foldersUpserted).toBe(1) // a renamed
    expect(result.counts.foldersDeleted).toBe(0)
    expect(result.counts.bookmarksUpserted).toBe(1) // m1 moved
    expect(result.counts.bookmarksDeleted).toBe(0)
  })
})

// ─── Validation delegation ───────────────────────────────────────────────

describe('diffIncoming — validation delegation', () => {
  it('throws SyncPlanError for duplicate folder chromeIds (delegated to builder)', () => {
    const input: SyncInput = {
      folders: [
        f('dup', null, 'A'),
        f('dup', null, 'B'),
      ],
      bookmarks: [],
    }
    expect(() => diffIncoming(input, emptyDb())).toThrow(SyncPlanError)
  })

  it('throws SyncPlanError for cycles', () => {
    const input: SyncInput = {
      folders: [f('a', 'b', 'A'), f('b', 'a', 'B')],
      bookmarks: [],
    }
    expect(() => diffIncoming(input, emptyDb())).toThrow(SyncPlanError)
  })

  it('throws SyncPlanError for bookmarks referencing unknown folders', () => {
    const input: SyncInput = {
      folders: [f('f1', null, 'F1')],
      bookmarks: [b('m1', 'nonexistent')],
    }
    expect(() => diffIncoming(input, emptyDb())).toThrow(SyncPlanError)
  })
})

// ─── DiffError not currently thrown (forward compat) ────────────────────

describe('diffIncoming — DiffError', () => {
  it('exports DiffError for forward compatibility (currently unused)', () => {
    // The differ doesn't throw DiffError today — every case is handled
    // by either an upsert or a delete op. The class exists so future
    // ambiguous-reconciliation scenarios (e.g., a chromeId appearing
    // under two parents) have a clear error type.
    const err = new DiffError('placeholder', 'placeholder_code')
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('placeholder_code')
    expect(err.name).toBe('DiffError')
  })
})