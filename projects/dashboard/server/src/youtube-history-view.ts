import { Hono } from 'hono'
import type { AuthVariables } from './auth.js'
import type { Database } from './db.js'
import {
  getWatchHistoryOverview,
  listWatchHistoryChannels,
  listWatchHistoryTags,
  searchWatchHistory,
  type WatchHistoryAvailability,
  type WatchHistoryEvent,
  type WatchHistoryFacet,
  type WatchHistoryOverview,
  type WatchHistorySort,
} from './youtube-history.js'
import {
  COMMON_HEAD,
  HAMBURGER_SCRIPT_TAG,
  THEME_SCRIPT_TAG,
  renderAppNavigation,
  renderHeader,
  renderSidebarFooter,
} from './view-shared.js'

export function youtubeHistoryView(deps: { readonly db: Database }): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>()
  app.get('/', (c) => {
    const page = positiveInt(c.req.query('page')) ?? 1
    const query = c.req.query('q')?.trim() || undefined
    const channelId = c.req.query('channel_id') || undefined
    const tagId = c.req.query('tag_id') || undefined
    const watchedFrom = validDate(c.req.query('watched_from'))
    const watchedTo = validDate(c.req.query('watched_to'))
    const availability = parseAvailability(c.req.query('availability'))
    const sort = c.req.query('sort') === 'oldest' ? 'oldest' : 'newest'
    const result = searchWatchHistory(deps.db, {
      query, channelId, tagId, watchedFrom, watchedTo, availability, sort, page, limit: 48,
    })
    return c.html(renderPage({
      result,
      overview: getWatchHistoryOverview(deps.db),
      channels: listWatchHistoryChannels(deps.db),
      tags: listWatchHistoryTags(deps.db),
      query, channelId, tagId, watchedFrom, watchedTo, availability, sort,
    }))
  })
  return app
}

interface HistoryPageOptions {
  readonly result: ReturnType<typeof searchWatchHistory>
  readonly overview: WatchHistoryOverview
  readonly channels: readonly WatchHistoryFacet[]
  readonly tags: readonly WatchHistoryFacet[]
  readonly query: string | undefined
  readonly channelId: string | undefined
  readonly tagId: string | undefined
  readonly watchedFrom: string | undefined
  readonly watchedTo: string | undefined
  readonly availability: WatchHistoryAvailability
  readonly sort: WatchHistorySort
}

function renderPage(opts: HistoryPageOptions): string {
  const { result } = opts
  const pages = Math.max(1, Math.ceil(result.total / result.limit))
  const hasFilters = Boolean(opts.query || opts.channelId || opts.tagId || opts.watchedFrom || opts.watchedTo || opts.availability !== 'all' || opts.sort !== 'newest')
  const content = result.total === 0
    ? renderEmpty(opts.overview.total > 0, hasFilters)
    : `<ol class="history-grid">${result.items.map(renderEvent).join('')}</ol>${pagination(opts, pages)}`
  return `<!doctype html>
<html lang="en">
<head>
${COMMON_HEAD}
  <title>Watch history — Dashboard</title>
  <meta name="robots" content="noindex">
  <style>${STYLES}</style>
</head>
<body class="space-youtube-page">
  ${renderHeader()}
  <div class="layout">
    <aside class="sidebar" data-sidebar>${renderAppNavigation({ active: 'youtube', context: 'history' })}${renderSidebarFooter('YouTube · private watch history')}</aside>
    <main class="history-main">
      <header class="history-hero">
        <div><span class="page-eyebrow">Your viewing archive</span><h1>Watch history</h1><p>Rediscover what you watched without the noise of YouTube. Search, filter, and jump back into the videos that matter.</p></div>
        <a class="history-import-link" href="/settings/youtube#watch-history-import"><span aria-hidden="true">↻</span> Import history</a>
      </header>
      ${renderOverview(opts.overview)}
      ${renderFilters(opts)}
      <div class="history-results-heading"><div><strong>${formatNumber(result.total)}</strong> ${result.total === 1 ? 'watch' : 'watches'}${hasFilters ? ' match your filters' : ''}</div>${hasFilters ? '<a href="/history">Clear all</a>' : '<span>Every replay remains a separate moment</span>'}</div>
      ${content}
    </main>
  </div>
  ${THEME_SCRIPT_TAG}
  ${HAMBURGER_SCRIPT_TAG}
</body>
</html>`
}

