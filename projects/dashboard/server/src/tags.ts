// tags.ts — issue #008
//
// Storage + HTTP API for tags. Tags are flat, multi-parent-per-bookmark
// categorization (in addition to the folder tree, which is single-parent).
// The schema (in migrations/001_initial.sql) has:
//   tags (id TEXT PK, name TEXT UNIQUE, created_at)
//   bookmark_tags (bookmark_id, tag_id, composite PK)
//
// This module owns:
//   - `normalize`/`normalizeAll` re-exports for convenience
//   - Pure storage helpers: `listAllTags`, `getTagsForBookmark`,
//     `attachTagsToBookmark`, `replaceTagsForBookmark`, `detachTagFromBookmark`
//   - The `tagsApi(db)` Hono sub-app exposing:
//       GET /api/tags — all tag names + ids, used by the UI datalist for
//                       autocomplete. Returns `[{id, name, usageCount}]`.
//
// Invariants enforced here (so callers don't have to think about them):
//   - All tag names pass through `normalizeAll` before insert.
//   - `attachTagsToBookmark` and `replaceTagsForBookmark` are idempotent:
//     re-running them with the same inputs leaves the row state unchanged.
//   - Empty / whitespace-only tag inputs are silently dropped.
//   - `detachTagFromBookmark` on a missing (bookmark, tag) pair is a
//     no-op (returns 0).
//
// NOT responsible for:
//   - Tag CRUD on its own (you can't rename a tag in v1; tags are
//     immutable by name. To "rename", insert the new tag and detach
//     the old — or leave both and let the user re-tag explicitly).
//   - Bulk-tag operations across multiple bookmarks (out of scope).

import { Hono } from 'hono'
import type { Database } from './db.js'
import type { AuthVariables } from './auth.js'
import { normalize, normalizeAll } from './tag-normalizer.js'
import { recomputeTrigramsForBookmark } from './search.js'

// ─── Re-exports ────────────────────────────────────────────────────────────

export { normalize, normalizeAll }

// ─── Types ────────────────────────────────────────────────────────────────

export interface TagRecord {
  readonly id: string
  readonly name: string
}

export interface TagWithUsage extends TagRecord {
  readonly usageCount: number
}

// ─── Storage helpers ──────────────────────────────────────────────────────

/**
 * List every tag in the system, alphabetized by name.
 *
 * Used by `GET /api/tags` for the autocomplete datalist. Alphabetical
 * order matches the chip order in the UI so they're visually grouped.
 */
export function listAllTags(db: Database): TagRecord[] {
  const rows = db.all<{ id: string; name: string }>(
    'SELECT id, name FROM tags ORDER BY name',
  )
  return rows
}

/**
 * List every tag with the number of bookmarks that carry it. Used by
 * the UI to show "(3)" counts next to tag suggestions — helps users
 * pick a useful existing tag vs. creating a near-duplicate.
 */
export function listAllTagsWithUsage(db: Database): TagWithUsage[] {
  const rows = db.all<{ id: string; name: string; usage_count: number }>(
    `SELECT t.id, t.name, COUNT(bt.bookmark_id) AS usage_count
       FROM tags t
       LEFT JOIN bookmark_tags bt ON bt.tag_id = t.id
      GROUP BY t.id, t.name
      ORDER BY t.name`,
  )
  return rows.map((r) => ({ id: r.id, name: r.name, usageCount: r.usage_count }))
}

/**
 * Return the tags attached to a single bookmark, alphabetized.
 *
 * Returns `[]` if the bookmark has no tags (never `null`).
 */
export function getTagsForBookmark(db: Database, bookmarkId: string): TagRecord[] {
  const rows = db.all<{ id: string; name: string }>(
    `SELECT t.id, t.name
       FROM tags t
       JOIN bookmark_tags bt ON bt.tag_id = t.id
      WHERE bt.bookmark_id = ?
      ORDER BY t.name`,
    [bookmarkId],
  )
  return rows
}

/**
 * Attach the given tag names to a bookmark. Creates tag rows for any
 * names that don't exist yet (idempotent — UNIQUE(name) protects against
 * duplicates). Existing attachments are left in place.
 *
 * Returns the resulting set of tag records attached after the call,
 * alphabetized. This is the shape the caller wants to send back to
 * the UI as a confirmation / refresh payload.
 *
 * Skips names that normalize to empty. The whole operation runs in a
 * single transaction so a partial failure doesn't leave the bookmark
 * with a half-applied tag set.
 */
