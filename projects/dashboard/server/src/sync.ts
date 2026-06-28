// sync.ts — thin orchestrator that applies the extension's sync input to
// the DB via the BookmarkDiffer.
//
// Responsibilities (and ONLY these):
//   1. Snapshot the DB state (readDbState).
//   2. Compute the minimal CRUD ops (BookmarkDiffer).
//   3. Apply the ops in a transaction:
//        - Deletes first (FK cascade handles descendants).
//        - Then folder upserts in topological order (parents first).
//        - Then bookmark upserts (folder_id resolved via in-memory map).
//   4. Return a SyncResult with the chromeId → serverId map and counts.
//
// NOT responsible for:
//   - Validation (FolderTreeBuilder via BookmarkDiffer does that)
//   - Diffing against existing DB state (BookmarkDiffer, this issue)
//   - HTTP serialization (bookmarks.ts does that)
//
// Why diff-then-apply (vs the #005 blind upsert):
//   - #005 didn't handle deletes. Re-syncing the same tree never
//     cleaned up bookmarks/folders the user had removed in Chrome.
//   - The differ computes the minimal ops, so we only write what's
//     actually different. Idempotent re-syncs become real no-ops on
//     the DB (zero UPDATE/INSERT statements against matching rows).

import { randomUUID } from 'node:crypto'
import type { Database } from './db.js'
import {
  buildSyncPlan,
  SyncPlanError,
  type SyncInput,
} from './folder-tree-builder.js'
import {
  diffIncoming,
  readDbState,
  type SyncOp,
} from './bookmark-differ.js'
import { bulkRecomputeTrigrams } from './search.js'

// Re-export SyncInput so route handlers and tests can import everything
// they need from `./sync.js` instead of reaching into the deep modules.
export type { SyncInput }

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Result of a successful sync. `idMap` lets the extension cache
 * chromeId → serverId for future per-event updates. Counts are surfaced
 * so the UI can show "N added, M updated, K deleted" feedback.
 *
 * The "created" / "updated" counts mirror the differ's
 * foldersUpserted/bookmarksUpserted counts. We split upserts into
 * created vs updated at apply time so the UI gets a more useful signal.
 */
