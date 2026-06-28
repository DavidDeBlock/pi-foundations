// activity-feed.ts — issues #007 + #008
//
// Renders the dashboard's landing page (activity feed of recent bookmarks)
// and the per-bookmark detail page. The module encapsulates:
//
//   - Query layer: `queryFeed()`, `queryBookmark()`, `queryFolderOptions()`
//     build SQL against the bookmarks + folders + bookmark_tags + tags
//     tables, returning typed result objects (NOT raw rows).
//   - View layer: `renderFeedPage()` and `renderDetailPage()` produce
//     server-rendered HTML strings from those typed objects.
//
// #008 additions:
//   - When the optional `categorize` context is passed, the renderers
//     embed categorize controls (inline title edit, folder picker, tag
//     input, × buttons, sidebar + button, double-click rename). All
//     interactions are driven by `categorize.js`, served at
//     `/static/categorize.js` from `app.ts`. The renderer only emits
//     the markup + data attributes; the JS owns event binding.
//   - `queryFolderOptions()` produces the flat list of folders with
//     their full path strings, for the move picker.
//   - `queryAllTagOptions()` produces the list of all tags for the
//     autocomplete `<datalist>`.
//
// NOT responsible for:
//   - HTTP routing (app.ts owns that)
//   - Browser-side JS (categorize.js is its own file)
//   - Search (#009)

import { Hono } from 'hono'
import type { Database } from './db.js'
import { buildTree, type FolderNode } from './folders.js'
import type { AuthVariables } from './auth.js'

// ─── Public types ─────────────────────────────────────────────────────────

export interface FeedItem {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly folderPath: string
  readonly createdAt: string
  readonly tags: readonly string[]
}

export interface FeedPage {
  readonly items: readonly FeedItem[]
  readonly page: number
  readonly perPage: number
  readonly totalItems: number
  readonly totalPages: number
}

export interface FeedQueryOptions {
  readonly page?: number
  readonly perPage?: number
  /** When set, restrict the feed to bookmarks inside this folder OR any
   *  of its descendants. The filter is applied to `totalItems` so
   *  pagination reports correct page counts for the filtered view. */
  readonly folderId?: string
}

export interface BookmarkDetail {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly folderPath: string
  readonly tags: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastSeenAt: string | null
}

/**
 * One option in the "move to folder" picker. `path` is the full
 * ancestry from root (e.g. `"Bookmarks bar > Tech"`), used for the
 * label so users can pick by visible location rather than by id.
 */
export interface FolderOption {
  readonly id: string
  readonly name: string
  readonly path: string
}

/** One option in the tag autocomplete `<datalist>`. */
export interface TagOption {
  readonly id: string
  readonly name: string
}

/**
 * Optional categorize context passed to the renderers. When provided,
 * the rendered HTML includes inline-edit / folder-picker / tag-input
 * controls wired up by `categorize.js`. When omitted (unit tests), the
 * markup is plain — no controls, no extra data attributes, no datalist.
 *
 * Routes pass this context by default; tests pass `undefined` to keep
 * assertions simple.
 */
export interface CategorizeContext {
  readonly folderOptions: readonly FolderOption[]
  readonly allTags: readonly TagOption[]
}

// ─── Defaults ─────────────────────────────────────────────────────────────

const DEFAULT_PER_PAGE = 50
const MAX_PER_PAGE = 200

// ─── Query layer ──────────────────────────────────────────────────────────

