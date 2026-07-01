// email-tags.ts — issue #025
//
// Pure module: dashboard-only tags for emails. Tags live in a
// separate join table (`email_tags`) that the Gmail sync worker
// (issue #021) never touches. Adding a tag, removing it, listing
// it, and computing tag-with-counts all live here. The HTTP layer
// (email-read.ts) is a thin wrapper that maps boolean results to
// 204/404.
//
// Architectural invariant: tags are dashboard-private. They never
// propagate to Gmail and they survive re-syncs by design — the
// sync UPSERT writes to `emails`, not to `email_tags`, so even an
// explicit "full re-sync" cannot lose a tag.
//
// Normalization (issue #025 AC: "Tags are normalized before
// storage"): trim whitespace, lowercase, reject empty after
// normalization, reject tags that contain whitespace internally
// (those would be ambiguous — `#launch plans` looks like one tag
// to the user but stores as something the autocomplete would
// surface incorrectly).
//
// Public functions:
//   normalizeTag(input)                     → string          throws InvalidTagError
//   addTag(db, emailId, rawTag)             → AddTagResult
//   removeTag(db, emailId, tag)             → boolean
//   getTagsForEmail(db, emailId)            → string[]
//   listAllTagsWithCounts(db, limit?)       → TagSummary[]
//   filterEmailIdsByTag(db, tag)            → Set<string>     (for query-builder integration)
//
// Errors:
//   InvalidTagError — thrown by normalizeTag for empty/whitespace
//     tags. The HTTP layer maps it to a 400.

import type { Database } from './db.js'

// ─── Errors ───────────────────────────────────────────────────────────────

/**
 * Raised when a tag fails normalization. The HTTP layer maps this
 * to a 400 with a human-readable message — the client should
 * display the message rather than retry.
 */
export class InvalidTagError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTagError'
  }
}

// ─── Public types ─────────────────────────────────────────────────────────

export interface TagSummary {
  /** Normalized tag (lowercase, trimmed, no internal whitespace). */
  readonly tag: string
  /** Number of distinct emails carrying this tag. */
  readonly count: number
}

export type AddTagResult =
  /** Tag was newly inserted on this email. */
  | { readonly status: 'added' }
  /** Email already had this tag — no-op, no error. */
  | { readonly status: 'already_present' }
  /** Email id doesn't exist in `emails`. Caller should map to 404. */
  | { readonly status: 'email_not_found' }

// ─── Normalization ────────────────────────────────────────────────────────

/**
 * Normalize a raw tag string to its canonical storage form.
 *
 * Rules (issue #025 AC):
 *   - Trim leading/trailing whitespace.
 *   - Lowercase the result.
 *   - Reject empty after trim.
 *   - Reject tags containing internal whitespace — "#launch plans"
 *     reads as two tags to most users, and accepting it would make
 *     autocomplete lie. Splitting on whitespace and joining with
 *     "-" would silently transform intent, so we reject instead.
 *   - Length cap 64 — defense against pathological inputs; the
 *     URL routing layer caps at 200 bytes, but tags should be
 *     human-sized.
 *
 * The leading `#` is NOT stripped — the storage form is
 * `launch`, but if the user types `#launch` we accept it and
 * strip the hash. Same for `Launch` (case). This makes the
 * autocomplete feel forgiving without losing the canonical
 * storage shape.
 *
 * Throws `InvalidTagError` for any rejected input. The HTTP
 * layer maps the error to a 400.
 */
export function normalizeTag(raw: string): string {
  if (typeof raw !== 'string') {
    throw new InvalidTagError('tag must be a string')
  }
  // Trim first so we can detect a leading '#' even when the input
  // is "  #launch". Then strip a single leading '#' if present.
  let s = raw.trim()
  if (s.startsWith('#')) s = s.slice(1)
  if (s.length === 0) {
    throw new InvalidTagError('tag must not be empty')
  }
  s = s.toLowerCase()
  // Reject any internal whitespace (including Unicode whitespace).
  // We accept letters, digits, dashes, underscores, dots, and
  // slashes (for nested-style tags like "work/urgent").
  if (/\s/.test(s)) {
    throw new InvalidTagError('tag must not contain whitespace')
  }
  if (!/^[\p{L}\p{N}\-._/]+$/u.test(s)) {
    throw new InvalidTagError('tag contains invalid characters')
  }
  if (s.length > 64) {
    throw new InvalidTagError('tag is too long (max 64 characters)')
  }
  return s
}

// ─── addTag ───────────────────────────────────────────────────────────────

/**
 * Attach a tag to an email. Idempotent: re-adding the same
 * (email_id, tag) is a no-op. The status field tells the caller
 * which path was taken so the HTTP layer can pick a status code.
 *
 * Returns `email_not_found` when the email id doesn't exist
 * (caller maps to 404). Note: we check the email first because
 * `email_tags.email_id` has a FK — inserting an orphan tag row
 * would also fail, but the FK error is opaque and the
 * "email_not_found" branch is the user-facing message.
 *
 * `rawTag` is normalized at the application layer — passing an
 * already-normalized value is fine; passing "#Launch " is also
 * fine and produces the same stored value as "launch".
 */
