// youtube-videos-view.ts — issue YT-005
//
// Server-rendered list page at `/videos`. Reverse-chronological
// by `discovered_at`, with three filter chips (channel, folder,
// tag). Mirrors the YT-003 `/subscriptions` page's pattern for
// consistency:
//   * Filters are server-roundtrips — no SPA, deep links work,
//     refresh-safe.
//   * Filter selects live inside a `<form method="get">` so the
//     URL becomes the canonical state.
//   * Each row links to its detail page (`/videos/:id`).
//
// The detail page (`/videos/:id`) is what owns the inline edit
// + folder move + tag add/remove mutations. The list page is
// intentionally read-only — categorizing from a list view
// involves too many DOM patches per row to fit a 60-line IIFE.

import { Hono } from 'hono'
import type { AuthVariables } from './auth.js'
import type { Database } from './db.js'
import {
  COMMON_HEAD,
  THEME_SCRIPT_TAG,
  HAMBURGER_SCRIPT_TAG,
  renderHeader,
} from './view-shared.js'
import {
  searchVideos,
  type VideoListItem,
} from './youtube-videos.js'
import { listAllFoldersWithCounts } from './folders.js'
import { listAllTagsWithUsage } from './tags.js'
import { searchSubscriptions } from './youtube-subscriptions.js'

// ─── Helper: list subscriptions with thumbnails for the filter dropdown ─

// Reuse listIncludedSubscriptions (YT-002) for the channel filter.
// All-views filter is server-side via `listSubscriptions` (YT-003),
// which excludes nothing.

// ─── Hono sub-app ─────────────────────────────────────────────────────────

export interface YouTubeVideosViewDeps {
  readonly db: Database
}

/**
 * Mounted at `/videos`.  Single page; no sub-resources on this
 * factory (the per-video detail page has its own factory).
 */
export function youtubeVideosView(
  deps: YouTubeVideosViewDeps,
): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  api.get('/', (c) => {
    const channelId = c.req.query('channel_id') || undefined
    const folderIdRaw = c.req.query('folder_id') ?? 'all'
    const tagId = c.req.query('tag_id') || undefined
    const page = parsePositiveInt(c.req.query('page')) ?? 1
    const limitRaw = parsePositiveInt(c.req.query('limit')) ?? 50

    const folder =
      folderIdRaw === 'all' || folderIdRaw === ''
        ? { kind: 'any' as const }
        : folderIdRaw === 'none'
          ? { kind: 'unfoldered' as const }
          : { kind: 'folder' as const, id: folderIdRaw }

    const searchOpts =
      folder.kind === 'any'
        ? {
            ...(channelId ? { channelId } : {}),
            ...(tagId ? { tagId } : {}),
            page,
            limit: limitRaw,
          }
        : folder.kind === 'folder'
          ? {
              ...(channelId ? { channelId } : {}),
              folderId: folder.id,
              ...(tagId ? { tagId } : {}),
              page,
              limit: limitRaw,
            }
          : {
              ...(channelId ? { channelId } : {}),
              unfoldered: true,
              ...(tagId ? { tagId } : {}),
              page,
              limit: limitRaw,
            }

    const r = searchVideos(deps.db, searchOpts)
    const channelsChannel = searchSubscriptions(deps.db, {
      filter: 'included',
      limit: 200,
    })
    const channels = channelsChannel.items.map((s) => ({
      channelId: s.channelId,
      channelTitle: s.channelTitle,
    }))
    const folders = listAllFoldersWithCounts(deps.db)
    const tags = listAllTagsWithUsage(deps.db)
    return c.html(
      renderPage({
        items: r.items,
        total: r.total,
        page: r.page,
        limit: r.limit,
        channelId,
        folderIdRaw,
        tagId,
        channels,
        folders,
        tags,
      }),
    )
  })

  return api
}

// ─── Render ───────────────────────────────────────────────────────────────

interface RenderPageOptions {
  readonly items: VideoListItem[]
  readonly total: number
  readonly page: number
  readonly limit: number
  readonly channelId: string | undefined
  readonly folderIdRaw: string
  readonly tagId: string | undefined
  readonly channels: Array<{ readonly channelId: string; readonly channelTitle: string | null }>
  readonly folders: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly bookmarkCount: number
    readonly videoCount: number
  }>
  readonly tags: Array<{ readonly id: string; readonly name: string }>
}