export function queryFeed(
  db: Database,
  opts: FeedQueryOptions = {},
): FeedPage {
  const page = clampPage(opts.page)
  const perPage = clampPerPage(opts.perPage)
  const offset = (page - 1) * perPage
  const folderId = opts.folderId

  // When filtering by folder, restrict to that folder and all its
  // descendants via a recursive CTE. The same CTE also builds the
  // `folder_paths` row set so we can both filter AND render the
  // human-readable folder path on each card in one query.
  const sql = `
    WITH RECURSIVE
      folder_paths(id, parent_id, name, path) AS (
        SELECT id, parent_id, name, name
          FROM folders
         WHERE parent_id IS NULL
        UNION ALL
        SELECT f.id, f.parent_id, f.name, fp.path || ' > ' || f.name
          FROM folders f
          JOIN folder_paths fp ON f.parent_id = fp.id
      ),
      ${folderId
        ? `folder_filter(id) AS (
             SELECT id FROM folders WHERE id = ?
             UNION ALL
             SELECT f.id FROM folders f JOIN folder_filter ff ON f.parent_id = ff.id
           ),`
        : ''}
      bookmark_tags_agg AS (
        SELECT bt.bookmark_id, GROUP_CONCAT(t.name, x'1f') AS tag_csv
          FROM bookmark_tags bt
          JOIN tags t ON bt.tag_id = t.id
         GROUP BY bt.bookmark_id
      )
    SELECT b.id, b.url, b.title, b.created_at,
           fp.path AS folder_path,
           COALESCE(bta.tag_csv, '') AS tag_csv
      FROM bookmarks b
      JOIN folder_paths fp ON b.folder_id = fp.id
      ${folderId ? 'JOIN folder_filter ff ON ff.id = b.folder_id' : ''}
      LEFT JOIN bookmark_tags_agg bta ON bta.bookmark_id = b.id
     ORDER BY b.created_at DESC, b.id DESC
     LIMIT ? OFFSET ?
  `

  const params: unknown[] = folderId ? [folderId, perPage, offset] : [perPage, offset]
  const rows = db.all<RawFeedRow>(sql, params)

  // Total count must reflect the filter so pagination reports correct
  // page counts. We use a separate count query rather than a window
  // function over the main SELECT — simpler and SQLite handles a
  // dedicated COUNT well at this scale (see PR #009 perf note).
  const totalItems = folderId
    ? db.get<{ c: number }>(
        `WITH RECURSIVE folder_filter(id) AS (
           SELECT id FROM folders WHERE id = ?
           UNION ALL
           SELECT f.id FROM folders f JOIN folder_filter ff ON f.parent_id = ff.id
         )
         SELECT COUNT(*) AS c FROM bookmarks b
          JOIN folder_filter ff ON ff.id = b.folder_id`,
        [folderId],
      )?.c ?? 0
    : db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM bookmarks',
      )?.c ?? 0

  return {
    items: rows.map(rowToFeedItem),
    page,
    perPage,
    totalItems,
    totalPages: Math.max(1, Math.ceil(totalItems / perPage)),
  }
}

export function queryBookmark(
  db: Database,
  id: string,
): BookmarkDetail | null {
  const sql = `
    WITH RECURSIVE
      folder_paths(id, parent_id, name, path) AS (
        SELECT id, parent_id, name, name
          FROM folders
         WHERE parent_id IS NULL
        UNION ALL
        SELECT f.id, f.parent_id, f.name, fp.path || ' > ' || f.name
          FROM folders f
          JOIN folder_paths fp ON f.parent_id = fp.id
      ),
      bookmark_tags_agg AS (
        SELECT bt.bookmark_id, GROUP_CONCAT(t.name, x'1f') AS tag_csv
          FROM bookmark_tags bt
          JOIN tags t ON bt.tag_id = t.id
         GROUP BY bt.bookmark_id
      )
    SELECT b.id, b.url, b.title, b.created_at, b.updated_at, b.last_seen_at,
           fp.path AS folder_path,
           COALESCE(bta.tag_csv, '') AS tag_csv
      FROM bookmarks b
      JOIN folder_paths fp ON b.folder_id = fp.id
      LEFT JOIN bookmark_tags_agg bta ON bta.bookmark_id = b.id
     WHERE b.id = ?
     LIMIT 1
  `

  const row = db.get<RawDetailRow>(sql, [id])
  if (!row) return null
  return rowToDetail(row)
}

/**
 * Flat list of every folder, with its full ancestry path. Used by
 * the move-to-folder `<select>` so users see "Bookmarks bar > Tech"
 * instead of just "Tech".
 *
 * Computed in SQL via the same recursive CTE as `queryFeed`. Sorted
 * by path so the picker shows folders in the order they appear in
 * the sidebar.
 */
export function queryFolderOptions(db: Database): FolderOption[] {
  const sql = `
    WITH RECURSIVE folder_paths(id, parent_id, name, path) AS (
      SELECT id, parent_id, name, name
        FROM folders
       WHERE parent_id IS NULL
      UNION ALL
      SELECT f.id, f.parent_id, f.name, fp.path || ' > ' || f.name
        FROM folders f
        JOIN folder_paths fp ON f.parent_id = fp.id
    )
    SELECT id, name, path FROM folder_paths ORDER BY path
  `
  return db.all<FolderOption>(sql)
}

