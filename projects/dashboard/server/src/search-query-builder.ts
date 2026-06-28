// search-query-builder.ts — issue #009
//
// Pure module: composes SQL for the search endpoint. No DB calls, no
// Hono. Two query shapes:
//
//   1. FTS5 mode — used for exact + prefix matching. SQLite's bookmark_fts
//      virtual table already exists (from migration 001). We pass a
//      sanitized FTS5 MATCH expression and return rows with ranking.
//
//   2. Candidate-fetch mode — used by the fuzzy fallback in search.ts.
//      Doesn't try to do matching in SQL; just fetches all bookmark rows
//      that share at least one trigram with the query AND match the
//      filters. The caller post-processes in JS to score by Jaccard
//      overlap.
//
// Everything is parameterized — no string concatenation of user input
// into SQL. The only interpolation point is the column whitelist
// (already-known SQL fragments), so SQL injection is impossible.

// ─── Public types ─────────────────────────────────────────────────────────

/** Filters supported by the search endpoint. All optional. */
export interface SearchFilters {
  /** Restrict results to bookmarks in this folder. */
  readonly folderId?: string
  /** Restrict results to bookmarks tagged with this tag id. */
  readonly tagId?: string
  /** ISO 8601 lower bound on `created_at`. Inclusive. */
  readonly fromDate?: string
  /** ISO 8601 upper bound on `created_at`. Inclusive. */
  readonly toDate?: string
  /** Page size. Clamped to [1, MAX_LIMIT]. Defaults to 50. */
  readonly limit?: number
  /** Pagination offset. Clamped to >=0. Defaults to 0. */
  readonly offset?: number
}

export interface FtsSearchQuery {
  readonly sql: string
  readonly params: readonly (string | number)[]
  readonly mode: 'fts5'
}

export interface CandidateFetchQuery {
  readonly sql: string
  readonly params: readonly (string | number)[]
  readonly mode: 'candidates'
  readonly trigrams: readonly string[]
}

export interface EmptyQuery {
  readonly sql: string
  readonly params: readonly []
  readonly mode: 'empty'
  readonly trigrams: readonly string[]
}

export type SearchQuery = FtsSearchQuery | CandidateFetchQuery | EmptyQuery

// ─── Constants ────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

// ─── FTS5 builder ─────────────────────────────────────────────────────────

/**
 * Build an FTS5 MATCH query for the given user input.
 *
 * Tokenization: split on any non-alphanumeric character (treats spaces,
 * punctuation, FTS5 operators, and even script-like content as word
 * boundaries). Each token gets a prefix wildcard for partial-word
 * matching, and tokens are joined with `AND` so all must match.
 *
 * Returns `null` if no usable tokens remain.
 *
 * Examples:
 *   "post tips"           → "post* AND tips*"
 *   "abc:def"             → "abc* AND def*"
 *   "evil\"; DROP TABLE"  → "evil* AND DROP* AND TABLE*"
 *   "(punctuation only)"  → null
 */
export function buildFtsMatchQuery(userQuery: string): string | null {
  const tokens = userQuery
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter((t) => t.length > 0)

  if (tokens.length === 0) return null
  return tokens.map((t) => `${t}*`).join(' AND ')
}

/**
 * Build the full FTS5 search SQL. Composes the MATCH clause with
 * optional WHERE fragments for filters and pagination.
 *
 * The SELECT pulls folder path (recursive CTE) and tag CSV (GROUP_CONCAT)
 * in the same query — no N+1, no application-side path walking.
 * Ordering uses FTS5's `rank` column (bm25-style; lower is better) with
 * `created_at DESC` as a stable tiebreaker.
 */
export function buildFtsSearchQuery(
  userQuery: string,
  filters: SearchFilters,
  limit: number,
  offset: number,
): FtsSearchQuery | EmptyQuery {
  const ftsExpr = buildFtsMatchQuery(userQuery)
  if (ftsExpr === null) {
    return {
      sql: 'SELECT 1 WHERE 1 = 0',
      params: [],
      mode: 'empty',
      trigrams: [],
    }
  }

  const where: string[] = ['bookmark_fts MATCH ?']
  const params: (string | number)[] = [ftsExpr]

  appendFilters(where, params, filters)

  params.push(limit, offset)

  const sql = `
    WITH RECURSIVE
      folder_paths(id, parent_id, name, path) AS (
        SELECT id, parent_id, name, name FROM folders WHERE parent_id IS NULL
        UNION ALL
        SELECT f.id, f.parent_id, f.name, fp.path || ' > ' || f.name
          FROM folders f JOIN folder_paths fp ON f.parent_id = fp.id
      ),
      bookmark_tags_agg AS (
        SELECT bt.bookmark_id, GROUP_CONCAT(t.name, x'1f') AS tag_csv
          FROM bookmark_tags bt JOIN tags t ON bt.tag_id = t.id
         GROUP BY bt.bookmark_id
      )
    SELECT
      b.id, b.url, b.title,
      b.created_at,
      fp.path AS folder_path,
      COALESCE(bta.tag_csv, '') AS tag_csv,
      bm25(bookmark_fts) AS rank_score,
      snippet(bookmark_fts, 0, '<mark>', '</mark>', '\u2026', 16) AS title_snippet,
      snippet(bookmark_fts, 1, '<mark>', '</mark>', '\u2026', 16) AS url_snippet
    FROM bookmark_fts
    JOIN bookmarks b ON b.rowid = bookmark_fts.rowid
    JOIN folder_paths fp ON b.folder_id = fp.id
    LEFT JOIN bookmark_tags_agg bta ON bta.bookmark_id = b.id
    WHERE ${where.join(' AND ')}
    ORDER BY rank_score, b.created_at DESC, b.id DESC
    LIMIT ? OFFSET ?
  `

  return { sql, params, mode: 'fts5' }
}