function renderPage(opts: RenderPageOptions): string {
  const totalPages = Math.max(1, Math.ceil(opts.total / opts.limit))
  const rows = opts.items.map((v) => renderRow(v)).join('')
  return `<!doctype html>
<html lang="en">
<head>
${COMMON_HEAD}
  <title>Videos — Dashboard</title>
  <meta name="robots" content="noindex">
  <style>${VIDEOS_VIEW_STYLES}</style>
</head>
<body>
  ${renderHeader()}
  <div class="layout">
    ${renderVideosSidebar()}
    <main class="videos-main">
      <header class="videos-header">
        <h1>New videos</h1>
        <p class="videos-subtitle">Reverse-chronological by <em>discovered_at</em> across your included YouTube channels.</p>
      </header>

      <form method="get" class="videos-filters" data-videos-filters>
        <div class="videos-filter">
          <label for="channel_id">Channel</label>
          <select id="channel_id" name="channel_id" data-videos-channel>
            <option value="">All channels</option>
            ${opts.channels
              .map(
                (ch) =>
                  `<option value="${escapeHtml(ch.channelId)}" ${
                    opts.channelId === ch.channelId ? 'selected' : ''
                  }>${escapeHtml(ch.channelTitle ?? ch.channelId)}</option>`,
              )
              .join('')}
          </select>
        </div>
        <div class="videos-filter">
          <label for="folder_id">Folder</label>
          <select id="folder_id" name="folder_id" data-videos-folder>
            <option value="all" ${opts.folderIdRaw === 'all' ? 'selected' : ''}>All folders</option>
            <option value="none" ${opts.folderIdRaw === 'none' ? 'selected' : ''}>Unfoldered</option>
            ${opts.folders
              .map(
                (f) =>
                  `<option value="${escapeHtml(f.id)}" ${
                    opts.folderIdRaw === f.id ? 'selected' : ''
                  }>${escapeHtml(f.name)} (${f.videoCount})</option>`,
              )
              .join('')}
          </select>
        </div>
        <div class="videos-filter">
          <label for="tag_id">Tag</label>
          <select id="tag_id" name="tag_id" data-videos-tag>
            <option value="">All tags</option>
            ${opts.tags
              .map(
                (t) =>
                  `<option value="${escapeHtml(t.id)}" ${
                    opts.tagId === t.id ? 'selected' : ''
                  }>${escapeHtml(t.name)}</option>`,
              )
              .join('')}
          </select>
        </div>
        <div class="videos-filter videos-filter-actions">
          <button type="submit">Filter</button>
        </div>
      </form>

      <p class="videos-counts">
        <strong>${opts.total}</strong> ${opts.total === 1 ? 'video' : 'videos'}
        ${opts.total === 0 ? '\u2014 nothing matches.' : ''}
      </p>

      ${opts.total === 0 ? renderEmpty(opts) : `<ol class="videos-list">${rows}</ol>`}

      ${renderPagination(opts, totalPages)}
    </main>
  </div>
  ${THEME_SCRIPT_TAG}
  ${HAMBURGER_SCRIPT_TAG}
</body>
</html>`
}

function renderRow(v: VideoListItem): string {
  const thumb = v.thumbnailUrl
    ? `<img class="videos-row-thumb" src="${escapeHtml(v.thumbnailUrl)}" alt="" loading="lazy">`
    : `<div class="videos-row-thumb videos-row-thumb-fallback" aria-hidden="true"></div>`
  const folder = v.folderName !== null
    ? `<span class="videos-row-folder" data-videos-row-folder>${escapeHtml(v.folderName)}</span>`
    : `<span class="videos-row-folder videos-row-folder-empty" data-videos-row-folder>Unfoldered</span>`
  const tagChips = v.tags.map(
    (t) =>
      `<span class="videos-row-tag" data-videos-row-tag="${escapeHtml(t.id)}">${escapeHtml(t.name)}</span>`,
  )
  return `<li class="videos-row" data-videos-row data-video-id="${escapeHtml(v.id)}">
  <a class="videos-row-link" href="/videos/${encodeURIComponent(v.id)}">
    ${thumb}
    <span class="videos-row-body">
      <span class="videos-row-title">${escapeHtml(v.title)}</span>
      <span class="videos-row-meta">
        <span class="videos-row-channel">${escapeHtml(v.channelTitle)}</span>
        <span class="videos-row-dot">\u00b7</span>
        <span class="videos-row-date"><time datetime="${escapeHtml(v.publishedAt)}">${formatDate(v.publishedAt)}</time></span>
      </span>
      <span class="videos-row-tags">${folder}${tagChips.length > 0 ? `<span class="videos-row-tag-list">${tagChips.join('')}</span>` : ''}</span>
    </span>
  </a>
</li>`
}

