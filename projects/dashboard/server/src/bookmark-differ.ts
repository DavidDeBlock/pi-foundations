// bookmark-differ.ts — pure deep module that computes the minimal set of
// CRUD operations needed to bring the DB in line with the extension's
// incoming tree.
//
// Responsibilities (and ONLY these):
//   - Compare incoming SyncInput against current DbState.
//   - Emit minimal SyncOp[] that, when applied in order, reconcile the
//     two states (insert, update, delete, move).
//   - Validate the incoming tree via FolderTreeBuilder before diffing
//     (delegated — cycles, duplicates, dangling refs are caught there).
//   - Account for FK cascade so we don't emit redundant delete ops for
//     bookmarks whose folder is also being deleted.
//
// NOT responsible for:
//   - DB reads (caller passes DbState)
//   - DB writes (sync.ts does that)
//   - HTTP serialization (bookmarks.ts does that)
//
// Why a separate module from sync.ts:
//   - The differ is pure and side-effect free; testing it requires only
//     the input + dbState, no DB at all.
//   - The differ can be reused by future endpoints (e.g., a "diff" debug
//     endpoint) without dragging the DB along.
//   - Separating "what should change" from "apply the change" follows
//     the same shape as FolderTreeBuilder (validate) → SyncHandler
//     (apply). Easy to reason about, easy to evolve.

import {
  buildSyncPlan,
  type SyncInput,
} from './folder-tree-builder.js'

// ─── DbState (caller provides this) ───────────────────────────────────────

/**
 * One folder as it exists in the DB. The differ only needs identity
 * (chromeId, parentChromeId, name) — not server id or timestamps.
 */
export interface DbFolderState {
  readonly id: string
  readonly chromeId: string
  readonly parentChromeId: string | null
  readonly name: string
}

/**
 * One bookmark as it exists in the DB. chromeId is the identity; URL,
 * title, folderChromeId are the data we compare for staleness.
 */
export interface DbBookmarkState {
  readonly id: string
  readonly chromeId: string
  readonly folderChromeId: string
  readonly url: string
  readonly title: string
}

/**
 * Snapshot of the DB state relevant to a sync. Caller builds this once
 * per sync (two `SELECT *` queries) and passes it to the differ.
 *
 * Keyed by chromeId so the differ can do O(1) lookups.
 */
export interface DbState {
  readonly folders: ReadonlyMap<string, DbFolderState>
  readonly bookmarks: ReadonlyMap<string, DbBookmarkState>
}

// ─── Ops (differ output) ─────────────────────────────────────────────────

/**
 * One atomic operation to apply to the DB. The sync handler walks the
 * ops in order: deletes first (cascade handles children), then upserts
 * in topological order (parents first → FK satisfied).
 */
export type SyncOp =
  | {
      readonly kind: 'upsert_folder'
      readonly chromeId: string
      readonly parentChromeId: string | null
      readonly name: string
    }
  | { readonly kind: 'delete_folder'; readonly chromeId: string }
  | {
      readonly kind: 'upsert_bookmark'
      readonly chromeId: string
      readonly folderChromeId: string
      readonly url: string
      readonly title: string
      readonly createdAt?: string
      readonly updatedAt?: string
    }
  | { readonly kind: 'delete_bookmark'; readonly chromeId: string }

/**
 * Result of the diff. `ops` is the actual work to do; `counts` is a
 * summary the API surfaces so the UI can show "0 added, 1 updated,
 * 2 deleted" feedback.
 */
export interface DiffResult {
  readonly ops: readonly SyncOp[]
  readonly counts: {
    readonly foldersUpserted: number
    readonly foldersDeleted: number
    readonly bookmarksUpserted: number
    readonly bookmarksDeleted: number
  }
}

// ─── Errors ────────────────────────────────────────────────────────────────

/**
 * Thrown when the diff encounters something it can't reconcile.
 * Today the differ doesn't throw — every case falls into a "treat as
 * upsert/delete" bucket. The class exists for forward compatibility:
 * if a future chrome_id-vs-URL semantic needs user intervention (e.g.,
 * Chrome's id reuse in a way that's ambiguous), the differ will throw
 * here.
 */
export class DiffError extends Error {
  public readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'DiffError'
    this.code = code
  }
}

// ─── Differ ───────────────────────────────────────────────────────────────

