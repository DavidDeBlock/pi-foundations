// youtube-video-detail-view.ts — issue YT-005
//
// Server-rendered detail page at `/videos/:id`.
//
// Three edit surfaces, all using fetch + DOM patch (no full
// reload) per the AC:
//   1. Title — click → swap to <input> → blur/Enter → PATCH.
//   2. Folder — change the <select data-folder-select> → PATCH.
//   3. Tags — chip × buttons (DELETE) + new-tag input (POST)
//             with autocomplete from a `<script
//             type="application/json">` block (same pattern as
//             v1's categorize.js and the email detail view).
//
// The categorization logic reuses the project-wide
// `TagNormalizer` and the YT-001..YT-004 storage helpers
// (no duplicated normalization). Folder picker dropdown is
// built from `listFoldersAsTree` for visual hierarchy.
//
// Inline JS for the three mutations is a ~120-line IIFE in
// `VIDEO_DETAIL_SCRIPT` (exported so it can be reused in
// other contexts if needed, e.g. the per-channel feed list).

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
import { getVideoDetail, type VideoDetail } from './youtube-videos.js'
import { listAllFoldersWithCounts } from './folders.js'
import { listAllTagsWithUsage } from './tags.js'
import {
  getVideoTranscript,
  type VideoTranscript,
} from './youtube-transcripts.js'
import {
  getVideoSummary,
  type CitedInsight,
  type VideoSummary,
} from './youtube-video-summaries.js'

// ─── Hono sub-app ─────────────────────────────────────────────────────────

export interface YouTubeVideoDetailViewDeps {
  readonly db: Database
  readonly summaryConfigured?: boolean
}

/**
 * Mounted at `/videos`. Adds:
 *   GET /videos/:id  — detail page with edit affordances.
 * 404 when `:id` is unknown.
 */
export function youtubeVideoDetailView(
  deps: YouTubeVideoDetailViewDeps,
): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  api.get('/:id', (c) => {
    const id = c.req.param('id')
    if (!id) return c.text('not found', 404)
    const detail = getVideoDetail(deps.db, id)
    if (detail === null) return c.text('Video not found', 404)
    const folders = listAllFoldersWithCounts(deps.db)
    const tags = listAllTagsWithUsage(deps.db)
    const transcript = getVideoTranscript(deps.db, id)
    const summary = getVideoSummary(deps.db, id)
    return c.html(
      renderPage({
        detail,
        folders,
        tags,
        allTags: tags,
        transcript,
        summary,
        summaryConfigured: deps.summaryConfigured === true,
      }),
    )
  })

  return api
}

// ─── Render ───────────────────────────────────────────────────────────────

interface RenderPageOptions {
  readonly detail: VideoDetail
  readonly folders: ReadonlyArray<{
    readonly id: string
    readonly name: string
  }>
  readonly tags: ReadonlyArray<{ readonly id: string; readonly name: string }>
  readonly allTags: ReadonlyArray<{ readonly id: string; readonly name: string }>
  readonly transcript: VideoTranscript | null
  readonly summary: VideoSummary | null
  readonly summaryConfigured: boolean
}

