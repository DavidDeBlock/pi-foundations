// email-read.ts — issue #022 (read endpoints), #024 (visibility
// endpoints), #025 (tag CRUD + autocomplete + filter)
//
// HTTP layer for the email read endpoints, plus the soft-delete
// hide/unhide/list-hidden endpoints from #024 and the dashboard
// tag endpoints from #025. Mounted at `/api/email` alongside the
// OAuth flow (`email-oauth.ts`) and the sync worker driver
// (`email-sync.ts`). Routes:
//
//   GET    /                       — list visible emails, with filters
//                                    (?tag=launch — issue #025)
//   GET    /search                 — FTS5 + trigram search
//   GET    /thread/:threadId       — full thread, chronological (hidden excluded)
//   GET    /hidden                 — list HIDDEN emails (issue #024)
//   GET    /tags                   — list all dashboard tags + counts (#025, autocomplete)
//   GET    /:id                    — single email with full body (404 if missing OR hidden)
//   POST   /:id/tags               — add a tag to an email (issue #025, 204 / 400 / 404)
//   POST   /:id/hide               — soft-delete (issue #024, 204 / 404)
//   POST   /:id/unhide             — restore to default view (issue #024, 204 / 404)
//   DELETE /:id/tags/:tag          — remove a tag (issue #025, 204 / 400 / 404)
//
// All list/search/thread/detail routes return JSON, require standard
// dashboard auth (HTTP Basic for UI, Bearer for service callers),
// and filter `WHERE hidden_at IS NULL` (defense-in-depth from #022,
// preserved through #024 — hidden emails are invisible to the JSON
// read API even though they exist in the DB).
//
// Layering:
//   - `listEmails(db, filters)`     — pure orchestrator over EmailQueryBuilder
//   - `getEmailDetail(db, id)`      — wrapper around EmailRetriever.getById
//   - `emailVisibility` helpers     — pure write side (email-visibility.ts)
//   - `emailTags` helpers           — pure write/read side (email-tags.ts)
//   - `emailReadApi(db)`            — Hono sub-app for the routes
//
// Note on route ordering: Hono matches in declaration order. The
// literal paths (`/search`, `/thread/:threadId`, `/hidden`, `/tags`)
// MUST be declared BEFORE the catch-all `/:id`; otherwise they
// would match `/:id` (e.g. `:id="hidden"` for `/hidden`). The POST
// `/:id/hide`, `/:id/unhide`, and `/:id/tags` are different paths
// from `/:id` (they have an extra segment) so they don't conflict —
// declared after for clarity. Same for `DELETE /:id/tags/:tag`.

import { Hono } from 'hono'
import type { Database } from './db.js'
import type { AuthVariables } from './auth.js'
import {
  buildListQuery,
  clampEmailLimit,
  encodeCursor,
  type EmailListFilters,
} from './email-query-builder.js'
import { getById, getThread } from './email-retriever.js'
import { searchEmails, type EmailSummary } from './email-searcher.js'
import {
  hideEmail,
  listHiddenEmails,
  unhideEmail,
} from './email-visibility.js'
import {
  addTag,
  InvalidTagError,
  listAllTagsWithCounts,
  normalizeTag,
  removeTag,
} from './email-tags.js'

// ─── HTTP sub-app ─────────────────────────────────────────────────────────

