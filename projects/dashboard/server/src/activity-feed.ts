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
//
// #012 additions (card layout):
//   - `getSourceFromUrl(url)` parses the URL hostname and detects
//     YouTube (used by the source badge in the new card markup).
//   - `formatRelativeTime(iso)` returns a short relative-time string
//     ("just now", "5m ago", "2h ago", "yesterday", "3d ago",
//     "Jan 15", "Mar 2025") used inside the <time> element of the
//     card. The raw ISO datetime is still emitted in the `datetime`
//     and `title` attributes for machine-readability + hover tooltip.
//   - The card markup is now <article class="feed-item"> with a
//     `.feed-item-header` (source badge + thumb slot),
//     `.feed-item-title`, `.feed-item-meta` (folder + relative time
//     + tags), and `.feed-item-actions` (open/edit/copy buttons).
//
// #014 additions (favicons + YouTube thumbnails):
//   - `getCardThumbnail(url)` returns `{ type, src, alt }` for a
//     favicon (google.com/s2/favicons) or a YouTube video thumbnail
//     (img.youtube.com/vi/<id>/hqdefault.jpg). Returns null for
//     malformed URLs.
//   - `getYouTubeVideoId(url)` extracts the 11-char ID from a
//     YouTube watch/embed/short URL; null otherwise.
//   - `.feed-item-thumb-slot` is now populated by `renderFeedItem`
//     with an <img class="feed-item-thumb …"> carrying `loading="lazy"`
//     and an `onerror` handler that hides the broken-image icon.

import { Hono } from 'hono'
import type { Database } from './db.js'
import { buildTree, type FolderNode } from './folders.js'
import type { AuthVariables } from './auth.js'
import {
  COMMON_HEAD,
  THEME_SCRIPT_TAG,
  CLIPBOARD_SCRIPT_TAG,
  HAMBURGER_SCRIPT_TAG,
  renderHeader,
  renderEmptyState,
} from './view-shared.js'

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

// Only the rules that aren't yet in /static/styles.css (and aren't
// scheduled for a future slice) belong here. After slice #013 the
// inline block is small — just the bookmark-detail <dl> styling, the
// pagination links, and a couple of categorize.js hooks that depend
// on inline rules for cascade ordering during the migration.
const BASE_STYLES = `
  nav { margin-top: 1.5rem; }
  nav a { margin-right: 1rem; color: var(--accent); }
  nav a:hover { text-decoration: underline; }
  .pagination { display: flex; justify-content: space-between; align-items: center; padding: 1rem 0; color: var(--muted); font-size: 0.9rem; }
  .pagination a { color: var(--accent); text-decoration: none; }
  .pagination a:hover { text-decoration: underline; }
  .pagination .disabled { color: var(--border); }
  main h2 { font-weight: 500; font-size: 1.1rem; margin: 0 0 1rem; }
  main .empty { color: var(--muted); font-style: italic; padding: 2rem 0; text-align: center; }
  .sidebar .empty { color: var(--muted); font-style: italic; padding: 0.5rem 0.6rem; }
  dl { margin: 1.5rem 0; }
  dt { color: var(--muted); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 1rem; }
  dd { margin-left: 0; margin-bottom: 0.5rem; }
  .detail-main h1 { font-weight: 500; margin: 1.5rem 0 0.5rem; }
  .detail-main h1 a { color: var(--text); text-decoration: none; }
  .detail-main h1 a:hover { color: var(--accent); text-decoration: underline; }
  .detail-main .url a { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.875rem; word-break: break-all; color: var(--accent); }
  .detail-main .detail-edit select { font-size: 0.85rem; padding: 0.2rem 0.3rem; border: 1px solid var(--border); border-radius: 0.25rem; background-color: var(--bg); color: var(--text); }
  .detail-main nav.back { margin-top: 2rem; }
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

  /* Inbox teaser line above the feed list. The link is the primary
     affordance — muted grey sync note is secondary. */
  .inbox-teaser { margin: 0.5rem 0 1rem; font-size: 0.95rem; color: var(--muted); }
  .inbox-teaser-link { color: var(--accent); text-decoration: none; font-weight: 500; }
  .inbox-teaser-link:hover { text-decoration: underline; }
  .inbox-teaser-sync { margin-left: 0.5rem; color: var(--muted); font-size: 0.85rem; }

  /* Sidebar Account sub-line (renders under the Email compartment
     when a Gmail account is connected). Matches the muted footer
     rhythm of the folder tree. */
  .sidebar-account-note { font-size: 0.8rem; color: var(--muted); padding: 0.25rem 0.6rem; margin: 0; }
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
  inboxTeaser?: InboxTeaser,
): string {
  const styles = categorize ? BASE_STYLES + CATEGORIZE_STYLES : BASE_STYLES
  const sidebarHtml = categorize
    ? renderFolderSidebarCategorize(tree, activeFolderId, inboxTeaser)
    : renderFolderSidebar(tree, activeFolderId, inboxTeaser)
  const itemsHtml = feed.items
    .map((item) => renderFeedItem(item, categorize))
    .join('')
  const activeFolderPath = activeFolderId ? findFolderPath(tree, activeFolderId) : undefined
  return `<!doctype html>
