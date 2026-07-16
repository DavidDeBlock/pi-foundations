import { Hono } from 'hono'
import type { AuthVariables } from './auth.js'
import type { Database } from './db.js'
import { listAllFoldersWithCounts } from './folders.js'
import { listAllTagsWithUsage } from './tags.js'
import {
  COMMON_HEAD,
  HAMBURGER_SCRIPT_TAG,
  THEME_SCRIPT_TAG,
  renderAppNavigation,
  renderHeader,
  renderSidebarFooter,
} from './view-shared.js'
import {
  getYouTubePlaylist,
  listYouTubePlaylistChannels,
  listYouTubePlaylists,
  searchYouTubePlaylistVideos,
  type YouTubePlaylistVideoItem,
  type YouTubePlaylistView,
} from './youtube-playlists.js'

interface GlobalSyncState {
  status: string
  playlist_count: number | bigint
  included_count: number | bigint
  synced_item_count: number | bigint
  failed_playlist_count: number | bigint
  completed_at: string | null
  error: string | null
}

export function youtubePlaylistsView(deps: {
  readonly db: Database
}): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.get('/', (c) => {
    const connected = deps.db.get<{ id: string }>(
      `SELECT id FROM youtube_accounts ORDER BY connected_at DESC LIMIT 1`,
    ) !== undefined
    const playlists = listYouTubePlaylists(deps.db)
    const sync = latestSync(deps.db)
    return c.html(renderListPage({ connected, playlists, sync }))
  })

  app.get('/:id', (c) => {
    const playlist = getYouTubePlaylist(deps.db, c.req.param('id'))
    if (!playlist) return c.text('Playlist not found', 404)
    const folderRaw = c.req.query('folder_id') ?? 'all'
    const transcript = readiness(c.req.query('transcript'))
    const summary = readiness(c.req.query('summary'))
    const watched = watchedFilter(c.req.query('watched'))
    const page = positiveInt(c.req.query('page')) ?? 1
    const limit = Math.min(100, positiveInt(c.req.query('limit')) ?? 30)
    const result = searchYouTubePlaylistVideos(deps.db, playlist, {
      ...(c.req.query('channel_id') ? { channelId: c.req.query('channel_id') } : {}),
      ...(folderRaw !== 'all' && folderRaw !== 'none' ? { folderId: folderRaw } : {}),
      ...(folderRaw === 'none' ? { unfoldered: true } : {}),
      ...(c.req.query('tag_id') ? { tagId: c.req.query('tag_id') } : {}),
      ...(transcript ? { transcript } : {}),
      ...(summary ? { summary } : {}),
      ...(watched ? { watched } : {}),
      page, limit,
    })
    return c.html(renderDetailPage({
      playlist,
      result,
      channels: listYouTubePlaylistChannels(deps.db, playlist),
      folders: listAllFoldersWithCounts(deps.db),
      tags: listAllTagsWithUsage(deps.db),
      query: {
        channelId: c.req.query('channel_id') ?? '', folderId: folderRaw,
        tagId: c.req.query('tag_id') ?? '', transcript: transcript ?? '',
        summary: summary ?? '', watched: watched ?? '',
      },
    }))
  })

  return app
}

function renderListPage(opts: {
  connected: boolean
  playlists: readonly YouTubePlaylistView[]
  sync: GlobalSyncState | null
}): string {
  const content = !opts.connected
    ? statePanel('Disconnected', 'Connect YouTube before syncing playlists.', '/settings/youtube', 'Open YouTube settings')
    : opts.playlists.length === 0
      ? statePanel('No playlists mirrored yet', 'Run a playlist sync to discover playlists from your connected account.', null, null)
      : `<div class="playlist-grid">${opts.playlists.map(renderPlaylistCard).join('')}</div>`
  return `<!doctype html>
<html lang="en">
<head>
${COMMON_HEAD}
  <title>Playlists — Dashboard</title>
  <meta name="robots" content="noindex">
  <style>${PLAYLIST_STYLES}</style>
</head>
<body class="space-youtube-page">
  ${renderHeader()}
  <div class="layout">
    ${sidebar('YouTube · saved collections')}
    <main class="playlists-main">
      <header class="playlist-page-header">
        <div><span class="page-eyebrow">YouTube library</span><h1>Playlists</h1>
        <p>Choose the collections you want available in your personal library.</p></div>
        ${opts.connected ? '<button class="playlist-sync-button" type="button" data-playlists-sync>Sync playlists</button>' : ''}
      </header>
      ${renderGlobalSync(opts.sync)}
      <div class="playlist-action-result" data-playlists-result role="status" aria-live="polite"></div>
      ${content}
    </main>
  </div>
  ${THEME_SCRIPT_TAG}
  ${HAMBURGER_SCRIPT_TAG}
  <script>${PLAYLIST_SCRIPT}</script>
</body>
</html>`
}