export function emailReadApi(db: Database): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  // ─── GET /search ────────────────────────────────────────────────────
  // FTS5 + trigram search. Must be declared BEFORE the `/:id` route.
  // Query params: q, from, to, subject_contains, label, unread,
  // since, until, limit.
  api.get('/search', (c) => {
    const q = c.req.query('q') ?? ''
    const response = searchEmails(db, q, parseSearchFilters(c))
    return c.json(response)
  })

  // ─── GET /thread/:threadId ──────────────────────────────────────────
  // Full thread, chronological. Declared BEFORE `/:id` so the literal
  // `/thread/` segment doesn't get captured by `/:id`.
  api.get('/thread/:threadId', (c) => {
    const threadId = c.req.param('threadId')
    if (!threadId) return c.json({ error: 'missing threadId' }, 400)
    const messages = getThread(db, threadId)
    return c.json({ threadId, count: messages.length, messages })
  })

  // ─── GET /hidden (#024) ─────────────────────────────────────────────
  // List hidden emails, sorted by hidden_at DESC. Declared BEFORE
  // `/:id` so the literal `/hidden` segment doesn't get captured by
  // the catch-all `/:id` route.
  // Query params: limit (default 50, clamped to [1, 200]).
  api.get('/hidden', (c) => {
    const limitRaw = c.req.query('limit')
    let limit: number | undefined
    if (typeof limitRaw === 'string' && limitRaw !== '') {
      const n = Number(limitRaw)
      if (Number.isFinite(n)) limit = Math.floor(n)
    }
    const results = listHiddenEmails(db, limit)
    return c.json({ results })
  })

  // ─── GET /tags (#025) ───────────────────────────────────────────────
  // List every distinct dashboard tag with its email count, sorted
  // by count DESC then alphabetical. Used by the detail-page
  // autocomplete and (future) by an inbox-side tag picker. Declared
  // BEFORE `/:id` so the literal `/tags` segment doesn't get
  // captured by the catch-all `/:id` route.
  // Query params: limit (default 50, clamped to [1, 200]).
  api.get('/tags', (c) => {
    const limitRaw = c.req.query('limit')
    let limit: number | undefined
    if (typeof limitRaw === 'string' && limitRaw !== '') {
      const n = Number(limitRaw)
      if (Number.isFinite(n)) limit = Math.floor(n)
    }
    const results = listAllTagsWithCounts(db, limit)
    return c.json({ results })
  })

  // ─── GET /:id ───────────────────────────────────────────────────────
  // Single email, full body. 404 when the id is unknown OR the row
  // is hidden (the retriever filters both into `null`).
  api.get('/:id', (c) => {
    const id = c.req.param('id')
    const detail = getById(db, id)
    if (detail === null) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.json(detail)
  })

  // ─── POST /:id/hide (#024) ──────────────────────────────────────────
  // Soft-delete: sets `hidden_at = now()`. Returns 204 on success,
  // 404 when the id doesn't exist. Idempotent (re-hiding an
  // already-hidden row also returns 204; the column updates to the
  // new timestamp, which is the same UX surface).
  api.post('/:id/hide', (c) => {
    const id = c.req.param('id')
    const ok = hideEmail(db, id)
    if (!ok) return c.json({ error: 'not_found' }, 404)
    return new Response(null, { status: 204 })
  })

  // ─── POST /:id/unhide (#024) ────────────────────────────────────────
  // Restore: clears `hidden_at`. Returns 204 on success, 404 when
  // the id doesn't exist. Idempotent.
  api.post('/:id/unhide', (c) => {
    const id = c.req.param('id')
    const ok = unhideEmail(db, id)
    if (!ok) return c.json({ error: 'not_found' }, 404)
    return new Response(null, { status: 204 })
  })

  // ─── POST /:id/tags (#025) ───────────────────────────────────────────
  // Add a dashboard tag to an email. Body: `{tag: string}` (JSON).
  // The tag is normalized at the application boundary (trim,
  // lowercase, leading-# stripped). Returns 204 on success
  // (whether newly added or already present — both are no-ops at
  // the wire level), 400 when the tag fails normalization, 404
  // when the email id doesn't exist.
  //
  // Reading the body via `c.req.text()` + `JSON.parse` rather than
  // `c.req.json()` keeps the route tolerant of malformed JSON —
  // the helper throws and we map to 400.
  api.post('/:id/tags', async (c) => {
    const id = c.req.param('id')
    let body: unknown
    try {
      const text = await c.req.text()
      body = text === '' ? {} : JSON.parse(text)
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }
    const raw = (body as { tag?: unknown }).tag
    if (typeof raw !== 'string') {
      return c.json({ error: 'missing_tag' }, 400)
    }
    let tag: string
    try {
      tag = normalizeTag(raw)
    } catch (err) {
      if (err instanceof InvalidTagError) {
        return c.json({ error: 'invalid_tag', message: err.message }, 400)
      }
      throw err
    }
    const result = addTag(db, id, tag)
    if (result.status === 'email_not_found') {
      return c.json({ error: 'not_found' }, 404)
    }
    // 'added' or 'already_present' both → 204. The client reloads
    // and reads the new tag from the server-rendered detail page.
    return new Response(null, { status: 204 })
  })

  // ─── DELETE /:id/tags/:tag (#025) ───────────────────────────────────
  // Remove a dashboard tag from an email. The `:tag` segment is
  // URL-decoded by Hono; we still normalize it before querying so
  // "delete /api/email/x/tags/Launch" removes the canonical
  // "launch" tag (defense in depth — the UI sends normalized
  // values, but a direct API caller might not).
  //
  // 204 when the (emailId, tag) row existed and was deleted.
  // 404 when it didn't (also covers missing email id and invalid
  // tag normalization).
  api.delete('/:id/tags/:tag', (c) => {
    const id = c.req.param('id')
    const rawTag = c.req.param('tag') ?? ''
    let tag: string
    try {
      tag = normalizeTag(rawTag)
    } catch (err) {
      if (err instanceof InvalidTagError) {
        return c.json({ error: 'invalid_tag', message: err.message }, 400)
      }
      throw err
    }
    const ok = removeTag(db, id, tag)
    if (!ok) return c.json({ error: 'not_found' }, 404)
    return new Response(null, { status: 204 })
  })

  // ─── GET / ─────────────────────────────────────────────────────────
  // Paginated list with filters. Declared LAST among GETs so the
  // more specific routes above take precedence.
  api.get('/', (c) => {
    const filters = parseListFilters(c)
    const list = listEmails(db, filters)
    return c.json(list)
  })

  return api
}