<html lang="en">
  <head>
${COMMON_HEAD}
    <title>Dashboard — Activity</title>
    <style>${styles}</style>
  </head>
  <body data-user="${escapeHtml(user)}">
    ${renderHeader()}
    <div class="layout">
      ${sidebarHtml}
      <main>
        ${renderFeedMain(feed, itemsHtml, activeFolderId ?? undefined, activeFolderPath ?? undefined, inboxTeaser)}
      </main>
    </div>
    ${categorize ? renderCategorizeDatalists(feed.items, categorize.allTags) : ''}
    ${categorize ? categorizeScriptTag() : ''}
    ${CLIPBOARD_SCRIPT_TAG}
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
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

function renderFeedMain(
  feed: FeedPage,
  itemsHtml: string,
  activeFolderId?: string,
  activeFolderPath?: string,
  inboxTeaser?: InboxTeaser,
): string {
  const teaserHtml = renderInboxTeaserLine(inboxTeaser)
  if (feed.totalItems === 0) {
    const emptyState = activeFolderPath
      ? { kind: 'empty-folder' as const, folderPath: activeFolderPath }
      : { kind: 'no-bookmarks' as const }
    return `
      <h2>Activity${activeFolderPath ? ` <span class="heading-suffix">in ${escapeHtml(activeFolderPath)}</span>` : ''}</h2>
      ${teaserHtml}
      ${renderEmptyState(emptyState)}
    `
  }
  const start = (feed.page - 1) * feed.perPage + 1
  const end = Math.min(start + feed.perPage - 1, feed.totalItems)
  const range = start === end ? `${start}` : `${start}–${end}`
  const headingSuffix = activeFolderPath
    ? ` <span class="heading-suffix">in ${escapeHtml(activeFolderPath)} (${range} of ${feed.totalItems}) <a href="/" class="heading-clear">clear</a></span>`
    : ` <span class="heading-suffix heading-suffix-muted">(${range} of ${feed.totalItems})</span>`
  return `
    <h2>Activity${headingSuffix}</h2>
    ${teaserHtml}
    ${renderPagination(feed, activeFolderId)}
    <div class="feed-list">${itemsHtml}</div>
    ${renderPagination(feed, activeFolderId)}
  `
}

/** Render the inbox teaser line above the feed list. Shown when at
 *  least one Gmail account is connected AND we're on the unfiltered
 *  feed (no active folder — once the user has drilled into a folder,
 *  the inbox teaser is out of context). The line links to `/email`
 *  so the user has a one-click path from the activity feed to the
 *  inbox. The unread count comes from `queryInboxTeaser` so it stays
 *  in sync with what the email sidebar shows. */
function renderInboxTeaserLine(teaser: InboxTeaser | undefined): string {
  if (!teaser || !teaser.connected) return ''
  const label = teaser.unreadCount === 0
    ? '📬 Inbox — no unread'
    : teaser.unreadCount === 1
      ? '📬 1 unread email'
      : `📬 ${teaser.unreadCount} unread emails`
  const lastSyncNote = teaser.lastSyncAt
    ? ` <span class="inbox-teaser-sync">last sync ${escapeHtml(formatRelativeTime(teaser.lastSyncAt))}</span>`
    : ''
  return `<p class="inbox-teaser" data-inbox-teaser>
    <a class="inbox-teaser-link" href="/email">${label}</a>${lastSyncNote}
  </p>`
}

