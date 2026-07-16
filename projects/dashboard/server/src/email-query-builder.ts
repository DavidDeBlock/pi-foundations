// email-query-builder.ts — issue #022
//
// Pure module: composes SQL for the email read endpoints. No DB
// calls, no Hono. Mirrors search-query-builder.ts — the same
// "no string interpolation of user input" rule applies. Every user
// value flows through a `?` placeholder; the only string-template
// content is the column whitelist (already-known SQL fragments).
//
// Three query shapes:
//   1. `buildListQuery` — paginated list for `GET /api/email`. Uses
//      keyset pagination on (received_at DESC, id DESC) via an
//      opaque base64 cursor; falls back to OFFSET when the caller
//      didn't pass a cursor.
//   2. `buildThreadQuery` — chronological thread for `GET
//      /api/email/thread/:threadId`. Always ascending by
//      received_at (oldest first); no pagination.
//   3. `buildDetailQuery` — single email by id for `GET /api/email/:id`.
//      Returns 404 (via the caller) when no row matches.
//
// All three filter `WHERE hidden_at IS NULL` as defense-in-depth:
// even before slice #024 lands the hide/unhide endpoints, any row
// that already has a `hidden_at` value is invisible to readers.

// ─── Public types ─────────────────────────────────────────────────────────

/** Filters supported by the list endpoint. All optional. */
export interface EmailListFilters {
  /** Exact match on `sender_email`. Case-insensitive. */
  readonly from?: string
  /** Substring match on `to_addrs` JSON (any recipient's email). */
  readonly to?: string
  /** Case-insensitive substring match on `subject`. */
  readonly subjectContains?: string
  /** Exact match against any label in the `labels` JSON array. */
  readonly label?: string
  /** Tri-state: true = unread only, false = read only, undefined = any. */
  readonly unread?: boolean
  /** ISO 8601 lower bound on `received_at`. Inclusive. */
  readonly since?: string
  /** ISO 8601 upper bound on `received_at`. Inclusive. */
  readonly until?: string
  /**
   * Restrict to emails carrying this tag (dashboard-only tag,
   * normalized via `normalizeTag` before reaching the builder).
   * Joins `email_tags` and filters by the (already-normalized)
   * `tag` value. Hidden emails are still excluded by the global
   * `hidden_at IS NULL` filter — a tag on a hidden email doesn't
   * surface in the list.
   */
  readonly tag?: string
  /** Page size. Clamped to [1, MAX_LIMIT]. Defaults to DEFAULT_LIMIT. */
  readonly limit?: number
  /** Opaque cursor from a previous response's `nextCursor`. */
  readonly cursor?: string
}

export interface ListQuery {
  readonly sql: string
  readonly params: readonly (string | number)[]
}

export interface ThreadQuery {
  readonly sql: string
  readonly params: readonly (string | number)[]
}

export interface DetailQuery {
  readonly sql: string
  readonly params: readonly (string | number)[]
}

// ─── Constants ────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

// ─── List query ───────────────────────────────────────────────────────────

/**
 * Build the paginated list SQL for `GET /api/email`.
 *
 * Pagination strategy: keyset (a.k.a. seek) pagination on
 * (received_at DESC, id DESC). More stable than OFFSET for live
 * data — new mail arriving between page 1 and page 2 doesn't shift
 * later pages. The cursor is opaque base64 of `${receivedAt}|${id}`;
 * callers should not parse it.
 *
 * Filters compose with AND. The WHERE clause always includes
 * `hidden_at IS NULL`. Bound placeholders for every user value —
 * no string interpolation.
 */