function renderPlaylistCard(playlist: YouTubePlaylistView): string {
  const unsupported = !playlist.liveSyncSupported
  const thumb = playlist.thumbnailUrl
    ? `<img src="${escapeHtml(playlist.thumbnailUrl)}" alt="" loading="lazy">`
    : '<span class="playlist-thumb-fallback" aria-hidden="true">▶</span>'
  const error = playlist.syncError
    ? `<p class="playlist-card-message playlist-card-error">${escapeHtml(playlist.syncError)}</p>`
    : unsupported
      ? '<p class="playlist-card-message">YouTube does not provide live access to this collection. Use Takeout when history import becomes available.</p>'
      : ''
  return `<article class="playlist-card" data-playlist-card data-playlist-id="${escapeHtml(playlist.playlistId)}">
    <a class="playlist-card-main" href="/playlists/${encodeURIComponent(playlist.playlistId)}">
      <span class="playlist-thumb">${thumb}<span>${playlist.localItemCount} saved</span></span>
      <span class="playlist-card-copy">
        <span class="playlist-card-kicker"><span class="privacy privacy-${escapeHtml(playlist.privacyStatus)}">${escapeHtml(playlist.privacyStatus)}</span>${playlist.specialType ? `<span class="special">${escapeHtml(specialLabel(playlist.specialType))}</span>` : ''}</span>
        <strong>${escapeHtml(playlist.title)}</strong>
        <span>${playlist.remoteItemCount} on YouTube · ${playlist.localItemCount} local</span>
      </span>
    </a>
    <footer class="playlist-card-footer">
      <label class="playlist-switch">
        <input type="checkbox" role="switch" data-playlist-toggle ${playlist.isIncluded ? 'checked' : ''} ${unsupported ? 'disabled' : ''}>
        <span>${playlist.isIncluded ? 'Included' : 'Excluded'}</span>
      </label>
      <span class="playlist-sync-state status-${escapeHtml(playlist.syncStatus)}" data-playlist-status>${syncLabel(playlist)}</span>
    </footer>
    ${error}
  </article>`
}

function renderGlobalSync(sync: GlobalSyncState | null): string {
  if (!sync) return '<p class="global-sync" data-global-sync>Not synced yet.</p>'
  const counts = `${Number(sync.playlist_count)} playlists · ${Number(sync.included_count)} included · ${Number(sync.synced_item_count)} videos`
  const failed = Number(sync.failed_playlist_count) > 0 ? ` · ${Number(sync.failed_playlist_count)} failed` : ''
  return `<p class="global-sync status-${escapeHtml(sync.status)}" data-global-sync>
    ${escapeHtml(sync.status === 'running' ? 'Syncing playlists…' : `Last sync ${formatRelative(sync.completed_at)} · ${counts}${failed}`)}
    ${sync.error ? `<span>${escapeHtml(sync.error)}</span>` : ''}
  </p>`
}