/** All tag rows, alphabetized. Used by the autocomplete `<datalist>`. */
export function queryAllTagOptions(db: Database): TagOption[] {
  return db.all<TagOption>('SELECT id, name FROM tags ORDER BY name')
}

// ─── SQL row shapes (internal) ────────────────────────────────────────────

interface RawFeedRow {
  id: string
  url: string
  title: string
  created_at: string
  folder_path: string
  tag_csv: string
}

interface RawDetailRow extends RawFeedRow {
  updated_at: string
  last_seen_at: string | null
}

function rowToFeedItem(r: RawFeedRow): FeedItem {
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    folderPath: r.folder_path,
    createdAt: r.created_at,
    tags: splitTags(r.tag_csv),
  }
}

function rowToDetail(r: RawDetailRow): BookmarkDetail {
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    folderPath: r.folder_path,
    tags: splitTags(r.tag_csv),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastSeenAt: r.last_seen_at,
  }
}

function splitTags(csv: string): string[] {
  if (csv === '') return []
  return csv.split('\x1f').sort()
}

// ─── View layer ───────────────────────────────────────────────────────────

const BASE_STYLES = `
  body { font-family: system-ui, sans-serif; max-width: 56rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-weight: 500; }
  .user { color: #666; font-size: 0.9rem; }
  nav { margin-top: 1.5rem; }
  nav a { margin-right: 1rem; color: #06c; }
  .layout { display: grid; grid-template-columns: 14rem 1fr; gap: 2rem; margin-top: 1.5rem; }
  aside { border-right: 1px solid #eee; padding-right: 1rem; }
  aside h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: #666; margin: 0 0 0.5rem; display: flex; align-items: center; gap: 0.5rem; }
  aside ul { list-style: none; padding: 0; margin: 0; }
  aside li { margin: 0.15rem 0; }
  aside .folder-label { color: #1a1a1a; text-decoration: none; display: block; padding: 0.2rem 0.4rem; border-radius: 0.25rem; cursor: pointer; }
  aside .folder-label:hover { background: #f0f0f0; }
  aside .folder-label.active { background: #06c; color: #fff; font-weight: 500; }
  aside .folder-label.active:hover { background: #06c; }
  aside .empty { color: #999; font-style: italic; }
  main h2 { font-weight: 500; font-size: 1.1rem; margin: 0 0 1rem; }
  main .empty { color: #999; font-style: italic; padding: 2rem 0; text-align: center; }
  ul.feed { list-style: none; padding: 0; margin: 0; }
  .feed-item { padding: 1rem 0; border-bottom: 1px solid #eee; }
  .feed-item:last-child { border-bottom: none; }
  .feed-item .title { font-size: 1rem; margin: 0 0 0.25rem; font-weight: 500; }
  .feed-item .title a { color: #1a1a1a; text-decoration: none; }
  .feed-item .title a:hover { text-decoration: underline; }
  .feed-item .detail-link { margin-left: 0.5rem; color: #06c; text-decoration: none; font-size: 0.85rem; }
  .feed-item .meta { color: #666; font-size: 0.85rem; margin: 0 0 0.5rem; }
  .feed-item .meta .folder-path { color: #444; }
  .feed-item .tags { margin: 0; }
  .tag { display: inline-block; background: #eef; color: #335; padding: 0.1rem 0.5rem; border-radius: 0.25rem; font-size: 0.8rem; margin-right: 0.25rem; margin-bottom: 0.25rem; }
  .pagination { display: flex; justify-content: space-between; align-items: center; padding: 1rem 0; color: #666; font-size: 0.9rem; }
  .pagination a { color: #06c; text-decoration: none; }
  .pagination a:hover { text-decoration: underline; }
  .pagination .disabled { color: #bbb; }
  .search-form { margin: 1rem 0; display: flex; gap: 0.5rem; align-items: center; }
  .search-form input[type=search] { font-size: 1rem; padding: 0.4rem 0.6rem; border: 1px solid #ccc; border-radius: 0.25rem; min-width: 20rem; }
  .search-form button { font-size: 0.9rem; padding: 0.4rem 0.8rem; border: 1px solid #06c; background: #06c; color: #fff; border-radius: 0.25rem; cursor: pointer; }
`