export function addTag(
  db: Database,
  emailId: string,
  rawTag: string,
): AddTagResult {
  if (typeof emailId !== 'string' || emailId.length === 0) {
    return { status: 'email_not_found' }
  }
  const tag = normalizeTag(rawTag)

  // Verify the email exists. We do this before the INSERT so the
  // error is informative; if we relied on the FK we would still
  // get the right outcome but the failure mode would be a generic
  // SQLite constraint error.
  const email = db.get<{ id: string }>(
    'SELECT id FROM emails WHERE id = ?',
    [emailId],
  )
  if (email === undefined) {
    return { status: 'email_not_found' }
  }

  const result = db.run(
    'INSERT OR IGNORE INTO email_tags (email_id, tag) VALUES (?, ?)',
    [emailId, tag],
  )
  // `changes` from better-sqlite3 is 1 on insert, 0 on ignore.
  return result.changes > 0
    ? { status: 'added' }
    : { status: 'already_present' }
}

// ─── removeTag ────────────────────────────────────────────────────────────

/**
 * Remove a tag from an email. The `tag` argument MUST be in
 * normalized form (lowercase, trimmed). The HTTP layer
 * normalizes the URL param via `normalizeTag` before calling.
 *
 * Returns `true` when the row existed (and was deleted),
 * `false` otherwise. The HTTP layer maps `false` to 404. Note
 * the asymmetry with `addTag`: removing a tag that doesn't exist
 * is "not_found" at the resource level (the (emailId, tag)
 * resource is missing), whereas adding a tag to an email that
 * already has it is success at the resource level (idempotent).
 */
export function removeTag(
  db: Database,
  emailId: string,
  tag: string,
): boolean {
  if (typeof emailId !== 'string' || emailId.length === 0) return false
  if (typeof tag !== 'string' || tag.length === 0) return false
  const result = db.run(
    'DELETE FROM email_tags WHERE email_id = ? AND tag = ?',
    [emailId, tag],
  )
  return result.changes > 0
}

// ─── getTagsForEmail ──────────────────────────────────────────────────────

/**
 * Return all tags for one email, sorted alphabetically for stable
 * rendering. Empty array when the email has no tags (or doesn't
 * exist — we don't distinguish because the route calls this only
 * after a successful getById).
 */
export function getTagsForEmail(db: Database, emailId: string): string[] {
  if (typeof emailId !== 'string' || emailId.length === 0) return []
  const rows = db.all<{ tag: string }>(
    `SELECT tag FROM email_tags WHERE email_id = ? ORDER BY tag ASC`,
    [emailId],
  )
  return rows.map((r) => r.tag)
}

// ─── listAllTagsWithCounts ────────────────────────────────────────────────

/**
 * Return every distinct tag with its email count, sorted by count
 * DESC then alphabetical. Used by the autocomplete endpoint and
 * by the inbox filter's "available tags" list (a future slice
 * could surface a tag cloud).
 *
 * `limit` is clamped to [1, 200] and defaults to 50. Hidden
 * emails count too — the autocomplete needs every tag the user
 * has ever created, not just tags on visible emails. The
 * "show me everything tagged #X" filter (`filterEmailIdsByTag`)
 * also counts hidden emails; the inbox's tag-filter UI then
 * narrows by the resulting id set, but those rows are already
 * hidden_at-filtered by the query builder so they wouldn't
 * appear anyway.
 *
 * Tags that only existed on now-deleted emails are not returned
 * — the FK CASCADE removes them, so the DISTINCT list is
 * naturally compact.
 */
export function listAllTagsWithCounts(
  db: Database,
  limit?: number,
): TagSummary[] {
  const clampedLimit = clampTagLimit(limit)
  const rows = db.all<{ tag: string; count: number }>(
    `SELECT tag, COUNT(DISTINCT email_id) AS count
       FROM email_tags
       GROUP BY tag
       ORDER BY count DESC, tag ASC
       LIMIT ?`,
    [clampedLimit],
  )
  return rows.map((r) => ({ tag: r.tag, count: r.count }))
}

// ─── filterEmailIdsByTag ──────────────────────────────────────────────────

/**
 * Return the set of email ids that carry a given tag. Used by
 * the query-builder to apply the inbox tag filter without
 * inlining a subquery everywhere.
 *
 * Hidden emails are NOT excluded here — the query-builder's
 * existing `WHERE hidden_at IS NULL` filter handles that, and
 * pre-filtering would mask the bug if it ever broke.
 *
 * Returns an empty Set when no email carries the tag.
 */
export function filterEmailIdsByTag(db: Database, tag: string): Set<string> {
  if (typeof tag !== 'string' || tag.length === 0) return new Set()
  const rows = db.all<{ email_id: string }>(
    `SELECT email_id FROM email_tags WHERE tag = ?`,
    [tag],
  )
  return new Set(rows.map((r) => r.email_id))
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function clampTagLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_TAG_LIMIT
  }
  return Math.min(MAX_TAG_LIMIT, Math.floor(limit))
}

const DEFAULT_TAG_LIMIT = 50
const MAX_TAG_LIMIT = 200