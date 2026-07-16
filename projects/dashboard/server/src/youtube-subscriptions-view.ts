// youtube-subscriptions-view.ts — issue YT-003
//
// Server-rendered HTML for `/subscriptions`. The page renders
// the channel list + filter chips + search + sync-now button +
// inline toggles. Behavior on top:
//
//   * `PATCH /api/subscriptions/:id` fires from the toggle's
//     onchange handler — server-confirmed, then DOM-patched
//     (no full page reload) so the operator gets instant
//     feedback. Matches the v1 "categorize UI" pattern (PRD-001
//     §"what makes a good test").
//
//   * "Sync now" posts to `/api/youtube/sync` (YT-002) and
//     renders the count summary in an inline banner —
//     `+added ~updated -removed =unchanged` — without leaving
//     the page. Errors (no account, 500) flash in the same
//     banner.
//
//   * Filter chips + search box are plain `<a>` + `<form>`
//     elements that round-trip the URL. No SPA, no client-side
//     state to lose on reload; deep-links work.
//
// The page is NOT mounted when YouTube deps are absent (setup-
// only mode). The empty-state copy on a freshly-installed
// dashboard reads "No subscriptions yet — connect YouTube to
// import them" with a button to `/api/youtube/oauth/start`.
//
// Styling: a single CSS block (scoped to this page's classes)
// inherits `--text`, `--muted`, `--surface`, `--border`,
// `--accent`, etc. from `/static/styles.css`. Dark mode +
// sidebar toggle + theme toggle + hamburger come for free
// because the layout reuses `renderHeader`.

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
  searchSubscriptions,
  countIncludedExcluded,
  type Subscription,
  type SubscriptionFilter,
} from './youtube-subscriptions.js'

// ─── Hono sub-app ─────────────────────────────────────────────────────────

export interface SubscriptionsViewDeps {
  readonly db: Database
}

/** Mounted at `/subscriptions`. The list is the only route in
 *  v3.0 — there is no per-subscription detail page (the toggle
 *  controls live on the row). A future "videos per channel"
 *  filter (YT-005) can extend this without a separate file. */
export function subscriptionsViewApi(
  deps: SubscriptionsViewDeps,
): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  api.get('/', (c) => {
    const filter = parseFilter(c.req.query('filter'))
    const search = (c.req.query('search') ?? '').trim()
    const page = parsePositiveInt(c.req.query('page')) ?? 1
    const limit = parsePositiveInt(c.req.query('limit')) ?? 50

    const result = searchSubscriptions(deps.db, { filter, search, page, limit })
    const counts = countIncludedExcluded(deps.db)
    return c.html(
      renderPage({
        items: result.items,
        total: result.total,
        page: result.page,
        limit: result.limit,
        filter: result.invalidFilter !== null ? 'all' : filter,
        search,
        counts,
      }),
    )
  })

  return api
}

// ─── Query-param parsing ──────────────────────────────────────────────────

function parseFilter(raw: string | undefined): SubscriptionFilter {
  if (raw === 'included' || raw === 'excluded' || raw === 'all') return raw
  return 'all'
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  return Math.floor(n)
}

// ─── Render ───────────────────────────────────────────────────────────────

interface RenderArgs {
  readonly items: readonly Subscription[]
  readonly total: number
  readonly page: number
  readonly limit: number
  readonly filter: SubscriptionFilter
  readonly search: string
  readonly counts: { readonly included: number; readonly excluded: number }
}

