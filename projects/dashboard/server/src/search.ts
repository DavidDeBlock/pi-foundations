// search.ts — issue #009
//
// Orchestrator for the search endpoint. Composes:
//   - `SearchQueryBuilder` (pure SQL builder) — FTS5 + candidate fetch
//   - JS trigram scoring (Jaccard) for the fuzzy fallback
//   - Snippet generation (FTS5 `snippet()` for exact, JS `<mark>` wrap
//     for fuzzy)
//   - HTTP layer: `GET /api/search` returns JSON; `GET /search`
//     returns a server-rendered HTML page.
//
// Strategy:
//   1. Run the FTS5 query first. FTS5 prefix-matches each token.
//   2. If the result count is below `FUZZY_TRIGGER_THRESHOLD`, run the
//      candidate fetch + JS Jaccard scoring (typo-tolerant fallback).
//   3. Return whichever mode produced results, tagged in the response
//      so the UI can show "fuzzy match" as a hint.
//
// Layering:
//   - `searchBookmarks(db, query, filters)` — orchestrator (pure-ish:
//     does DB I/O but no HTTP concerns). Tests cover this directly.
//   - `searchApi(db)` — Hono sub-app for `GET /api/search` (JSON).
//   - `searchViewApi(db)` — Hono sub-app for `GET /search` (HTML).
//   - `recomputeTrigramsForBookmark(db, bookmarkId)` — public helper
//     called by `bookmarks.ts` and `tags.ts` after writes.

import { Hono } from 'hono'
import type { Database } from './db.js'
import type { AuthVariables } from './auth.js'
import {
  buildFtsSearchQuery,
  buildCandidateFetchQuery,
  clampSearchLimit,
  clampSearchOffset,
  extractTrigrams,
  extractTrigramsAsArray,
  MAX_CANDIDATES,
} from './search-query-builder.js'
import { queryFolderOptions, queryAllTagOptions, type CategorizeContext } from './activity-feed.js'

// Re-export SearchFilters so callers (HTTP layer, tests) only import from
// this module; the search-query-builder is an implementation detail.
export type { SearchFilters } from './search-query-builder.js'
import { COMMON_HEAD, THEME_SCRIPT_TAG, CLIPBOARD_SCRIPT_TAG, HAMBURGER_SCRIPT_TAG, renderHeader, renderEmptyState } from './view-shared.js'

// ─── Result types ─────────────────────────────────────────────────────────

export type SearchMode = 'fts5' | 'fuzzy' | 'empty'

export interface SearchResult {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly folderPath: string
  readonly createdAt: string
  readonly tags: readonly string[]
  readonly snippet: string   // title or url with <mark>…</mark>
}

export interface SearchResponse {
  readonly mode: SearchMode
  readonly query: string
  readonly results: readonly SearchResult[]
  readonly totalCount: number
}

// ─── Internal row shapes (raw SQL output) ─────────────────────────────────

interface RawSearchRow {
  id: string
  url: string
  title: string
  created_at: string
  folder_path: string
  tag_csv: string
  rank_score?: number
  title_snippet?: string
  url_snippet?: string
}

interface RawCandidateRow {
  id: string
  url: string
  title: string
  created_at: string
  folder_path: string
  tag_csv: string
}

// ─── Orchestrator ─────────────────────────────────────────────────────────

/**
 * Run the search pipeline. Returns the shaped results and which mode
 * produced them (FTS5 or fuzzy fallback).
 *
 * `filters.limit` and `filters.offset` are clamped; everything else is
 * passed through to the builder. An empty/whitespace query returns an
 * empty response with `mode: 'empty'`.
 */
