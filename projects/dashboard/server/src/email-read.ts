// email-read.ts — issue #022
//
// HTTP layer for the email read endpoints. Mounted at `/api/email`
// alongside the OAuth flow (`email-oauth.ts`) and the sync worker
// driver (`email-sync.ts`). Routes:
//
//   GET /                       — list, with filters + keyset cursor
//   GET /search                 — FTS5 + trigram search
//   GET /thread/:threadId       — full thread, chronological
//   GET /:id                    — single email with full body (404 if missing)
//
// All routes return JSON, require standard dashboard auth
// (HTTP Basic for UI, Bearer for service callers), and filter
// `WHERE hidden_at IS NULL` (defense-in-depth before #024 wires
// the hide/unhide endpoints).
//
// Layering:
//   - `listEmails(db, filters)`     — pure orchestrator over EmailQueryBuilder
//   - `getEmailDetail(db, id)`      — wrapper around EmailRetriever.getById
//   - `emailReadApi(db)`            — Hono sub-app for the four routes
//
// Note on route ordering: Hono matches in declaration order. The
// more specific paths (`/search`, `/thread/:threadId`) MUST be
// declared BEFORE the catch-all `/:id`; otherwise `/search` would
// match `/:id` with id="search".

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

  // tag is reserved for #025; accepted but ignored.
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