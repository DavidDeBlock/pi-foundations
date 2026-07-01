// email-visibility.ts — issue #024
//
// Pure module: hide/unhide/list for the email mirror's soft-delete
// flag (`hidden_at`). All routes that READ the mirror are already
// filtering `WHERE hidden_at IS NULL` (defense-in-depth added in
// #022 via the `hidden_at` column from migration #005). This module
// is the WRITE side: setting and clearing that flag.
//
// Public functions:
//   hideEmail(db, id, nowMs?)               → boolean
//   unhideEmail(db, id)                     → boolean
//   listHiddenEmails(db, limit?)            → HiddenEmailSummary[]
//   getByIdIncludingHidden(db, id)          → detail + hiddenAt
//
// Both helpers return `true` when an existing row was updated and
// `false` when the id doesn't exist. They are idempotent: re-calling
// `hideEmail` on an already-hidden row sets the timestamp to "now"
// (treated as a re-confirm) and returns `true`. Same shape for
// `unhideEmail`. The HTTP layer maps `false` to 404.
//
// Architectural invariant: `hidden_at` is a LOCAL-STATE column. The
// sync worker's UPSERT (issue #021) explicitly excludes it from the
// UPDATE column list, so a re-sync never overwrites a soft-delete.
// Adding more local columns later follows the same pattern: add
// the column, do not reference it in the UPSERT.

import type { Database } from './db.js'
import { clampEmailLimit } from './email-query-builder.js'

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Read-shape for hidden emails — same fields as `EmailSummary` plus
 * `hiddenAt` so the `/email/hidden` view can render a "hidden 2h
 * ago" timestamp without joining anything extra. Sorted by
 * `hiddenAt DESC` (most recently hidden first) per the issue spec.
 */
export interface HiddenEmailSummary {
  readonly id: string
  readonly threadId: string
  readonly accountId: string
  readonly subject: string
  readonly sender: string
  readonly senderEmail: string
  readonly receivedAt: string
  readonly snippet: string
  readonly isUnread: boolean
  readonly labels: readonly string[]
  readonly hiddenAt: string
}

/**
 * The detail-view shape needed to render the Hide ↔ Unhide toggle.
 * A superset of the bare-minimum fields the detail page needs,
 * chosen to avoid re-querying when the view decides between
 * `Hide` and `Unhide` based on `hiddenAt`.
 *
 * `hiddenAt` is null when the row is visible (default after sync).
 */
export interface EmailDetailWithHidden {
  readonly id: string
  readonly threadId: string
  readonly accountId: string
  readonly subject: string
  readonly sender: string
  readonly senderEmail: string
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly receivedAt: string
  readonly snippet: string
  readonly bodyPlain: string
  readonly isUnread: boolean
  readonly labels: readonly string[]
  readonly syncedAt: string
  readonly hiddenAt: string | null
}

// ─── hideEmail ────────────────────────────────────────────────────────────

/**
 * Soft-delete one email. Sets `hidden_at` to the supplied timestamp.
 *
 * Idempotency: re-hiding an already-hidden row updates the
 * timestamp to "now". This is fine for the use case (a 204 from
 * the API is the same UX whether the row was visible or already
 * hidden), and it sidesteps a SQL change-count ambiguity under
 * SQLite's UPSERT semantics.
 *
 * Returns `true` when a row matched the id, `false` when no row
 * exists with that id. Empty-string ids are rejected as `false`.
 */
export function hideEmail(
  db: Database,
  id: string,
  nowMs: () => number = () => Date.now(),
): boolean {
  if (typeof id !== 'string' || id.length === 0) return false
  const nowIso = new Date(nowMs()).toISOString()
  const result = db.run(
    `UPDATE emails SET hidden_at = ? WHERE id = ?`,
    [nowIso, id],
  )
  return result.changes > 0
}

// ─── unhideEmail ──────────────────────────────────────────────────────────

/**
 * Restore a hidden email to the default view. Clears `hidden_at`.
 *
 * Idempotency: re-unhiding an already-visible row is a no-op on
 * `hidden_at` but still returns `true` (the row matched). The
 * caller can't tell whether the row was previously hidden from
 * this return value — and doesn't need to.
 *
 * Returns `true` when a row matched the id, `false` when no row
 * exists. Empty-string ids are rejected as `false`.
 */
