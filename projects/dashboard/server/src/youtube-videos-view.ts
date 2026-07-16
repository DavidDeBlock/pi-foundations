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
  renderAppNavigation,
  renderSidebarFooter,
} from './view-shared.js'
import {
  searchVideos,
  type VideoListItem,
} from './youtube-videos.js'
import { listAllFoldersWithCounts } from './folders.js'
import { listAllTagsWithUsage } from './tags.js'
import { searchSubscriptions } from './youtube-subscriptions.js'
import { listYouTubePlaylists } from './youtube-playlists.js'

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
    const playlistId = c.req.query('playlist_id') || undefined
    const source = c.req.query('source') === 'playlist' || playlistId
      ? 'playlist' as const
      : undefined
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
            ...(source ? { source } : {}),
            ...(playlistId ? { playlistId } : {}),
            page,
            limit: limitRaw,
          }
        : folder.kind === 'folder'
          ? {
              ...(channelId ? { channelId } : {}),
              folderId: folder.id,
              ...(tagId ? { tagId } : {}),
              ...(source ? { source } : {}),
              ...(playlistId ? { playlistId } : {}),
              page,
              limit: limitRaw,
            }
          : {
              ...(channelId ? { channelId } : {}),
              unfoldered: true,
              ...(tagId ? { tagId } : {}),
              ...(source ? { source } : {}),
              ...(playlistId ? { playlistId } : {}),
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
        source,
        playlistId,
        channels,
        folders,
        tags,
        playlists: listYouTubePlaylists(deps.db),
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
  readonly source: 'playlist' | undefined
  readonly playlistId: string | undefined
  readonly channels: Array<{ readonly channelId: string; readonly channelTitle: string | null }>
  readonly folders: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly bookmarkCount: number
    readonly videoCount: number
  }>
  readonly tags: Array<{ readonly id: string; readonly name: string }>
  readonly playlists: ReadonlyArray<{ readonly playlistId: string; readonly title: string }>
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
<body class="space-youtube-page">
  ${renderHeader()}
  <div class="layout">
    ${renderVideosSidebar()}
    <main class="videos-main">
      <header class="videos-header">
        <span class="page-eyebrow">YouTube</span>
        <h1>New videos</h1>
        <p class="videos-subtitle">Fresh uploads from the channels you chose to follow here.</p>
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
          <label for="source">Source</label>
          <select id="source" name="source" data-videos-source>
            <option value="">New videos</option>
            <option value="playlist" ${opts.source === 'playlist' ? 'selected' : ''}>Playlists</option>
          </select>
        </div>
        <div class="videos-filter">
          <label for="playlist_id">Playlist</label>
          <select id="playlist_id" name="playlist_id" data-videos-playlist>
            <option value="">All playlists</option>
            ${opts.playlists.map((playlist) => `<option value="${escapeHtml(playlist.playlistId)}" ${opts.playlistId === playlist.playlistId ? 'selected' : ''}>${escapeHtml(playlist.title)}</option>`).join('')}
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
  const playlistChips = v.playlists.map((playlist) =>
    `<span class="videos-row-playlist">${escapeHtml(playlist.title)}</span>`,
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
      <span class="videos-row-tags">${folder}${tagChips.length > 0 ? `<span class="videos-row-tag-list">${tagChips.join('')}</span>` : ''}${playlistChips.join('')}</span>
    </span>
  </a>
</li>`
}

function renderEmpty(opts: RenderPageOptions): string {
  if (opts.total !== 0) return ''
  // Distinct message when filters are active vs not.
  const filtersActive =
    opts.channelId || opts.folderIdRaw !== 'all' || opts.tagId || opts.source || opts.playlistId
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
    if (opts.source) sp.set('source', opts.source)
    if (opts.playlistId) sp.set('playlist_id', opts.playlistId)
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
  return `<aside class="sidebar" data-sidebar>
  ${renderAppNavigation({ active: 'youtube', context: 'videos' })}
  ${renderSidebarFooter('YouTube · fresh uploads')}
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
.videos-main { flex: 1; min-width: 0; padding: 24px clamp(12px, 4vw, 48px) 64px; }
.videos-header { margin-bottom: 24px; }
.videos-header h1 { margin: 3px 0 5px; font-size: clamp(1.6rem, 3vw, 2.1rem); }
.videos-subtitle { margin: 0 0 20px; color: var(--muted); font-size: 0.95rem; }
.videos-filters { display: flex; gap: 12px; flex-wrap: wrap; padding: 14px; background: color-mix(in srgb, var(--surface) 90%, transparent); border: 1px solid var(--border); border-radius: 14px; margin-bottom: 16px; box-shadow: var(--shadow); }
.videos-filter { display: flex; flex-direction: column; gap: 4px; min-width: 180px; }
.videos-filter label { font-size: 0.78rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
.videos-filter select, .videos-filter button { min-height: 38px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); color: var(--text); font: inherit; }
.videos-filter button { color: var(--accent-text); background: var(--accent); border-color: var(--accent); font-weight: 600; }
.videos-filter-actions { align-self: end; }
.videos-counts { margin: 0 0 16px; color: var(--muted); }
.videos-list { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(270px, 100%), 1fr)); gap: 18px; }
.videos-row { min-width: 0; overflow: hidden; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 10px 30px rgba(4, 10, 24, 0.13); transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease; }
.videos-row:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--accent) 65%, var(--border)); box-shadow: 0 18px 42px color-mix(in srgb, var(--accent) 10%, rgba(4, 10, 24, .3)); }
.videos-row-link { display: flex; height: 100%; flex-direction: column; color: inherit; text-decoration: none; }
.videos-row-thumb { width: 100%; aspect-ratio: 16 / 9; background: var(--surface-2); object-fit: cover; }
.videos-row-thumb-fallback { background: var(--surface-2, rgba(127,127,127,0.1)); }
.videos-row-body { display: flex; flex: 1; flex-direction: column; gap: 8px; padding: 14px; }
.videos-row-title { font-weight: 600; font-size: 1rem; line-height: 1.35; }
.videos-row-meta { color: var(--muted); font-size: 0.85rem; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.videos-row-channel { color: var(--text); }
.videos-row-date { color: var(--muted); }
.videos-row-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: auto; padding-top: 4px; font-size: 0.8rem; }
.videos-row-folder { padding: 2px 8px; background: var(--accent-bg, rgba(60, 130, 230, 0.1)); color: var(--accent, #3c82e6); border-radius: 4px; }
.videos-row-folder-empty { color: var(--muted); background: transparent; border: 1px dashed var(--border); }
.videos-row-tag { padding: 2px 8px; background: var(--surface-2, rgba(127,127,127,0.1)); border-radius: 4px; color: var(--muted); }
.videos-row-tag-list { display: inline-flex; gap: 6px; flex-wrap: wrap; }
.videos-row-playlist { padding: 2px 8px; border: 1px solid color-mix(in srgb, #8b5cf6 50%, var(--border)); border-radius: 999px; color: #a78bfa; background: color-mix(in srgb, #8b5cf6 10%, transparent); }
.videos-empty { padding: 32px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; text-align: center; color: var(--muted); }
.videos-empty button { padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); cursor: pointer; }
.videos-pagination { display: flex; justify-content: space-between; align-items: center; padding: 16px 0; }
.videos-pagination a { color: var(--accent); padding: 6px 12px; border: 1px solid var(--border); border-radius: 4px; text-decoration: none; }
.videos-pagination a[aria-disabled="true"] { color: var(--muted); pointer-events: none; }
.videos-pagination-info { color: var(--muted); font-size: 0.85rem; }
@media (max-width: 720px) {
  .videos-main { padding: 18px 12px 48px; }
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