export function searchBookmarks(
  db: Database,
  userQuery: string,
  filters: { folderId?: string; tagId?: string; fromDate?: string; toDate?: string; limit?: number; offset?: number } = {},
): SearchResponse {
  const query = userQuery.trim()
  if (query === '') {
    return { mode: 'empty', query: '', results: [], totalCount: 0 }
  }

  const limit = clampSearchLimit(filters.limit)
  const offset = clampSearchOffset(filters.offset)

  // ── Phase 1: FTS5 ────────────────────────────────────────────────────
  const ftsQuery = buildFtsSearchQuery(query, filters, limit, offset)
  if (ftsQuery.mode === 'fts5') {
    const rows = db.all<RawSearchRow>(ftsQuery.sql, [...ftsQuery.params])
    if (rows.length > 0) {
      return {
        mode: 'fts5',
        query,
        results: rows.map(rowToFtsResult),
        totalCount: rows.length,
      }
    }
  }

  // ── Phase 2: Fuzzy fallback ──────────────────────────────────────────
  const candidateQuery = buildCandidateFetchQuery(query, filters, MAX_CANDIDATES)
  if (candidateQuery.mode === 'empty') {
    // Query had no trigrams (pure punctuation) — return FTS5's results
    // (likely empty too) without falling back.
    return {
      mode: 'fts5',
      query,
      results: ftsQuery.mode === 'fts5'
        ? db.all<RawSearchRow>(ftsQuery.sql, [...ftsQuery.params]).map(rowToFtsResult)
        : [],
      totalCount: 0,
    }
  }

  const candidates = db.all<RawCandidateRow>(candidateQuery.sql, [
    ...candidateQuery.params,
  ])
  const queryGrams = new Set(candidateQuery.trigrams)

  const scored: Array<{ result: SearchResult; score: number }> = []
  for (const c of candidates) {
    const corpus = `${c.title}\n${c.url}\n${c.tag_csv.replace(/\x1f/g, ' ')}`
    const candGrams = extractTrigrams(corpus)
    const score = jaccard(queryGrams, candGrams)
    if (score > 0) {
      scored.push({
        score,
        result: rowToFuzzyResult(c, queryGrams),
      })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, limit).map((s) => s.result)

  return { mode: 'fuzzy', query, results: top, totalCount: top.length }
}

// ─── Row → result ─────────────────────────────────────────────────────────

function rowToFtsResult(r: RawSearchRow): SearchResult {
  // Prefer the FTS5-generated title snippet; fall back to the raw title
  // if the snippet helper returned null (no match term in title).
  const snippet = r.title_snippet ?? r.title
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    folderPath: r.folder_path,
    createdAt: r.created_at,
    tags: splitTags(r.tag_csv),
    snippet,
  }
}

function rowToFuzzyResult(
  r: RawCandidateRow,
  queryGrams: Set<string>,
): SearchResult {
  // For fuzzy matches, generate a snippet by wrapping any query-trigram
  // hit in the title with <mark>. We pick the longest matching trigram
  // as the highlight token (avoids marking single chars like "  ").
  const snippet = makeFuzzySnippet(r.title, queryGrams)
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    folderPath: r.folder_path,
    createdAt: r.created_at,
    tags: splitTags(r.tag_csv),
    snippet,
  }
}

function splitTags(csv: string): string[] {
  if (csv === '') return []
  return csv.split('\x1f').sort()
}

// ─── Trigram scoring ──────────────────────────────────────────────────────

/**
 * Jaccard similarity: |intersect(A, B)| / |union(A, B)|.
 * Returns 0 when both sets are empty (so we don't accidentally match
 * against a bookmark with no trigram-extractable text).
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersect = 0
  for (const x of a) if (b.has(x)) intersect++
  const union = a.size + b.size - intersect
  return union === 0 ? 0 : intersect / union
}

// ─── Snippet helpers ──────────────────────────────────────────────────────

/**
 * Build a snippet from `text` by finding any trigram in `queryGrams`
 * that appears in the text's trigrams and wrapping the longest such
 * trigram's first occurrence in <mark> tags.
 *
 * Case-insensitive; preserves the original casing in the output. If no
 * trigram matches (shouldn't happen for fuzzy-mode results since we
 * already filtered by trigram overlap), returns the text unchanged.
 */