const CATEGORIZE_STYLES = `
  .feed-item .title-text { cursor: text; }
  .feed-item .title-input { font-size: 1rem; padding: 0.15rem 0.3rem; border: 1px solid #06c; border-radius: 0.25rem; }
  .feed-item .actions { margin-top: 0.4rem; display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; font-size: 0.85rem; color: #666; }
  .feed-item .actions select, .feed-item .actions input { font-size: 0.85rem; padding: 0.15rem 0.3rem; border: 1px solid #ccc; border-radius: 0.25rem; }
  .feed-item .actions input[type=text] { width: 8rem; }
  .feed-item .actions button { font-size: 0.8rem; padding: 0.15rem 0.5rem; border: 1px solid #ccc; background: #f6f6f6; border-radius: 0.25rem; cursor: pointer; color: #333; }
  .feed-item .actions button:hover { background: #eee; }
  .feed-item .tag-remove { margin-left: 0.2rem; color: #900; background: none; border: none; cursor: pointer; font-size: 0.9rem; padding: 0; }
  .feed-item .tag-remove:hover { color: #c00; }
  .feed-item .saved-flash { color: #080; font-size: 0.8rem; }
  .feed-item .error-flash { color: #c00; font-size: 0.8rem; }
  /* The folder-name span sits inside an anchor that filters the feed,
     so it inherits cursor:pointer from the link. We only flip to
     text cursor while the inline rename input is active. */
  aside .folder-name[data-editing="true"] { background: #fffbe6; outline: 1px solid #d8b400; }
  aside .add-folder-btn { font-size: 0.85rem; padding: 0 0.4rem; border: 1px solid #ccc; background: #f6f6f6; border-radius: 0.25rem; cursor: pointer; color: #333; }
  aside .add-folder-btn:hover { background: #eee; }
  aside .add-folder-form { margin-top: 0.5rem; display: none; }
  aside .add-folder-form[data-open="true"] { display: block; }
  aside .add-folder-form input { font-size: 0.85rem; padding: 0.15rem 0.3rem; border: 1px solid #ccc; border-radius: 0.25rem; width: 10rem; margin-right: 0.25rem; }
  aside .add-folder-form button { font-size: 0.8rem; padding: 0.15rem 0.5rem; border: 1px solid #ccc; background: #f6f6f6; border-radius: 0.25rem; cursor: pointer; }
  dl { margin: 1.5rem 0; }
  dt { color: #666; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 1rem; }
  dd { margin: 0.25rem 0 0; word-break: break-all; }
  dd.url a { color: #06c; }
  .detail-edit input[type=text] { font-size: 1rem; padding: 0.25rem 0.4rem; border: 1px solid #06c; border-radius: 0.25rem; min-width: 20rem; }
  .detail-edit select, .detail-edit input { font-size: 0.95rem; padding: 0.2rem 0.3rem; border: 1px solid #ccc; border-radius: 0.25rem; }
  .detail-edit button { font-size: 0.85rem; padding: 0.2rem 0.6rem; border: 1px solid #ccc; background: #f6f6f6; border-radius: 0.25rem; cursor: pointer; }
  .detail-edit .tag-remove { margin-left: 0.3rem; color: #900; background: none; border: none; cursor: pointer; font-size: 1rem; padding: 0; }
  .detail-edit .actions { margin-top: 0.4rem; }
  nav.back { margin-top: 2rem; }
  nav.back a { color: #06c; text-decoration: none; }
  nav.back a:hover { text-decoration: underline; }
`