function renderPage(args: RenderArgs): string {
  return `<!doctype html>
<html lang="en">
  <head>
${COMMON_HEAD}
    <title>Subscriptions — Dashboard</title>
    <meta name="robots" content="noindex">
    <style>${STYLES}</style>
  </head>
  <body>
    ${renderHeader({ showSearch: false })}
    <div class="layout">
      ${renderSidebar({ active: 'subscriptions' })}
      <main class="subscriptions-main">
        <header class="page-heading">
          <span class="page-eyebrow">YouTube</span>
          <h1>Subscriptions</h1>
          <p>Import every channel you subscribe to on YouTube, drop the music channels from this dashboard, and prepare the list for the morning briefing.</p>
        </header>
        <nav class="subscriptions-tabs" aria-label="YouTube sections">
          <a class="subscriptions-tab subscriptions-tab-active" href="/subscriptions" aria-current="page">Subscriptions</a>
          <a class="subscriptions-tab" href="/settings/youtube">Settings</a>
        </nav>
        ${renderToolbar(args)}
        ${renderCountsLine(args.counts)}
        <div data-sync-banner-slot></div>
        ${args.items.length === 0
          ? renderEmpty(args)
          : `<ul class="subscriptions-list" data-subscriptions-list>${args.items.map(renderRow).join('')}</ul>`}
        ${renderPagination(args)}
      </main>
    </div>
    <script>${SUBSCRIPTIONS_PAGE_SCRIPT}</script>
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
  </body>
</html>`
}

function renderSidebar(_args: { readonly active: 'subscriptions' }): string {
  // Lightweight sidebar mirroring the home page's top sections.
  // No folder tree here — the subscriptions page has no folders
  // (folders belong to bookmarks). Bookmarks + Email + YouTube
  // sections, with "Subscriptions" active under YouTube. (Videos
  // gets its own active class on the `/videos` route.)
  const bookmarksActive = ''
  const emailActive = ''
  const videosActive = ''
  const subscriptionsActive = ' compartment-button-active'
  return `<aside class="sidebar" data-sidebar>
      <div class="sidebar-section">
        <h2 class="sidebar-title">Dashboard</h2>
        <ul class="compartment-nav">
          <li>
            <a class="compartment-button${bookmarksActive}" href="/">
              <span class="compartment-icon" aria-hidden="true">\u25a3</span>
              <span class="compartment-label">Bookmarks</span>
            </a>
          </li>
        </ul>
      </div>
      <div class="sidebar-section">
        <h2 class="sidebar-title">Email</h2>
        <ul class="compartment-nav">
          <li>
            <a class="compartment-button${emailActive}" href="/email">
              <span class="compartment-icon" aria-hidden="true">\u2709\ufe0f</span>
              <span class="compartment-label">Inbox</span>
            </a>
          </li>
        </ul>
      </div>
      <div class="sidebar-section">
        <h2 class="sidebar-title">YouTube</h2>
        <ul class="compartment-nav">
          <li>
            <a class="compartment-button${videosActive}" href="/videos" data-sidebar-nav="videos">
              <span class="compartment-icon" aria-hidden="true">\u25b6</span>
              <span class="compartment-label">Videos</span>
            </a>
          </li>
          <li>
            <a class="compartment-button${subscriptionsActive}" href="/subscriptions" data-sidebar-nav="subscriptions">
              <span class="compartment-icon" aria-hidden="true">\u25cb</span>
              <span class="compartment-label">Subscriptions</span>
            </a>
          </li>
        </ul>
      </div>
    </aside>`
}

