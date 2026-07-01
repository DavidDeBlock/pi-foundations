// email-searcher.ts — issue #022
//
// Orchestrator for the email search endpoint. Composes:
//   - `EmailQueryBuilder` (handled by searchEmails' sister endpoint)
//   - FTS5 query against `email_fts` for exact + prefix matching
//   - Trigram-based fuzzy fallback against `email_trigrams`
//   - Snippet generation: FTS5 `snippet()` for exact matches,
//     JS `<mark>` wrapping for fuzzy
//
// Strategy:
//   1. Run the FTS5 query. If it returns results, return them.
//   2. Otherwise, fall back to candidate-fetch (trigram pre-filter
//      in SQL) + JS Jaccard scoring (typo-tolerant).
//
// Mirrors `search.ts` (the bookmarks searcher) — same two-phase
// strategy, same return shape conventions. Filtered `hidden_at IS
// NULL` so hidden messages are never surfaced, even before #024
// wires the hide/unhide endpoints.
//
// All filters from `EmailSearchFilters` are AND-combined with the
// text query. Filters like `from`/`label` are passed through to the
// SQL builder when needed; for the FTS5 path they're appended as
// extra WHERE clauses; for the fuzzy path they're applied to the
// candidate fetch.

import type { Database } from './db.js'
import {
  clampEmailLimit,
  type EmailListFilters,
} from './email-query-builder.js'
import { extractTrigrams, extractTrigramsAsArray } from './search-query-builder.js'

// ─── Public types ─────────────────────────────────────────────────────────

/** Combined filters for the search endpoint. Text query + structured
 *  filters compose with AND. */
export interface EmailSearchFilters extends EmailListFilters {
  /** Free-text search query (subject + body + sender). */
  readonly query: string
}

/** A search hit — the read-shape used by the list, detail, and search
 *  endpoints. `snippet` is HTML with `<mark>...</mark>` tags wrapping
 *  the matched terms. */
export interface EmailSummary {
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
}

export interface EmailSearchResponse {
  readonly mode: SearchMode
  readonly query: string
  readonly results: readonly EmailSummary[]
  readonly totalCount: number
}

export type SearchMode = 'fts5' | 'fuzzy' | 'empty'

// ─── Internal row shapes (raw SQL output) ─────────────────────────────────

interface RawFtsRow {
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
  fts_snippet: string | null
}

interface RawCandidateRow {
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
}

// ─── Orchestrator ─────────────────────────────────────────────────────────

/** Cap on fuzzy-mode candidates — bounds JS scoring cost. */
const MAX_CANDIDATES = 1000

/**
 * Run the email search pipeline. Two-phase: FTS5 first, then
 * trigram fallback when the FTS5 query returns too few results.
 *
 * Filter composes with `EmailListFilters` for the structured side.
 * The text query goes through FTS5 (subject + body_plain + sender +
 * sender_email) and trigram fallback.
 *
 * Hidden emails are filtered out at the SQL layer (defense-in-depth
 * before #024 wires the hide/unhide endpoints).
 */