function renderEmpty(opts: RenderPageOptions): string {
  if (opts.total !== 0) return ''
  // Distinct message when filters are active vs not.
  const filtersActive =
    opts.channelId || opts.folderIdRaw !== 'all' || opts.tagId
  if (filtersActive) {
    return `<div class="videos-empty">
  <p>No videos match those filters.</p>
  <p><a href="/videos">Clear filters</a></p>
</div>`
  }
  return `<div class="videos-empty">
  <p>No videos yet.</p>
  <p>After YouTube is connected, the RSS poller runs every 15 minutes and discovers new uploads from your <a href="/subscriptions">included channels</a>.</p>
  <p>To kick a poll now: <button type="button" data-videos-poll>Poll now</button></p>
  <p data-videos-poll-result></p>
</div>`
}

function renderPagination(
  opts: RenderPageOptions,
  totalPages: number,
): string {
  if (totalPages <= 1) return ''
  const params = (page: number): string => {
    const sp = new URLSearchParams()
    if (opts.channelId) sp.set('channel_id', opts.channelId)
    if (opts.folderIdRaw !== 'all') sp.set('folder_id', opts.folderIdRaw)
    if (opts.tagId) sp.set('tag_id', opts.tagId)
    sp.set('page', String(page))
    return sp.toString()
  }
  const cur = opts.page
  const prevDisabled = cur <= 1
  const nextDisabled = cur >= totalPages
  return `<nav class="videos-pagination" aria-label="Pagination">
  <a href="/videos?${params(Math.max(1, cur - 1))}"${prevDisabled ? ' aria-disabled="true"' : ''}>Previous</a>
  <span class="videos-pagination-info">Page ${cur} of ${totalPages}</span>
  <a href="/videos?${params(Math.min(totalPages, cur + 1))}"${nextDisabled ? ' aria-disabled="true"' : ''}>Next</a>
</nav>`
}

function renderVideosSidebar(): string {
  // YouTube compartment (mirrored from subscriptions-view).
  return `<aside class="sidebar">
  <nav>
    <h3 class="sidebar-heading">YouTube</h3>
    <ul class="sidebar-list">
      <li><a href="/videos" class="sidebar-active">Videos</a></li>
      <li><a href="/subscriptions">Subscriptions</a></li>
      <li><a href="/settings/youtube">Settings</a></li>
    </ul>
    <h3 class="sidebar-heading">Other</h3>
    <ul class="sidebar-list">
      <li><a href="/">Bookmarks</a></li>
      <li><a href="/email">Email</a></li>
    </ul>
  </nav>
</aside>`
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n)) return null
  return n
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatDate(iso: string): string {
  // Locale-aware short form. UTC because polling is UTC-based and
  // we don't want surprise timezone flips in the human-facing UI.
  try {
    const d = new Date(iso)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const day = 24 * 60 * 60 * 1000
    if (diffMs < day) {
      const hrs = Math.floor(diffMs / (60 * 60 * 1000))
      if (hrs <= 1) return 'just now'
      return `${hrs}h ago`
    }
    if (diffMs < 7 * day) {
      return `${Math.floor(diffMs / day)}d ago`
    }
    return d.toISOString().slice(0, 10)
  } catch {
    return iso
  }
}

// ─── Stylesheet (scoped to the page) ─────────────────────────────────────