function renderFeedItem(item: FeedItem, categorize?: CategorizeContext): string {
  const source = getSourceFromUrl(item.url)
  const thumb = renderThumb(item.url)
  const tagsHtml = renderTagList(item.tags, categorize, item.id)
  const sourceBadgeClass = source.isYouTube ? 'source-badge source-badge-youtube' : 'source-badge'
  const sourceBadgeTitle = source.isYouTube ? 'YouTube' : source.domain
  const editAttr = categorize
    ? 'data-edit-title="true"'
    : `href="/bookmarks/${encodeURIComponent(item.id)}"`
  const editTag = categorize ? 'button' : 'a'
  return `
    <article class="feed-item" data-bookmark-id="${escapeHtml(item.id)}" data-folder-path="${escapeHtml(item.folderPath)}" data-bookmark-url="${escapeHtml(item.url)}">
      <header class="feed-item-header">
        <span class="${sourceBadgeClass}" data-source="${escapeHtml(source.domain)}" title="${escapeHtml(sourceBadgeTitle)}">${escapeHtml(source.badgeLabel)}</span>
        ${thumb}
      </header>
      <h3 class="feed-item-title title">
        <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>
      </h3>
      <div class="feed-item-meta">
        <span class="folder-path" data-folder-display>${escapeHtml(item.folderPath)}</span>
        <span class="meta-sep">·</span>
        <time datetime="${escapeHtml(item.createdAt)}" title="${escapeHtml(item.createdAt)}">${formatRelativeTime(item.createdAt)}</time>
        ${tagsHtml ? `<span class="meta-sep">·</span>${tagsHtml}` : ''}
      </div>
      <div class="feed-item-actions">
        <a class="action-button" href="${escapeHtml(item.url)}" target="_blank" rel="noopener" data-action="open" title="Open in new tab" aria-label="Open in new tab">↗</a>
        <${editTag} class="action-button" ${editAttr} data-action="edit" title="${categorize ? 'Edit title inline' : 'View details'}" aria-label="${categorize ? 'Edit title' : 'View details'}">${categorize ? '✏' : 'ⓘ'}</${editTag}>
        <button type="button" class="action-button" data-action="copy" title="Copy URL" aria-label="Copy URL">📋</button>
        ${categorize ? renderCategorizeControls(item, categorize) : ''}
      </div>
    </article>
  `
}

/**
 * Render the thumbnail <img> for a card. Returns an empty string when
 * the URL is malformed (no thumbnail to show); otherwise emits a
 * lazy-loaded <img> with an `onerror` handler that hides broken-image
 * icons. The handler uses `style.display='none'` (not `remove()`)
 * so the surrounding flex layout doesn't reflow mid-fade.
 *
 * Slice #014 fills the slot that #012 left empty.
 */
function renderThumb(url: string): string {
  const thumb = getCardThumbnail(url)
  if (!thumb) return ''
  const klass =
    thumb.type === 'youtube'
      ? 'feed-item-thumb feed-item-thumb-youtube'
      : 'feed-item-thumb feed-item-thumb-favicon'
  // src/alt come from a trusted URL parser + a fixed CDN host, so
  // they're already safe to interpolate; escapeHtml is still applied
  // so future refactors don't silently introduce an injection.
  return `<img class="${klass}" src="${escapeHtml(thumb.src)}" alt="${escapeHtml(thumb.alt)}" loading="lazy" decoding="async" onerror="this.style.display='none'">`
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
  return `<div class="tags" data-tag-list>${chips}${inputHtml}</div>`
}

