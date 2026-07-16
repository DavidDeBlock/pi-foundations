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

// ─── Hono sub-app ─────────────────────────────────────────────────────────

export interface YouTubeVideoDetailViewDeps {
  readonly db: Database
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
    return c.html(
      renderPage({ detail, folders, tags, allTags: tags }),
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
})();`
