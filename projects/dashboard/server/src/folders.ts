import { Hono } from 'hono'
import type { Database } from './db.js'

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * Folder node as returned by `GET /api/folders`. `children` is recursive;
 * leaves have an empty array. `parentId` and `chromeId` are included for
 * clients that want flat access or id-mapping (the extension uses
 * `chromeId` to resolve its local ids to server ids).
 */
export interface FolderNode {
  readonly id: string
  readonly name: string
  readonly parentId: string | null
  readonly chromeId: string | null
  readonly children: readonly FolderNode[]
}

/** Flat row as stored in the `folders` table. */
interface FolderRow {
  id: string
  parent_id: string | null
  name: string
  chrome_id: string | null
}

// ─── Module API ────────────────────────────────────────────────────────────

/**
 * HTTP API for folders. Currently read-only (issue #003 only ships the
 * GET endpoint); write endpoints land alongside the bookmark sync work in
 * issue #005.
 *
 *   GET /api/folders — full tree, root folders at the top level
 */
export function foldersApi(db: Database): Hono {
  const api = new Hono()

  api.get('/', (c) => {
    const rows = db.all<FolderRow>(
      'SELECT id, parent_id, name, chrome_id FROM folders ORDER BY name',
    )
    return c.json(buildTree(rows))
  })

  return api
}

// ─── Tree builder (inline for v1) ──────────────────────────────────────────
//
// Trivial O(n) flat-to-nested: build a parent_id → children map, then
// read off the roots. Issue #005 extracts this into the `FolderTreeBuilder`
// deep module per the PRD module map; no point abstracting until we have
// the second use case (extension's incoming tree).

export function buildTree(rows: readonly FolderRow[]): FolderNode[] {
  const byParent = new Map<string | null, FolderNode[]>()
  const all = new Map<string, FolderNode>()

  // First pass: convert each row into a node with empty children.
  for (const row of rows) {
    const node: FolderNode = {
      id: row.id,
      name: row.name,
      parentId: row.parent_id,
      chromeId: row.chrome_id,
      children: [],
    }
    all.set(row.id, node)
    const bucket = byParent.get(row.parent_id) ?? []
    bucket.push(node)
    byParent.set(row.parent_id, bucket)
  }

  // Second pass: attach each node into its parent's children array.
  for (const node of all.values()) {
    const siblings = byParent.get(node.id)
    if (siblings && siblings.length > 0) {
      // `children` is `readonly` in the public type. We built the node
      // ourselves with an empty array; cast through `unknown` is the
      // cleanest way to attach the now-populated children list.
      ;(node as unknown as { children: FolderNode[] }).children = siblings
    }
  }

  return byParent.get(null) ?? []
}