function renderCategorizeControls(item: FeedItem, ctx: CategorizeContext): string {
  const folderSelect = renderFolderSelect(item.id, ctx.folderOptions)
  return `
    <select class="folder-select action-select" data-folder-select title="Move to folder" aria-label="Move to folder">
      ${folderSelect}
    </select>
    <button type="button" class="action-button" data-delete-bookmark title="Delete this bookmark" aria-label="Delete">🗑</button>
    <span class="actions-status" data-actions-status></span>
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
  // When the entire feed fits on one page, no nav is needed. The
  // "Page 1 of 1" + disabled prev/next state is suppressed entirely
  // — both the top and bottom bars get this for free since they share
  // this function call (issue #019).
  if (feed.totalPages <= 1) return ''
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
${COMMON_HEAD}
    <title>${escapeHtml(detail.title)} — Dashboard</title>
    <style>${styles}</style>
  </head>
  <body>
    ${renderHeader()}
    <div class="layout">
      <main class="detail-main">
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
    ${CLIPBOARD_SCRIPT_TAG}
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
      </main>
    </div>
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
${COMMON_HEAD}
    <title>Not found — Dashboard</title>
    <style>body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; } h1 { font-weight: 500; } nav { margin-top: 2rem; } nav a { color: #06c; text-decoration: none; }</style>
  </head>
  <body>
    ${renderHeader()}
    <main class="detail-main">
      <h1>Bookmark not found</h1>
      <p>That bookmark doesn't exist (or was deleted).</p>
      <nav><a href="/">← Back to activity feed</a></nav>
    </main>
    ${CLIPBOARD_SCRIPT_TAG}
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
  </body>
</html>`
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Snapshot of the email slice for the dashboard sidebar + feed-header
 *  teaser. Cheap to compute (single COUNT + a couple of point reads);
 *  the activity-feed API runs it on every page load. The shape lets
 *  the caller decide what to render: when no account is connected,
 *  the Email section is suppressed entirely. */
export interface InboxTeaser {
  readonly connected: boolean
  /** Count of un-hidden, un-read messages across all connected
   *  accounts. Zero when nothing is connected. */
  readonly unreadCount: number
  /** Connected email address (most-recent). Null when nothing is
   *  connected. The home feed renders this under the Email section
   *  as an "Account" sub-line. */
  readonly accountEmail: string | null
  /** Most-recent last_sync_at across all accounts. Null when
   *  nothing has ever synced. */
  readonly lastSyncAt: string | null
}

/** Read the teaser data directly from the DB. No cipher required —
 *  the `email_accounts.email_address` column is plaintext, and the
 *  `emails` table doesn't store tokens. The `is_unread` flag is a
 *  denormalised column populated by the sync worker (#021). */
function queryInboxTeaser(db: Database): InboxTeaser {
  // Most-recently-connected account: drives both the Account sub-line
  // and the "is anything connected?" gate.
  const account = db.get<{ email_address: string; last_sync_at: string | null }>(
    `SELECT email_address, last_sync_at FROM email_accounts
       ORDER BY connected_at DESC, id ASC LIMIT 1`,
  )
  if (!account) {
    return { connected: false, unreadCount: 0, accountEmail: null, lastSyncAt: null }
  }
  // Unread count: hidden rows are excluded at the DB layer (the
  // hidden action #024 sets hidden_at; #022 added the column).
  // `is_unread` mirrors Gmail's UNREAD label state at sync time.
  const unreadRow = db.get<{ n: number | bigint }>(
    `SELECT COUNT(*) AS n FROM emails
       WHERE hidden_at IS NULL AND is_unread = 1`,
  )
  return {
    connected: true,
    unreadCount: Number(unreadRow?.n ?? 0),
    accountEmail: account.email_address,
    lastSyncAt: account.last_sync_at,
  }
}

/** Render the top sections of the dashboard sidebar: Bookmarks
 *  (active here) + Email + Account info. Sits above the folder
 *  tree in both the plain and categorize sidebars. When `teaser`
 *  is missing or `connected: false`, the Email and Account
 *  sections are suppressed — Bookmarks is the only entry. */
function renderSidebarTopSections(teaser: InboxTeaser | undefined): string {
  const bookmarksActive = ' compartment-button-active'
  const emailActive = ''
  const dashboard = `
    <div class="sidebar-section">
      <h2 class="sidebar-title">Dashboard</h2>
      <ul class="compartment-nav">
        <li>
          <a class="compartment-button${bookmarksActive}" href="/" data-sidebar-nav="bookmarks">
            <span class="compartment-icon" aria-hidden="true">\u25a3</span>
            <span class="compartment-label">Bookmarks</span>
          </a>
        </li>
      </ul>
    </div>`
  if (!teaser || !teaser.connected) {
    return dashboard
  }
  const emailSection = `
    <div class="sidebar-section">
      <h2 class="sidebar-title">Email</h2>
      <ul class="compartment-nav">
        <li>
          <a class="compartment-button${emailActive}" href="/email" data-sidebar-nav="email">
            <span class="compartment-icon" aria-hidden="true">\u2709\ufe0f</span>
            <span class="compartment-label">Inbox${teaser.unreadCount > 0 ? ` (${teaser.unreadCount})` : ''}</span>
          </a>
        </li>
      </ul>
    </div>
    <div class="sidebar-section sidebar-folder-section">
      <h2 class="sidebar-title">Account</h2>
      <p class="sidebar-account-note" data-sidebar-account>${escapeHtml(teaser.accountEmail ?? '')}${teaser.lastSyncAt ? ` \u2014 last sync ${escapeHtml(formatRelativeTime(teaser.lastSyncAt))}` : ' \u2014 never synced'}</p>
    </div>`
  return dashboard + emailSection
}

/** Categorize-mode sidebar: adds the "+ New folder" button + form. */
function renderFolderSidebarCategorize(
  tree: readonly FolderNode[],
  activeFolderId?: string | null,
  teaser?: InboxTeaser,
): string {
  return `
    <aside class="sidebar">
      ${renderSidebarTopSections(teaser)}
      <header class="sidebar-header">
        <h2 class="sidebar-title">Folders</h2>
        <button type="button" class="add-folder-btn" data-add-folder title="New folder" aria-label="New folder">＋</button>
      </header>
      <div class="sidebar-tree">
        <ul>${renderFolderTree(tree, true, activeFolderId, 0)}</ul>
      </div>
      <form class="add-folder-form" data-add-folder-form>
        <input type="text" placeholder="New folder name" required>
        <button type="submit">Add</button>
        <button type="button" data-cancel-add-folder>cancel</button>
        <span class="actions-status" data-actions-status></span>
      </form>
    </aside>
  `
}

/** Plain sidebar (no categorize controls). */
function renderFolderSidebar(
  tree: readonly FolderNode[],
  activeFolderId?: string | null,
  teaser?: InboxTeaser,
): string {
  return `
    <aside class="sidebar">
      ${renderSidebarTopSections(teaser)}
      <header class="sidebar-header">
        <h2 class="sidebar-title">Folders</h2>
      </header>
      <div class="sidebar-tree">
        <ul>${renderFolderTree(tree, false, activeFolderId, 0)}</ul>
      </div>
    </aside>
  `
}

/**
 * Render the folder tree as a flat list of <li class="sidebar-item">.
 *
 * Each item carries:
 *   - `data-folder-id` so JS hooks (categorize.js) can find the node.
 *   - `data-depth` so CSS can compute padding-left from it without
 *     counting ancestor <ul> levels.
 *
 * The visible label is `<a class="folder-label">` containing:
 *   - a folder icon (`📁`) — purely visual
 *   - the folder name (`.sidebar-name.folder-name` so rename hook
 *     targets it without needing a new selector)
 *
 * When the folder has children, a SIBLING `<button class="sidebar-chevron">`
 * is emitted after the `<a>` (slice #016). It is a `<button>` (not an
 * `<a>` or `<span>`) so its click doesn't navigate to the filtered feed;
 * `categorize.js` toggles `data-collapsed` on the parent `<li>` and
 * updates `aria-expanded` / `aria-label`. The chevron is always rendered
 * at server-side, with `aria-expanded="true"` to match the always-expanded
 * initial state.
 */
function renderFolderTree(
  nodes: readonly FolderNode[],
  categorize: boolean,
  activeFolderId: string | null | undefined,
  depth: number,
): string {
  return nodes
    .map((node) => {
      const hasChildren = node.children.length > 0
      const childHtml = hasChildren
        ? `<ul>${renderFolderTree(node.children, categorize, activeFolderId, depth + 1)}</ul>`
        : ''
      const isActive = node.id === activeFolderId
      const activeAttr = isActive ? ' data-active="true"' : ''
      const labelClass = isActive ? 'folder-label sidebar-link-active' : 'folder-label'
      // Sibling chevron button — kept outside the <a> so its click
      // toggles collapse instead of navigating. Emitted only when the
      // folder has children; leaf folders show no button.
      const chevronHtml = hasChildren
        ? '<button type="button" class="sidebar-chevron" data-toggle-folder aria-expanded="true" aria-label="Collapse">›</button>'
        : ''
      const href = `/?folder=${encodeURIComponent(node.id)}`
      if (categorize) {
        // Categorize-mode folders keep the data attributes the inline
        // rename hook depends on. The icon lives OUTSIDE the
        // `.folder-name` span so it survives the rename swap
        // (categorize.js only replaces the inner span with an
        // <input>). The chevron is now a sibling of the <a> entirely,
        // so it lives outside the link and the rename swap.
        const nameHtml = `<a class="${labelClass}" href="${href}"${activeAttr}><span class="sidebar-icon" aria-hidden="true">\ud83d\udcc1</span><span class="sidebar-name folder-name" data-folder-name data-folder-id="${escapeHtml(node.id)}" title="Click to filter, double-click to rename">${escapeHtml(node.name)}</span></a>`
        return `<li class="sidebar-item" data-folder-id="${escapeHtml(node.id)}" data-depth="${depth}"${hasChildren ? ' data-has-children="true"' : ''}>${nameHtml}${chevronHtml}${childHtml}</li>`
      }
      const nameHtml = `<a class="${labelClass}" href="${href}"${activeAttr}><span class="sidebar-icon" aria-hidden="true">\ud83d\udcc1</span><span class="sidebar-name">${escapeHtml(node.name)}</span></a>`
      return `<li class="sidebar-item" data-folder-id="${escapeHtml(node.id)}" data-depth="${depth}"${hasChildren ? ' data-has-children="true"' : ''}>${nameHtml}${chevronHtml}${childHtml}</li>`
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

/**
 * ISO 8601 → short relative-time string for card meta line.
 *
 *   < 60s          → "just now"
 *   < 60m          → "Nm ago"
 *   < 24h, same d  → "Nh ago"
 *   exactly 1 day  → "yesterday"
 *   < 7d           → "Nd ago"
 *   same calendar year → "Jan 15"
 *   different year     → "Mar 2025"
 *
 * Returns the raw ISO string if parsing fails so a malformed date
 * never blanks out the card meta line.
 */
function formatRelativeTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.valueOf())) return iso
  const now = Date.now()
  const diffMs = now - d.valueOf()
  if (diffMs < 0) {
    // Future-dated (clock skew, manual import). Show the same shape
    // but with "in" so the user notices.
    return formatRelativeTimeFuture(diffMs)
  }
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}h ago`
  const diffDay = Math.floor(diffHour / 24)
  if (diffDay === 1) return 'yesterday'
  if (diffDay < 7) return `${diffDay}d ago`
  return formatRelativeTimeAbsolute(d)
}

/** "in Nm / Nh / Nd" counterpart for clock skew / future dates. */
function formatRelativeTimeFuture(negativeDiffMs: number): string {
  const diffSec = Math.ceil(-negativeDiffMs / 1000)
  if (diffSec < 60) return 'in a moment'
  const diffMin = Math.ceil(diffSec / 60)
  if (diffMin < 60) return `in ${diffMin}m`
  const diffHour = Math.ceil(diffMin / 60)
  if (diffHour < 24) return `in ${diffHour}h`
  const diffDay = Math.ceil(diffHour / 24)
  return `in ${diffDay}d`
}

/** "Jan 15" (same year) or "Mar 2025" (different year). */
function formatRelativeTimeAbsolute(d: Date): string {
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/**
 * Parse a URL into the bits the card header needs.
 *
 *   - `domain`: hostname with leading `www.` stripped (e.g.
 *     `github.com`, not `www.github.com`).
 *   - `badgeLabel`: same as `domain` today; kept separate so we can
 *     upper-case, abbreviate, or override per-site without changing
 *     every call site.
 *   - `isYouTube`: true for `youtube.com` and `youtu.be` URLs. Used by
 *     the source badge (red accent) and by slice #014 to swap the
 *     favicon thumbnail for a YouTube video thumbnail.
 *
 * Returns safe fallbacks if `url` can't be parsed so a single bad
 * bookmark never crashes the feed render.
 */
export interface SourceInfo {
  readonly domain: string
  readonly badgeLabel: string
  readonly isYouTube: boolean
}

export function getSourceFromUrl(url: string): SourceInfo {
  try {
    const parsed = new URL(url)
    let host = parsed.hostname.toLowerCase()
    if (host.startsWith('www.')) host = host.slice(4)
    if (!host) return { domain: url, badgeLabel: url, isYouTube: false }
    const isYouTube = host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be'
    return { domain: host, badgeLabel: host, isYouTube }
  } catch {
    return { domain: url, badgeLabel: url, isYouTube: false }
  }
}

// ─── Thumbnail helper (issue #014) ─────────────────────────────────────────

/**
 * What kind of thumbnail (if any) should be rendered for a bookmark URL.
 * YouTube URLs get a proper video thumbnail (80×45); everything else
 * gets a 32×32 favicon. `null` means "no thumbnail" (malformed URL).
 */
export type Thumbnail =
  | { readonly type: 'youtube'; readonly src: string; readonly alt: string }
  | { readonly type: 'favicon'; readonly src: string; readonly alt: string }
  | null

/**
 * Extract the YouTube video ID from a watch/embed/short URL, or null
 * if the URL isn't a YouTube link with a recognised shape.
 *
 * Accepts:
 *   - youtube.com/watch?v=ID         (with optional www. or m. prefix)
 *   - youtube.com/embed/ID
 *   - youtu.be/ID
 * The video ID is the canonical 11-character base64-ish token.
 *
 * Single capture group: the alternation is structured so the ID is
 * always at the END of the match, regardless of which branch fires.
 */
const YOUTUBE_REGEX =
  /^https?:\/\/(?:(?:(?:www|m)\.)?youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/

export function getYouTubeVideoId(url: string): string | null {
  const m = url.match(YOUTUBE_REGEX)
  return m ? m[1] : null
}

/**
 * Resolve a bookmark URL to a thumbnail source. Used by the card
 * layout to populate `.feed-item-thumb-slot`.
 *
 * - YouTube → returns a `youtube` thumbnail pointing at the standard
 *   `img.youtube.com/vi/<id>/hqdefault.jpg` (120×90, scaled by CSS).
 * - Anything else with a hostname → returns a `favicon` thumbnail
 *   using Google's public favicon service (always 32×32 actual size;
 *   `sz=64` requests a 2× version so high-DPI displays don't blur).
 * - Malformed / no-hostname URLs → returns `null`. The card skips
 *   the `<img>` and the thumb slot collapses to zero width.
 */
export function getCardThumbnail(url: string): Thumbnail {
  const videoId = getYouTubeVideoId(url)
  if (videoId) {
    return {
      type: 'youtube',
      src: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      alt: 'YouTube video thumbnail',
    }
  }
  try {
    const parsed = new URL(url)
    let host = parsed.hostname.toLowerCase()
    if (host.startsWith('www.')) host = host.slice(4)
    if (!host) return null
    return {
      type: 'favicon',
      src: `https://www.google.com/s2/favicons?domain=${host}&sz=64`,
      alt: `${host} favicon`,
    }
  } catch {
    return null
  }
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
    // Email teaser: drives both the sidebar's Email section (slice
    // #026) and the inbox teaser line above the feed list. Cheap
    // queries — see queryInboxTeaser. Runs unconditionally; the
    // `connected: false` branch suppresses the UI when no Gmail
    // account exists.
    const teaser = queryInboxTeaser(db)
    return c.html(renderFeedPage(who, tree, feed, categorize, knownFolderId, teaser))
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