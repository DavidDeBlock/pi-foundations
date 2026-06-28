// folder-tree-builder.ts — pure deep module for the Chrome → server sync path.
//
// Converts the extension's flat sync input (folder records with parent
// references + bookmark refs) into a validated, topologically-sorted
// plan ready for DB insertion.
//
// Responsibilities (and ONLY these — no I/O):
//   1. Validate input shape: no duplicate chromeIds, no dangling parent
//      references, no cycles, every bookmark's folderChromeId resolves.
//   2. Topologically sort folders so parents insert before children —
//      SQLite FK constraints require this order when inserting in a
//      single pass.
//   3. Build the nested tree so callers can render or inspect the input
//      (the sync API returns this to the extension for sanity).
//
// NOT responsible for:
//   - DB writes (the sync handler does that)
//   - chromeId → serverId mapping (sync handler resolves that against
//     the DB; this module is pure)
//   - Diffing against existing DB state (BookmarkDiffer, #006)
//
// The module is intentionally side-effect free so it can be unit-tested
// in isolation — see folder-tree-builder.test.ts.

// ─── Input shapes (extension-facing) ──────────────────────────────────────

/**
 * One folder record as sent by the extension. Mirrors Chrome's bookmark
 * tree node shape with `parentChromeId` flattened to the parent's chrome
 * id (or null for top-level).
 */
export interface FolderInput {
  readonly chromeId: string
  readonly parentChromeId: string | null
  readonly name: string
}

/**
 * One bookmark record as sent by the extension.
 * `createdAt` and `updatedAt` are optional — Chrome populates them when
 * available; the server falls back to "now" when missing.
 */
export interface BookmarkInput {
  readonly chromeId: string
  readonly url: string
  readonly title: string
  readonly folderChromeId: string
  readonly createdAt?: string
  readonly updatedAt?: string
}

/** Full sync payload. */
export interface SyncInput {
  readonly folders: readonly FolderInput[]
  readonly bookmarks: readonly BookmarkInput[]
}

// ─── Plan shapes (DB-facing) ──────────────────────────────────────────────

/** One folder in the insert plan. Identical shape to FolderInput but in a
 *  dedicated type so consumers can distinguish "input" from "plan". */
export interface FolderPlanEntry {
  readonly chromeId: string
  readonly parentChromeId: string | null
  readonly name: string
}

/** One bookmark in the insert plan. */
export interface BookmarkPlanEntry {
  readonly chromeId: string
  readonly url: string
  readonly title: string
  readonly folderChromeId: string
  readonly createdAt?: string
  readonly updatedAt?: string
}

// ─── Tree shapes (UI / debug-facing) ─────────────────────────────────────

/** A node in the nested tree view. Either a folder (with children) or a
 *  bookmark (leaf). Bookmarks always appear inside a folder. */
export type PlanTreeNode =
  | {
      readonly kind: 'folder'
      readonly chromeId: string
      readonly name: string
      readonly parentChromeId: string | null
      readonly children: readonly PlanTreeNode[]
    }
  | {
      readonly kind: 'bookmark'
      readonly chromeId: string
      readonly title: string
      readonly url: string
      readonly folderChromeId: string
    }

/** Result of `buildSyncPlan`. */
export interface SyncPlan {
  /**
   * Folders in insertion order. Parents ALWAYS appear before their
   * children, so a single pass INSERT in this order satisfies FKs.
   */
  readonly sortedFolders: readonly FolderPlanEntry[]
  /** Bookmarks in input order. Each `folderChromeId` resolves to an
   *  entry in `sortedFolders`. */
  readonly bookmarks: readonly BookmarkPlanEntry[]
  /** Convenience map for O(1) folder lookup by chromeId. */
  readonly foldersByChromeId: ReadonlyMap<string, FolderPlanEntry>
  /** Nested tree — folders nested, bookmarks attached to their folders. */
  readonly tree: readonly PlanTreeNode[]
}

// ─── Errors ────────────────────────────────────────────────────────────────

/**
 * Thrown when the input is malformed. `code` is a stable identifier
 * the API surfaces so the extension can branch on it (e.g. retry vs.
 * prompt the user to reinstall).
 */
export class SyncPlanError extends Error {
  public readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'SyncPlanError'
    this.code = code
  }
}

// ─── Builder ──────────────────────────────────────────────────────────────

/**
 * Build a validated, topologically-sorted sync plan from the extension's
 * input. Throws `SyncPlanError` on any structural problem.
 *
 * Algorithm:
 *   1. Index folders by chromeId, rejecting duplicates.
 *   2. Validate every parentChromeId resolves to a folder in the input.
 *   3. Detect cycles via DFS — a cycle makes topological sort impossible.
 *   4. Validate every bookmark's folderChromeId resolves to a folder.
 *   5. Topological sort: walk from each root, recursing into children,
 *      recording each folder AFTER its parent. The result has parents
 *      first; siblings appear in their original input order.
 *   6. Build the nested tree from the sorted folder list.
 *
 * Step 5 guarantees the FK ordering property. Step 6 builds the tree in
 * one linear pass over the sorted folders, then attaches bookmarks to
 * their folders in a second linear pass.
 */