export function attachTagsToBookmark(
  db: Database,
  bookmarkId: string,
  rawTagNames: readonly string[],
): TagRecord[] {
  const names = normalizeAll(rawTagNames)
  if (names.length === 0) {
    // Nothing to attach. Still return the current set so the caller
    // sees the post-state.
    return getTagsForBookmark(db, bookmarkId)
  }

  return db.transaction(() => {
    for (const name of names) {
      // Find or create the tag row.
      let row = db.get<{ id: string }>('SELECT id FROM tags WHERE name = ?', [name])
      if (!row) {
        // `randomUUID()` is allowed in SQLite (registered by better-sqlite3
        // on connection — see db.ts). We generate the id in JS so it's
        // available for the INSERT … ON CONFLICT pattern below.
        const newId = crypto.randomUUID()
        db.run('INSERT INTO tags (id, name) VALUES (?, ?)', [newId, name])
        row = { id: newId }
      }
      // Attach. Composite PK protects against double-attaching.
      db.run(
        `INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)`,
        [bookmarkId, row.id],
      )
    }
    // Tag names are part of the searchable corpus — refresh trigrams.
    recomputeTrigramsForBookmark(db, bookmarkId)
    return getTagsForBookmark(db, bookmarkId)
  })
}

/**
 * Replace the tag set on a bookmark with the given names. Drops any
 * existing tags not in the new set, and adds any new ones (creating
 * tag rows as needed). After this call, the bookmark has exactly the
 * tags whose normalized names appear in `rawTagNames` (skipping empties).
 *
 * Runs in a single transaction so concurrent reads never see a half-
 * replaced tag set.
 */
export function replaceTagsForBookmark(
  db: Database,
  bookmarkId: string,
  rawTagNames: readonly string[],
): TagRecord[] {
  const desiredNames = new Set(normalizeAll(rawTagNames))

  return db.transaction(() => {
    // Snapshot current tags so we can drop the diff.
    const current = getTagsForBookmark(db, bookmarkId)
    const currentNames = new Set(current.map((t) => t.name))

    // Drop tags no longer desired.
    for (const tag of current) {
      if (!desiredNames.has(tag.name)) {
        db.run('DELETE FROM bookmark_tags WHERE bookmark_id = ? AND tag_id = ?', [
          bookmarkId,
          tag.id,
        ])
      }
    }

    // Add tags that are desired but not yet attached.
    for (const name of desiredNames) {
      if (currentNames.has(name)) continue
      let row = db.get<{ id: string }>('SELECT id FROM tags WHERE name = ?', [name])
      if (!row) {
        const newId = crypto.randomUUID()
        db.run('INSERT INTO tags (id, name) VALUES (?, ?)', [newId, name])
        row = { id: newId }
      }
      db.run(
        'INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)',
        [bookmarkId, row.id],
      )
    }

    // Tag names changed — refresh trigrams.
    recomputeTrigramsForBookmark(db, bookmarkId)
    return getTagsForBookmark(db, bookmarkId)
  })
}

/**
 * Remove a single tag from a bookmark. No-op if the (bookmark, tag) link
 * doesn't exist. Returns `true` if a row was deleted.
 */
export function detachTagFromBookmark(
  db: Database,
  bookmarkId: string,
  tagId: string,
): boolean {
  const result = db.run(
    'DELETE FROM bookmark_tags WHERE bookmark_id = ? AND tag_id = ?',
    [bookmarkId, tagId],
  )
  if (result.changes > 0) {
    // Tag set changed — refresh trigrams for fuzzy search.
    recomputeTrigramsForBookmark(db, bookmarkId)
  }
  return result.changes > 0
}

// ─── HTTP API ─────────────────────────────────────────────────────────────

/**
 * HTTP API for tag reads.
 *
 *   GET /api/tags — list all tags with usage counts (for autocomplete)
 *
 * Tag creation is implicit in bookmark update (POST /api/bookmarks/:id
 * with `tags: [...]`) — there's no separate POST /api/tags endpoint in v1
 * because the only reason to create a tag is to attach it to a bookmark.
 */
export function tagsApi(db: Database): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  api.get('/', (c) => {
    const tags = listAllTagsWithUsage(db)
    return c.json(tags)
  })

  return api
}