/**
 * Compute the minimal set of CRUD ops needed to reconcile the incoming
 * tree against the current DB state.
 *
 * Algorithm:
 *   1. Validate the incoming tree via FolderTreeBuilder. Throws
 *      SyncPlanError on structural problems (delegated).
 *   2. For each incoming folder:
 *        - If not in DB → upsert_folder.
 *        - If in DB but name or parentChromeId differs → upsert_folder.
 *        - Otherwise → no-op.
 *   3. For each DB folder not present in incoming → delete_folder.
 *      Cascading FKs clean up child folders + bookmarks.
 *   4. For each incoming bookmark:
 *        - If not in DB → upsert_bookmark.
 *        - If in DB but url/title/folderChromeId differs → upsert_bookmark.
 *        - Otherwise → no-op.
 *   5. For each DB bookmark not present in incoming:
 *        - If its folder is also being deleted → skip (cascade handles it).
 *        - Else → delete_bookmark.
 *
 * Step 5 is the only place we look at "what else is being deleted" —
 * avoids emitting redundant delete ops that the DB would reject or
 * cascade anyway.
 *
 * Note on the "conflict between chrome_id and URL" case from the issue
 * spec: a bookmark with chromeId X in the DB has URL Z, and the same
 * chromeId X in the incoming has URL Y (Y ≠ Z). This is a normal
 * bookmark edit (user changed the URL) — step 4 emits an upsert with
 * the new URL. Not an error.
 */
export function diffIncoming(
  incoming: SyncInput,
  dbState: DbState,
): DiffResult {
  // ─── Step 1: validate incoming + get topological order ─────────────
  // buildSyncPlan throws SyncPlanError on structural problems; we let
  // it propagate so the route handler converts it to HTTP 400 with a
  // structured error code (same contract as #005).
  const plan = buildSyncPlan(incoming)

  const ops: SyncOp[] = []

  // ─── Step 2: folder upserts (from incoming) ────────────────────────
  let foldersUpserted = 0
  for (const folder of plan.sortedFolders) {
    const dbFolder = dbState.folders.get(folder.chromeId)

    if (!dbFolder) {
      // New folder (or one we lost track of after a previous delete).
      ops.push({
        kind: 'upsert_folder',
        chromeId: folder.chromeId,
        parentChromeId: folder.parentChromeId,
        name: folder.name,
      })
      foldersUpserted++
      continue
    }

    // Existing folder: only emit upsert if something changed.
    if (
      dbFolder.name !== folder.name ||
      dbFolder.parentChromeId !== folder.parentChromeId
    ) {
      ops.push({
        kind: 'upsert_folder',
        chromeId: folder.chromeId,
        parentChromeId: folder.parentChromeId,
        name: folder.name,
      })
      foldersUpserted++
    }
    // else: no-op — folder is already in the desired state
  }

  // ─── Step 3: folder deletes (DB-only) ──────────────────────────────
  // We collect the set of folder chromeIds being deleted so step 5
  // can decide whether to emit redundant bookmark deletes.
  const foldersBeingDeleted = new Set<string>()
  let foldersDeleted = 0
  for (const dbFolder of dbState.folders.values()) {
    if (plan.foldersByChromeId.has(dbFolder.chromeId)) continue
    foldersBeingDeleted.add(dbFolder.chromeId)
    ops.push({ kind: 'delete_folder', chromeId: dbFolder.chromeId })
    foldersDeleted++
  }

  // ─── Step 4: bookmark upserts (from incoming) ───────────────────────
  let bookmarksUpserted = 0
  for (const bookmark of plan.bookmarks) {
    const dbBookmark = dbState.bookmarks.get(bookmark.chromeId)

    if (!dbBookmark) {
      // New bookmark.
      ops.push({
        kind: 'upsert_bookmark',
        chromeId: bookmark.chromeId,
        folderChromeId: bookmark.folderChromeId,
        url: bookmark.url,
        title: bookmark.title,
        ...(bookmark.createdAt !== undefined
          ? { createdAt: bookmark.createdAt }
          : {}),
        ...(bookmark.updatedAt !== undefined
          ? { updatedAt: bookmark.updatedAt }
          : {}),
      })
      bookmarksUpserted++
      continue
    }

    // Existing bookmark: only emit upsert if something changed. The
    // URL change case is the "conflict between chrome_id and URL"
    // scenario from the issue spec — treated as a normal update, not
    // an error. The bookmark id stays stable across URL edits.
    if (
      dbBookmark.url !== bookmark.url ||
      dbBookmark.title !== bookmark.title ||
      dbBookmark.folderChromeId !== bookmark.folderChromeId
    ) {
      ops.push({
        kind: 'upsert_bookmark',
        chromeId: bookmark.chromeId,
        folderChromeId: bookmark.folderChromeId,
        url: bookmark.url,
        title: bookmark.title,
        ...(bookmark.createdAt !== undefined
          ? { createdAt: bookmark.createdAt }
          : {}),
        ...(bookmark.updatedAt !== undefined
          ? { updatedAt: bookmark.updatedAt }
          : {}),
      })
      bookmarksUpserted++
    }
    // else: no-op — bookmark is already in the desired state
  }

  // ─── Step 5: bookmark deletes (DB-only, minus cascade-deleted) ─────
  // For each DB bookmark, decide whether to emit a delete op:
  //   - If the bookmark IS in the incoming tree → skip (still exists)
  //   - If the bookmark's folder is being deleted → skip (cascade handles it)
  //   - Otherwise → emit delete_bookmark
  //
  // We compute the incoming bookmark id set up front for O(1) lookups
  // in the loop below. The check is unconditional — incoming may
  // contain folders without bookmarks (e.g. an empty Bookmarks bar),
  // and we still need to detect which DB bookmarks are no longer
  // present.
  const incomingBookmarkIds = new Set(plan.bookmarks.map((b) => b.chromeId))
  let bookmarksDeleted = 0
  for (const dbBookmark of dbState.bookmarks.values()) {
    if (incomingBookmarkIds.has(dbBookmark.chromeId)) continue

    // If the bookmark's folder is being deleted, the FK cascade
    // already removes the bookmark — emitting delete_bookmark would
    // either no-op (row already gone) or worse, cause a confusing
    // "row not found" intermediate state in logs.
    if (foldersBeingDeleted.has(dbBookmark.folderChromeId)) continue

    ops.push({ kind: 'delete_bookmark', chromeId: dbBookmark.chromeId })
    bookmarksDeleted++
  }

  return {
    ops,
    counts: {
      foldersUpserted,
      foldersDeleted,
      bookmarksUpserted,
      bookmarksDeleted,
    },
  }
}