function renderOverview(overview: WatchHistoryOverview): string {
  const libraryShare = overview.uniqueVideos > 0
    ? Math.round((overview.libraryVideos / overview.uniqueVideos) * 100)
    : 0
  return `<section class="history-overview" aria-label="Watch history overview">
    <article class="history-stat history-stat-primary"><span class="history-stat-icon" aria-hidden="true">▶</span><div><strong>${formatNumber(overview.total)}</strong><span>Total watches</span></div><small>Your complete imported timeline</small></article>
    <article class="history-stat"><span class="history-stat-icon history-stat-icon-violet" aria-hidden="true">◇</span><div><strong>${formatNumber(overview.uniqueVideos)}</strong><span>Unique videos</span></div><small>Distinct things you have watched</small></article>
    <article class="history-stat"><span class="history-stat-icon history-stat-icon-green" aria-hidden="true">↻</span><div><strong>${formatNumber(overview.replayEvents)}</strong><span>Replay moments</span></div><small>Videos worth returning to</small></article>
    <article class="history-stat"><span class="history-stat-icon history-stat-icon-amber" aria-hidden="true">▣</span><div><strong>${formatNumber(overview.libraryVideos)}</strong><span>In your library</span></div><small>${libraryShare}% ready with details and tools</small></article>
  </section>`
}