// ─── Candidate fetch builder (for fuzzy fallback) ─────────────────────────

/**
 * Build a SQL query that returns candidate bookmark rows for fuzzy
 * (trigram) matching. Pre-filters by trigram overlap so we don't have
 * to JS-score every bookmark in the DB.
 *
 * Returns the query trigrams alongside the SQL so the caller can score
 * each candidate against them. The query trigrams are derived in JS (not
 * SQL) because SQLite string functions can't easily enumerate substring
 * positions.
 *
 * If the query has too few characters to produce any trigrams, returns
 * an `empty` query.
 */
export function buildCandidateFetchQuery(
  userQuery: string,
  filters: SearchFilters,
  candidateLimit: number,
): CandidateFetchQuery | EmptyQuery {
  const trigrams = extractTrigramsAsArray(userQuery)
  if (trigrams.length === 0) {
    return {
      sql: 'SELECT 1 WHERE 1 = 0',
      params: [],
      mode: 'empty',
      trigrams: [],
    }
  }

  const placeholders = trigrams.map(() => '?').join(', ')

  const where: string[] = [
    `EXISTS (
      SELECT 1 FROM bookmark_trigrams bt
       WHERE bt.bookmark_id = b.id AND bt.trigram IN (${placeholders})
    )`,
  ]
  const params: (string | number)[] = [...trigrams]

  appendFilters(where, params, filters)

  params.push(candidateLimit)

  const sql = `
    WITH RECURSIVE
      folder_paths(id, parent_id, name, path) AS (
        SELECT id, parent_id, name, name FROM folders WHERE parent_id IS NULL
        UNION ALL
        SELECT f.id, f.parent_id, f.name, fp.path || ' > ' || f.name
          FROM folders f JOIN folder_paths fp ON f.parent_id = fp.id
      ),
      bookmark_tags_agg AS (
        SELECT bt.bookmark_id, GROUP_CONCAT(t.name, x'1f') AS tag_csv
          FROM bookmark_tags bt JOIN tags t ON bt.tag_id = t.id
         GROUP BY bt.bookmark_id
      )
    SELECT
      b.id, b.url, b.title,
      b.created_at,
      fp.path AS folder_path,
      COALESCE(bta.tag_csv, '') AS tag_csv
    FROM bookmarks b
    JOIN folder_paths fp ON b.folder_id = fp.id
    LEFT JOIN bookmark_tags_agg bta ON bta.bookmark_id = b.id
    WHERE ${where.join(' AND ')}
    ORDER BY b.created_at DESC, b.id DESC
    LIMIT ?
  `

  return { sql, params, mode: 'candidates', trigrams }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Compose WHERE-clause fragments for the supplied filters. Mutates the
 * arrays in place; returns nothing. Shared by both builders.
 *
 * Each filter is optional. Missing filters contribute nothing to the
 * WHERE clause (the corresponding column is unconstrained). Each
 * appended filter is a parameterized fragment — no SQL injection risk.
 */
function appendFilters(
  where: string[],
  params: (string | number)[],
  filters: SearchFilters,
): void {
  if (typeof filters.folderId === 'string' && filters.folderId !== '') {
    where.push('b.folder_id = ?')
    params.push(filters.folderId)
  }
  if (typeof filters.tagId === 'string' && filters.tagId !== '') {
    where.push(
      'EXISTS (SELECT 1 FROM bookmark_tags bt WHERE bt.bookmark_id = b.id AND bt.tag_id = ?)',
    )
    params.push(filters.tagId)
  }
  if (typeof filters.fromDate === 'string' && filters.fromDate !== '') {
    where.push('b.created_at >= ?')
    params.push(filters.fromDate)
  }
  if (typeof filters.toDate === 'string' && filters.toDate !== '') {
    where.push('b.created_at <= ?')
    params.push(filters.toDate)
  }
}

/**
 * Extract every distinct trigram from `text`. Pads the string with two
 * spaces on each side so very short strings still produce trigrams.
 *
 * Lowercase + collapse whitespace before extracting so case differences
 * and word boundaries don't fragment the trigram set (otherwise "Postgres"
 * and "postgres" would produce disjoint trigrams and miss matches).
 */
export function extractTrigrams(text: string): Set<string> {
  const trimmed = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (trimmed === '') return new Set<string>()
  // Single-space padding on each side. Padded-text trigrams capture
  // word boundaries (e.g. " pa" marks the start of a word starting with
  // 'p'). We use a SINGLE space, not two — double-space produced
  // spurious overlap like "  p" that matched every word beginning with
  // the same letter.
  const normalized = ` ${trimmed} `
  const out = new Set<string>()
  for (let i = 0; i <= normalized.length - 3; i++) {
    out.add(normalized.slice(i, i + 3))
  }
  return out
}

/** Array form of extractTrigrams (for SQL IN (?, ?, ?)). */
export function extractTrigramsAsArray(text: string): string[] {
  return [...extractTrigrams(text)]
}

// ─── Public helpers for limit clamping (used by HTTP layer) ──────────────

export function clampSearchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_LIMIT
  }
  return Math.min(MAX_LIMIT, Math.floor(limit))
}

export function clampSearchOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset) || offset < 0) {
    return 0
  }
  return Math.floor(offset)
}

/** Maximum candidates for the fuzzy fallback (caps JS scoring cost). */
export const MAX_CANDIDATES = 1000

/** Below this many FTS5 results, trigger the fuzzy fallback. */
export const FUZZY_TRIGGER_THRESHOLD = 5