function renderDetailPage(opts: {
  playlist: YouTubePlaylistView
  result: ReturnType<typeof searchYouTubePlaylistVideos>
  channels: Array<{ readonly id: string; readonly title: string }>
  folders: ReadonlyArray<{ readonly id: string; readonly name: string; readonly videoCount: number }>
  tags: ReadonlyArray<{ readonly id: string; readonly name: string }>
  query: { channelId: string; folderId: string; tagId: string; transcript: string; summary: string; watched: string }
}): string {
  const { playlist, result, query } = opts
  const unsupported = !playlist.liveSyncSupported
  const activeFilters = Object.values(query).some((value) => value !== '' && value !== 'all')
  let body: string
  if (unsupported) {
    body = statePanel('Live sync is unavailable', playlist.syncError ?? 'YouTube does not expose this collection through its read-only API.', '/playlists', 'Back to playlists')
  } else if (!playlist.isIncluded) {
    body = statePanel('This playlist is excluded', 'Include it from the Playlists page to import its videos. Existing cached videos are kept safely.', '/playlists', 'Choose playlists')
  } else if (result.total === 0) {
    body = activeFilters
      ? statePanel('No videos match', 'Try clearing one or more filters.', `/playlists/${encodeURIComponent(playlist.playlistId)}`, 'Clear filters')
      : statePanel('No videos here yet', 'Sync this included playlist to import its current videos.', '/playlists', 'Sync playlists')
  } else {
    body = `<ol class="playlist-video-grid">${result.items.map((item) => renderVideoCard(item, playlist)).join('')}</ol>${renderPagination(playlist, result, query)}`
  }
  return `<!doctype html>
<html lang="en">
<head>
${COMMON_HEAD}
  <title>${escapeHtml(playlist.title)} — Dashboard</title>
  <meta name="robots" content="noindex">
  <style>${PLAYLIST_STYLES}</style>
</head>
<body class="space-youtube-page">
  ${renderHeader()}
  <div class="layout">
    ${sidebar('YouTube · playlist library')}
    <main class="playlists-main">
      <nav class="playlist-breadcrumb"><a href="/playlists">← All playlists</a></nav>
      <header class="playlist-detail-header">
        ${playlist.thumbnailUrl ? `<img src="${escapeHtml(playlist.thumbnailUrl)}" alt="">` : '<span class="playlist-detail-icon" aria-hidden="true">▶</span>'}
        <div><span class="page-eyebrow">${escapeHtml(playlist.privacyStatus)} playlist</span><h1>${escapeHtml(playlist.title)}</h1>
        <p>${playlist.remoteItemCount} on YouTube · ${playlist.localItemCount} saved locally · ${syncLabel(playlist)}</p></div>
      </header>
      ${!unsupported && playlist.isIncluded ? renderFilters(opts) : ''}
      <p class="playlist-results-count"><strong>${result.total}</strong> ${result.total === 1 ? 'video' : 'videos'} in YouTube order</p>
      ${body}
    </main>
  </div>
  ${THEME_SCRIPT_TAG}
  ${HAMBURGER_SCRIPT_TAG}
</body>
</html>`
}

function renderFilters(opts: Parameters<typeof renderDetailPage>[0]): string {
  const q = opts.query
  const select = (name: string, label: string, choices: Array<[string, string]>, selected: string) =>
    `<label><span>${label}</span><select name="${name}">${choices.map(([value, title]) => `<option value="${escapeHtml(value)}" ${selected === value ? 'selected' : ''}>${escapeHtml(title)}</option>`).join('')}</select></label>`
  return `<form method="get" class="playlist-filters" data-playlist-filters>
    ${select('channel_id', 'Channel', [['', 'All channels'], ...opts.channels.map((item) => [item.id, item.title] as [string, string])], q.channelId)}
    ${select('folder_id', 'Folder', [['all', 'All folders'], ['none', 'Unfoldered'], ...opts.folders.map((item) => [item.id, item.name] as [string, string])], q.folderId)}
    ${select('tag_id', 'Tag', [['', 'All tags'], ...opts.tags.map((item) => [item.id, item.name] as [string, string])], q.tagId)}
    ${select('transcript', 'Transcript', [['', 'Any transcript'], ['ready', 'Ready'], ['missing', 'Missing']], q.transcript)}
    ${select('summary', 'Insight', [['', 'Any insight'], ['ready', 'Ready'], ['missing', 'Missing']], q.summary)}
    ${opts.result.watchedAvailable ? select('watched', 'Watched', [['', 'Any watch state'], ['watched', 'Watched'], ['unwatched', 'Unwatched']], q.watched) : ''}
    <button type="submit">Apply filters</button>
  </form>`
}