const VIDEOS_VIEW_STYLES = `
.layout { display: flex; min-height: calc(100vh - var(--header-h)); }
.videos-main { flex: 1; padding: 24px clamp(12px, 4vw, 48px); }
.videos-header h1 { margin: 0 0 4px; font-size: 1.5rem; }
.videos-subtitle { margin: 0 0 20px; color: var(--muted); font-size: 0.95rem; }
.videos-filters { display: flex; gap: 12px; flex-wrap: wrap; padding: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 16px; }
.videos-filter { display: flex; flex-direction: column; gap: 4px; min-width: 180px; }
.videos-filter label { font-size: 0.78rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
.videos-filter select, .videos-filter button { padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit; }
.videos-filter-actions { align-self: end; }
.videos-counts { margin: 0 0 16px; color: var(--muted); }
.videos-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 12px; }
.videos-row { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
.videos-row-link { display: grid; grid-template-columns: 160px 1fr; gap: 16px; padding: 12px; color: inherit; text-decoration: none; }
.videos-row-link:hover { background: var(--surface-2, rgba(127,127,127,0.07)); }
.videos-row-thumb { width: 160px; aspect-ratio: 16 / 9; background: var(--surface); border-radius: 4px; object-fit: cover; }
.videos-row-thumb-fallback { background: var(--surface-2, rgba(127,127,127,0.1)); }
.videos-row-body { display: flex; flex-direction: column; gap: 6px; }
.videos-row-title { font-weight: 600; line-height: 1.3; }
.videos-row-meta { color: var(--muted); font-size: 0.85rem; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.videos-row-channel { color: var(--text); }
.videos-row-date { color: var(--muted); }
.videos-row-tags { display: flex; gap: 6px; flex-wrap: wrap; font-size: 0.85rem; }
.videos-row-folder { padding: 2px 8px; background: var(--accent-bg, rgba(60, 130, 230, 0.1)); color: var(--accent, #3c82e6); border-radius: 4px; }
.videos-row-folder-empty { color: var(--muted); background: transparent; border: 1px dashed var(--border); }
.videos-row-tag { padding: 2px 8px; background: var(--surface-2, rgba(127,127,127,0.1)); border-radius: 4px; color: var(--muted); }
.videos-row-tag-list { display: inline-flex; gap: 6px; flex-wrap: wrap; }
.videos-empty { padding: 32px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; text-align: center; color: var(--muted); }
.videos-empty button { padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); cursor: pointer; }
.videos-pagination { display: flex; justify-content: space-between; align-items: center; padding: 16px 0; }
.videos-pagination a { color: var(--accent); padding: 6px 12px; border: 1px solid var(--border); border-radius: 4px; text-decoration: none; }
.videos-pagination a[aria-disabled="true"] { color: var(--muted); pointer-events: none; }
.videos-pagination-info { color: var(--muted); font-size: 0.85rem; }
@media (max-width: 720px) {
  .videos-row-link { grid-template-columns: 1fr; }
  .videos-row-thumb { width: 100%; }
}
`

// Inline script for the "Poll now" button on the empty-state copy.
// Tiny (~30 lines); same rationale as the inline IIFE in the
// subscriptions view.
export const VIDEOS_POLL_SCRIPT = `(function(){
  var btn = document.querySelector('[data-videos-poll]');
  var out = document.querySelector('[data-videos-poll-result]');
  if (!btn || !out) return;
  btn.addEventListener('click', function(){
    btn.disabled = true;
    out.textContent = 'Polling\u2026';
    fetch('/api/youtube/poll', { method: 'POST', credentials: 'same-origin' })
      .then(function(res){ return res.json().then(function(j){ return { res: res, json: j }; }); })
      .then(function(pair){
        if (pair.res.ok && pair.json.ok) {
          out.textContent = 'Poll finished; refresh to see new videos.';
        } else if (pair.json.reason === 'no_included_subscriptions') {
          out.textContent = 'No channels are enabled \u2014 visit Subscriptions and toggle one to start.';
        } else {
          out.textContent = 'Poll failed: ' + (pair.json.error || pair.res.status);
        }
      })
      .catch(function(err){
        out.textContent = 'Poll failed: ' + (err && err.message ? err.message : 'unknown');
      })
      .finally(function(){ btn.disabled = false; });
  });
})();`