function renderToolbar(args: RenderArgs): string {
  // Filter chips — link to /subscriptions?filter=... and preserve
  // the current search. The "active" chip uses `data-active` so
  // the JS can detect clicks and re-route the search box.
  const chipHref = (f: SubscriptionFilter): string =>
    `/subscriptions?filter=${f}${args.search !== '' ? `&search=${encodeURIComponent(args.search)}` : ''}`

  const chips = [
    { id: 'all', label: `All (${args.counts.included + args.counts.excluded})`, href: chipHref('all') },
    { id: 'included', label: `Included (${args.counts.included})`, href: chipHref('included') },
    { id: 'excluded', label: `Excluded (${args.counts.excluded})`, href: chipHref('excluded') },
  ] as const

  const chipsHtml = chips.map((c) => {
    const active = args.filter === c.id ? ' filter-chip-active' : ''
    return `<a class="filter-chip${active}" href="${escapeHtml(c.href)}" data-filter-chip="${c.id}" aria-pressed="${args.filter === c.id ? 'true' : 'false'}">${escapeHtml(c.label)}</a>`
  }).join('')

  // Search input — GET form that preserves the current filter.
  // Mirrors the email-search input shape; we don't need a
  // debounce here because each keystroke just navigates to the
  // filtered list (the server renders fast).
  const searchHtml = `
      <form class="subscriptions-search" method="get" action="/subscriptions" data-subscriptions-search-form role="search">
        <input type="hidden" name="filter" value="${escapeHtml(args.filter)}">
        <input type="search" name="search" placeholder="Search channels\u2026" value="${escapeHtml(args.search)}" data-subscriptions-search aria-label="Search subscriptions">
        <button type="submit">Search</button>
        ${args.search !== '' ? `<a class="search-clear" href="/subscriptions?filter=${encodeURIComponent(args.filter)}" aria-label="Clear search">\u00d7</a>` : ''}
      </form>`

  // Sync-now button. Triggers a manual `POST /api/youtube/sync`
  // (YT-002) and renders the count summary in the banner slot
  // directly below the toolbar. Disabled while a sync is
  // running so the operator can't fire two in parallel.
  const syncHtml = `
      <button type="button" class="primary-button sync-now-button" data-sync-now>
        <span class="sync-now-label">Sync now</span>
      </button>`

  return `<section class="subscriptions-toolbar">
        <nav class="filter-chips" aria-label="Filter subscriptions">${chipsHtml}</nav>
        <div class="subscriptions-toolbar-right">
          ${searchHtml}
          ${syncHtml}
        </div>
      </section>`
}

function renderCountsLine(
  counts: { readonly included: number; readonly excluded: number },
): string {
  const total = counts.included + counts.excluded
  return `<p class="subscriptions-counts" data-subscriptions-counts>
        <strong>${total}</strong> total &middot;
        <strong>${counts.included}</strong> included &middot;
        <strong>${counts.excluded}</strong> excluded
      </p>`
}

function renderEmpty(args: RenderArgs): string {
  // Two shapes: zero subscriptions total (the operator hasn't
  // connected YouTube yet, or the auto-sync failed) vs. zero
  // after filtering (the operator toggled every channel off).
  const totalAll = args.counts.included + args.counts.excluded
  if (totalAll === 0) {
    return `<section class="subscriptions-empty" data-subscriptions-empty>
        <div class="empty-icon" aria-hidden="true">\u25b6</div>
        <h2 class="empty-title">No subscriptions yet</h2>
        <p class="empty-message">
          Connect your YouTube account to import your subscriptions.
          The dashboard imports them read-only and never modifies
          anything on YouTube.
        </p>
        <a class="primary-button" href="/api/youtube/oauth/start">Connect YouTube</a>
        <p class="empty-help">
          Already connected? Click <strong>Sync now</strong> above
          to re-run the import.
        </p>
      </section>`
  }
  if (args.search !== '') {
    return `<section class="subscriptions-empty" data-subscriptions-empty>
        <div class="empty-icon" aria-hidden="true">\ud83d\udd0d</div>
        <p class="empty-message">No subscriptions match <strong>${escapeHtml(args.search)}</strong>.</p>
        <a class="empty-cta" href="/subscriptions?filter=${encodeURIComponent(args.filter)}">Clear search \u2192</a>
      </section>`
  }
  // Filter is "included" or "excluded" and the matching set is empty.
  return `<section class="subscriptions-empty" data-subscriptions-empty>
      <div class="empty-icon" aria-hidden="true">\u2728</div>
      <p class="empty-message">No ${escapeHtml(args.filter)} subscriptions.</p>
      <a class="empty-cta" href="/subscriptions?filter=all">Show all \u2192</a>
    </section>`
}

