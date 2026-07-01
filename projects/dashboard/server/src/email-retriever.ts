// email-retriever.ts — issue #022
//
// Deep module around `emails` row reads. Provides two operations:
//   - `getById(id)` returns one email's full detail (subject, body,
//     headers, recipients). Returns `null` for missing id or hidden
//     row — the route maps both to 404.
//   - `getThread(threadId)` returns every message in the thread in
//     chronological order (oldest first). Hidden messages are
//     skipped — the thread view should not surface them.
//
// Both operations filter `WHERE hidden_at IS NULL` as defense-in-
// depth: even before slice #024 wires the hide/unhide endpoints,
// any row that already has `hidden_at` set is invisible here.
//
// Why a separate module from the route:
//   - Encapsulates the JSON-array parsing (`to_addrs`, `cc_addrs`,
//     `labels`) so the route returns a clean shape and doesn't
//     need to know the storage representation.
//   - Mirrors the v1 pattern: `bookmark-differ.ts` (pure) +
//     `activity-feed.ts` (DB I/O) + `bookmarks.ts` (HTTP).
//   - Reusable for the LLM tool surface (issue #027): the
//     `get_email` and `get_thread` tools can call these directly.

import type { Database } from './db.js'
import { buildDetailQuery, buildThreadQuery } from './email-query-builder.js'

// ─── Public types ─────────────────────────────────────────────────────────

/** Full email detail — the shape returned to the LLM tools and
 *  the detail UI route. Includes the plain-text body, all
 *  recipients, labels, and the unread flag. */
export interface EmailDetail {
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
}

// ─── Errors ────────────────────────────────────────────────────────────────

/** Returned to callers when the requested id doesn't exist (or is
 *  hidden). The HTTP route maps this to a 404. Throwing would
 *  also work, but `null` is friendlier for the LLM tool surface
 *  where "not found" is a normal expected outcome, not an error. */
export class EmailNotFoundError extends Error {
  readonly id: string
  constructor(id: string) {
    super(`email ${id} not found`)
    this.name = 'EmailNotFoundError'
    this.id = id
  }
}

// ─── Internal row shapes (raw SQL output) ─────────────────────────────────

interface RawDetailRow {
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
}

// ─── getById ──────────────────────────────────────────────────────────────

/**
 * Look up one email by id. Returns the full detail shape (subject,
 * body_plain, recipients, etc.) or `null` when the id is unknown
 * OR the row is hidden.
 *
 * The route handler is responsible for mapping `null` to 404 —
 * see email-read.ts. We don't throw because "not found" is a
 * normal, expected outcome (the UI requests a specific id; if
 * Gmail's never seen that id, we just don't have it).
 */
export function getById(db: Database, id: string): EmailDetail | null {
  if (typeof id !== 'string' || id.length === 0) return null
  const q = buildDetailQuery(id)
  const row = db.get<RawDetailRow>(q.sql, [...q.params])
  return row ? rowToDetail(row) : null
}

// ─── getThread ────────────────────────────────────────────────────────────

/**
 * Return every non-hidden message in the thread, ordered by
 * received_at ASC (oldest first). An empty array is a valid
 * response — the route returns `{messages: []}` with HTTP 200 in
 * that case (the thread exists conceptually, just nothing synced).
 *
 * Note: hidden messages are NOT represented in the result. If a
 * thread has 5 messages but the middle one is hidden, the route
 * gets a 4-element array in chronological order. The UI can
 * render this directly.
 */
export function getThread(db: Database, threadId: string): EmailDetail[] {
  if (typeof threadId !== 'string' || threadId.length === 0) return []
  const q = buildThreadQuery(threadId)
  const rows = db.all<RawDetailRow>(q.sql, [...q.params])
  return rows.map(rowToDetail)
}

// ─── Row → detail ─────────────────────────────────────────────────────────

function rowToDetail(r: RawDetailRow): EmailDetail {
  return {
    id: r.id,
    threadId: r.thread_id,
    accountId: r.account_id,
    subject: r.subject,
    sender: r.sender,
    senderEmail: r.sender_email,
    to: parseJsonArray(r.to_addrs),
    cc: parseJsonArray(r.cc_addrs),
    receivedAt: r.received_at,
    snippet: r.snippet,
    bodyPlain: r.body_plain,
    isUnread: !!r.is_unread,
    labels: parseJsonArray(r.labels),
    syncedAt: r.synced_at,
  }
}

/** Defensive JSON-array parse. Falls back to [] on garbage so a
 *  corrupted row doesn't crash the route. */
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