function makeFuzzySnippet(text: string, queryGrams: Set<string>): string {
  const textGrams = extractTrigramsAsArray(text)
  // Find the longest query trigram that actually appears in the text's
  // trigram list. Longer = more specific = better highlight anchor.
  let best: string | null = null
  for (const qg of queryGrams) {
    if (qg.length < 3) continue
    if (textGrams.includes(qg)) {
      if (best === null || qg.length > best.length) {
        best = qg
      }
    }
  }
  if (best === null) return escapeHtml(text)

  // Wrap the first case-insensitive occurrence of `best` in the text.
  const lower = text.toLowerCase()
  const idx = lower.indexOf(best.toLowerCase())
  if (idx < 0) return escapeHtml(text)
  const before = text.slice(0, idx)
  const match = text.slice(idx, idx + best.length)
  const after = text.slice(idx + best.length)
  return `${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ─── Trigram maintenance ─────────────────────────────────────────────────

/**
 * Recompute the trigram index for a single bookmark. Replaces all
 * existing rows for `bookmarkId` with the trigrams of the bookmark's
 * current title + url + tag names. No-op if the bookmark doesn't exist.
 *
 * Called from:
 *   - `bookmarks.ts` after title update (and any other title/url change)
 *   - `tags.ts` after attach / detach / replace (tag names change the
 *     searchable corpus)
 *   - `sync.ts` after applySync inserts/updates bookmarks
 *
 * Runs in a single transaction so concurrent reads never see a half-
 * rebuilt trigram set.
 */
export function recomputeTrigramsForBookmark(
  db: Database,
  bookmarkId: string,
): void {
  bulkRecomputeTrigrams(db, [bookmarkId])
}

/**
 * Bulk version of `recomputeTrigramsForBookmark`. All bookmarks share
 * a single transaction so the per-row transaction overhead is
 * amortized. Used by `sync.ts` after `applySync` touches many rows at
 * once — a 1,000-bookmark sync would otherwise mean 1,000 transactions.
 *
 * Missing bookmark ids are silently skipped (the FK ON DELETE CASCADE
 * already cleaned up their trigram rows).
 */
export function bulkRecomputeTrigrams(
  db: Database,
  bookmarkIds: readonly string[],
): void {
  if (bookmarkIds.length === 0) return

  db.transaction(() => {
    for (const bookmarkId of bookmarkIds) {
      const row = db.get<{ title: string; url: string }>(
        'SELECT title, url FROM bookmarks WHERE id = ?',
        [bookmarkId],
      )
      if (!row) continue

      const tagRows = db.all<{ name: string }>(
        `SELECT t.name FROM tags t
           JOIN bookmark_tags bt ON bt.tag_id = t.id
          WHERE bt.bookmark_id = ?
          ORDER BY t.name`,
        [bookmarkId],
      )

      const corpus = [row.title, row.url, ...tagRows.map((t) => t.name)]
        .join(' ')
        .toLowerCase()

      const trigrams = extractTrigramsAsArray(corpus)

      db.run('DELETE FROM bookmark_trigrams WHERE bookmark_id = ?', [bookmarkId])
      for (const t of trigrams) {
        db.run(
          'INSERT OR IGNORE INTO bookmark_trigrams (bookmark_id, trigram) VALUES (?, ?)',
          [bookmarkId, t],
        )
      }
    }
  })
}

// ─── HTTP API ─────────────────────────────────────────────────────────────

/**
 * JSON API for search. Returns shaped results for the JS search-as-you-type
 * component to render. The HTTP layer stays thin: it parses query params,
 * clamps, hands off to the orchestrator.
 */
export function searchApi(db: Database): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  api.get('/', (c) => {
    const q = c.req.query('q') ?? ''
    const response = searchBookmarks(db, q, {
      folderId: c.req.query('folder'),
      tagId: c.req.query('tag'),
      fromDate: c.req.query('from'),
      toDate: c.req.query('to'),
      limit: parseIntOr(c.req.query('perPage'), undefined),
      offset: pageToOffset(c.req.query('page'), parseIntOr(c.req.query('perPage'), undefined)),
    })
    return c.json(response)
  })

  return api
}

function parseIntOr(value: string | undefined, fallback: number | undefined): number | undefined {
  if (value === undefined) return fallback
  const n = parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

/** Convert a 1-based `page` query param into a 0-based offset. */
function pageToOffset(page: string | undefined, perPage: number | undefined): number | undefined {
  const p = parseIntOr(page, undefined)
  if (p === undefined || p < 1) return undefined
  const pp = perPage ?? clampSearchLimit(undefined)
  return (p - 1) * pp
}

// ─── HTML page (server-rendered) ──────────────────────────────────────────

const SEARCH_PAGE_STYLES = `
  body { font-family: system-ui, sans-serif; max-width: 56rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-weight: 500; }
  .user { color: #666; font-size: 0.9rem; }
  .search-form { margin: 1.5rem 0; display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
  .search-form input[type=search] { font-size: 1rem; padding: 0.4rem 0.6rem; border: 1px solid #ccc; border-radius: 0.25rem; min-width: 18rem; }
  .search-form select { font-size: 0.9rem; padding: 0.3rem 0.4rem; border: 1px solid #ccc; border-radius: 0.25rem; }
  .search-form input[type=date] { font-size: 0.9rem; padding: 0.25rem 0.4rem; border: 1px solid #ccc; border-radius: 0.25rem; }
  .search-form button { font-size: 0.9rem; padding: 0.4rem 0.8rem; border: 1px solid #06c; background: #06c; color: #fff; border-radius: 0.25rem; cursor: pointer; }
  .search-form button.secondary { background: #f6f6f6; color: #333; border-color: #ccc; }
  .search-status { color: #666; font-size: 0.85rem; margin: 1rem 0; }
  .search-status .fuzzy { color: #b85c00; }
  ul.results { list-style: none; padding: 0; margin: 0; }
  .result { padding: 1rem 0; border-bottom: 1px solid #eee; }
  .result:last-child { border-bottom: none; }
  .result h3 { margin: 0 0 0.25rem; font-size: 1rem; font-weight: 500; }
  .result h3 a { color: #1a1a1a; text-decoration: none; }
  .result h3 a:hover { text-decoration: underline; }
  .result .snippet { color: #444; font-size: 0.9rem; margin: 0.25rem 0; }
  .result .snippet mark { background: #fff3a8; padding: 0 0.15rem; border-radius: 0.1rem; }
  .result .meta { color: #666; font-size: 0.85rem; }
  .tag { display: inline-block; background: #eef; color: #335; padding: 0.1rem 0.5rem; border-radius: 0.25rem; font-size: 0.8rem; margin-right: 0.25rem; }
  nav { margin-top: 1.5rem; }
  nav a { margin-right: 1rem; color: #06c; }
  .pagination { display: flex; justify-content: space-between; align-items: center; padding: 1rem 0; color: #666; font-size: 0.9rem; }
  .pagination a { color: #06c; text-decoration: none; }
  .pagination .disabled { color: #bbb; }
  .empty { color: #999; font-style: italic; padding: 2rem 0; text-align: center; }
`

/**
 * HTML search results page (deep-linkable, server-rendered).
 * Mounted at `/search` by `app.ts`. Mirrors `activityFeedApi`'s pattern
 * of a Hono sub-app with one GET route.
 *
 * The page also includes a `<script src="/static/search.js" defer>` tag
 * so the search-as-you-type UX is available — the JS hooks into the
 * `<form data-search-form>` and fetches JSON from `/api/search`.
 */
export function searchViewApi(db: Database): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  api.get('/', (c) => {
    const who = c.get('user') ?? c.get('tokenId') ?? 'unknown'
    const q = c.req.query('q') ?? ''
    const folderId = c.req.query('folder') ?? ''
    const tagId = c.req.query('tag') ?? ''
    const fromDate = c.req.query('from') ?? ''
    const toDate = c.req.query('to') ?? ''
    const page = parseIntOr(c.req.query('page'), undefined)
    const perPage = parseIntOr(c.req.query('perPage'), undefined)

    const response = searchBookmarks(db, q, {
      folderId: folderId || undefined,
      tagId: tagId || undefined,
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
      limit: perPage,
      offset: page !== undefined && page > 1 ? (page - 1) * (perPage ?? 50) : undefined,
    })

    const ctx: CategorizeContext = {
      folderOptions: queryFolderOptions(db),
      allTags: queryAllTagOptions(db),
    }

    return c.html(
      renderSearchPage(who, response, {
        query: q,
        folderId,
        tagId,
        fromDate,
        toDate,
        page: page ?? 1,
        perPage: perPage ?? clampSearchLimit(undefined),
        ctx,
      }),
    )
  })

  return api
}

interface SearchPageRenderOpts {
  readonly query: string
  readonly folderId: string
  readonly tagId: string
  readonly fromDate: string
  readonly toDate: string
  readonly page: number
  readonly perPage: number
  readonly ctx: CategorizeContext
}

function renderSearchPage(
  user: string,
  response: SearchResponse,
  opts: SearchPageRenderOpts,
): string {
  // Three display modes:
  //   1. Empty query ("")          → prompt: "Type a query…"
  //   2. Query with zero results   → centred .empty-state panel
  //   3. Query with N>0 results    → status line + result list
  const statusHtml =
    response.mode === 'empty'
      ? `<p class="search-status">Type a query above to search bookmarks.</p>`
      : response.results.length === 0
        ? renderEmptyState({ kind: 'no-results', query: response.query })
        : `<p class="search-status">${response.results.length} result${response.results.length === 1 ? '' : 's'} for <strong>${escapeHtml(response.query)}</strong>${response.mode === 'fuzzy' ? ' <span class="fuzzy">(fuzzy match)</span>' : ''}</p>`

  const resultsHtml =
    response.results.length === 0
      ? ''
      : `<ul class="results">${response.results.map((r) => renderResultItem(r)).join('')}</ul>`

  const paginationHtml = renderPagination(opts, response.totalCount)

  return `<!doctype html>
<html lang="en">
  <head>
${COMMON_HEAD}
    <title>Search — Dashboard</title>
    <style>${SEARCH_PAGE_STYLES}</style>
  </head>
  <body data-user="${escapeHtml(user)}">
    ${renderHeader({ initialQuery: opts.query })}
    <main class="search-main">
      ${renderSearchForm(opts)}
      ${statusHtml}
      ${resultsHtml}
      ${paginationHtml}
      <nav><a href="/">Activity</a> &middot; <a href="/settings">Settings</a></nav>
    </main>
    <script src="/static/search.js" defer></script>
    ${CLIPBOARD_SCRIPT_TAG}
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
  </body>
</html>`
}

function renderSearchForm(opts: SearchPageRenderOpts): string {
  const folderOptions = opts.ctx.folderOptions
    .map(
      (f) =>
        `<option value="${escapeHtml(f.id)}"${f.id === opts.folderId ? ' selected' : ''}>${escapeHtml(f.path)}</option>`,
    )
    .join('')
  const tagOptions = opts.ctx.allTags
    .map(
      (t) =>
        `<option value="${escapeHtml(t.id)}"${t.id === opts.tagId ? ' selected' : ''}>${escapeHtml(t.name)}</option>`,
    )
    .join('')

  return `
    <form class="search-form" data-search-form method="get" action="/search">
      <input type="search" name="q" placeholder="Search bookmarks\u2026" value="${escapeHtml(opts.query)}" autofocus data-search-input>
      <select name="folder" data-search-folder>
        <option value="">All folders</option>
        ${folderOptions}
      </select>
      <select name="tag" data-search-tag>
        <option value="">All tags</option>
        ${tagOptions}
      </select>
      <input type="date" name="from" value="${escapeHtml(opts.fromDate)}" title="From date">
      <input type="date" name="to" value="${escapeHtml(opts.toDate)}" title="To date">
      <button type="submit">Search</button>
      <a href="/search" class="button secondary">Clear</a>
    </form>
  `
}

function renderResultItem(r: SearchResult): string {
  const tagsHtml =
    r.tags.length > 0
      ? r.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')
      : ''
  return `
    <li class="result" data-bookmark-id="${escapeHtml(r.id)}">
      <h3><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a></h3>
      <p class="snippet">${r.snippet}</p>
      <p class="meta">${escapeHtml(r.folderPath)} &middot; ${tagsHtml}</p>
    </li>
  `
}

function renderPagination(
  opts: SearchPageRenderOpts,
  totalCount: number,
): string {
  if (opts.query === '' || totalCount === 0) return ''
  const totalPages = Math.max(1, Math.ceil(totalCount / opts.perPage))
  if (totalPages <= 1) return ''
  const prev = opts.page > 1 ? `<a href="?${paginationQuery(opts, opts.page - 1)}">\u2190 Newer</a>` : `<span class="disabled">\u2190 Newer</span>`
  const next = opts.page < totalPages ? `<a href="?${paginationQuery(opts, opts.page + 1)}">Older \u2192</a>` : `<span class="disabled">Older \u2192</span>`
  return `<div class="pagination">${prev}<span>Page ${opts.page} of ${totalPages}</span>${next}</div>`
}

function paginationQuery(opts: SearchPageRenderOpts, page: number): string {
  const params = new URLSearchParams()
  if (opts.query) params.set('q', opts.query)
  if (opts.folderId) params.set('folder', opts.folderId)
  if (opts.tagId) params.set('tag', opts.tagId)
  if (opts.fromDate) params.set('from', opts.fromDate)
  if (opts.toDate) params.set('to', opts.toDate)
  params.set('page', String(page))
  if (opts.perPage) params.set('perPage', String(opts.perPage))
  return params.toString()
}

// Tree type re-exported for downstream consumers (tests, future modules).
export type { FolderNode } from './folders.js'