function renderRow(s: Subscription): string {
  // Channel link: YouTube uses the URL
  //   https://www.youtube.com/channel/<channel_id>
  // for the canonical channel page. The dashboard never reads
  // it back; this is for the operator's "show me this channel on
  // YouTube" click.
  const youtubeUrl = `https://www.youtube.com/channel/${encodeURIComponent(s.channelId)}`
  const thumbHtml = s.channelThumbnailUrl
    ? `<img class="channel-thumb" src="${escapeHtml(s.channelThumbnailUrl)}" alt="" loading="lazy" width="48" height="48">`
    : `<span class="channel-thumb channel-thumb-fallback" aria-hidden="true">${escapeHtml((s.channelTitle[0] ?? '?').toUpperCase())}</span>`
  const includedChecked = s.isIncluded ? ' checked' : ''
  const importantChecked = s.isImportant ? ' checked' : ''
  return `
        <li class="subscription-row" data-subscription-row data-subscription-id="${escapeHtml(s.id)}">
          <a class="channel-link" href="${escapeHtml(youtubeUrl)}" target="_blank" rel="noopener">
            ${thumbHtml}
            <span class="channel-title">${escapeHtml(s.channelTitle)}</span>
          </a>
          <label class="toggle" title="Include in dashboard view">
            <input type="checkbox" data-toggle="is_included" ${includedChecked}>
            <span class="toggle-label">Included</span>
          </label>
          <label class="toggle" title="Reserve for future LLM job (no behavior in v3.0)">
            <input type="checkbox" data-toggle="is_important" ${importantChecked}>
            <span class="toggle-label">Important</span>
          </label>
          <span class="row-status" data-row-status></span>
        </li>`
}