function renderFilters(opts: HistoryPageOptions): string {
  return `<form class="history-filters" method="get" action="/history" aria-label="Filter watch history">
    <div class="history-filter history-filter-search"><label for="history-q">Search history</label><div class="history-search-control"><span aria-hidden="true">⌕</span><input id="history-q" name="q" type="search" value="${escapeHtml(opts.query ?? '')}" placeholder="Video title or channel"></div></div>
    <div class="history-filter"><label for="history-channel">Channel</label><select id="history-channel" name="channel_id"><option value="">All channels</option>${opts.channels.map((channel) => `<option value="${escapeHtml(channel.id)}"${channel.id === opts.channelId ? ' selected' : ''}>${escapeHtml(channel.name)} · ${formatNumber(channel.count)}</option>`).join('')}</select></div>
    <div class="history-filter"><label for="history-tag">Tag</label><select id="history-tag" name="tag_id"><option value="">All tags</option>${opts.tags.map((tag) => `<option value="${escapeHtml(tag.id)}"${tag.id === opts.tagId ? ' selected' : ''}>#${escapeHtml(tag.name)} · ${formatNumber(tag.count)}</option>`).join('')}</select></div>
    <div class="history-filter history-filter-date"><label for="history-from">Watched from</label><input id="history-from" name="watched_from" type="date" value="${escapeHtml(opts.watchedFrom ?? '')}"></div>
    <div class="history-filter history-filter-date"><label for="history-to">Watched to</label><input id="history-to" name="watched_to" type="date" value="${escapeHtml(opts.watchedTo ?? '')}"></div>
    <div class="history-filter"><label for="history-availability">Video access</label><select id="history-availability" name="availability"><option value="all"${opts.availability === 'all' ? ' selected' : ''}>Everything</option><option value="library"${opts.availability === 'library' ? ' selected' : ''}>In my library</option><option value="snapshot"${opts.availability === 'snapshot' ? ' selected' : ''}>Snapshot only</option></select></div>
    <div class="history-filter"><label for="history-sort">Sort</label><select id="history-sort" name="sort"><option value="newest"${opts.sort === 'newest' ? ' selected' : ''}>Recently watched</option><option value="oldest"${opts.sort === 'oldest' ? ' selected' : ''}>Oldest watched</option></select></div>
    <div class="history-filter-actions"><button type="submit">Apply filters</button><a href="/history">Reset</a></div>
  </form>`
}

function renderEmpty(hasHistory: boolean, hasFilters: boolean): string {
  if (hasHistory && hasFilters) {
    return `<section class="history-empty"><span aria-hidden="true">⌕</span><h2>No matching watches</h2><p>Try a broader date range or remove one of the filters.</p><a href="/history">Clear filters</a></section>`
  }
  return `<section class="history-empty"><span aria-hidden="true">◷</span><h2>No watch history imported</h2><p>Import a Google Takeout watch-history JSON or HTML file to build your private viewing archive.</p><a href="/settings/youtube#watch-history-import">Import watch history</a></section>`
}

function renderEvent(item: WatchHistoryEvent): string {
  const thumbnailUrl = item.thumbnailUrl
    ?? (item.videoId && item.youtubeVideoId
      ? `https://i.ytimg.com/vi/${encodeURIComponent(item.youtubeVideoId)}/hqdefault.jpg`
      : null)
  const thumbnail = `<span class="history-thumb-fallback" aria-hidden="true">▶</span>${thumbnailUrl
    ? `<img src="${escapeHtml(thumbnailUrl)}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'">`
    : ''}`
  const title = escapeHtml(item.title)
  const canonicalLink = item.videoId ? `/videos/${encodeURIComponent(item.videoId)}` : null
  const youtubeLink = item.youtubeVideoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(item.youtubeVideoId)}` : null
  const href = canonicalLink ?? youtubeLink
  const repeat = item.watchCount > 1 ? `<span class="history-repeat" title="Watched ${item.watchCount} times">↻ ${item.watchCount}×</span>` : ''
  const source = item.source === 'takeout' ? 'Takeout' : item.source === 'embedded_player' ? 'Dashboard player' : item.source[0]!.toUpperCase() + item.source.slice(1)
  const tags = item.tags.map((tag) => `<span class="history-tag${tag.source !== 'manual' ? ' history-tag-inherited' : ''}" title="${tag.source === 'both' ? 'Manual and inherited from subscription' : tag.source === 'subscription' ? 'Inherited from subscription' : 'Manual video tag'}">${tag.source !== 'manual' ? '↳' : '#'}${escapeHtml(tag.name)}</span>`).join('')
  return `<li class="history-card" data-history-event>
    ${href ? `<a class="history-card-link" href="${escapeHtml(href)}"${canonicalLink ? '' : ' target="_blank" rel="noopener noreferrer"'}>` : '<div class="history-card-link">'}
      <span class="history-thumb">${thumbnail}<span class="history-watch-badge"><span aria-hidden="true">✓</span> Watched</span>${repeat}</span>
      <span class="history-copy"><span class="history-channel">${escapeHtml(item.channelTitle ?? 'Unknown channel')}</span><strong>${title}</strong><time datetime="${escapeHtml(item.watchedAt)}">${escapeHtml(formatDate(item.watchedAt))} · ${escapeHtml(source)}</time><span class="history-states">${tags}${canonicalLink ? '<span class="history-access">View details <span aria-hidden="true">→</span></span>' : '<span class="history-snapshot">Snapshot only</span>'}</span></span>
    ${href ? '</a>' : '</div>'}
  </li>`
}

function pagination(opts: HistoryPageOptions, pages: number): string {
  if (pages <= 1) return ''
  const page = opts.result.page
  return `<nav class="history-pagination" aria-label="History pages"><a href="${escapeHtml(historyUrl(opts, Math.max(1, page - 1)))}"${page === 1 ? ' aria-disabled="true"' : ''}>← Previous</a><span>Page ${page} of ${pages}</span><a href="${escapeHtml(historyUrl(opts, Math.min(pages, page + 1)))}"${page === pages ? ' aria-disabled="true"' : ''}>Next →</a></nav>`
}

function historyUrl(opts: HistoryPageOptions, page: number): string {
  const params = new URLSearchParams()
  if (opts.query) params.set('q', opts.query)
  if (opts.channelId) params.set('channel_id', opts.channelId)
  if (opts.tagId) params.set('tag_id', opts.tagId)
  if (opts.watchedFrom) params.set('watched_from', opts.watchedFrom)
  if (opts.watchedTo) params.set('watched_to', opts.watchedTo)
  if (opts.availability !== 'all') params.set('availability', opts.availability)
  if (opts.sort !== 'newest') params.set('sort', opts.sort)
  if (page > 1) params.set('page', String(page))
  const query = params.toString()
  return query ? `/history?${query}` : '/history'
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date) + ' UTC'
}

function positiveInt(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function validDate(raw: string | undefined): string | undefined {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined
  const date = new Date(`${raw}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : undefined
}