export function buildSyncPlan(input: SyncInput): SyncPlan {
  // ─── Step 1: index folders by chromeId ────────────────────────────────
  const foldersByChromeId = new Map<string, FolderInput>()
  for (const folder of input.folders) {
    if (foldersByChromeId.has(folder.chromeId)) {
      throw new SyncPlanError(
        `Duplicate folder chromeId: ${folder.chromeId}`,
        'duplicate_folder_id',
      )
    }
    foldersByChromeId.set(folder.chromeId, folder)
  }

  // ─── Step 2: validate parent references ──────────────────────────────
  for (const folder of foldersByChromeId.values()) {
    if (folder.parentChromeId === null) continue
    if (!foldersByChromeId.has(folder.parentChromeId)) {
      throw new SyncPlanError(
        `Folder ${folder.chromeId} references unknown parent ${folder.parentChromeId}`,
        'unknown_parent',
      )
    }
  }

  // ─── Step 3: detect cycles via DFS ────────────────────────────────────
  detectCycles(foldersByChromeId)

  // ─── Step 4: validate bookmark folder references ─────────────────────
  for (const bookmark of input.bookmarks) {
    if (!foldersByChromeId.has(bookmark.folderChromeId)) {
      throw new SyncPlanError(
        `Bookmark ${bookmark.chromeId} references unknown folder ${bookmark.folderChromeId}`,
        'unknown_bookmark_folder',
      )
    }
  }

  // ─── Step 5: topological sort ─────────────────────────────────────────
  const sortedFolders = topologicalSort(foldersByChromeId)

  // ─── Step 6: build nested tree ───────────────────────────────────────
  const tree = buildTree(sortedFolders, input.bookmarks)

  return {
    sortedFolders,
    bookmarks: input.bookmarks,
    foldersByChromeId: new Map(sortedFolders.map((f) => [f.chromeId, f] as const)),
    tree,
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/**
 * DFS from each folder; if we revisit a node on the current path, it's a
 * cycle. The `onStack` set tracks the current path; `visited` memoizes
 * already-checked subtrees.
 */
function detectCycles(foldersByChromeId: Map<string, FolderInput>): void {
  const visited = new Set<string>()
  const onStack = new Set<string>()

  function dfs(chromeId: string): void {
    if (onStack.has(chromeId)) {
      throw new SyncPlanError(
        `Cycle detected involving folder ${chromeId}`,
        'cycle_detected',
      )
    }
    if (visited.has(chromeId)) return
    visited.add(chromeId)
    onStack.add(chromeId)

    const folder = foldersByChromeId.get(chromeId)
    if (folder?.parentChromeId !== null && folder?.parentChromeId !== undefined) {
      dfs(folder.parentChromeId)
    }

    onStack.delete(chromeId)
  }

  for (const chromeId of foldersByChromeId.keys()) {
    dfs(chromeId)
  }
}

/**
 * Walk every folder and record it after its parent. Result: parents
 * first, siblings in their original input order. O(n) — each folder
 * visited once thanks to the `visited` memo.
 */
function topologicalSort(
  foldersByChromeId: Map<string, FolderInput>,
): FolderPlanEntry[] {
  const result: FolderPlanEntry[] = []
  const visited = new Set<string>()

  function visit(chromeId: string): void {
    if (visited.has(chromeId)) return
    visited.add(chromeId)

    const folder = foldersByChromeId.get(chromeId)
    if (!folder) return

    // Visit parent first so it appears earlier in the result. This is
    // the topological-order constraint; FK insertions need this.
    if (folder.parentChromeId !== null) {
      visit(folder.parentChromeId)
    }

    result.push({
      chromeId: folder.chromeId,
      parentChromeId: folder.parentChromeId,
      name: folder.name,
    })
  }

  for (const chromeId of foldersByChromeId.keys()) {
    visit(chromeId)
  }

  return result
}

/**
 * Build the nested tree. First pass creates a folder node per folder;
 * second pass nests each under its parent. Bookmarks are attached to
 * their folder as children, preserving input order.
 */
function buildTree(
  sortedFolders: readonly FolderPlanEntry[],
  bookmarks: readonly BookmarkInput[],
): PlanTreeNode[] {
  // Mutable node map — children arrays start empty and get filled in
  // pass 2. The `children` field is then frozen when we return.
  interface MutableFolderNode {
    kind: 'folder'
    chromeId: string
    name: string
    parentChromeId: string | null
    children: PlanTreeNode[]
  }

  const folderNodes = new Map<string, MutableFolderNode>()
  for (const folder of sortedFolders) {
    folderNodes.set(folder.chromeId, {
      kind: 'folder',
      chromeId: folder.chromeId,
      name: folder.name,
      parentChromeId: folder.parentChromeId,
      children: [],
    })
  }

  const roots: MutableFolderNode[] = []
  for (const node of folderNodes.values()) {
    if (node.parentChromeId === null) {
      roots.push(node)
    } else {
      const parent = folderNodes.get(node.parentChromeId)
      if (parent) {
        parent.children.push(node)
      }
      // Else: dangling parent (already rejected by validation); skip.
    }
  }

  // Attach bookmarks to their folders.
  for (const bookmark of bookmarks) {
    const folder = folderNodes.get(bookmark.folderChromeId)
    if (!folder) continue
    folder.children.push({
      kind: 'bookmark',
      chromeId: bookmark.chromeId,
      title: bookmark.title,
      url: bookmark.url,
      folderChromeId: bookmark.folderChromeId,
    })
  }

  // Cast the mutable children array to the readonly `PlanTreeNode[]`
  // type. TypeScript's `readonly` enforces the immutability contract at
  // compile time; runtime mutation by a misbehaving caller is the
  // caller's responsibility. v1 doesn't need Object.freeze here.
  return roots as unknown as PlanTreeNode[]
}