function renderVideoCard(item: YouTubePlaylistVideoItem, playlist: YouTubePlaylistView): string {
  const thumbnail = item.thumbnailUrl
    ? `<img src="${escapeHtml(item.thumbnailUrl)}" alt="" loading="lazy">`
    : '<span class="video-thumb-fallback" aria-hidden="true">▶</span>'
  const statuses = [
    item.watched === true ? `<span class="video-state watched" title="Last watched ${escapeHtml(formatDate(item.lastWatchedAt!))}">Watched${item.watchCount > 1 ? ` · ${item.watchCount}×` : ''}</span>` : '',
    item.transcriptStatus === 'ready' ? '<span class="video-state">Transcript</span>' : '',
    item.summaryStatus === 'ready' ? '<span class="video-state insight">Insight</span>' : '',
  ].join('')
  return `<li class="playlist-video-card" data-video-id="${escapeHtml(item.id)}" data-position="${item.position}">
    <a href="/videos/${encodeURIComponent(item.id)}" class="playlist-video-link">
      <span class="playlist-video-thumb">${thumbnail}<span class="playlist-position">${item.position + 1}</span></span>
      <span class="playlist-video-copy">
        <span class="playlist-badge" title="YouTube playlist">${escapeHtml(playlist.title)}</span>
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.channelTitle)} · ${escapeHtml(formatDate(item.publishedAt))}</span>
        <span class="video-card-categories">${item.folderName ? `<span>${escapeHtml(item.folderName)}</span>` : ''}${item.tags.map((tag) => `<span title="${tag.source === 'both' ? 'Manual and inherited from subscription' : tag.source === 'subscription' ? 'Inherited from subscription' : 'Manual video tag'}">${tag.source !== 'manual' ? '↳' : '#'}${escapeHtml(tag.name)}</span>`).join('')}</span>
        <span class="video-card-states">${statuses}</span>
      </span>
    </a>
  </li>`
}

function renderPagination(
  playlist: YouTubePlaylistView,
  result: ReturnType<typeof searchYouTubePlaylistVideos>,
  query: Parameters<typeof renderDetailPage>[0]['query'],
): string {
  const pages = Math.ceil(result.total / result.limit)
  if (pages <= 1) return ''
  const href = (page: number) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries({
      channel_id: query.channelId, folder_id: query.folderId === 'all' ? '' : query.folderId,
      tag_id: query.tagId, transcript: query.transcript, summary: query.summary, watched: query.watched,
    })) if (value) params.set(key, value)
    params.set('page', String(page))
    params.set('limit', String(result.limit))
    return `/playlists/${encodeURIComponent(playlist.playlistId)}?${params}`
  }
  return `<nav class="playlist-pagination" aria-label="Playlist pages">
    ${result.page > 1 ? `<a href="${escapeHtml(href(result.page - 1))}">Previous</a>` : '<span aria-disabled="true">Previous</span>'}
    <span>Page ${result.page} of ${pages}</span>
    ${result.page < pages ? `<a href="${escapeHtml(href(result.page + 1))}">Next</a>` : '<span aria-disabled="true">Next</span>'}
  </nav>`
}

function sidebar(note: string): string {
  return `<aside class="sidebar" data-sidebar>${renderAppNavigation({ active: 'youtube', context: 'playlists' })}${renderSidebarFooter(note)}</aside>`
}

function statePanel(title: string, message: string, href: string | null, action: string | null): string {
  return `<section class="playlist-empty" role="status"><span aria-hidden="true">▶</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>${href && action ? `<a href="${escapeHtml(href)}">${escapeHtml(action)} →</a>` : ''}</section>`
}

function latestSync(db: Database): GlobalSyncState | null {
  return db.get<GlobalSyncState>(
    `SELECT status, playlist_count, included_count, synced_item_count,
       failed_playlist_count, completed_at, error
       FROM youtube_playlist_sync_state ORDER BY completed_at DESC LIMIT 1`,
  ) ?? null
}

function syncLabel(playlist: YouTubePlaylistView): string {
  if (!playlist.liveSyncSupported) return 'Live sync unavailable'
  if (playlist.syncStatus === 'pending') return 'Waiting for first sync…'
  if (playlist.syncStatus === 'running') return 'Syncing videos…'
  if (playlist.syncStatus === 'failed') return 'Sync failed · retry available'
  if (playlist.lastSyncedAt) return `Synced ${formatRelative(playlist.lastSyncedAt)}`
  return playlist.isIncluded ? 'Not synced yet' : 'Not included'
}

function specialLabel(value: string): string {
  if (value === 'liked') return 'Liked videos'
  if (value === 'watch_later') return 'Watch Later'
  if (value === 'history') return 'Watch History'
  return value
}