function renderPage(opts: RenderPageOptions): string {
  const { detail } = opts
  const tagsJson = JSON.stringify(opts.allTags.map((t) => t.name))
  const folderSelect = renderFolderSelect(opts.folders, detail.folderId)
  const tagChips = detail.tags.map((t) => renderTagChip(t, detail.id)).join('')
  return `<!doctype html>
<html lang="en">
<head>
${COMMON_HEAD}
  <title>${escapeHtml(detail.title)} — Dashboard</title>
  <meta name="robots" content="noindex">
  <style>${VIDEO_DETAIL_STYLES}</style>
</head>
<body class="space-youtube-page">
  ${renderHeader()}
  <div class="layout">
    ${renderDetailSidebar({ active: 'videos' })}
    <main class="video-detail-main">
      <nav class="video-detail-breadcrumb"><a href="/videos">\u2190 Back to videos</a></nav>
      <article class="video-detail" data-video-id="${escapeHtml(detail.id)}" data-video-channel="${escapeHtml(detail.channelId)}">
        <header class="video-detail-header">
          <h1 class="video-detail-title" data-video-title-display>
            ${escapeHtml(detail.title)}
          </h1>
          <button type="button" class="video-detail-edit-btn" data-edit-video-title title="Rename this video">Edit</button>
          <dl class="video-detail-meta">
            <dt>Channel</dt>
            <dd>
              <a href="/subscriptions?channel_id=${encodeURIComponent(detail.channelId)}" data-video-channel-link>${escapeHtml(detail.channelTitle)}</a>
              ${detail.channelIsIncluded
                ? ''
                : '<span class="video-detail-channel-flag">channel is excluded from polling</span>'}
            </dd>
            <dt>Published</dt>
            <dd><time datetime="${escapeHtml(detail.publishedAt)}">${escapeHtml(formatDateFull(detail.publishedAt))}</time></dd>
            <dt>Discovered</dt>
            <dd><time datetime="${escapeHtml(detail.discoveredAt)}">${escapeHtml(formatDateFull(detail.discoveredAt))}</time></dd>
            <dt>Watch</dt>
            <dd><a href="${escapeHtml(detail.link)}" target="_blank" rel="noopener noreferrer">Open on YouTube \u2197</a></dd>
          </dl>
        </header>

        <section class="video-detail-thumb">
          ${detail.thumbnailUrl
            ? `<a href="${escapeHtml(detail.link)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(detail.thumbnailUrl)}" alt="" loading="lazy"></a>`
            : '<div class="video-detail-thumb-fallback" aria-hidden="true"></div>'}
        </section>

        <section class="video-detail-folder">
          <h2>Folder</h2>
          ${folderSelect}
          <p class="video-detail-folder-status" data-video-folder-status></p>
        </section>

        <section class="video-detail-tags">
          <h2>Tags</h2>
          <div class="video-detail-tag-list" data-video-tag-list>
            ${tagChips}
            <input type="text" class="video-detail-tag-input" data-video-tag-input
                   placeholder="Add a tag\u2026" list="video-all-tags-list"
                   autocomplete="off" />
            <button type="button" class="video-detail-tag-add" data-video-tag-add>Add</button>
          </div>
          <datalist id="video-all-tags-list"></datalist>
          <p class="video-detail-tag-status" data-video-tag-status></p>
        </section>

        ${renderSummarySection(detail, opts.transcript, opts.summary, opts.summaryConfigured)}
        ${renderTranscriptSection(detail, opts.transcript)}
      </article>
    </main>
  </div>
  ${THEME_SCRIPT_TAG}
  ${HAMBURGER_SCRIPT_TAG}
  <script type="application/json" id="video-all-tags" data-video-all-tags>${tagsJson}</script>
  <script>${VIDEO_DETAIL_SCRIPT}</script>
</body>
</html>`
}

function renderSummarySection(
  detail: VideoDetail,
  transcript: VideoTranscript | null,
  summary: VideoSummary | null,
  configured: boolean,
): string {
  let content: string
  if (!configured) {
    content = `<div class="video-ai-empty">
      <p>Add <code>LLM_API_KEY</code> to <code>server/.env</code> and restart the dashboard to enable MiniMax summaries.</p>
    </div>`
  } else if (summary?.status === 'ready') {
    const points = summary.keyPoints.map((item) => renderCitedInsight(detail, item)).join('')
    const actions = summary.actionItems.length > 0
      ? `<div class="video-ai-block"><h3>Action items</h3><ul>${summary.actionItems.map((item) => renderCitedInsight(detail, item)).join('')}</ul></div>`
      : ''
    const mentioned = summary.mentioned.length > 0
      ? `<div class="video-ai-mentioned">${summary.mentioned.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>`
      : ''
    content = `<div class="video-ai-ready">
      <div class="video-ai-tldr"><span>TL;DR</span><p>${escapeHtml(summary.tldr ?? '')}</p></div>
      <div class="video-ai-block"><h3>Key takeaways</h3><ul>${points}</ul></div>
      <div class="video-ai-block"><h3>Why watch the full video?</h3><p>${escapeHtml(summary.worthWatching ?? '')}</p></div>
      ${actions}
      ${mentioned}
      <div class="video-ai-footer"><span>Generated with ${escapeHtml(summary.model)}</span><button type="button" class="video-ai-link-button" data-summarize-video data-force="true">Regenerate</button></div>
    </div>`
  } else if (summary?.status === 'pending') {
    content = `<div class="video-ai-working"><span class="video-ai-spark" aria-hidden="true">✦</span><div><strong>Building your Insight Card…</strong><p>MiniMax is reading the timed transcript in the background.</p></div></div>`
  } else if (summary?.status === 'failed') {
    content = `<div class="video-ai-empty"><p>The Insight Card could not be generated. You can safely retry without fetching the transcript again.</p><button type="button" class="primary-button" data-summarize-video>Try again</button></div>`
  } else if (transcript?.status !== 'ready') {
    content = `<div class="video-ai-empty"><p>Fetch the transcript first, then MiniMax can turn it into a short, timestamped briefing.</p></div>`
  } else {
    content = `<div class="video-ai-empty"><p>Turn this transcript into a concise briefing with key points, action items, and links to the exact moments.</p><button type="button" class="primary-button" data-summarize-video>Summarize with MiniMax</button></div>`
  }

  return `<section class="video-ai-card" data-video-summary data-summary-status="${summary?.status ?? 'not_requested'}">
    <div class="video-ai-heading"><div class="video-ai-icon" aria-hidden="true">✦</div><div><span class="video-ai-eyebrow">AI insight</span><h2>Video briefing</h2></div></div>
    <div data-summary-content>${content}</div>
    <p class="video-ai-feedback" data-summary-feedback aria-live="polite"></p>
  </section>`
}