export function renderFeedPage(
  user: string,
  tree: readonly FolderNode[],
  feed: FeedPage,
  categorize?: CategorizeContext,
  activeFolderId?: string | null,
): string {
  const styles = categorize ? BASE_STYLES + CATEGORIZE_STYLES : BASE_STYLES
  const sidebarHtml = categorize
    ? renderFolderSidebarCategorize(tree, activeFolderId)
    : renderFolderSidebar(tree, activeFolderId)
  const itemsHtml = feed.items
    .map((item) => renderFeedItem(item, categorize))
    .join('')
  const activeFolderPath = activeFolderId ? findFolderPath(tree, activeFolderId) : undefined
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Dashboard — Activity</title>
    <style>${styles}</style>
  </head>
  <body>
    <h1>Dashboard</h1>
    <p class="user">Signed in as <strong>${escapeHtml(user)}</strong></p>
    <form class="search-form" data-search-form method="get" action="/search">
      <input type="search" name="q" placeholder="Search\u2026" data-search-input>
      <button type="submit">Search</button>
    </form>
    <div class="layout">
      <aside>
        ${sidebarHtml}
      </aside>
      <main>
        ${renderFeedMain(feed, itemsHtml, activeFolderId ?? undefined, activeFolderPath ?? undefined)}
        <nav><a href="/settings">Settings</a> &middot; <a href="/api/folders">JSON</a></nav>
      </main>
    </div>
    ${categorize ? renderCategorizeDatalists(feed.items, categorize.allTags) : ''}
    ${categorize ? categorizeScriptTag() : ''}
  </body>
</html>`
}

/**
 * Walk the sidebar tree and return the human-readable path (root → leaf)
 * for the folder with the given id, or null if no such folder exists.
 * Returns just the folder name for root folders.
 */
function findFolderPath(
  tree: readonly FolderNode[],
  id: string,
  prefix: string = '',
): string | null {
  for (const node of tree) {
    const path = prefix ? `${prefix} > ${node.name}` : node.name
    if (node.id === id) return path
    const found = findFolderPath(node.children, id, path)
    if (found) return found
  }
  return null
}

/** Find a folder id anywhere in the tree. Returns null if not found. */
function findFolderNodeId(
  tree: readonly FolderNode[],
  id: string,
): string | null {
  for (const node of tree) {
    if (node.id === id) return node.id
    const found = findFolderNodeId(node.children, id)
    if (found) return found
  }
  return null
}

function renderFeedMain(feed: FeedPage, itemsHtml: string, activeFolderId?: string, activeFolderPath?: string): string {
  if (feed.totalItems === 0) {
    const emptyMessage = activeFolderPath
      ? `No bookmarks in <strong>${escapeHtml(activeFolderPath)}</strong> or its subfolders. <a href="/">Show all bookmarks</a>.`
      : 'No bookmarks synced yet. Install the Chrome extension and save its settings to import your bookmark tree.'
    return `
      <h2>Activity${activeFolderPath ? ` <span style="color:#666;font-weight:400;font-size:0.9rem">in ${escapeHtml(activeFolderPath)}</span>` : ''}</h2>
      <p class="empty">${emptyMessage}</p>
    `
  }
  const start = (feed.page - 1) * feed.perPage + 1
  const end = Math.min(start + feed.perPage - 1, feed.totalItems)
  const range = start === end ? `${start}` : `${start}–${end}`
  const headingSuffix = activeFolderPath
    ? ` <span style="color:#666;font-weight:400;font-size:0.9rem">in ${escapeHtml(activeFolderPath)} (${range} of ${feed.totalItems}) <a href="/" style="font-size:0.85rem">clear</a></span>`
    : ` <span style="color:#999;font-weight:400;font-size:0.9rem">(${range} of ${feed.totalItems})</span>`
  return `
    <h2>Activity${headingSuffix}</h2>
    <ul class="feed">${itemsHtml}</ul>
    ${renderPagination(feed, activeFolderId)}
  `
}

function renderFeedItem(item: FeedItem, categorize?: CategorizeContext): string {
  const tagsHtml = renderTagList(item.tags, categorize, item.id)
  const actionsHtml = categorize ? renderCardActions(item, categorize) : ''
  return `
    <li class="feed-item" data-bookmark-id="${escapeHtml(item.id)}" data-folder-path="${escapeHtml(item.folderPath)}">
      <h3 class="title">
        <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>
        <a class="detail-link" href="/bookmarks/${encodeURIComponent(item.id)}">details →</a>
      </h3>
      <p class="meta">
        <span class="folder-path">${escapeHtml(item.folderPath)}</span> ·
        <time datetime="${escapeHtml(item.createdAt)}">${formatDate(item.createdAt)}</time>
      </p>
      ${tagsHtml}
      ${actionsHtml}
    </li>
  `
}

function renderTagList(
  tags: readonly string[],
  categorize: CategorizeContext | undefined,
  bookmarkId: string,
): string {
  if (tags.length === 0 && !categorize) {
    // Read-only view: omit the tag paragraph when there are no tags AND
    // we're not in categorize mode (no input to show).
    return ''
  }
  const chips = tags
    .map(
      (t) =>
        `<span class="tag" data-tag="${escapeHtml(t)}">${escapeHtml(t)}${
          categorize
            ? `<button type="button" class="tag-remove" data-remove-tag="${escapeHtml(t)}" title="Remove tag">×</button>`
            : ''
        }</span>`,
    )
    .join('')
  const inputHtml = categorize
    ? `<input type="text" class="tag-input" list="tag-suggestions-${escapeHtml(bookmarkId)}" placeholder="add tag…" data-tag-input>`
    : ''
  return `<p class="tags" data-tag-list>${chips}${inputHtml}</p>`
}

function renderCardActions(item: FeedItem, ctx: CategorizeContext): string {
  const folderSelect = renderFolderSelect(item.id, ctx.folderOptions)
  return `
    <div class="actions">
      <span class="folder-path" data-folder-display>${escapeHtml(item.folderPath)}</span>
      <select class="folder-select" data-folder-select title="Move to folder">
        ${folderSelect}
      </select>
      <button type="button" class="edit-title-btn" data-edit-title>edit title</button>
      <button type="button" class="delete-btn" data-delete-bookmark title="Delete this bookmark">delete</button>
      <span class="actions-status" data-actions-status></span>
    </div>
  `
}

function renderFolderSelect(
  _currentBookmarkId: string,
  folderOptions: readonly FolderOption[],
): string {
  // Each card gets its own `<select>`; no need to mark "current folder"
  // because the displayed folder path is the source of truth. The user
  // picks a new folder from the dropdown and clicks elsewhere to save.
  return folderOptions
    .map(
      (f) =>
        `<option value="${escapeHtml(f.id)}">${escapeHtml(f.path)}</option>`,
    )
    .join('')
}

function renderCategorizeDatalists(
  items: readonly FeedItem[],
  allTags: readonly TagOption[],
): string {
  // Each card has its own datalist id so autocomplete suggestions
  // appear on the right input. All cards share the same suggestion set
  // (the entire tag catalogue); per-bookmark filtering would just
  // fragment the UX.
  const options = allTags
    .map((t) => `<option value="${escapeHtml(t.name)}">`)
    .join('')
  const lists = items
    .map(
      (item) =>
        `<datalist id="tag-suggestions-${escapeHtml(item.id)}">${options}</datalist>`,
    )
    .join('')
  return lists
}

function categorizeScriptTag(): string {
  return `<script src="/static/categorize.js" defer></script>`
}

function renderPagination(feed: FeedPage, folderId?: string | null): string {
  const prevPage = feed.page > 1 ? feed.page - 1 : null
  const nextPage = feed.page < feed.totalPages ? feed.page + 1 : null
  // Preserve the folder filter when paginating so the user doesn't
  // lose their context when navigating.
  const folderQs = folderId ? `&folder=${encodeURIComponent(folderId)}` : ''
  const prev = prevPage
    ? `<a href="?page=${prevPage}${folderQs}">← Newer</a>`
    : `<span class="disabled">← Newer</span>`
  const next = nextPage
    ? `<a href="?page=${nextPage}${folderQs}">Older →</a>`
    : `<span class="disabled">Older →</span>`
  return `<div class="pagination">${prev}<span>Page ${feed.page} of ${feed.totalPages}</span>${next}</div>`
}

/**
 * Render the bookmark detail page.
 *
 * With categorize context, the title and folder become inline-editable
 * and the tag list shows chips with × buttons + an input for adding new
 * tags. Without it, the page is plain read-only.
 */
export function renderDetailPage(
  detail: BookmarkDetail,
  categorize?: CategorizeContext,
): string {
  const styles = categorize ? BASE_STYLES + CATEGORIZE_STYLES : BASE_STYLES
  const folderSelect = categorize
    ? renderFolderSelect(detail.id, categorize.folderOptions)
    : ''
  const tagsHtml = renderTagList(detail.tags, categorize, detail.id)
  // On the detail page, show an explicit "no tags" placeholder when
  // there are none. The feed page omits the paragraph entirely (an
  // empty `<p class="tags">` would look weird in the stream of items).
  const tagsDisplay = detail.tags.length === 0 && !categorize
    ? '<em style="color:#999">no tags</em>'
    : tagsHtml
  const actionsHtml = categorize ? renderDetailActions(detail) : ''
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(detail.title)} — Dashboard</title>
    <style>${styles}</style>
  </head>
  <body>
    <h1><a href="${escapeHtml(detail.url)}" target="_blank" rel="noopener">${escapeHtml(detail.title)}</a></h1>
    <dl>
      <dt>URL</dt>
      <dd class="url"><a href="${escapeHtml(detail.url)}" target="_blank" rel="noopener">${escapeHtml(detail.url)}</a></dd>
      <dt>Folder</dt>
      <dd class="detail-edit">
        <span class="folder-path" data-folder-display>${escapeHtml(detail.folderPath)}</span>
        <select class="folder-select" data-folder-select title="Move to folder">${folderSelect}</select>
      </dd>
      <dt>Tags</dt>
      <dd>${tagsDisplay}</dd>
      <dt>Created</dt>
      <dd><time datetime="${escapeHtml(detail.createdAt)}">${formatDate(detail.createdAt)}</time></dd>
      <dt>Updated</dt>
      <dd><time datetime="${escapeHtml(detail.updatedAt)}">${formatDate(detail.updatedAt)}</time></dd>
      <dt>Last seen</dt>
      <dd>${detail.lastSeenAt ? `<time datetime="${escapeHtml(detail.lastSeenAt)}">${formatDate(detail.lastSeenAt)}</time>` : '<em style="color:#999">never</em>'}</dd>
    </dl>
    ${actionsHtml}
    <nav class="back"><a href="/">← Back to activity feed</a></nav>
    ${categorize ? `<datalist id="tag-suggestions-${escapeHtml(detail.id)}">${categorize.allTags.map((t) => `<option value="${escapeHtml(t.name)}">`).join('')}</datalist>` : ''}
    ${categorize ? categorizeScriptTag() : ''}
  </body>
</html>`
}

