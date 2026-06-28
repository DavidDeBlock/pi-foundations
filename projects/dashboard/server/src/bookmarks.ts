import { Hono } from 'hono'
import type { Database } from './db.js'
import { applySync, SyncPlanError } from './sync.js'
import type { SyncInput } from './sync.js'
import {
  attachTagsToBookmark,
  getTagsForBookmark,
  replaceTagsForBookmark,
  type TagRecord,
} from './tags.js'
import { recomputeTrigramsForBookmark } from './search.js'

/**
 * Sync request body shape. Mirrors SyncInput plus an optional
 * `syncedFrom` marker the extension sets to identify the trigger
 * (e.g., "extension_event" for a per-event sync, vs an initial sync
 * after install). The server echoes the marker in its response so the
 * extension can confirm receipt. See issue #006.
 */
interface SyncRequestBody extends SyncInput {
  readonly syncedFrom?: string
}

// ─── Module API ────────────────────────────────────────────────────────────

// ─── Storage helpers ──────────────────────────────────────────────────────

/** Single-bookmark read for after-write confirmation payloads. */
function readBookmark(
  db: Database,
  id: string,
): { id: string; url: string; title: string; folder_id: string; chrome_id: string | null; created_at: string; updated_at: string; last_seen_at: string | null } | undefined {
  return db.get<{
    id: string
    url: string
    title: string
    folder_id: string
    chrome_id: string | null
    created_at: string
    updated_at: string
    last_seen_at: string | null
  }>(
    'SELECT id, url, title, folder_id, chrome_id, created_at, updated_at, last_seen_at FROM bookmarks WHERE id = ?',
    [id],
  )
}

/**
 * Update an existing bookmark's title (and optionally its tag set).
 * Returns the updated record (with tags) or null if the id doesn't exist.
 */