export function unhideEmail(db: Database, id: string): boolean {
  if (typeof id !== 'string' || id.length === 0) return false
  const result = db.run(
    `UPDATE emails SET hidden_at = NULL WHERE id = ?`,
    [id],
  )
  return result.changes > 0
}

// ─── listHiddenEmails ─────────────────────────────────────────────────────

/**
 * List hidden emails, sorted by `hidden_at DESC` (most recently
 * hidden first) — the order the issue spec requires for the
 * `/email/hidden` view. `limit` is clamped to [1, 200] and
 * defaults to 50.
 *
 * The sort uses `hidden_at` as the primary key and `id` as the
 * tiebreaker so pages are stable across calls when many emails
 * were hidden in the same millisecond (rare for the human-driven
 * use case, but the determinism helps pagination correctness).
 */
export function listHiddenEmails(
  db: Database,
  limit?: number,
): HiddenEmailSummary[] {
  const clampedLimit = clampEmailLimit(limit)
  const rows = db.all<{
    id: string
    account_id: string
    thread_id: string
    subject: string
    sender: string
    sender_email: string
    received_at: string
    snippet: string
    is_unread: number | bigint
    labels: string
    hidden_at: string
  }>(
    `SELECT id, account_id, thread_id, subject, sender, sender_email,
            received_at, snippet, is_unread, labels, hidden_at
       FROM emails
      WHERE hidden_at IS NOT NULL
      ORDER BY hidden_at DESC, id DESC
      LIMIT ?`,
    [clampedLimit],
  )
  return rows.map(rowToHiddenSummary)
}

function rowToHiddenSummary(r: {
  id: string
  account_id: string
  thread_id: string
  subject: string
  sender: string
  sender_email: string
  received_at: string
  snippet: string
  is_unread: number | bigint
  labels: string
  hidden_at: string
}): HiddenEmailSummary {
  return {
    id: r.id,
    threadId: r.thread_id,
    accountId: r.account_id,
    subject: r.subject,
    sender: r.sender,
    senderEmail: r.sender_email,
    receivedAt: r.received_at,
    snippet: r.snippet,
    isUnread: !!r.is_unread,
    labels: parseJsonArray(r.labels),
    hiddenAt: r.hidden_at,
  }
}

function parseJsonArray(s: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(s)
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string')
    }
  } catch {
    // Fall through.
  }
  return []
}

// ─── getByIdIncludingHidden ───────────────────────────────────────────────

/**
 * Look up one email by id and include hidden rows. Used ONLY by the
 * detail view to render the Hide ↔ Unhide toggle. The JSON API
 * keeps using `EmailRetriever.getById` which filters `hidden_at IS
 * NULL` and maps hidden rows to 404 (defense-in-depth before #024,
 * preserved for API consumers).
 *
 * Returns `null` for missing id (and empty-string id). Otherwise
 * returns the same shape as `EmailDetail` plus a `hiddenAt`
 * timestamp (null when visible).
 *
 * The query is a thin wrapper — we keep this here rather than
 * touching `EmailRetriever` so the read API's "hidden is invisible"
 * contract is preserved.
 */
export function getByIdIncludingHidden(
  db: Database,
  id: string,
): EmailDetailWithHidden | null {
  if (typeof id !== 'string' || id.length === 0) return null
  const row = db.get<{
    id: string
    account_id: string
    thread_id: string
    subject: string
    sender: string
    sender_email: string
    to_addrs: string
    cc_addrs: string
    received_at: string
    snippet: string
    body_plain: string
    is_unread: number | bigint
    labels: string
    synced_at: string
    hidden_at: string | null
  }>(
    `SELECT id, account_id, thread_id, subject, sender, sender_email,
            to_addrs, cc_addrs, received_at, snippet, body_plain,
            is_unread, labels, synced_at, hidden_at
       FROM emails
      WHERE id = ?`,
    [id],
  )
  if (row === undefined) return null
  return {
    id: row.id,
    threadId: row.thread_id,
    accountId: row.account_id,
    subject: row.subject,
    sender: row.sender,
    senderEmail: row.sender_email,
    to: parseJsonArray(row.to_addrs),
    cc: parseJsonArray(row.cc_addrs),
    receivedAt: row.received_at,
    snippet: row.snippet,
    bodyPlain: row.body_plain,
    isUnread: !!row.is_unread,
    labels: parseJsonArray(row.labels),
    syncedAt: row.synced_at,
    hiddenAt: row.hidden_at,
  }
}