function renderPagination(args: RenderArgs): string {
  const pages = Math.max(1, Math.ceil(args.total / args.limit))
  if (pages <= 1) return ''
  const prev = args.page > 1 ? args.page - 1 : null
  const next = args.page < pages ? args.page + 1 : null
  const baseQuery = `filter=${args.filter}${args.search !== '' ? `&search=${encodeURIComponent(args.search)}` : ''}`
  const pageHref = (p: number): string => `/subscriptions?${baseQuery}&page=${p}`
  return `<nav class="subscriptions-pagination" aria-label="Subscriptions pagination">
        ${prev !== null
          ? `<a class="pagination-link" href="${escapeHtml(pageHref(prev))}">\u2190 Page ${prev}</a>`
          : '<span class="pagination-disabled">\u2190 Previous</span>'}
        <span class="pagination-info">Page ${args.page} of ${pages}</span>
        ${next !== null
          ? `<a class="pagination-link" href="${escapeHtml(pageHref(next))}">Page ${next} \u2192</a>`
          : '<span class="pagination-disabled">Next \u2192</span>'}
      </nav>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ─── Inline JS (toggle PATCH + Sync-now POST) ────────────────────────────
//
// Two responsibilities, kept in one inline script for simplicity:
//   1. Toggle change → `PATCH /api/subscriptions/:id` → flash
//      "saved" / "error" in the row status. Optimistic flip
//      before the round-trip so the operator sees instant
//      feedback; revert on failure so the toggle always reflects
//      server truth.
//   2. Sync-now click → `POST /api/youtube/sync` → render the
//      counts in the banner slot. Disable the button while
//      in-flight so a double-click doesn't fire two syncs.
//
// The script uses fetch's Basic-credential inheritance: the page
// was authenticated by Hono's middleware at render time, so the
// browser already has the right header cached for same-origin
// fetches (`credentials: 'same-origin'`). No JS-side auth code.

const SUBSCRIPTIONS_PAGE_SCRIPT = `(function(){
  // ─── Toggle PATCH ────────────────────────────────────────────────────
  function wireRow(row) {
    var toggles = row.querySelectorAll('[data-toggle]');
    toggles.forEach(function (toggle) {
      toggle.addEventListener('change', function () {
        var field = toggle.getAttribute('data-toggle');
        var value = toggle.checked;
        var next = value;
        // Optimistic flip — the user already sees the new state.
        // If the server rejects, we revert below.
        toggle.disabled = true;
        var status = row.querySelector('[data-row-status]');
        flashRowStatus(status, 'saving\u2026', 'pending');
        var body = {};
        body[field === 'is_included' ? 'is_included' : 'is_important'] = next;
        fetch('/api/subscriptions/' + encodeURIComponent(row.getAttribute('data-subscription-id')), {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (res) {
            if (res.status === 401) {
              window.location.href = '/api/login';
              return null;
            }
            if (!res.ok) {
              return res.json().then(function (err) {
                throw new Error(err.message || err.error || ('HTTP ' + res.status));
              }).catch(function () {
                throw new Error('HTTP ' + res.status);
              });
            }
            return res.json();
          })
          .then(function (payload) {
            if (!payload) return; // auth-redirect already happened
            toggle.disabled = false;
            // Server is the source of truth — read it back and
            // reconcile in case the DB normalised anything we
            // didn't anticipate (none today, but cheap insurance).
            if (payload.subscription) {
              var serverVal = field === 'is_included'
                ? payload.subscription.is_included
                : payload.subscription.is_important;
              if (toggle.checked !== serverVal) toggle.checked = serverVal;
            }
            flashRowStatus(status, 'saved', 'ok');
          })
          .catch(function (err) {
            toggle.disabled = false;
            toggle.checked = !value; // revert
            flashRowStatus(status, 'failed: ' + (err.message || 'unknown'), 'error');
          });
      });
    });
  }

  function flashRowStatus(el, message, kind) {
    if (!el) return;
    el.textContent = message;
    el.setAttribute('data-row-status-kind', kind);
    if (kind === 'pending' || kind === 'error') return; // sticky on error
    clearTimeout(el._timer);
    el._timer = setTimeout(function () {
      el.textContent = '';
      el.removeAttribute('data-row-status-kind');
    }, 1800);
  }

  document.querySelectorAll('[data-subscription-row]').forEach(wireRow);

  // ─── Sync-now POST ───────────────────────────────────────────────────
  var syncBtn = document.querySelector('[data-sync-now]');
  var bannerSlot = document.querySelector('[data-sync-banner-slot]');
  if (syncBtn && bannerSlot) {
    syncBtn.addEventListener('click', function () {
      if (syncBtn.disabled) return;
      syncBtn.disabled = true;
      syncBtn.classList.add('sync-now-busy');
      var originalLabel = syncBtn.querySelector('.sync-now-label').textContent;
      syncBtn.querySelector('.sync-now-label').textContent = 'Syncing\u2026';
      renderBanner(bannerSlot, { kind: 'pending', message: 'Syncing subscriptions\u2026' });
      fetch('/api/youtube/sync', {
        method: 'POST',
        credentials: 'same-origin',
      })
        .then(function (res) {
          if (res.status === 401) {
            window.location.href = '/api/login';
            return null;
          }
          return res.json().then(function (body) { return { status: res.status, body: body }; });
        })
        .then(function (payload) {
          if (!payload) return;
          syncBtn.disabled = false;
          syncBtn.classList.remove('sync-now-busy');
          syncBtn.querySelector('.sync-now-label').textContent = originalLabel;
          if (payload.status === 404) {
            renderBanner(bannerSlot, {
              kind: 'error',
              message: 'No YouTube account connected. Connect YouTube on /settings/youtube, then try again.',
            });
            return;
          }
          if (payload.status !== 200) {
            renderBanner(bannerSlot, {
              kind: 'error',
              message: 'Sync failed (HTTP ' + payload.status + '). Check the server log.',
            });
            return;
          }
          var r = payload.body;
          renderBanner(bannerSlot, {
            kind: 'ok',
            message: 'Synced ' + r.total + ' channels: +' + r.added + ' added, ~' + r.updated + ' updated, -' + r.removed + ' removed, =' + r.unchanged + ' unchanged. Reload to see the updated list.',
          });
        })
        .catch(function (err) {
          syncBtn.disabled = false;
          syncBtn.classList.remove('sync-now-busy');
          syncBtn.querySelector('.sync-now-label').textContent = originalLabel;
          renderBanner(bannerSlot, {
            kind: 'error',
            message: 'Sync failed: ' + (err.message || 'network error'),
          });
        });
    });
  }

  function renderBanner(slot, args) {
    var cls = args.kind === 'ok' ? 'sync-banner-ok'
            : args.kind === 'error' ? 'sync-banner-error'
            : 'sync-banner-pending';
    slot.innerHTML = '<div class="sync-banner ' + cls + '" role="status"><span class="sync-banner-icon" aria-hidden="true">' +
      (args.kind === 'ok' ? '\u2713' : args.kind === 'error' ? '\u26a0' : '\u21bb') +
      '</span><span class="sync-banner-message">' + escapeText(args.message) + '</span></div>';
  }

  function escapeText(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();`

// ─── Styles ───────────────────────────────────────────────────────────────

const STYLES = `
.layout { display: flex; min-height: calc(100vh - 56px); align-items: stretch; }
.subscriptions-main { flex: 1; min-width: 0; padding: 1.5rem 2rem 4rem; max-width: 1080px; }
.page-heading { margin-bottom: 0.75rem; }
.page-eyebrow { display: inline-block; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; margin-bottom: 0.25rem; }
.page-heading h1 { margin: 0 0 0.4rem; font-size: 1.6rem; font-weight: 600; }
.page-heading p { margin: 0; color: var(--muted); font-size: 0.95rem; max-width: 38rem; }

.subscriptions-tabs { display: flex; gap: 0.25rem; margin: 1.25rem 0 1.5rem; border-bottom: 1px solid var(--border); }
.subscriptions-tab { padding: 0.5rem 0.9rem; color: var(--muted); text-decoration: none; font-size: 0.9rem; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.subscriptions-tab:hover { color: var(--text); }
.subscriptions-tab-active { color: var(--text); border-bottom-color: var(--accent); font-weight: 500; }

.subscriptions-toolbar { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.75rem; }
.filter-chips { display: inline-flex; gap: 0.4rem; flex-wrap: wrap; }
.filter-chip { padding: 0.4rem 0.85rem; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); color: var(--text); text-decoration: none; font-size: 0.85rem; }
.filter-chip:hover { background: var(--surface-hover); }
.filter-chip-active { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
.filter-chip-active:hover { filter: brightness(0.95); }

.subscriptions-toolbar-right { margin-left: auto; display: flex; gap: 0.5rem; align-items: center; }
.subscriptions-search { display: inline-flex; gap: 0.4rem; align-items: center; }
.subscriptions-search input[type="search"] { padding: 0.4rem 0.7rem; font-size: 0.85rem; border: 1px solid var(--border); border-radius: 0.375rem; background: var(--surface); color: var(--text); min-width: 14rem; }
.subscriptions-search button { padding: 0.4rem 0.85rem; font-size: 0.85rem; border: 1px solid var(--border); border-radius: 0.375rem; background: var(--surface); color: var(--text); cursor: pointer; }
.subscriptions-search button:hover { background: var(--surface-hover); }
.search-clear { color: var(--muted); text-decoration: none; font-size: 1.1rem; padding: 0 0.4rem; }

.primary-button { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.45rem 0.95rem; border-radius: 0.3rem; cursor: pointer; font-size: 0.9rem; line-height: 1; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-text); text-decoration: none; font-weight: 500; }
.primary-button:hover { filter: brightness(0.92); }
.primary-button:disabled { opacity: 0.6; cursor: not-allowed; filter: none; }
.sync-now-busy .sync-now-label::before { content: '\u21bb  '; display: inline-block; animation: subscriptions-spin 1.1s linear infinite; }
@keyframes subscriptions-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.subscriptions-counts { color: var(--muted); font-size: 0.85rem; margin: 0 0 1rem; }
.subscriptions-counts strong { color: var(--text); font-weight: 600; }

.subscriptions-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.subscription-row { display: grid; grid-template-columns: 1fr auto auto auto; gap: 1rem; align-items: center; padding: 0.7rem 0.9rem; background: var(--surface); border: 1px solid var(--border); border-radius: 0.5rem; }
.subscription-row:hover { border-color: var(--accent); }
.channel-link { display: flex; align-items: center; gap: 0.7rem; min-width: 0; color: var(--text); text-decoration: none; }
.channel-link:hover .channel-title { color: var(--accent); }
.channel-thumb { width: 48px; height: 48px; border-radius: 999px; background: var(--surface-hover); object-fit: cover; flex-shrink: 0; display: inline-block; }
.channel-thumb-fallback { display: inline-flex; align-items: center; justify-content: center; color: var(--muted); font-weight: 600; font-size: 1.1rem; }
.channel-title { font-weight: 500; font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.toggle { display: inline-flex; align-items: center; gap: 0.4rem; cursor: pointer; font-size: 0.85rem; color: var(--muted); user-select: none; }
.toggle input[type="checkbox"] { width: 1rem; height: 1rem; accent-color: var(--accent); cursor: pointer; }
.toggle-label { white-space: nowrap; }

.row-status { font-size: 0.8rem; min-width: 8rem; text-align: right; color: var(--muted); }
.row-status[data-row-status-kind="ok"] { color: var(--accent); }
.row-status[data-row-status-kind="error"] { color: var(--danger); }
.row-status[data-row-status-kind="pending"] { color: var(--muted); }

.subscriptions-empty { padding: 3rem 1.5rem; text-align: center; border: 1px dashed var(--border); border-radius: 0.5rem; background: var(--surface); }
.subscriptions-empty .empty-icon { font-size: 2.5rem; margin-bottom: 0.5rem; color: var(--muted); }
.subscriptions-empty .empty-title { font-size: 1.2rem; font-weight: 600; margin: 0 0 0.5rem; }
.subscriptions-empty .empty-message { color: var(--muted); margin: 0 0 1rem; max-width: 30rem; margin-left: auto; margin-right: auto; }
.subscriptions-empty .empty-help { color: var(--muted); font-size: 0.85rem; margin-top: 1rem; }
.subscriptions-empty .empty-cta { color: var(--accent); text-decoration: none; }
.subscriptions-empty .empty-cta:hover { text-decoration: underline; }

.subscriptions-pagination { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--border); }
.pagination-link { color: var(--accent); text-decoration: none; font-size: 0.9rem; }
.pagination-link:hover { text-decoration: underline; }
.pagination-disabled { color: var(--muted); font-size: 0.9rem; }
.pagination-info { color: var(--muted); font-size: 0.85rem; }

.sync-banner { display: flex; align-items: center; gap: 0.6rem; padding: 0.7rem 1rem; border-radius: 0.4rem; margin: 0 0 1rem; border: 1px solid; font-size: 0.9rem; }
.sync-banner-ok { background: var(--surface); color: var(--text); border-color: var(--accent); }
.sync-banner-error { background: var(--surface); color: var(--danger); border-color: var(--danger); }
.sync-banner-pending { background: var(--surface); color: var(--muted); border-color: var(--border); }
.sync-banner-icon { font-size: 1.1rem; }

@media (max-width: 720px) {
  .subscriptions-main { padding: 1rem; }
  .subscription-row { grid-template-columns: 1fr; gap: 0.5rem; }
  .subscription-row .toggle { justify-self: start; }
  .subscription-row .row-status { text-align: left; justify-self: start; min-width: 0; }
  .subscriptions-toolbar { flex-direction: column; align-items: stretch; }
  .subscriptions-toolbar-right { margin-left: 0; flex-direction: column; align-items: stretch; }
  .subscriptions-search { width: 100%; }
  .subscriptions-search input[type="search"] { flex: 1; min-width: 0; }
  .filter-chips { overflow-x: auto; padding-bottom: 0.25rem; }
  .channel-thumb { width: 40px; height: 40px; }
}
`