function renderCitedInsight(detail: VideoDetail, insight: CitedInsight): string {
  const citation = insight.startMs === null
    ? ''
    : `<a href="https://www.youtube.com/watch?v=${encodeURIComponent(detail.videoId)}&amp;t=${Math.floor(insight.startMs / 1000)}s" target="_blank" rel="noopener noreferrer">${formatTimestamp(insight.startMs)}</a>`
  return `<li><span>${escapeHtml(insight.text)}</span>${citation}</li>`
}

function renderTranscriptSection(
  detail: VideoDetail,
  transcript: VideoTranscript | null,
): string {
  const status = transcript?.status ?? 'not_requested'
  let content: string
  if (transcript?.status === 'ready') {
    const language = transcript.language
      ? `<span class="video-transcript-language">${escapeHtml(transcript.language)}</span>`
      : ''
    const rows = transcript.segments.map((segment) => {
      const seconds = Math.floor(segment.startMs / 1000)
      return `<li class="video-transcript-segment">
        <a class="video-transcript-time" href="https://www.youtube.com/watch?v=${encodeURIComponent(detail.videoId)}&amp;t=${seconds}s" target="_blank" rel="noopener noreferrer">${formatTimestamp(segment.startMs)}</a>
        <span>${escapeHtml(segment.text)}</span>
      </li>`
    }).join('')
    content = `<div class="video-transcript-ready">
      <div class="video-transcript-summary"><strong>Transcript ready</strong>${language}</div>
      <ol class="video-transcript-segments">${rows}</ol>
    </div>`
  } else if (transcript?.status === 'pending') {
    content = `<p class="video-transcript-state">Fetching captions in the background…</p>`
  } else if (transcript?.status === 'unavailable') {
    content = `<p class="video-transcript-state">No captions are currently available for this video.</p>
      <button type="button" class="primary-button" data-fetch-transcript>Try again</button>`
  } else if (transcript?.status === 'failed') {
    content = `<p class="video-transcript-state">The transcript could not be fetched. YouTube caption access can fail temporarily.</p>
      <button type="button" class="primary-button" data-fetch-transcript>Try again</button>`
  } else {
    content = `<p class="video-transcript-state">Fetch this video’s captions when you need them.</p>
      <button type="button" class="primary-button" data-fetch-transcript>Fetch transcript</button>`
  }
  return `<section class="video-detail-transcript" data-video-transcript data-transcript-status="${status}">
    <div class="video-transcript-heading">
      <div><h2>Transcript</h2><p>Timed captions stored locally for reading and future summaries.</p></div>
    </div>
    <div data-transcript-content>${content}</div>
    <p class="video-transcript-feedback" data-transcript-feedback aria-live="polite"></p>
  </section>`
}

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

function renderFolderSelect(
  folders: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  currentId: string | null,
): string {
  // If the current folder id isn't in the visible list (it might
  // have been deleted while this view was open), surface it as a
  // disabled placeholder so the operator sees what was last
  // assigned without being misled about it still being valid.
  if (
    currentId !== null &&
    !folders.some((f) => f.id === currentId)
  ) {
    return `<select class="video-detail-folder-select" data-video-folder-select disabled>
      <option value="" selected>(folder deleted)</option>
    </select>`
  }
  const noFolderSelected = currentId === null ? ' selected' : ''
  const opts = [`<option value="" data-video-folder-placeholder${noFolderSelected}>(none — uncategorized)</option>`]
  for (const f of folders) {
    const sel = f.id === currentId ? ' selected' : ''
    opts.push(
      `<option value="${escapeHtml(f.id)}"${sel}>${escapeHtml(f.name)}</option>`,
    )
  }
  return `<select class="video-detail-folder-select" data-video-folder-select>${opts.join('')}</select>`
}

function renderTagChip(
  tag: { readonly id: string; readonly name: string },
  _videoId: string,
): string {
  return `<span class="video-detail-tag" data-video-tag data-tag-id="${escapeHtml(tag.id)}" data-tag-name="${escapeHtml(tag.name)}">
    ${escapeHtml(tag.name)}
    <button type="button" class="video-detail-tag-x" data-video-tag-remove data-tag-id="${escapeHtml(tag.id)}" aria-label="Remove tag ${escapeHtml(tag.name)}">\u00d7</button>
  </span>`
}