function parseAvailability(raw: string | undefined): WatchHistoryAvailability {
  return raw === 'library' || raw === 'snapshot' ? raw : 'all'
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en').format(value)
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const STYLES = `
.layout { display:flex; min-height:calc(100vh - var(--header-h)); }
.history-main { display:block; flex:1; min-width:0; max-width:1680px; margin:0 auto; padding:34px clamp(18px,3.5vw,56px) 72px; }
.history-hero { display:flex; align-items:flex-end; justify-content:space-between; gap:28px; margin-bottom:26px; }
.history-hero h1 { margin:5px 0 8px; font-size:clamp(2rem,4vw,3.25rem); line-height:1; letter-spacing:-.045em; }
.history-hero p { max-width:720px; color:var(--muted); margin:0; line-height:1.55; }
.page-eyebrow { color:var(--accent); font-size:.72rem; font-weight:750; letter-spacing:.14em; text-transform:uppercase; }
.history-import-link,.history-empty a { display:inline-flex; align-items:center; gap:8px; color:var(--accent-text); background:linear-gradient(135deg,var(--accent),#8b5cf6); border-radius:11px; padding:11px 16px; box-shadow:0 10px 26px color-mix(in srgb,var(--accent) 22%,transparent); text-decoration:none; font-weight:700; white-space:nowrap; }
.history-overview { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; margin-bottom:18px; }
.history-stat { position:relative; overflow:hidden; display:grid; grid-template-columns:auto 1fr; gap:4px 12px; min-height:130px; padding:18px; border:1px solid var(--border); border-radius:17px; background:linear-gradient(145deg,color-mix(in srgb,var(--surface) 96%,var(--accent) 4%),var(--surface)); box-shadow:var(--shadow); }
.history-stat::after { content:''; position:absolute; width:90px; height:90px; right:-38px; top:-42px; border-radius:50%; background:color-mix(in srgb,var(--accent) 9%,transparent); }
.history-stat-icon { display:grid; place-items:center; width:38px; height:38px; border-radius:11px; color:#60a5fa; background:color-mix(in srgb,#3b82f6 14%,var(--surface)); font-weight:800; }
.history-stat-icon-violet { color:#c4b5fd; background:color-mix(in srgb,#8b5cf6 14%,var(--surface)); }.history-stat-icon-green { color:#6ee7b7; background:color-mix(in srgb,#10b981 14%,var(--surface)); }.history-stat-icon-amber { color:#fcd34d; background:color-mix(in srgb,#f59e0b 14%,var(--surface)); }
.history-stat div { display:flex; flex-direction:column; }.history-stat strong { font-size:1.55rem; line-height:1; letter-spacing:-.03em; }.history-stat div span { margin-top:5px; font-size:.78rem; font-weight:700; color:var(--text); }
.history-stat small { grid-column:1/-1; align-self:end; color:var(--muted); font-size:.75rem; }
.history-filters { display:grid; grid-template-columns:minmax(250px,1.5fr) repeat(3,minmax(145px,1fr)); gap:12px; padding:16px; margin-bottom:20px; border:1px solid var(--border); border-radius:17px; background:color-mix(in srgb,var(--surface) 94%,transparent); box-shadow:var(--shadow); }
.history-filter { display:flex; min-width:0; flex-direction:column; gap:6px; }.history-filter label { color:var(--muted); font-size:.68rem; font-weight:750; letter-spacing:.06em; text-transform:uppercase; }
.history-filter input,.history-filter select { width:100%; min-width:0; height:40px; padding:0 11px; border:1px solid var(--border); border-radius:9px; background:var(--surface-2); color:var(--text); font:inherit; font-size:.85rem; }
.history-search-control { position:relative; }.history-search-control span { position:absolute; left:12px; top:50%; transform:translateY(-50%); color:var(--muted); font-size:1.1rem; }.history-search-control input { padding-left:35px; }
.history-filter input:focus,.history-filter select:focus { outline:3px solid color-mix(in srgb,var(--accent) 22%,transparent); border-color:var(--accent); }
.history-filter-actions { display:flex; align-items:flex-end; gap:9px; }.history-filter-actions button,.history-filter-actions a { display:inline-flex; height:40px; align-items:center; justify-content:center; border-radius:9px; font:inherit; font-size:.84rem; font-weight:700; cursor:pointer; text-decoration:none; }.history-filter-actions button { flex:1; padding:0 14px; border:1px solid var(--accent); background:var(--accent); color:var(--accent-text); }.history-filter-actions a { padding:0 10px; color:var(--muted); }
.history-results-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; margin:0 2px 14px; color:var(--muted); font-size:.84rem; }.history-results-heading strong { color:var(--text); }.history-results-heading a { color:var(--accent); text-decoration:none; font-weight:700; }
.history-grid { list-style:none; padding:0; margin:0; display:grid; grid-template-columns:repeat(auto-fill,minmax(min(270px,100%),1fr)); gap:18px; }
.history-card { min-width:0; overflow:hidden; background:var(--surface); border:1px solid var(--border); border-radius:16px; box-shadow:0 10px 30px rgba(4,10,24,.13); transition:transform 180ms ease,border-color 180ms ease,box-shadow 180ms ease; }
.history-card:hover { transform:translateY(-3px); border-color:color-mix(in srgb,var(--accent) 60%,var(--border)); box-shadow:0 18px 42px color-mix(in srgb,var(--accent) 10%,rgba(4,10,24,.3)); }
.history-card-link { display:flex; height:100%; flex-direction:column; color:inherit; text-decoration:none; }
.history-thumb { width:100%; aspect-ratio:16/9; flex:none; overflow:hidden; background:var(--surface-2); display:grid; place-items:center; }
.history-thumb img { position:absolute; z-index:1; inset:0; width:100%; height:100%; object-fit:cover; }
.history-thumb { position:relative; background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 9%,var(--surface-2)),var(--surface-2)); }.history-thumb-fallback { color:color-mix(in srgb,var(--accent) 55%,var(--muted)); font-size:1.7rem; }
.history-watch-badge,.history-repeat { position:absolute; z-index:2; top:10px; border-radius:999px; padding:4px 8px; color:#d1fae5; background:rgba(5,46,36,.86); border:1px solid rgba(110,231,183,.28); backdrop-filter:blur(8px); font-size:.69rem; font-weight:750; }.history-watch-badge { left:10px; }.history-repeat { right:10px; color:#ddd6fe; background:rgba(46,16,101,.86); border-color:rgba(196,181,253,.3); }
.history-copy { min-width:0; display:flex; flex:1; flex-direction:column; gap:7px; padding:14px 15px 15px; }
.history-channel { overflow:hidden; color:var(--accent); font-size:.72rem; font-weight:750; text-overflow:ellipsis; white-space:nowrap; }.history-copy strong { min-height:2.7em; line-height:1.35; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; }.history-copy time { color:var(--muted); font-size:.76rem; }
.history-states { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-top:auto; padding-top:5px; color:var(--muted); font-size:.72rem; }
.history-tag { border-radius:999px; padding:2px 8px; color:var(--muted); background:var(--surface-2); border:1px solid var(--border); }
.history-tag-inherited { color:var(--text); border-color:color-mix(in srgb,var(--accent) 28%,var(--border)); background:color-mix(in srgb,var(--accent) 7%,var(--surface)); }
.history-access { margin-left:auto; color:var(--accent); font-weight:700; }.history-snapshot { margin-left:auto; padding:2px 7px; border:1px dashed var(--border); border-radius:999px; }
.history-empty { text-align:center; padding:52px 20px; border:1px dashed var(--border); border-radius:14px; background:var(--surface); }
.history-empty>span { display:block; font-size:2rem; color:var(--accent); }.history-empty h2 { margin:10px 0 5px; }.history-empty p { color:var(--muted); margin:0 auto 22px; max-width:520px; }
.history-pagination { display:flex; justify-content:space-between; align-items:center; padding:28px 0 0; color:var(--muted); font-size:.84rem; }.history-pagination a { min-width:100px; padding:9px 12px; border:1px solid var(--border); border-radius:9px; color:var(--accent); text-align:center; text-decoration:none; }.history-pagination a[aria-disabled=true] { pointer-events:none; color:var(--muted); opacity:.55; }
@media(max-width:1180px){.history-overview{grid-template-columns:repeat(2,minmax(0,1fr))}.history-filters{grid-template-columns:repeat(3,minmax(0,1fr))}.history-filter-search{grid-column:span 2}}
@media(max-width:760px){.history-main{padding:24px 14px 52px}.history-hero{align-items:flex-start;flex-direction:column}.history-import-link{width:100%;justify-content:center}.history-filters{grid-template-columns:repeat(2,minmax(0,1fr))}.history-filter-search{grid-column:1/-1}.history-filter-actions{grid-column:1/-1}.history-results-heading>span{display:none}}
@media(max-width:480px){.history-overview{grid-template-columns:1fr}.history-filters{grid-template-columns:1fr}.history-filter-search,.history-filter-actions{grid-column:auto}.history-filter-actions{align-items:center}.history-grid{grid-template-columns:1fr}.history-results-heading{align-items:flex-start;flex-direction:column;gap:5px}}
`
