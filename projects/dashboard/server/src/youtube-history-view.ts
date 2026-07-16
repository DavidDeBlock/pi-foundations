import { Hono } from 'hono'
import type { AuthVariables } from './auth.js'
import type { Database } from './db.js'
import { searchWatchHistory, type WatchHistoryEvent } from './youtube-history.js'
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
    const result = searchWatchHistory(deps.db, { page, limit: 50 })
    return c.html(renderPage(result))
  })
  return app
}

function renderPage(result: ReturnType<typeof searchWatchHistory>): string {
  const pages = Math.max(1, Math.ceil(result.total / result.limit))
  const content = result.total === 0
    ? `<section class="history-empty"><span aria-hidden="true">◷</span><h2>No watch history imported</h2><p>Import a Google Takeout <code>watch-history.json</code> file to see your watched videos here.</p><a href="/settings/youtube#watch-history-import">Import watch history</a></section>`
    : `<ol class="history-list">${result.items.map(renderEvent).join('')}</ol>${pagination(result.page, pages)}`
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
      <header class="history-header"><div><span class="page-eyebrow">YouTube library</span><h1>History</h1><p>Your imported watch events, newest first. Replays stay visible as separate moments.</p></div><a class="history-import-link" href="/settings/youtube#watch-history-import">Import history</a></header>
      <section class="history-stats" aria-label="Watch history totals"><div><strong>${result.total}</strong><span>watch events</span></div><div><strong>${result.uniqueVideos}</strong><span>unique videos</span></div></section>
      ${content}
    </main>
  </div>
  ${THEME_SCRIPT_TAG}
  ${HAMBURGER_SCRIPT_TAG}
</body>
</html>`
}

function renderEvent(item: WatchHistoryEvent): string {
  const thumbnail = item.thumbnailUrl
    ? `<img src="${escapeHtml(item.thumbnailUrl)}" alt="" loading="lazy">`
    : '<span class="history-thumb-fallback" aria-hidden="true">▶</span>'
  const title = escapeHtml(item.title)
  const canonicalLink = item.videoId ? `/videos/${encodeURIComponent(item.videoId)}` : null
  const youtubeLink = item.youtubeVideoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(item.youtubeVideoId)}` : null
  const href = canonicalLink ?? youtubeLink
  const repeat = item.watchCount > 1 ? `<span class="history-repeat" title="Watched ${item.watchCount} times">${item.watchCount}× watched</span>` : '<span class="history-watched">Watched</span>'
  const tags = item.tags.map((tag) => `<span class="history-tag${tag.source !== 'manual' ? ' history-tag-inherited' : ''}" title="${tag.source === 'both' ? 'Manual and inherited from subscription' : tag.source === 'subscription' ? 'Inherited from subscription' : 'Manual video tag'}">${tag.source !== 'manual' ? '↳' : '#'}${escapeHtml(tag.name)}</span>`).join('')
  return `<li class="history-event" data-history-event>
    ${href ? `<a class="history-event-link" href="${escapeHtml(href)}"${canonicalLink ? '' : ' target="_blank" rel="noopener noreferrer"'}>` : '<div class="history-event-link">'}
      <span class="history-thumb">${thumbnail}</span>
      <span class="history-copy"><strong>${title}</strong><span class="history-meta">${escapeHtml(item.channelTitle ?? 'Unknown channel')} · <time datetime="${escapeHtml(item.watchedAt)}">${escapeHtml(formatDate(item.watchedAt))}</time></span><span class="history-states">${repeat}${tags}${canonicalLink ? '<span>Open details →</span>' : '<span>Snapshot only</span>'}</span></span>
    ${href ? '</a>' : '</div>'}
  </li>`
}

function pagination(page: number, pages: number): string {
  if (pages <= 1) return ''
  return `<nav class="history-pagination" aria-label="History pages"><a href="/history?page=${Math.max(1, page - 1)}"${page === 1 ? ' aria-disabled="true"' : ''}>Previous</a><span>Page ${page} of ${pages}</span><a href="/history?page=${Math.min(pages, page + 1)}"${page === pages ? ' aria-disabled="true"' : ''}>Next</a></nav>`
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

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const STYLES = `
.layout { display:flex; min-height:calc(100vh - var(--header-h)); }
.history-main { flex:1; min-width:0; padding:24px clamp(12px,4vw,48px) 64px; }
.history-header { display:flex; align-items:flex-end; justify-content:space-between; gap:20px; margin-bottom:22px; }
.history-header h1 { margin:3px 0 5px; font-size:clamp(1.7rem,3vw,2.2rem); }
.history-header p { color:var(--muted); margin:0; }
.history-import-link,.history-empty a { color:var(--accent-text); background:var(--accent); border-radius:9px; padding:10px 14px; text-decoration:none; font-weight:650; white-space:nowrap; }
.history-stats { display:flex; gap:12px; margin-bottom:20px; }
.history-stats div { min-width:140px; padding:14px 16px; border:1px solid var(--border); border-radius:12px; background:var(--surface); box-shadow:var(--shadow); }
.history-stats strong { display:block; font-size:1.35rem; }
.history-stats span { color:var(--muted); font-size:.82rem; }
.history-list { list-style:none; padding:0; margin:0; display:grid; gap:10px; }
.history-event { background:var(--surface); border:1px solid var(--border); border-radius:13px; overflow:hidden; }
.history-event-link { display:flex; gap:14px; padding:12px; color:inherit; text-decoration:none; }
.history-event a:hover { background:color-mix(in srgb,var(--accent) 5%,var(--surface)); }
.history-thumb { width:150px; aspect-ratio:16/9; flex:none; overflow:hidden; border-radius:8px; background:var(--surface-2); display:grid; place-items:center; }
.history-thumb img { width:100%; height:100%; object-fit:cover; }
.history-thumb-fallback { color:var(--muted); font-size:1.4rem; }
.history-copy { min-width:0; display:flex; flex-direction:column; gap:7px; justify-content:center; }
.history-copy strong { line-height:1.35; }
.history-meta { color:var(--muted); font-size:.86rem; }
.history-states { display:flex; gap:8px; flex-wrap:wrap; color:var(--muted); font-size:.78rem; }
.history-watched,.history-repeat { border-radius:999px; padding:2px 8px; color:#34d399; background:color-mix(in srgb,#10b981 12%,transparent); border:1px solid color-mix(in srgb,#10b981 35%,var(--border)); }
.history-tag { border-radius:999px; padding:2px 8px; color:var(--muted); background:var(--surface-2); border:1px solid var(--border); }
.history-tag-inherited { color:var(--text); border-color:color-mix(in srgb,var(--accent) 28%,var(--border)); background:color-mix(in srgb,var(--accent) 7%,var(--surface)); }
.history-empty { text-align:center; padding:52px 20px; border:1px dashed var(--border); border-radius:14px; background:var(--surface); }
.history-empty>span { display:block; font-size:2rem; color:var(--accent); }.history-empty h2 { margin:10px 0 5px; }.history-empty p { color:var(--muted); margin:0 auto 22px; max-width:520px; }
.history-pagination { display:flex; justify-content:space-between; align-items:center; padding:20px 0; color:var(--muted); }.history-pagination a { color:var(--accent); text-decoration:none; }.history-pagination a[aria-disabled=true] { pointer-events:none; color:var(--muted); }
@media(max-width:640px){.history-main{padding:18px 12px 44px}.history-header{align-items:flex-start;flex-direction:column}.history-thumb{width:105px}.history-stats div{min-width:0;flex:1}.history-event-link{gap:10px}}
`
