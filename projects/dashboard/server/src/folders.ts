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

// ─── Storage helpers (used by HTTP layer + tests) ──────────────────────────

/** Insert a new folder; returns the created row. Throws on bad parent. */
export function createFolder(
  db: Database,
  opts: { readonly name: string; readonly parentId?: string | null; readonly chromeId?: string | null },
): FolderNode {
  const id = crypto.randomUUID()
  db.run(
    'INSERT INTO folders (id, parent_id, name, chrome_id) VALUES (?, ?, ?, ?)',
    [id, opts.parentId ?? null, opts.name, opts.chromeId ?? null],
  )
  return {
    id,
    name: opts.name,
    parentId: opts.parentId ?? null,
    chromeId: opts.chromeId ?? null,
    children: [],
  }
}

/** Rename a folder. Returns the updated row, or null if id doesn't exist. */
export function renameFolder(
  db: Database,
  id: string,
  newName: string,
): FolderNode | null {
  const result = db.run(
    `UPDATE folders SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    [newName, id],
  )
  if (result.changes === 0) return null
  const row = db.get<FolderRow>(
    'SELECT id, parent_id, name, chrome_id FROM folders WHERE id = ?',
    [id],
  )
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    chromeId: row.chrome_id,
    children: [],
  }
}

/**
 * Delete a folder. The ON DELETE CASCADE on `folders.parent_id` re-parents
 * children to root, and the FK from `bookmarks.folder_id` cascades to
 * delete any bookmarks that lived in this folder (or its descendants).
 *
 * Returns `true` if the folder existed and was deleted.
 */
export function deleteFolder(db: Database, id: string): boolean {
  // Re-parent direct children to this folder's parent before deleting,
  // so the cascade doesn't remove them. NULL parent means "root".
  const folder = db.get<{ parent_id: string | null }>(
    'SELECT parent_id FROM folders WHERE id = ?',
    [id],
  )
  if (!folder) return false
  db.run(
    `UPDATE folders SET parent_id = ? WHERE parent_id = ?`,
    [folder.parent_id, id],
  )
  // Now deleting cascades to bookmarks (per FK ON DELETE CASCADE) but
  // leaves re-parented children intact.
  const result = db.run('DELETE FROM folders WHERE id = ?', [id])
  return result.changes > 0
}

// ─── Module API ────────────────────────────────────────────────────────────

/**
 * HTTP API for folders. Issue #003 shipped GET; #008 adds CRUD.
 *
 *   GET    /api/folders          — full tree
 *   POST   /api/folders          — create a folder (returns 201 + the new node)
 *   PATCH  /api/folders/:id      — rename (returns 200 + the updated node)
 *   DELETE /api/folders/:id      — delete (re-parents children to root, 204)
 */
export function foldersApi(db: Database): Hono {
  const api = new Hono()

  api.get('/', (c) => {
    const rows = db.all<FolderRow>(
      'SELECT id, parent_id, name, chrome_id FROM folders ORDER BY name',
    )
    return c.json(buildTree(rows))
  })

  api.post('/', async (c) => {
    let body: { name?: unknown; parentId?: unknown }
    try {
      body = (await c.req.json()) as { name?: unknown; parentId?: unknown }
    } catch {
      return c.json({ ok: false, error: 'malformed_json' }, 400)
    }
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return c.json(
        { ok: false, error: 'invalid_name', message: 'name must be a non-empty string' },
        400,
      )
    }
    const parentId = typeof body.parentId === 'string' ? body.parentId : null
    if (parentId !== null) {
      const parent = db.get<{ id: string }>(
        'SELECT id FROM folders WHERE id = ?',
        [parentId],
      )
      if (!parent) {
        return c.json(
          { ok: false, error: 'unknown_parent', message: `folder ${parentId} does not exist` },
          400,
        )
      }
    }
    const folder = createFolder(db, { name: body.name.trim(), parentId })
    return c.json(folder, 201)
  })

  api.patch('/:id', async (c) => {
    const id = c.req.param('id')
    let body: { name?: unknown }
    try {
      body = (await c.req.json()) as { name?: unknown }
    } catch {
      return c.json({ ok: false, error: 'malformed_json' }, 400)
    }
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return c.json(
        { ok: false, error: 'invalid_name', message: 'name must be a non-empty string' },
        400,
      )
    }
    const updated = renameFolder(db, id, body.name.trim())
    if (!updated) {
      return c.json({ ok: false, error: 'not_found' }, 404)
    }
    return c.json(updated)
  })

  api.delete('/:id', (c) => {
    const id = c.req.param('id')
    const ok = deleteFolder(db, id)
    if (!ok) return c.json({ ok: false, error: 'not_found' }, 404)
    return new Response(null, { status: 204 })
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