export function searchEmails(
  db: Database,
  rawQuery: string,
  filters: Omit<EmailSearchFilters, 'query'> = {},
): EmailSearchResponse {
  const query = rawQuery.trim()
  if (query === '') {
    return { mode: 'empty', query: '', results: [], totalCount: 0 }
  }

  const limit = clampEmailLimit(filters.limit)

  // ── Phase 1: FTS5 ────────────────────────────────────────────────────
  const ftsSql = buildFtsSearchSql(query, filters, limit)
  const ftsRows = db.all<RawFtsRow>(ftsSql.sql, [...ftsSql.params])
  if (ftsRows.length > 0) {
    return {
      mode: 'fts5',
      query,
      results: ftsRows.map(rowToFtsResult),
      totalCount: ftsRows.length,
    }
  }

  // ── Phase 2: Trigram fuzzy fallback ─────────────────────────────────
  const candidateSql = buildCandidateFetchSql(query, filters, MAX_CANDIDATES)
  if (candidateSql.mode === 'empty') {
    return { mode: 'fts5', query, results: [], totalCount: 0 }
  }

  const candidates = db.all<RawCandidateRow>(candidateSql.sql, [
    ...candidateSql.params,
  ])
  const queryGrams = new Set(candidateSql.trigrams)

  const scored: Array<{ result: EmailSummary; score: number }> = []
  for (const c of candidates) {
    const corpus = `${c.subject}\n${c.snippet}\n${c.sender}\n${c.sender_email}\n${c.labels.replace(/\x1f/g, ' ')}`
    const candGrams = extractTrigrams(corpus)
    const score = jaccard(queryGrams, candGrams)
    if (score > 0) {
      scored.push({ score, result: rowToFuzzyResult(c, queryGrams) })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, limit).map((s) => s.result)

  return { mode: 'fuzzy', query, results: top, totalCount: top.length }
}

// ─── FTS5 SQL builder ─────────────────────────────────────────────────────

interface SqlWithParams {
  readonly sql: string
  readonly params: readonly (string | number)[]
}

interface CandidateSqlWithParams extends SqlWithParams {
  readonly trigrams: readonly string[]
  readonly mode: 'candidates'
}

interface EmptySql extends SqlWithParams {
  readonly trigrams: readonly string[]
  readonly mode: 'empty'
}

/**
 * Build the FTS5 search SQL. Splits the user query on non-
 * alphanumeric boundaries (same tokenization rule as the bookmark
 * FTS query — see search-query-builder.ts `buildFtsMatchQuery`),
 * adds a prefix wildcard per token, AND-joins them.
 *
 * `snippet(email_fts, -1, '<mark>', '</mark>', '\u2026', 16)`
 * picks the most relevant window across the indexed columns and
 * wraps matched terms.
 */
function buildFtsSearchSql(
  userQuery: string,
  filters: Omit<EmailSearchFilters, 'query'>,
  limit: number,
): SqlWithParams {
  const where: string[] = []
  const params: (string | number)[] = []

  const ftsExpr = buildFtsMatchExpr(userQuery)
  if (ftsExpr === null) {
    // Punctuation-only query — return empty-mode shape from the
    // caller. FTS5 MATCH needs at least one token.
    return { sql: 'SELECT 1 WHERE 1 = 0', params: [] }
  }

  where.push('email_fts MATCH ?')
  params.push(ftsExpr)

  // Join FTS5 back to the emails table for the structured filters
  // (from/to/label/unread/since/until) AND the `hidden_at IS NULL`
  // defense-in-depth filter. FTS5 rowid aligns with emails.rowid.
  where.push('e.hidden_at IS NULL')

  if (typeof filters.from === 'string' && filters.from !== '') {
    where.push('LOWER(e.sender_email) = LOWER(?)')
    params.push(filters.from)
  }
  if (typeof filters.to === 'string' && filters.to !== '') {
    where.push(`EXISTS (
      SELECT 1 FROM json_each(e.to_addrs) je
       WHERE LOWER(je.value) LIKE '%' || LOWER(?) || '%'
    )`)
    params.push(filters.to)
  }
  if (typeof filters.label === 'string' && filters.label !== '') {
    where.push(`EXISTS (
      SELECT 1 FROM json_each(e.labels) je WHERE je.value = ?
    )`)
    params.push(filters.label)
  }
  if (filters.unread === true) {
    where.push('e.is_unread = 1')
  } else if (filters.unread === false) {
    where.push('e.is_unread = 0')
  }
  if (typeof filters.since === 'string' && filters.since !== '') {
    where.push('e.received_at >= ?')
    params.push(filters.since)
  }
  if (typeof filters.until === 'string' && filters.until !== '') {
    where.push('e.received_at <= ?')
    params.push(filters.until)
  }

  params.push(limit)

  const sql = `
    SELECT e.id, e.account_id, e.thread_id, e.subject, e.sender,
           e.sender_email, e.received_at, e.snippet, e.is_unread,
           e.labels,
           snippet(email_fts, -1, '<mark>', '</mark>', '\u2026', 16)
             AS fts_snippet
      FROM email_fts
      JOIN emails e ON e.rowid = email_fts.rowid
     WHERE ${where.join(' AND ')}
     ORDER BY bm25(email_fts), e.received_at DESC, e.id DESC
     LIMIT ?
  `
  return { sql, params }
}

/** Tokenize a user query into an FTS5 MATCH expression. Returns
 *  `null` when no usable tokens remain (empty / punctuation only). */
function buildFtsMatchExpr(userQuery: string): string | null {
  const tokens = userQuery
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return null
  return tokens.map((t) => `${t}*`).join(' AND ')
}

// ─── Candidate fetch SQL builder (fuzzy fallback) ─────────────────────────

function buildCandidateFetchSql(
  userQuery: string,
  filters: Omit<EmailSearchFilters, 'query'>,
  candidateLimit: number,
): CandidateSqlWithParams | EmptySql {
  const trigrams = extractTrigramsAsArray(userQuery)
  if (trigrams.length === 0) {
    const empty: EmptySql = {
      sql: 'SELECT 1 WHERE 1 = 0',
      params: [],
      trigrams: [],
      mode: 'empty',
    }
    return empty
  }

  const where: string[] = []
  const params: (string | number)[] = []

  const placeholders = trigrams.map(() => '?').join(', ')
  where.push(`EXISTS (
    SELECT 1 FROM email_trigrams et
     WHERE et.email_id = e.id AND et.trigram IN (${placeholders})
  )`)
  params.push(...trigrams)

  where.push('e.hidden_at IS NULL')

  if (typeof filters.from === 'string' && filters.from !== '') {
    where.push('LOWER(e.sender_email) = LOWER(?)')
    params.push(filters.from)
  }
  if (typeof filters.to === 'string' && filters.to !== '') {
    where.push(`EXISTS (
      SELECT 1 FROM json_each(e.to_addrs) je
       WHERE LOWER(je.value) LIKE '%' || LOWER(?) || '%'
    )`)
    params.push(filters.to)
  }
  if (typeof filters.label === 'string' && filters.label !== '') {
    where.push(`EXISTS (
      SELECT 1 FROM json_each(e.labels) je WHERE je.value = ?
    )`)
    params.push(filters.label)
  }
  if (filters.unread === true) {
    where.push('e.is_unread = 1')
  } else if (filters.unread === false) {
    where.push('e.is_unread = 0')
  }
  if (typeof filters.since === 'string' && filters.since !== '') {
    where.push('e.received_at >= ?')
    params.push(filters.since)
  }
  if (typeof filters.until === 'string' && filters.until !== '') {
    where.push('e.received_at <= ?')
    params.push(filters.until)
  }

  params.push(candidateLimit)

  const sql = `
    SELECT e.id, e.account_id, e.thread_id, e.subject, e.sender,
           e.sender_email, e.received_at, e.snippet, e.is_unread,
           e.labels
      FROM emails e
     WHERE ${where.join(' AND ')}
     ORDER BY e.received_at DESC, e.id DESC
     LIMIT ?
  `
  return { sql, params, trigrams, mode: 'candidates' }
}

// ─── Row → result ─────────────────────────────────────────────────────────

function rowToFtsResult(r: RawFtsRow): EmailSummary {
  return {
    id: r.id,
    threadId: r.thread_id,
    accountId: r.account_id,
    subject: r.subject,
    sender: r.sender,
    senderEmail: r.sender_email,
    receivedAt: r.received_at,
    snippet: r.fts_snippet ?? r.snippet,
    isUnread: !!r.is_unread,
    labels: parseJsonArray(r.labels),
  }
}

function rowToFuzzyResult(
  r: RawCandidateRow,
  queryGrams: Set<string>,
): EmailSummary {
  return {
    id: r.id,
    threadId: r.thread_id,
    accountId: r.account_id,
    subject: r.subject,
    sender: r.sender,
    senderEmail: r.sender_email,
    receivedAt: r.received_at,
    // For fuzzy matches, synthesize a snippet from subject + sender
    // by wrapping the first query-trigram hit in <mark>. Falls back
    // to the raw snippet when no trigram matches.
    snippet: makeFuzzySnippet(r.subject, r.sender, queryGrams, r.snippet),
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

// ─── Trigram scoring ──────────────────────────────────────────────────────

/**
 * Jaccard similarity: |intersect(A, B)| / |union(A, B)|. Returns 0
 * when either set is empty so an empty corpus doesn't accidentally
 * match.
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersect = 0
  for (const x of a) if (b.has(x)) intersect++
  const union = a.size + b.size - intersect
  return union === 0 ? 0 : intersect / union
}

// ─── Fuzzy snippet synthesis ──────────────────────────────────────────────

/**
 * Build a fuzzy snippet by finding the longest matching query
 * trigram in the candidate's subject+ sender and wrapping the first
 * occurrence in <mark>. If no trigram matches (shouldn't happen for
 * fuzzy-mode results since we already filtered by overlap), returns
 * the raw snippet unchanged.
 *
 * Two separate searches (subject first, then sender) so a trigram
 * from a multi-word phrase ("john doe") can land in either field.
 * Falls back to the raw snippet (which is Gmail-provided and may
 * contain other relevant text) only if the candidate corpus
 * genuinely matches zero trigrams.
 */
function makeFuzzySnippet(
  subject: string,
  sender: string,
  queryGrams: Set<string>,
  rawSnippet: string,
): string {
  for (const text of [subject, sender]) {
    const textGrams = extractTrigramsAsArray(text)
    const best = pickBestTrigram(queryGrams, textGrams)
    if (best !== null) {
      return wrapFirstOccurrence(text, best)
    }
  }
  return escapeHtml(rawSnippet)
}

/** Pick the longest query trigram that actually appears in the
 *  text's trigram set AND as a substring of the original (unpadded)
 *  text. Longer = more specific.
 *
 *  The padding in `extractTrigrams` adds a leading space so very
 *  short strings still produce trigrams (" pa" marks the start of a
 *  word starting with 'p'). The trigram " po" appears in the query
 *  set but is NOT a substring of "postgres tips" (no leading space
 *  in the original). Skipping leading-space trigrams avoids picking
 *  a highlight needle that indexOf() can't find. */
function pickBestTrigram(
  queryGrams: Set<string>,
  textGrams: readonly string[],
): string | null {
  let best: string | null = null
  for (const qg of queryGrams) {
    if (qg.length < 3) continue
    if (qg.startsWith(' ')) continue
    if (textGrams.includes(qg)) {
      if (best === null || qg.length > best.length) best = qg
    }
  }
  return best
}

/** Wrap the first case-insensitive occurrence of `needle` in `text`
 *  with `<mark>` tags. HTML-escapes the surrounding text so the
 *  snippet is safe to drop into the JSON response. */
function wrapFirstOccurrence(text: string, needle: string): string {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase())
  if (idx < 0) return escapeHtml(text)
  return (
    escapeHtml(text.slice(0, idx)) +
    '<mark>' +
    escapeHtml(text.slice(idx, idx + needle.length)) +
    '</mark>' +
    escapeHtml(text.slice(idx + needle.length))
  )
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}