// ─── Helpers for callers ─────────────────────────────────────────────────

/**
 * Read the current DB state into a DbState snapshot. Synchronous
 * (better-sqlite3 is sync). Used by the sync handler before calling
 * the differ.
 *
 * Exported so tests and future debug endpoints can build DbState
 * directly without going through the sync handler.
 */
export function readDbState(db: {
  all<T>(sql: string, params?: readonly unknown[]): T[]
}): DbState {
  const folderRows = db.all<{
    id: string
    chrome_id: string | null
    parent_id: string | null
    name: string
  }>('SELECT id, chrome_id, parent_id, name FROM folders')

  // Resolve parent chromeId via server id map. We need parent_chrome_id
  // for the differ's comparison logic.
  const folderIdToChromeId = new Map<string, string>()
  for (const row of folderRows) {
    if (row.chrome_id !== null) folderIdToChromeId.set(row.id, row.chrome_id)
  }

  const folders = new Map<string, DbFolderState>()
  for (const row of folderRows) {
    if (row.chrome_id === null) continue // skip rootless folders
    const parentChromeId =
      row.parent_id === null
        ? null
        : (folderIdToChromeId.get(row.parent_id) ?? null)
    folders.set(row.chrome_id, {
      id: row.id,
      chromeId: row.chrome_id,
      parentChromeId,
      name: row.name,
    })
  }

  const bookmarkRows = db.all<{
    id: string
    chrome_id: string | null
    folder_id: string
    url: string
    title: string
  }>('SELECT id, chrome_id, folder_id, url, title FROM bookmarks')

  const bookmarks = new Map<string, DbBookmarkState>()
  for (const row of bookmarkRows) {
    if (row.chrome_id === null) continue
    const folderChromeId = folderIdToChromeId.get(row.folder_id)
    if (folderChromeId === undefined) continue // orphaned bookmark; skip
    bookmarks.set(row.chrome_id, {
      id: row.id,
      chromeId: row.chrome_id,
      folderChromeId,
      url: row.url,
      title: row.title,
    })
  }

  return { folders, bookmarks }
}