function renderDetailSidebar(opts: { active: 'videos' | 'subscriptions' | 'settings' }): string {
  const context = opts.active === 'subscriptions' ? 'subscriptions' : 'videos'
  return `<aside class="sidebar" data-sidebar>
  ${renderAppNavigation({ active: 'youtube', context })}
  ${renderSidebarFooter('YouTube · video library')}
</aside>`
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatDateFull(iso: string): string {
  try {
    return new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')
  } catch {
    return iso
  }
}

// ─── Stylesheet ───────────────────────────────────────────────────────────

const VIDEO_DETAIL_STYLES = `
.layout { display: flex; min-height: calc(100vh - var(--header-h)); }
.video-detail-main { flex: 1; padding: 24px clamp(12px, 4vw, 48px); max-width: 980px; }
.video-detail-breadcrumb { margin: 0 0 16px; font-size: 0.9rem; }
.video-detail-breadcrumb a { color: var(--accent); text-decoration: none; }
.video-detail { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: clamp(18px, 4vw, 30px); box-shadow: var(--shadow); }
.video-detail-header { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-bottom: 16px; align-items: start; }
.video-detail-title { margin: 0; font-size: 1.4rem; line-height: 1.3; }
.video-detail-title-input { width: 100%; font-size: 1.4rem; font-weight: 600; padding: 6px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--text); }
.video-detail-edit-btn { padding: 4px 10px; border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 4px; cursor: pointer; }
.video-detail-edit-btn:hover { background: var(--surface-2, rgba(127,127,127,0.07)); }
.video-detail-meta { display: grid; grid-template-columns: 100px 1fr; row-gap: 6px; column-gap: 12px; margin: 16px 0 0; font-size: 0.92rem; }
.video-detail-meta dt { color: var(--muted); }
.video-detail-meta dd { margin: 0; color: var(--text); }
.video-detail-meta a { color: var(--accent); text-decoration: none; }
.video-detail-channel-flag { display: inline-block; margin-left: 8px; padding: 2px 6px; background: var(--surface-2, rgba(127,127,127,0.1)); color: var(--muted); border-radius: 4px; font-size: 0.78rem; }
.video-detail-thumb { margin: 16px 0 24px; }
.video-detail-thumb img { width: 100%; max-width: 560px; aspect-ratio: 16/9; object-fit: cover; border-radius: 12px; box-shadow: 0 14px 35px rgba(3,8,20,.24); }
.video-detail-thumb-fallback { width: 100%; max-width: 480px; aspect-ratio: 16/9; background: var(--surface-2, rgba(127,127,127,0.1)); border-radius: 6px; }
.video-detail-folder h2, .video-detail-tags h2 { margin: 24px 0 8px; font-size: 1rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.video-detail-folder-select { padding: 6px 10px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--text); font: inherit; min-width: 240px; }
.video-detail-folder-status { margin: 4px 0 0; font-size: 0.85rem; color: var(--muted); }
.video-detail-folder-status.saved-flash { color: var(--accent); }
.video-detail-folder-status.error-flash { color: var(--danger); }
.video-detail-tag-list { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.video-detail-tag { display: inline-flex; align-items: center; gap: 4px; padding: 4px 6px 4px 10px; background: var(--surface-2, rgba(127,127,127,0.1)); color: var(--text); border-radius: 4px; font-size: 0.92rem; }
.video-detail-tag-x { background: transparent; border: 0; cursor: pointer; color: var(--muted); font-size: 1rem; padding: 0 4px; }
.video-detail-tag-x:hover { color: var(--danger); }
.video-detail-tag-input { padding: 6px 10px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--text); font: inherit; min-width: 160px; }
.video-detail-tag-add { padding: 6px 12px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--text); cursor: pointer; }
.video-detail-tag-status { margin: 4px 0 0; font-size: 0.85rem; color: var(--muted); }
.video-detail-tag-status.saved-flash { color: var(--accent); }
.video-detail-tag-status.error-flash { color: var(--danger); }
.video-ai-card { position: relative; overflow: hidden; margin-top: 30px; padding: clamp(18px, 3vw, 26px); border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--border)); border-radius: 16px; background: linear-gradient(145deg, color-mix(in srgb, var(--accent) 10%, var(--surface)), color-mix(in srgb, #a855f7 7%, var(--surface))); }
.video-ai-card::after { content: ''; position: absolute; width: 170px; height: 170px; right: -85px; top: -100px; border-radius: 50%; background: color-mix(in srgb, var(--accent) 18%, transparent); filter: blur(28px); pointer-events: none; }
.video-ai-heading { position: relative; z-index: 1; display: flex; align-items: center; gap: 11px; margin-bottom: 18px; }
.video-ai-icon { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 11px; color: white; background: linear-gradient(135deg, var(--accent), #a855f7); box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 28%, transparent); }
.video-ai-eyebrow { display: block; color: var(--accent); font-size: .7rem; font-weight: 750; text-transform: uppercase; letter-spacing: .12em; }
.video-ai-heading h2 { margin: 2px 0 0; font-size: 1.1rem; }
.video-ai-empty { position: relative; z-index: 1; }
.video-ai-empty p { max-width: 680px; margin: 0 0 14px; color: var(--muted); line-height: 1.55; }
.video-ai-empty code { color: var(--text); font-size: .85em; }
.video-ai-tldr { padding: 16px 18px; border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border)); border-radius: 12px; background: color-mix(in srgb, var(--surface) 82%, transparent); }
.video-ai-tldr > span { color: var(--accent); font-size: .7rem; font-weight: 800; letter-spacing: .11em; }
.video-ai-tldr p { margin: 7px 0 0; font-size: 1.02rem; line-height: 1.58; }
.video-ai-block { margin-top: 19px; }
.video-ai-block h3 { margin: 0 0 9px; font-size: .79rem; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
.video-ai-block p { margin: 0; line-height: 1.55; }
.video-ai-block ul { list-style: none; display: grid; gap: 9px; margin: 0; padding: 0; }
.video-ai-block li { display: grid; grid-template-columns: 1fr auto; gap: 14px; align-items: baseline; line-height: 1.48; }
.video-ai-block li::before { content: '•'; color: var(--accent); position: absolute; }
.video-ai-block li > span { padding-left: 14px; }
.video-ai-block li a { color: var(--accent); text-decoration: none; font-size: .78rem; font-variant-numeric: tabular-nums; }
.video-ai-mentioned { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 19px; }
.video-ai-mentioned span { padding: 4px 9px; border-radius: 999px; border: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 76%, transparent); color: var(--muted); font-size: .77rem; }
.video-ai-footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 20px; padding-top: 13px; border-top: 1px solid color-mix(in srgb, var(--accent) 14%, var(--border)); color: var(--muted); font-size: .75rem; }
.video-ai-link-button { border: 0; padding: 3px; color: var(--accent); background: transparent; cursor: pointer; font: inherit; }
.video-ai-working { display: flex; gap: 12px; align-items: center; }
.video-ai-working .video-ai-spark { color: var(--accent); font-size: 1.4rem; animation: ai-pulse 1.3s ease-in-out infinite; }
.video-ai-working strong { display: block; }
.video-ai-working p { margin: 3px 0 0; color: var(--muted); font-size: .88rem; }
.video-ai-feedback { min-height: 1.15em; margin: 10px 0 0; color: var(--muted); font-size: .82rem; }
.video-ai-feedback.error-flash { color: var(--danger); }
@keyframes ai-pulse { 50% { opacity: .4; transform: scale(.85) rotate(18deg); } }
.video-detail-transcript { margin-top: 28px; padding-top: 24px; border-top: 1px solid var(--border); }
.video-transcript-heading h2 { margin: 0; font-size: 1.05rem; }
.video-transcript-heading p { margin: 4px 0 16px; color: var(--muted); font-size: .88rem; }
.video-transcript-state { margin: 0 0 12px; color: var(--muted); }
.video-transcript-summary { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.video-transcript-language { padding: 2px 7px; border-radius: 999px; background: var(--surface-2, rgba(127,127,127,.1)); color: var(--muted); font-size: .75rem; text-transform: uppercase; }
.video-transcript-segments { list-style: none; margin: 0; padding: 4px 0; max-height: 520px; overflow: auto; display: grid; gap: 2px; }
.video-transcript-segment { display: grid; grid-template-columns: 52px 1fr; gap: 10px; padding: 7px 8px; border-radius: 7px; line-height: 1.45; }
.video-transcript-segment:hover { background: var(--surface-2, rgba(127,127,127,.07)); }
.video-transcript-time { color: var(--accent); font-variant-numeric: tabular-nums; text-decoration: none; font-size: .82rem; padding-top: 2px; }
.video-transcript-feedback { min-height: 1.2em; margin: 8px 0 0; color: var(--muted); font-size: .84rem; }
.video-transcript-feedback.error-flash { color: var(--danger); }
@media (max-width: 720px) {
  .video-detail-header { grid-template-columns: 1fr; }
  .video-detail-edit-btn { justify-self: start; }
}
`

// ─── Inline JS ────────────────────────────────────────────────────────────

export const VIDEO_DETAIL_SCRIPT = `(function(){
  var article = document.querySelector('[data-video-id]');
  if (!article) return;
  var videoId = article.getAttribute('data-video-id');
  if (!videoId) return;

  // ── Status helper ─────────────────────────────────────────────
  // Flashes success/error in the given status element for 2.5s.
  // Matches v1 categorize.js's flashStatus so the UI behaves the same.
  function flashStatus(el, msg, ok){
    if (!el) return;
    el.textContent = msg;
    el.className = ok ? 'saved-flash' : 'error-flash';
    if (el._flashTimer) clearTimeout(el._flashTimer);
    el._flashTimer = setTimeout(function(){
      el.textContent = '';
      el.className = '';
    }, 2500);
  }

  // ── Datalist population ───────────────────────────────────────
  // Populate the autocomplete with the existing tag names rendered
  // into the inline JSON block. Same pattern as email-view's
  // EMAIL_TAG_SCRIPT — server hands us everything we need; no
  // extra round-trip on page load.
  var dl = document.getElementById('video-all-tags-list');
  var jsonEl = document.getElementById('video-all-tags');
  if (dl && jsonEl) {
    try {
      var tags = JSON.parse(jsonEl.textContent || '[]');
      for (var i = 0; i < tags.length; i++) {
        var opt = document.createElement('option');
        opt.value = tags[i];
        dl.appendChild(opt);
      }
    } catch (e) {
      // Bad JSON in the inline block — leave the datalist empty.
      // The input still works for creating new tags.
    }
  }

  // ── Title edit ────────────────────────────────────────────────
  // Click Edit → swap display for an input → save on Enter or blur,
  // revert on Escape. Server is source of truth — the response body
  // becomes the new display, in case the server normalized something.
  var titleDisplay = article.querySelector('[data-video-title-display]');
  var editBtn = article.querySelector('[data-edit-video-title]');
  if (editBtn && titleDisplay) {
    editBtn.addEventListener('click', function(){
      var original = titleDisplay.textContent || '';
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'video-detail-title-input';
      input.value = original;
      titleDisplay.replaceWith(input);
      input.focus();
      input.select();
      var done = false;
      function commit(){
        if (done) return;
        done = true;
        var newVal = input.value.trim();
        if (newVal === '' || newVal === original) {
          // Empty / unchanged → revert silently.
          input.replaceWith(titleDisplay);
          return;
        }
        fetch('/api/videos/' + encodeURIComponent(videoId), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ title: newVal }),
        })
          .then(function(res){ return res.json().then(function(j){ return { res: res, json: j }; }); })
          .then(function(pair){
            if (pair.res.ok && pair.json.title) {
              titleDisplay.textContent = pair.json.title;
              input.replaceWith(titleDisplay);
            } else {
              throw new Error((pair.json && pair.json.error) || ('HTTP ' + pair.res.status));
            }
          })
          .catch(function(err){
            input.replaceWith(titleDisplay);
            alert('Failed to save title: ' + err.message);
          });
      }
      function cancel(){
        if (done) return;
        done = true;
        input.replaceWith(titleDisplay);
      }
      input.addEventListener('keydown', function(ev){
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
      });
      input.addEventListener('blur', function(){
        if (!done) commit();
      });
    });
  }

  // ── Folder picker ─────────────────────────────────────────────
  // Change the select → PATCH → flash status.
  // Matches the v1 categorize.js folder change handler.
  var folderSelect = article.querySelector('[data-video-folder-select]');
  var folderStatus = article.querySelector('[data-video-folder-status]');
  if (folderSelect) {
    folderSelect.addEventListener('change', function(){
      // "" = unfolder; anything else = folder id.
      var raw = folderSelect.value;
      var folderId = raw === '' ? null : raw;
      folderSelect.disabled = true;
      fetch('/api/videos/' + encodeURIComponent(videoId), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ folder_id: folderId }),
      })
        .then(function(res){ return res.json().then(function(j){ return { res: res, json: j }; }); })
        .then(function(pair){
          if (!pair.res.ok) {
            throw new Error((pair.json && pair.json.error) || ('HTTP ' + pair.res.status));
          }
          folderSelect.disabled = false;
          flashStatus(folderStatus, 'moved', true);
        })
        .catch(function(err){
          folderSelect.disabled = false;
          flashStatus(folderStatus, err.message || 'failed', false);
        });
    });
  }

  // ── Tag add ───────────────────────────────────────────────────
  var tagInput = article.querySelector('[data-video-tag-input]');
  var tagAdd = article.querySelector('[data-video-tag-add]');
  var tagStatus = article.querySelector('[data-video-tag-status]');
  function addTag(){
    if (!tagInput) return;
    var raw = (tagInput.value || '').trim();
    if (!raw) {
      flashStatus(tagStatus, 'Type a tag first.', false);
      return;
    }
    if (tagAdd) tagAdd.disabled = true;
    flashStatus(tagStatus, '', true);
    fetch('/api/videos/' + encodeURIComponent(videoId) + '/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name: raw }),
    })
      .then(function(res){ return res.json().then(function(j){ return { res: res, json: j }; }); })
      .then(function(pair){
        if (tagAdd) tagAdd.disabled = false;
        if (pair.res.status === 401) { window.location.href = '/api/login'; return; }
        if (!pair.res.ok) {
          throw new Error((pair.json && pair.json.error) || ('HTTP ' + pair.res.status));
        }
        // Insert a fresh chip for the canonical-form tag. Avoid
        // duplicating if the chip was already on screen.
        var name = pair.json.name || raw;
        var tagId = pair.json.id;
        var list = article.querySelector('[data-video-tag-list]');
        if (list && tagId) {
          if (!list.querySelector('[data-tag-id="' + tagId + '"]')) {
            var inputEl = tagInput;
            var addBtn = tagAdd;
            var span = document.createElement('span');
            span.className = 'video-detail-tag';
            span.setAttribute('data-video-tag', '');
            span.setAttribute('data-tag-id', tagId);
            span.setAttribute('data-tag-name', name);
            span.appendChild(document.createTextNode(name + ' '));
            var x = document.createElement('button');
            x.type = 'button';
            x.className = 'video-detail-tag-x';
            x.setAttribute('data-video-tag-remove', '');
            x.setAttribute('data-tag-id', tagId);
            x.setAttribute('aria-label', 'Remove tag ' + name);
            x.textContent = '\\u00d7';
            span.appendChild(x);
            list.insertBefore(span, inputEl);
            if (addBtn) list.insertBefore(addBtn, inputEl.nextSibling);
          }
        }
        if (tagInput) tagInput.value = '';
        flashStatus(tagStatus, 'tag added', true);
      })
      .catch(function(err){
        if (tagAdd) tagAdd.disabled = false;
        flashStatus(tagStatus, err.message || 'failed', false);
      });
  }
  if (tagAdd) tagAdd.addEventListener('click', function(ev){ ev.preventDefault(); addTag(); });
  if (tagInput) tagInput.addEventListener('keydown', function(ev){
    if (ev.key === 'Enter') { ev.preventDefault(); addTag(); }
  });

  // ── Tag remove (× on each chip) ───────────────────────────────
  // Matches v1 categorize.js's tag-remove handler: optimistic
  // removal with restore on failure.
  var tagList = article.querySelector('[data-video-tag-list]');
  if (tagList) {
    tagList.addEventListener('click', function(ev){
      var x = ev.target.closest && ev.target.closest('[data-video-tag-remove]');
      if (!x) return;
      ev.preventDefault();
      var tagId = x.getAttribute('data-tag-id');
      if (!tagId) return;
      var chip = x.closest('[data-video-tag]');
      if (!chip) return;
      x.disabled = true;
      fetch('/api/videos/' + encodeURIComponent(videoId) + '/tags/' + encodeURIComponent(tagId), {
        method: 'DELETE',
        credentials: 'same-origin',
      })
        .then(function(res){
          if (res.status === 401) { window.location.href = '/api/login'; return; }
          if (!res.ok && res.status !== 204) {
            throw new Error('HTTP ' + res.status);
          }
          chip.remove();
          flashStatus(tagStatus, 'tag removed', true);
        })
        .catch(function(err){
          x.disabled = false;
          flashStatus(tagStatus, err.message || 'failed', false);
        });
    });
  }

  // ── Transcript request + status polling ──────────────────────
  var transcript = article.querySelector('[data-video-transcript]');
  var transcriptButton = transcript && transcript.querySelector('[data-fetch-transcript]');
  var transcriptFeedback = transcript && transcript.querySelector('[data-transcript-feedback]');
  var pollAttempts = 0;
  function pollTranscript(){
    pollAttempts++;
    fetch('/api/videos/' + encodeURIComponent(videoId) + '/transcript', {
      credentials: 'same-origin',
    })
      .then(function(res){
        if (res.status === 401) { window.location.href = '/api/login'; return null; }
        return res.json().then(function(json){ return { res: res, json: json }; });
      })
      .then(function(pair){
        if (!pair) return;
        if (!pair.res.ok) throw new Error(pair.json.error || ('HTTP ' + pair.res.status));
        var value = pair.json.transcript;
        if (value && value.status === 'pending' && pollAttempts < 40) {
          if (transcriptFeedback) transcriptFeedback.textContent = 'Fetching captions in the background\u2026';
          setTimeout(pollTranscript, 1500);
          return;
        }
        // The server-rendered view owns ready/error markup. Reload once
        // the worker reaches a terminal state so there is one renderer.
        if (value && value.status !== 'pending') window.location.reload();
        else if (transcriptFeedback) transcriptFeedback.textContent = 'Still working. You can leave this page and return later.';
      })
      .catch(function(err){
        if (transcriptFeedback) {
          transcriptFeedback.textContent = err.message || 'Failed to check transcript status.';
          transcriptFeedback.className = 'video-transcript-feedback error-flash';
        }
      });
  }
  if (transcriptButton) {
    transcriptButton.addEventListener('click', function(){
      transcriptButton.disabled = true;
      if (transcriptFeedback) transcriptFeedback.textContent = 'Adding transcript to the queue\u2026';
      fetch('/api/videos/' + encodeURIComponent(videoId) + '/transcript', {
        method: 'POST',
        credentials: 'same-origin',
      })
        .then(function(res){
          if (res.status === 401) { window.location.href = '/api/login'; return null; }
          return res.json().then(function(json){ return { res: res, json: json }; });
        })
        .then(function(pair){
          if (!pair) return;
          if (!pair.res.ok) throw new Error(pair.json.error || ('HTTP ' + pair.res.status));
          if (pair.json.transcript && pair.json.transcript.status === 'ready') {
            window.location.reload();
            return;
          }
          pollAttempts = 0;
          pollTranscript();
        })
        .catch(function(err){
          transcriptButton.disabled = false;
          if (transcriptFeedback) {
            transcriptFeedback.textContent = err.message || 'Failed to request transcript.';
            transcriptFeedback.className = 'video-transcript-feedback error-flash';
          }
        });
    });
  } else if (transcript && transcript.getAttribute('data-transcript-status') === 'pending') {
    pollTranscript();
  }

  // ── AI Insight Card request + status polling ────────────────
  var summary = article.querySelector('[data-video-summary]');
  var summaryButton = summary && summary.querySelector('[data-summarize-video]');
  var summaryFeedback = summary && summary.querySelector('[data-summary-feedback]');
  var summaryPollAttempts = 0;
  function pollSummary(){
    summaryPollAttempts++;
    fetch('/api/videos/' + encodeURIComponent(videoId) + '/summary', { credentials: 'same-origin' })
      .then(function(res){
        if (res.status === 401) { window.location.href = '/api/login'; return null; }
        return res.json().then(function(json){ return { res: res, json: json }; });
      })
      .then(function(pair){
        if (!pair) return;
        if (!pair.res.ok) throw new Error(pair.json.error || ('HTTP ' + pair.res.status));
        var value = pair.json.summary;
        if (value && value.status === 'pending' && summaryPollAttempts < 80) {
          if (summaryFeedback) summaryFeedback.textContent = 'MiniMax is building the briefing…';
          setTimeout(pollSummary, 1500);
          return;
        }
        if (value && value.status !== 'pending') window.location.reload();
        else if (summaryFeedback) summaryFeedback.textContent = 'Still working. You can leave this page and return later.';
      })
      .catch(function(err){
        if (summaryFeedback) {
          summaryFeedback.textContent = err.message || 'Failed to check summary status.';
          summaryFeedback.className = 'video-ai-feedback error-flash';
        }
      });
  }
  if (summaryButton) {
    summaryButton.addEventListener('click', function(){
      summaryButton.disabled = true;
      if (summaryFeedback) summaryFeedback.textContent = 'Adding the Insight Card to the queue…';
      var force = summaryButton.getAttribute('data-force') === 'true';
      fetch('/api/videos/' + encodeURIComponent(videoId) + '/summary', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: force }),
      })
        .then(function(res){
          if (res.status === 401) { window.location.href = '/api/login'; return null; }
          return res.json().then(function(json){ return { res: res, json: json }; });
        })
        .then(function(pair){
          if (!pair) return;
          if (!pair.res.ok) throw new Error(pair.json.error || ('HTTP ' + pair.res.status));
          if (pair.json.summary && pair.json.summary.status === 'ready') { window.location.reload(); return; }
          summaryPollAttempts = 0;
          pollSummary();
        })
        .catch(function(err){
          summaryButton.disabled = false;
          if (summaryFeedback) {
            var message = err.message === 'transcript_required' ? 'Fetch the transcript first.' : err.message;
            summaryFeedback.textContent = message || 'Failed to request summary.';
            summaryFeedback.className = 'video-ai-feedback error-flash';
          }
        });
    });
  } else if (summary && summary.getAttribute('data-summary-status') === 'pending') {
    pollSummary();
  }
})();`