export interface SyncResult {
  readonly ok: true
  readonly received: true
  readonly idMap: {
    /** chromeId → serverId for folders. Plain object for JSON safety. */
    readonly folders: Readonly<Record<string, string>>
    /** chromeId → serverId for bookmarks. Plain object for JSON safety. */
    readonly bookmarks: Readonly<Record<string, string>>
  }
  readonly counts: {
    readonly foldersCreated: number
    readonly foldersUpdated: number
    readonly foldersDeleted: number
    readonly bookmarksCreated: number
    readonly bookmarksUpdated: number
    readonly bookmarksDeleted: number
  }
  /** Echo of the `syncedFrom` field from the request body, if present.
   *  Useful for the extension to confirm the server received its
   *  marker. Not persisted (per #006 design — could become a log table
   *  in a future issue if analytics become needed). */
  readonly syncedFrom?: string
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Apply the extension's sync input to the DB via the differ.
 * Idempotent: re-running with the same input against an unchanged DB
 * is a true no-op (zero write statements).
 *
 * Throws `SyncPlanError` on validation failures (delegated to
 * FolderTreeBuilder via the differ). Any other error inside the
 * transaction causes a full rollback via the Database wrapper.
 */
export function applySync(
  db: Database,
  input: SyncInput,
  opts: { syncedFrom?: string } = {},
): SyncResult {
  // ─── Step 1: snapshot current DB state ─────────────────────────────
  // Two SELECTs (one per table). Used by the differ for comparison.
  const dbState = readDbState(db)

  // ─── Step 2: compute minimal ops via differ ────────────────────────
  // Throws SyncPlanError on validation failure (delegated to
  // FolderTreeBuilder). The route handler converts that to HTTP 400.
  const diff = diffIncoming(input, dbState)

  // ─── Step 3: apply ops in a transaction ────────────────────────────
  // applyOps returns the public SyncResult plus the list of bookmark
  // serverIds whose title/url changed (so we can refresh their trigram
  // index for fuzzy search). The trigram recompute runs AFTER the
  // transaction commits — better-sqlite3's nested-transaction savepoints
  // only work when the inner tx function is pre-created, which is
  // awkward inside a hot loop. Running it after the commit is cheaper
  // anyway (one bulk transaction instead of N savepoints).
  const { result, touchedBookmarkIds } = db.transaction(() =>
    applyOps(db, input, dbState, diff, opts),
  )
  bulkRecomputeTrigrams(db, touchedBookmarkIds)
  return result
}

// ─── Internal: apply ops ──────────────────────────────────────────────────

/**
 * Walk the differ's ops and apply them to the DB inside a transaction.
 * Caller wraps this in `db.transaction()` so any throw rolls back.
 *
 * Order matters:
 *   1. Deletes first — `ON DELETE CASCADE` cleans up child folders and
 *      bookmarks when a folder is deleted. We must do all folder
 *      deletes before any upserts because an upsert might re-parent a
 *      folder under one we're about to delete.
 *   2. Folder upserts in topological order (parents before children).
 *      This is enforced by buildSyncPlan; we re-derive it here so the
 *      differ's plan is reused for ordering.
 *   3. Bookmark upserts (folder_id resolves via the chromeId→serverId
 *      map built up during folder upserts).
 */
function applyOps(
  db: Database,
  input: SyncInput,
  dbState: ReturnType<typeof readDbState>,
  diff: ReturnType<typeof diffIncoming>,
  opts: { syncedFrom?: string },
): { result: SyncResult; touchedBookmarkIds: string[] } {
  // ─── Step 1: deletes ────────────────────────────────────────────────
  for (const op of diff.ops) {
    if (op.kind === 'delete_folder') {
      const dbFolder = dbState.folders.get(op.chromeId)
      if (dbFolder) {
        db.run('DELETE FROM folders WHERE id = ?', [dbFolder.id])
      }
    } else if (op.kind === 'delete_bookmark') {
      const dbBookmark = dbState.bookmarks.get(op.chromeId)
      if (dbBookmark) {
        db.run('DELETE FROM bookmarks WHERE id = ?', [dbBookmark.id])
      }
    }
  }

  // ─── Step 2: folder upserts ────────────────────────────────────────
  // Re-derive the plan to get topological order + the foldersByChromeId
  // map. The differ already did this work; we re-call because the plan
  // is also needed for bookmark folder resolution below, and the
  // differ doesn't expose its plan. (Future: have the differ return the
  // plan alongside ops. For now this is cheap.)
  const plan = buildSyncPlan(input)

  // Map chromeId → serverId. Seed with existing folders that aren't
  // being deleted. New folders get added as we INSERT them.
  const folderIdMap = new Map<string, string>()
  for (const [chromeId, f] of dbState.folders) {
    // If the folder still exists in incoming, it's still in the DB
    // (we only deleted folders not in incoming).
    if (plan.foldersByChromeId.has(chromeId)) {
      folderIdMap.set(chromeId, f.id)
    }
  }

  let foldersCreated = 0
  let foldersUpdated = 0
  const upsertFolderOps = new Set(
    diff.ops
      .filter((o): o is Extract<SyncOp, { kind: 'upsert_folder' }> => o.kind === 'upsert_folder')
      .map((o) => o.chromeId),
  )

  for (const folder of plan.sortedFolders) {
    if (!upsertFolderOps.has(folder.chromeId)) continue // no-op for this folder
    const op = diff.ops.find(
      (o): o is Extract<SyncOp, { kind: 'upsert_folder' }> =>
        o.kind === 'upsert_folder' && o.chromeId === folder.chromeId,
    )
    if (!op) continue

    // Resolve parent serverId. Parents always come first in sorted
    // order, so by the time we INSERT a child, its parent is either
    // (a) an existing folder (in folderIdMap from the seed loop) or
    // (b) a folder we just inserted (added to folderIdMap in this loop).
    const parentServerId =
      folder.parentChromeId === null
        ? null
        : folderIdMap.get(folder.parentChromeId) ?? null

    const existing = dbState.folders.get(folder.chromeId)
    if (existing) {
      db.run(
        'UPDATE folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?',
        [op.name, parentServerId, nowIso(), existing.id],
      )
      folderIdMap.set(folder.chromeId, existing.id)
      foldersUpdated++
    } else {
      const serverId = randomUUID()
      db.run(
        `INSERT INTO folders (id, parent_id, name, chrome_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [serverId, parentServerId, op.name, folder.chromeId, nowIso(), nowIso()],
      )
      folderIdMap.set(folder.chromeId, serverId)
      foldersCreated++
    }
  }

  // ─── Step 3: bookmark upserts ──────────────────────────────────────
  // Seed bookmarkIdMap with ALL existing bookmarks that are in
  // incoming (i.e., not deleted). Same logic as folderIdMap — the
  // returned idMap covers every chromeId, touched or untouched, so
  // the extension can cache chromeId→serverId for any row.
  const bookmarkIdMap: Record<string, string> = {}
  const incomingBookmarkChromeIds = new Set(plan.bookmarks.map((b) => b.chromeId))
  for (const [chromeId, b] of dbState.bookmarks) {
    if (incomingBookmarkChromeIds.has(chromeId)) {
      bookmarkIdMap[chromeId] = b.id
    }
  }

  let bookmarksCreated = 0
  let bookmarksUpdated = 0
  const touchedBookmarkIds: string[] = []
  const upsertBookmarkOps = new Set(
    diff.ops
      .filter((o): o is Extract<SyncOp, { kind: 'upsert_bookmark' }> => o.kind === 'upsert_bookmark')
      .map((o) => o.chromeId),
  )

  for (const bookmark of plan.bookmarks) {
    if (!upsertBookmarkOps.has(bookmark.chromeId)) continue
    const op = diff.ops.find(
      (o): o is Extract<SyncOp, { kind: 'upsert_bookmark' }> =>
        o.kind === 'upsert_bookmark' && o.chromeId === bookmark.chromeId,
    )
    if (!op) continue

    const folderServerId = folderIdMap.get(op.folderChromeId)
    if (!folderServerId) continue // defensive; builder already validated

    const existing = dbState.bookmarks.get(bookmark.chromeId)
    if (existing) {
      db.run(
        `UPDATE bookmarks
         SET url = ?, title = ?, folder_id = ?, updated_at = ?
         WHERE id = ?`,
        [op.url, op.title, folderServerId, nowIso(), existing.id],
      )
      bookmarkIdMap[bookmark.chromeId] = existing.id
      bookmarksUpdated++
      touchedBookmarkIds.push(existing.id)
    } else {
      const serverId = randomUUID()
      const createdAt = op.createdAt ?? nowIso()
      const updatedAt = op.updatedAt ?? nowIso()
      db.run(
        `INSERT INTO bookmarks
           (id, url, title, folder_id, chrome_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          serverId,
          op.url,
          op.title,
          folderServerId,
          op.chromeId,
          createdAt,
          updatedAt,
        ],
      )
      bookmarkIdMap[bookmark.chromeId] = serverId
      bookmarksCreated++
      touchedBookmarkIds.push(serverId)
    }
  }

  return {
    result: {
      ok: true as const,
      received: true as const,
      idMap: {
        folders: Object.fromEntries(folderIdMap),
        bookmarks: bookmarkIdMap,
      },
      counts: {
        foldersCreated,
        foldersUpdated,
        foldersDeleted: diff.counts.foldersDeleted,
        bookmarksCreated,
        bookmarksUpdated,
        bookmarksDeleted: diff.counts.bookmarksDeleted,
      },
      ...(opts.syncedFrom !== undefined ? { syncedFrom: opts.syncedFrom } : {}),
    },
    touchedBookmarkIds,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** ISO 8601 timestamp with millisecond precision. SQLite stores as TEXT. */
function nowIso(): string {
  return new Date().toISOString()
}

// Re-export SyncPlanError so route handlers only need to import from one
// place to discriminate validation failures from generic errors.
export { SyncPlanError }