function formatRelative(value: string | null): string {
  if (!value) return 'not completed'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en', { dateStyle: 'medium' })
}

function positiveInt(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return value >= 1 ? value : null
}

function readiness(raw: string | undefined): 'ready' | 'missing' | null {
  return raw === 'ready' || raw === 'missing' ? raw : null
}

function watchedFilter(raw: string | undefined): 'watched' | 'unwatched' | null {
  return raw === 'watched' || raw === 'unwatched' ? raw : null
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

const PLAYLIST_SCRIPT = `(function () {
  var result = document.querySelector('[data-playlists-result]')
  function say(message, error) {
    if (!result) return
    result.textContent = message
    result.classList.toggle('is-error', !!error)
  }
  try {
    var savedNotice = window.sessionStorage.getItem('playlist-sync-notice')
    if (savedNotice) {
      window.sessionStorage.removeItem('playlist-sync-notice')
      say(savedNotice, false)
    }
  } catch (_) { /* storage may be disabled; syncing still works */ }
  async function json(response) {
    var body = await response.json().catch(function () { return {} })
    if (!response.ok) throw new Error(body.error || 'Request failed')
    return body
  }
  function syncText(playlist) {
    if (playlist.sync_status === 'pending') return 'Waiting for first sync…'
    if (playlist.sync_status === 'running') return 'Syncing videos…'
    if (playlist.sync_status === 'failed') return 'Sync failed · retry available'
    if (playlist.sync_status === 'completed') return 'Sync complete · ' + playlist.local_item_count + ' videos'
    return playlist.is_included ? 'Not synced yet' : 'Not included'
  }
  async function pollPlaylist(card, input) {
    for (var attempt = 0; attempt < 60; attempt++) {
      await new Promise(function (resolve) { window.setTimeout(resolve, 1000) })
      try {
        var body = await json(await fetch('/api/youtube/playlists'))
        var playlist = body.items.find(function (item) { return item.id === card.dataset.playlistId })
        if (!playlist) return
        var status = card.querySelector('[data-playlist-status]')
        if (status) status.textContent = syncText(playlist)
        if (playlist.sync_status !== 'pending' && playlist.sync_status !== 'running') {
          input.disabled = false
          say(playlist.sync_status === 'completed'
            ? 'Initial sync complete: ' + playlist.local_item_count + ' videos are available.'
            : (playlist.sync_error || 'Initial sync did not complete.'), playlist.sync_status === 'failed')
          return
        }
      } catch (_) { /* leave the persisted pending state visible */ }
    }
    input.disabled = false
    say('The sync is still running in the background.', false)
  }
  document.addEventListener('change', async function (event) {
    var input = event.target && event.target.closest ? event.target.closest('[data-playlist-toggle]') : null
    if (!input) return
    var card = input.closest('[data-playlist-card]')
    var label = input.parentElement.querySelector('span')
    var status = card.querySelector('[data-playlist-status]')
    var wanted = input.checked
    input.disabled = true
    if (label) label.textContent = wanted ? 'Included' : 'Excluded'
    if (wanted && status) status.textContent = 'Waiting for first sync…'
    try {
      await json(await fetch('/api/youtube/playlists/' + encodeURIComponent(card.dataset.playlistId), {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ is_included: wanted })
      }))
      say(wanted ? 'Playlist included. Its first video sync has started.' : 'Playlist excluded. Cached videos were kept.', false)
      if (wanted) void pollPlaylist(card, input)
      else input.disabled = false
    } catch (error) {
      input.checked = !wanted
      if (label) label.textContent = wanted ? 'Excluded' : 'Included'
      input.disabled = false
      say(error.message, true)
    }
  })
  document.addEventListener('click', async function (event) {
    var button = event.target && event.target.closest ? event.target.closest('[data-playlists-sync]') : null
    if (!button) return
    button.disabled = true
    button.textContent = 'Syncing…'
    say('Reading playlists and included videos from YouTube…', false)
    try {
      var body = await json(await fetch('/api/youtube/playlists/sync', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
      }))
      var sync = body.sync
      var notice = 'Found ' + sync.playlistCount + ' playlist' + (sync.playlistCount === 1 ? '' : 's') + '. '
        + (sync.includedCount === 0
          ? 'Choose the collections to include; their videos will sync immediately. '
          : sync.includedCount + ' included. ')
        + 'Video changes: ' + sync.addedCount + ' added, ' + sync.updatedCount + ' updated, '
        + sync.removedCount + ' removed, ' + sync.failedPlaylistCount + ' failed.'
      try { window.sessionStorage.setItem('playlist-sync-notice', notice) } catch (_) {}
      window.location.reload()
    } catch (error) {
      say(error.message, true)
      button.disabled = false
      button.textContent = 'Sync playlists'
    }
  })
})()`

const PLAYLIST_STYLES = `
.playlists-main{max-width:1180px;margin:0 auto;padding:40px 42px 72px;width:100%}.playlist-page-header,.playlist-detail-header{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:20px}.playlist-page-header h1,.playlist-detail-header h1{font-size:clamp(2rem,4vw,3.5rem);letter-spacing:-.055em;margin:4px 0 8px}.playlist-page-header p,.playlist-detail-header p{color:var(--muted);margin:0;max-width:650px}.page-eyebrow{text-transform:uppercase;letter-spacing:.16em;font:600 .72rem "JetBrains Mono", monospace;color:var(--accent)}.playlist-sync-button,.playlist-filters button{border:0;border-radius:12px;background:linear-gradient(135deg,var(--accent),#8b5cf6);color:white;font-weight:600;padding:12px 18px;box-shadow:0 8px 28px color-mix(in srgb,var(--accent) 25%,transparent);cursor:pointer}.playlist-sync-button:disabled{opacity:.6;cursor:wait}.global-sync{color:var(--muted);font-size:.85rem;margin:0 0 24px}.global-sync span{display:block;color:#f87171;margin-top:5px}.playlist-action-result{min-height:1.4em;color:var(--accent);margin-bottom:10px}.playlist-action-result.is-error{color:#f87171}.playlist-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}.playlist-card{background:linear-gradient(145deg,color-mix(in srgb,var(--surface) 94%,var(--accent) 6%),var(--surface));border:1px solid var(--border);border-radius:18px;overflow:hidden;box-shadow:0 12px 38px rgba(0,0,0,.12);transition:transform .18s,border-color .18s}.playlist-card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--accent) 45%,var(--border))}.playlist-card-main{display:flex;gap:16px;padding:16px;color:inherit;text-decoration:none}.playlist-thumb{position:relative;display:block;width:116px;aspect-ratio:16/10;border-radius:12px;overflow:hidden;background:color-mix(in srgb,var(--surface) 80%,#8b5cf6);flex:none}.playlist-thumb img{width:100%;height:100%;object-fit:cover}.playlist-thumb>span:last-child{position:absolute;inset:auto 0 0;padding:5px 8px;background:rgba(7,10,18,.76);color:white;font-size:.7rem}.playlist-thumb-fallback{display:grid!important;place-items:center;height:100%;font-size:1.5rem;color:var(--accent)}.playlist-card-copy{display:flex;min-width:0;flex-direction:column;gap:6px}.playlist-card-copy strong{font-size:1.03rem;line-height:1.3}.playlist-card-copy>span:last-child{color:var(--muted);font-size:.8rem}.playlist-card-kicker{display:flex!important;gap:6px}.privacy,.special,.playlist-badge,.video-state{border:1px solid var(--border);border-radius:999px;padding:3px 7px;text-transform:uppercase;letter-spacing:.06em;font:600 .62rem "JetBrains Mono", monospace;width:max-content}.privacy-private{color:#c4b5fd}.privacy-public{color:#6ee7b7}.special{color:#fca5a5}.playlist-card-footer{display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--border);padding:12px 16px;color:var(--muted);font-size:.78rem}.playlist-switch{display:flex;align-items:center;gap:8px;cursor:pointer}.playlist-switch input{width:34px;height:18px;accent-color:var(--accent)}.playlist-switch input:focus-visible,.playlist-sync-button:focus-visible,.playlist-filters select:focus-visible,.playlist-filters button:focus-visible,a:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 60%,transparent);outline-offset:3px}.status-running,.status-pending{color:#fbbf24}.status-failed{color:#f87171}.status-completed{color:#6ee7b7}.playlist-card-message{margin:0;padding:0 16px 14px;color:var(--muted);font-size:.78rem;line-height:1.5}.playlist-card-error{color:#fca5a5}.playlist-empty{text-align:center;padding:70px 24px;border:1px dashed var(--border);border-radius:20px;background:color-mix(in srgb,var(--surface) 86%,transparent)}.playlist-empty>span{display:grid;place-items:center;width:52px;height:52px;margin:0 auto 16px;border-radius:16px;background:color-mix(in srgb,var(--accent) 14%,var(--surface));color:var(--accent)}.playlist-empty h2{margin:0 0 8px}.playlist-empty p{color:var(--muted);max-width:520px;margin:0 auto 18px}.playlist-empty a,.playlist-breadcrumb a{color:var(--accent);font-weight:600;text-decoration:none}.playlist-breadcrumb{margin-bottom:24px}.playlist-detail-header{justify-content:flex-start;padding-bottom:24px;border-bottom:1px solid var(--border)}.playlist-detail-header img,.playlist-detail-icon{width:160px;aspect-ratio:16/10;object-fit:cover;border-radius:16px;background:linear-gradient(145deg,color-mix(in srgb,var(--accent) 20%,var(--surface)),var(--surface));box-shadow:0 14px 34px rgba(0,0,0,.18)}.playlist-detail-icon{display:grid;place-items:center;color:var(--accent);font-size:2rem}.playlist-filters{display:grid;grid-template-columns:repeat(3,minmax(130px,1fr));gap:12px;align-items:end;padding:18px;border:1px solid var(--border);border-radius:16px;background:var(--surface);margin:20px 0}.playlist-filters label{display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:.72rem;font-weight:600}.playlist-filters select{min-width:0;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text)}.playlist-results-count{color:var(--muted);font-size:.84rem;margin:18px 0}.playlist-video-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:15px;list-style:none;padding:0;margin:0}.playlist-video-card{overflow:hidden;border:1px solid var(--border);border-radius:16px;background:var(--surface);transition:transform .18s,border-color .18s}.playlist-video-card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--accent) 45%,var(--border))}.playlist-video-link{display:block;color:inherit;text-decoration:none}.playlist-video-thumb{display:block;position:relative;aspect-ratio:16/9;background:color-mix(in srgb,var(--surface) 75%,#8b5cf6);overflow:hidden}.playlist-video-thumb img{width:100%;height:100%;object-fit:cover}.video-thumb-fallback{display:grid;place-items:center;height:100%;color:var(--accent);font-size:1.6rem}.playlist-position{position:absolute;right:9px;bottom:9px;display:grid;place-items:center;min-width:27px;height:27px;padding:0 6px;border-radius:8px;background:rgba(6,9,16,.82);color:white;font:600 .72rem "JetBrains Mono", monospace}.playlist-video-copy{display:flex;flex-direction:column;gap:7px;padding:14px}.playlist-badge{color:#c4b5fd;background:color-mix(in srgb,#8b5cf6 12%,transparent);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.playlist-video-copy strong{line-height:1.35}.playlist-video-copy>span:nth-child(3){color:var(--muted);font-size:.78rem}.video-card-categories,.video-card-states{display:flex;gap:5px;flex-wrap:wrap}.video-card-categories span{color:var(--muted);font-size:.72rem}.video-state{color:#67e8f9}.video-state.watched{color:#6ee7b7}.video-state.insight{color:#f0abfc}.playlist-pagination{display:flex;justify-content:center;align-items:center;gap:20px;margin-top:28px}.playlist-pagination a{color:var(--accent);text-decoration:none}.playlist-pagination [aria-disabled]{color:var(--muted);opacity:.55}@media(max-width:800px){.playlists-main{padding:26px 18px 60px}.playlist-page-header{align-items:flex-start;flex-direction:column}.playlist-sync-button{width:100%}.playlist-filters{grid-template-columns:1fr 1fr}.playlist-detail-header img,.playlist-detail-icon{width:110px}}@media(max-width:520px){.playlist-grid,.playlist-video-grid{grid-template-columns:1fr}.playlist-card-main{gap:12px}.playlist-thumb{width:96px}.playlist-filters{grid-template-columns:1fr}.playlist-detail-header{align-items:flex-start;flex-direction:column}.playlist-detail-header img,.playlist-detail-icon{width:100%}}`