export function updateBookmark(
  db: Database,
  id: string,
  patch: { title?: string; tags?: readonly string[]; tagReplace?: boolean },
): { id: string; title: string; folderId: string; tags: TagRecord[] } | null {
  const existing = readBookmark(db, id)
  if (!existing) return null

  return db.transaction(() => {
    if (typeof patch.title === 'string') {
      const trimmed = patch.title.trim()
      if (trimmed === '') {
        throw new ValidationError('invalid_title', 'title must be a non-empty string')
      }
      db.run(
        `UPDATE bookmarks SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        [trimmed, id],
      )
      // Title is part of the searchable corpus — refresh trigrams.
      recomputeTrigramsForBookmark(db, id)
    }

    let tags: TagRecord[]
    if (patch.tagReplace === true) {
      tags = replaceTagsForBookmark(db, id, patch.tags ?? [])
    } else if (Array.isArray(patch.tags) && patch.tags.length > 0) {
      tags = attachTagsToBookmark(db, id, patch.tags)
    } else {
      tags = getTagsForBookmark(db, id)
    }

    const fresh = readBookmark(db, id)!
    return {
      id: fresh.id,
      title: fresh.title,
      folderId: fresh.folder_id,
      tags,
    }
  })
}

/**
 * Move a bookmark to a different folder. Returns the updated record
 * (with tags) or null if the bookmark or target folder doesn't exist.
 */
export function moveBookmark(
  db: Database,
  id: string,
  folderId: string,
): { id: string; title: string; folderId: string; tags: TagRecord[] } | null {
  const bookmark = readBookmark(db, id)
  if (!bookmark) return null
  const target = db.get<{ id: string }>('SELECT id FROM folders WHERE id = ?', [folderId])
  if (!target) return null
  db.run(
    `UPDATE bookmarks SET folder_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    [folderId, id],
  )
  const tags = getTagsForBookmark(db, id)
  return { id, title: bookmark.title, folderId, tags }
}

/** Delete a bookmark by id. Returns true if the row existed. */
export function deleteBookmark(db: Database, id: string): boolean {
  const result = db.run('DELETE FROM bookmarks WHERE id = ?', [id])
  return result.changes > 0
}

// ─── Validation error type (for HTTP layer) ──────────────────────────────

class ValidationError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ValidationError'
  }
}

// ─── HTTP API ─────────────────────────────────────────────────────────────

/**
 * HTTP API for bookmarks. Read the issue tracker entry for the v1
 * rollout — the sync endpoint ships in #004 + #005.
 *
 *   POST   /api/bookmarks/sync   — bulk upsert from the Chrome extension.
 *   POST   /api/bookmarks/:id    — update one (issue #008 — categorize UI)
 *   POST   /api/bookmarks/:id/move — move to a different folder
 *   DELETE /api/bookmarks/:id    — delete one
 *
 * Read endpoints (GET list, GET single) are HTML-only — they live in
 * `activity-feed.ts` for the feed/detail views.
 */
export function bookmarksApi(db: Database): Hono {
  const api = new Hono()

  api.post('/sync', async (c) => {
    // Read the raw body so we can distinguish "empty" from "malformed".
    const raw = await c.req.text()
    if (raw.trim().length === 0) {
      // The extension may send an empty body on first install when it
      // hasn't read bookmarks yet. Acknowledge without writing.
      return c.json({ ok: true, received: false, reason: 'empty_body' }, 200)
    }

    let body: SyncRequestBody
    try {
      body = JSON.parse(raw) as SyncRequestBody
    } catch {
      // Surface the bug instead of silently dropping data — the
      // extension should never send malformed JSON.
      return c.json({ ok: false, error: 'malformed_json' }, 400)
    }

    // Defensive shape check: the sync handler expects arrays under
    // `folders` and `bookmarks`. Anything else is a malformed payload.
    if (!Array.isArray(body.folders) || !Array.isArray(body.bookmarks)) {
      return c.json(
        {
          ok: false,
          error: 'malformed_payload',
          message: 'Expected { folders: [], bookmarks: [] } at the top level',
        },
        400,
      )
    }

    // Strip the optional `syncedFrom` marker before passing the input
    // to applySync (which only knows about folders + bookmarks).
    const { syncedFrom, ...input } = body
    const opts: { syncedFrom?: string } = {}
    if (typeof syncedFrom === 'string') opts.syncedFrom = syncedFrom

    try {
      const result = applySync(db, input, opts)
      return c.json(result, 200)
    } catch (err) {
      if (err instanceof SyncPlanError) {
        // Validation failure from FolderTreeBuilder — surface the code
        // so the extension can branch on it (e.g. retry on transient
        // vs. report a permanent structural problem).
        return c.json(
          {
            ok: false,
            error: err.code,
            message: err.message,
          },
          400,
        )
      }
      // Anything else is unexpected; let Hono's default error handler
      // surface a 500 with the stack trace in dev.
      throw err
    }
  })

  // POST /api/bookmarks/:id — update title and/or tags.
  //
  // Body shapes:
  //   { title: "New title" }                                  → title only
  //   { tags: ["postgres", "rust"] }                          → attach (idempotent)
  //   { tags: ["postgres"], tagReplace: true }                → replace the whole set
  //   { title: "...", tags: [...] }                           → both
  //
  // Empty/missing fields are no-ops; only the provided fields update.
  api.post('/:id', async (c) => {
    const id = c.req.param('id')

    let body: { title?: unknown; tags?: unknown; tagReplace?: unknown }
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ ok: false, error: 'malformed_json' }, 400)
    }

    const patch: Parameters<typeof updateBookmark>[2] = {}
    if (typeof body.title === 'string') patch.title = body.title
    if (Array.isArray(body.tags)) {
      patch.tags = body.tags.filter((t): t is string => typeof t === 'string')
      if (body.tagReplace === true) patch.tagReplace = true
    }

    try {
      const updated = updateBookmark(db, id, patch)
      if (!updated) {
        return c.json({ ok: false, error: 'not_found' }, 404)
      }
      return c.json({ ok: true, bookmark: updated })
    } catch (err) {
      if (err instanceof ValidationError) {
        return c.json({ ok: false, error: err.code, message: err.message }, 400)
      }
      throw err
    }
  })

  // POST /api/bookmarks/:id/move — move to a different folder.
  //
  // Body: { folderId: "<uuid>" }
  api.post('/:id/move', async (c) => {
    const id = c.req.param('id')

    let body: { folderId?: unknown }
    try {
      body = (await c.req.json()) as { folderId?: unknown }
    } catch {
      return c.json({ ok: false, error: 'malformed_json' }, 400)
    }

    if (typeof body.folderId !== 'string') {
      return c.json(
        { ok: false, error: 'invalid_folder_id', message: 'folderId must be a string' },
        400,
      )
    }

    const updated = moveBookmark(db, id, body.folderId)
    if (!updated) {
      return c.json(
        {
          ok: false,
          error: 'not_found',
          message: 'bookmark or target folder does not exist',
        },
        404,
      )
    }
    return c.json({ ok: true, bookmark: updated })
  })

  // DELETE /api/bookmarks/:id — delete one.
  api.delete('/:id', (c) => {
    const id = c.req.param('id')
    if (!deleteBookmark(db, id)) {
      return c.json({ ok: false, error: 'not_found' }, 404)
    }
    return new Response(null, { status: 204 })
  })

  return api
}