function renderDetailActions(_detail: BookmarkDetail): string {
  return `
    <div class="actions detail-edit">
      <button type="button" data-edit-title>edit title</button>
      <button type="button" data-delete-bookmark>delete</button>
      <span class="actions-status" data-actions-status></span>
    </div>
  `
}

/** Render a 404 response body for the detail page. */
export function renderDetailNotFound(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Not found — Dashboard</title>
    <style>body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; } h1 { font-weight: 500; } nav { margin-top: 2rem; } nav a { color: #06c; text-decoration: none; }</style>
  </head>
  <body>
    <h1>Bookmark not found</h1>
    <p>That bookmark doesn't exist (or was deleted).</p>
    <nav><a href="/">← Back to activity feed</a></nav>
  </body>
</html>`
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Categorize-mode sidebar: adds the "+ New folder" button + form. */
function renderFolderSidebarCategorize(
  tree: readonly FolderNode[],
  activeFolderId?: string | null,
): string {
  return `
    <h2>Folders <button type="button" class="add-folder-btn" data-add-folder title="Create folder">+</button></h2>
    ${renderFolderTreeBody(tree, true, activeFolderId)}
    <form class="add-folder-form" data-add-folder-form>
      <input type="text" placeholder="New folder name" required>
      <button type="submit">Add</button>
      <button type="button" data-cancel-add-folder>cancel</button>
      <span class="actions-status" data-actions-status></span>
    </form>
  `
}

/** Plain sidebar (no categorize controls). */
function renderFolderSidebar(
  tree: readonly FolderNode[],
  activeFolderId?: string | null,
): string {
  return `
    <h2>Folders</h2>
    ${renderFolderTreeBody(tree, false, activeFolderId)}
  `
}

function renderFolderTreeBody(
  nodes: readonly FolderNode[],
  categorize: boolean,
  activeFolderId?: string | null,
): string {
  if (nodes.length === 0) {
    return '<p class="empty">No folders yet. Click + to create one.</p>'
  }
  return `<ul>${renderFolderTree(nodes, categorize, activeFolderId)}</ul>`
}

function renderFolderTree(
  nodes: readonly FolderNode[],
  categorize: boolean,
  activeFolderId?: string | null,
): string {
  return nodes
    .map((node) => {
      const childHtml =
        node.children.length > 0
          ? `<ul>${renderFolderTree(node.children, categorize, activeFolderId)}</ul>`
          : ''
      // Each folder is rendered as a link that filters the feed to
      // that folder (and its descendants). The currently-active
      // folder is marked with data-active="true" and styled
      // differently — both for affordance and so tests can assert it.
      const isActive = node.id === activeFolderId
      const activeAttr = isActive ? ' data-active="true"' : ''
      const labelClass = isActive ? 'folder-label active' : 'folder-label'
      const href = `/?folder=${encodeURIComponent(node.id)}`
      if (categorize) {
        // Categorize-mode folders still get the data attributes the
        // inline rename hook depends on, but the click target is the
        // anchor (not the span) so a single click filters while a
        // double-click on the span still triggers rename. The
        // categorize.js script checks `event.target` to disambiguate.
        const nameHtml = `<a class="${labelClass}" href="${href}"${activeAttr}><span class="folder-name" data-folder-id="${escapeHtml(node.id)}" data-folder-name title="Click to filter, double-click to rename">${escapeHtml(node.name)}</span></a>`
        return `<li>${nameHtml}${childHtml}</li>`
      }
      const nameHtml = `<a class="${labelClass}" href="${href}"${activeAttr}>${escapeHtml(node.name)}</a>`
      return `<li>${nameHtml}${childHtml}</li>`
    })
    .join('')
}

/** ISO 8601 → human-readable date for display. */
function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.valueOf())) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** HTML-escape user-controlled values (titles, URLs, folder names). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ─── Input clamping ───────────────────────────────────────────────────────

function clampPage(page: number | undefined): number {
  if (page === undefined || !Number.isFinite(page) || page < 1) return 1
  return Math.floor(page)
}

function clampPerPage(perPage: number | undefined): number {
  if (perPage === undefined || !Number.isFinite(perPage) || perPage < 1) {
    return DEFAULT_PER_PAGE
  }
  return Math.min(MAX_PER_PAGE, Math.floor(perPage))
}

// ─── HTTP API ─────────────────────────────────────────────────────────────

/**
 * HTTP API for the activity feed (landing page).
 *
 *   GET / — activity feed (HTML)
 *
 * Mounted at the root by `app.ts`. The detail route lives in
 * `bookmarkDetailApi` so it can be mounted under `/bookmarks` (with a
 * distinct path prefix that doesn't shadow other future routes).
 */
export function activityFeedApi(db: Database): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  api.get('/', (c) => {
    const page = parseIntQuery(c.req.query('page'))
    const perPage = parseIntQuery(c.req.query('perPage'))
    const folderParam = c.req.query('folder')
    // Only honor the folder filter when it points at a folder we know
    // about. An unknown id (or an empty string) silently falls back to
    // the unfiltered feed \u2014 same behavior as a missing param.
    const tree = loadFolderTree(db)
    const knownFolderId = folderParam ? findFolderNodeId(tree, folderParam) : null
    const who = c.get('user') ?? c.get('tokenId') ?? 'unknown'
    const feed = queryFeed(db, { page, perPage, folderId: knownFolderId ?? undefined })
    const categorize: CategorizeContext = {
      folderOptions: queryFolderOptions(db),
      allTags: queryAllTagOptions(db),
    }
    return c.html(renderFeedPage(who, tree, feed, categorize, knownFolderId))
  })

  return api
}

/**
 * HTTP API for individual bookmark detail.
 *
 *   GET /bookmarks/:id — bookmark detail (HTML; 404 if missing)
 *
 * Mounted under `/bookmarks` by `app.ts`.
 */
export function bookmarkDetailApi(db: Database): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  api.get('/:id', (c) => {
    const id = c.req.param('id')
    const detail = queryBookmark(db, id)
    if (!detail) {
      return c.html(renderDetailNotFound(), 404)
    }
    const categorize: CategorizeContext = {
      folderOptions: queryFolderOptions(db),
      allTags: queryAllTagOptions(db),
    }
    return c.html(renderDetailPage(detail, categorize))
  })

  return api
}

// ─── Internal HTTP helpers ────────────────────────────────────────────────

/** Parse an integer query param; returns undefined if absent/malformed. */
function parseIntQuery(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = parseInt(value, 10)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Load the folder tree for the sidebar. Pulled out so the route
 * handler stays focused on dispatching; mirrors `foldersApi`'s pattern.
 */
function loadFolderTree(db: Database): readonly FolderNode[] {
  const rows = db.all<{
    id: string
    parent_id: string | null
    name: string
    chrome_id: string | null
  }>('SELECT id, parent_id, name, chrome_id FROM folders ORDER BY name')
  return buildTree(rows)
}