// ─── Orchestrators ────────────────────────────────────────────────────────

export interface EmailListResponse {
  readonly results: readonly EmailSummary[]
  readonly nextCursor: string | null
}

/**
 * Run the list query and shape the response. `nextCursor` is `null`
 * when the page didn't fill `limit` rows (no more pages). We always
 * emit a cursor — even an empty results array with `nextCursor: null`
 * — so the client can iterate without ambiguity.
 *
 * The `nextCursor` is the (received_at, id) of the LAST row on this
 * page. The client passes it back as `?cursor=<cursor>`; the SQL
 * builder decodes it and emits the next page (strictly older rows).
 */
export function listEmails(
  db: Database,
  filters: EmailListFilters,
): EmailListResponse {
  const listQuery = buildListQuery(filters)
  const rows = db.all<{
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
    is_unread: number | bigint
    labels: string
    synced_at: string
  }>(listQuery.sql, [...listQuery.params])

  const limit = clampEmailLimit(filters.limit)
  const results = rows.map(rowToSummary)
  const nextCursor =
    rows.length === limit && rows.length > 0
      ? encodeCursor({
          receivedAt: rows[rows.length - 1]!.received_at,
          id: rows[rows.length - 1]!.id,
        })
      : null

  return { results, nextCursor }
}

// ─── Query-param parsing ──────────────────────────────────────────────────

function parseListFilters(
  c: { req: { query(name: string): string | undefined } },
): EmailListFilters {
  return parseCommonFilters(c, ['from', 'to', 'subjectContains', 'label'])
}

function parseSearchFilters(
  c: { req: { query(name: string): string | undefined } },
): Parameters<typeof searchEmails>[2] {
  return parseCommonFilters(c, ['from', 'to', 'label']) as Parameters<
    typeof searchEmails
  >[2]
}

/** Pull the shared filter set off the request. Maps snake_case
 *  URL params to the camelCase builder keys.
 *  `extras` is a list of CAMELCASE field names the caller wants
 *  populated. The URL→field mapping is fixed (e.g. subject_contains
 *  → subjectContains) so all routes share a consistent query
 *  contract. Subject-substring is intentionally NOT a search filter
 *  — search is full-text and doesn't need a separate subject-
 *  contains clause. */
export function parseCommonFilters(
  c: { req: { query(name: string): string | undefined } },
  extras: ReadonlyArray<'from' | 'to' | 'subjectContains' | 'label'>,
): EmailListFilters {
  const out: {
    from?: string
    to?: string
    subjectContains?: string
    label?: string
    unread?: boolean
    since?: string
    until?: string
    tag?: string
    limit?: number
    cursor?: string
  } = {}

  // snake_case URL params → camelCase builder keys
  const paramMap: Record<string, keyof typeof out> = {
    from: 'from',
    to: 'to',
    subject_contains: 'subjectContains',
    label: 'label',
  }

  for (const field of extras) {
    const urlKey = Object.entries(paramMap).find(([, v]) => v === field)?.[0]
    if (urlKey === undefined) continue
    const v = c.req.query(urlKey)
    if (typeof v === 'string' && v !== '') {
      ;(out as Record<string, unknown>)[field] = v
    }
  }

  // unread is tri-state — true, false, or undefined. "1" → true,
  // "0" → false, anything else → undefined.
  const unreadRaw = c.req.query('unread')
  if (unreadRaw === '1' || unreadRaw === 'true') out.unread = true
  else if (unreadRaw === '0' || unreadRaw === 'false') out.unread = false

  const since = c.req.query('since')
  if (typeof since === 'string' && since !== '') out.since = since
  const until = c.req.query('until')
  if (typeof until === 'string' && until !== '') out.until = until

  // Tag filter (#025). The query-builder normalizes; we just
  // pass the raw value through (the route may decide to call
  // normalizeTag at the entry point, but for the GET endpoint
  // we accept the URL value as-is — the inbox UI sends already-
  // normalized tags via autocomplete).
  const tag = c.req.query('tag')
  if (typeof tag === 'string' && tag !== '') out.tag = tag

  const limitRaw = c.req.query('limit')
  if (typeof limitRaw === 'string' && limitRaw !== '') {
    const n = Number(limitRaw)
    if (Number.isFinite(n)) out.limit = Math.floor(n)
  }

  const cursor = c.req.query('cursor')
  if (typeof cursor === 'string' && cursor !== '') out.cursor = cursor

  return out
}

// ─── Row → summary ────────────────────────────────────────────────────────

function rowToSummary(r: {
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
  is_unread: number | bigint
  labels: string
  synced_at: string
}): EmailSummary {
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