export function buildListQuery(filters: EmailListFilters): ListQuery {
  const where: string[] = ['hidden_at IS NULL']
  const params: (string | number)[] = []

  if (typeof filters.from === 'string' && filters.from !== '') {
    where.push('LOWER(sender_email) = LOWER(?)')
    params.push(filters.from)
  }
  if (typeof filters.to === 'string' && filters.to !== '') {
    // `to_addrs` is a JSON array of recipient email strings. Match if
    // any element case-insensitively contains the query substring.
    where.push(`EXISTS (
      SELECT 1 FROM json_each(emails.to_addrs) je
       WHERE LOWER(je.value) LIKE '%' || LOWER(?) || '%'
    )`)
    params.push(filters.to)
  }
  if (typeof filters.subjectContains === 'string' && filters.subjectContains !== '') {
    where.push('LOWER(subject) LIKE ?')
    params.push(`%${filters.subjectContains.toLowerCase()}%`)
  }
  if (typeof filters.label === 'string' && filters.label !== '') {
    where.push(`EXISTS (
      SELECT 1 FROM json_each(emails.labels) je WHERE je.value = ?
    )`)
    params.push(filters.label)
  }
  if (filters.unread === true) {
    where.push('is_unread = 1')
  } else if (filters.unread === false) {
    where.push('is_unread = 0')
  }
  if (typeof filters.since === 'string' && filters.since !== '') {
    where.push('received_at >= ?')
    params.push(filters.since)
  }
  if (typeof filters.until === 'string' && filters.until !== '') {
    where.push('received_at <= ?')
    params.push(filters.until)
  }

  // Tag filter: an INNER JOIN against `email_tags` would change the
  // result shape (one row per tag, not per email), so we use an
  // EXISTS subquery. Matches the existing label pattern above.
  if (typeof filters.tag === 'string' && filters.tag !== '') {
    where.push(`EXISTS (
      SELECT 1 FROM email_tags et WHERE et.email_id = emails.id AND et.tag = ?
    )`)
    params.push(filters.tag)
  }

  // Keyset pagination: cursor encodes the (received_at, id) of the
  // last row from the previous page. We want rows that are
  // STRICTLY "older" than that boundary.
  let cursorClause = ''
  if (typeof filters.cursor === 'string' && filters.cursor !== '') {
    const parsed = decodeCursor(filters.cursor)
    if (parsed !== null) {
      cursorClause = ' AND (received_at < ? OR (received_at = ? AND id < ?))'
      params.push(parsed.receivedAt, parsed.receivedAt, parsed.id)
    }
  }

  const limit = clampEmailLimit(filters.limit)
  params.push(limit)

  const sql = `
    SELECT id, account_id, thread_id, subject, sender, sender_email,
           to_addrs, cc_addrs, received_at, snippet, is_unread, labels,
           synced_at
      FROM emails
     WHERE ${where.join(' AND ')}${cursorClause}
     ORDER BY received_at DESC, id DESC
     LIMIT ?
  `
  return { sql, params }
}

// ─── Thread query ─────────────────────────────────────────────────────────

/**
 * Build the SQL for `GET /api/email/thread/:threadId`. Returns all
 * messages in the thread ordered chronologically (oldest first), so
 * the UI can render top-down without re-sorting.
 *
 * Selects the full detail shape (including body_plain) so the route
 * can return each message's body without a second round-trip. The
 * thread view is read-mostly; one larger SELECT beats N small ones.
 *
 * Filters `hidden_at IS NULL` like the list query. Hides a single
 * message mid-thread do NOT remove the others — the thread view
 * simply skips the hidden rows.
 */
export function buildThreadQuery(threadId: string): ThreadQuery {
  return {
    sql: `
      SELECT id, account_id, thread_id, subject, sender, sender_email,
             to_addrs, cc_addrs, received_at, snippet, body_plain, body_html,
             is_unread, labels, synced_at
        FROM emails
       WHERE thread_id = ?
         AND hidden_at IS NULL
       ORDER BY received_at ASC, id ASC
    `,
    params: [threadId],
  }
}

// ─── Detail query ─────────────────────────────────────────────────────────

/**
 * Build the SQL for `GET /api/email/:id`. The caller maps "no row"
 * to a 404. Hidden rows are excluded so the detail endpoint never
 * leaks a hidden message even if the id is known.
 */
export function buildDetailQuery(id: string): DetailQuery {
  return {
    sql: `
      SELECT id, account_id, thread_id, subject, sender, sender_email,
             to_addrs, cc_addrs, received_at, snippet, body_plain, body_html,
             is_unread, labels, synced_at
        FROM emails
       WHERE id = ?
         AND hidden_at IS NULL
    `,
    params: [id],
  }
}

// ─── Cursor encoding ──────────────────────────────────────────────────────

export interface CursorPosition {
  readonly receivedAt: string
  readonly id: string
}

/**
 * Encode a cursor for the next page. Opaque base64 so callers
 * can't depend on the wire format. The decoded payload is
 * `${receivedAt}|${id}` — `|` is not valid in an ISO 8601 string,
 * so this roundtrips cleanly.
 */
export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(`${position.receivedAt}|${position.id}`, 'utf8').toString('base64url')
}

/**
 * Decode an opaque cursor back into its (receivedAt, id) components.
 * Returns `null` for any malformed input — the caller treats that
 * as "no cursor" and starts from the first page.
 */
export function decodeCursor(cursor: string): CursorPosition | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const idx = raw.indexOf('|')
    if (idx <= 0 || idx === raw.length - 1) return null
    const receivedAt = raw.slice(0, idx)
    const id = raw.slice(idx + 1)
    if (!isIsoTimestamp(receivedAt) || id.length === 0) return null
    return { receivedAt, id }
  } catch {
    return null
  }
}

function isIsoTimestamp(s: string): boolean {
  // Pragmatic check: must parse via Date AND be in the
  // 0000-9999 range. Catches accidental garbage without rejecting
  // valid sub-millisecond precision.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) return false
  const ms = Date.parse(s)
  return Number.isFinite(ms)
}

// ─── Helpers for HTTP layer ───────────────────────────────────────────────

export function clampEmailLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_LIMIT
  }
  return Math.min(MAX_LIMIT, Math.floor(limit))
}
