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
  renderAppNavigation,
  renderSidebarFooter,
} from './view-shared.js'
import {
  searchSubscriptions,
  countIncludedExcluded,
  type Subscription,
  type SubscriptionFilter,
} from './youtube-subscriptions.js'
import { getMostRecentYouTubeAccountId } from './youtube-accounts.js'
import { getYouTubePreferences } from './youtube-preferences.js'
import { listAllTags, type TagRecord } from './tags.js'

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
    const tagId = c.req.query('tag_id') || undefined
    const page = parsePositiveInt(c.req.query('page')) ?? 1
    const limit = parsePositiveInt(c.req.query('limit')) ?? 50

    const result = searchSubscriptions(deps.db, {
      filter,
      search,
      ...(tagId ? { tagId } : {}),
      page,
      limit,
    })
    const counts = countIncludedExcluded(deps.db)
    const accountId = getMostRecentYouTubeAccountId(deps.db)
    const backfillDays = accountId
      ? getYouTubePreferences(deps.db, accountId).newSubscriptionBackfillDays
      : 30
    return c.html(
      renderPage({
        items: result.items,
        total: result.total,
        page: result.page,
        limit: result.limit,
        filter: result.invalidFilter !== null ? 'all' : filter,
        search,
        tagId: tagId ?? '',
        allTags: listAllTags(deps.db),
        counts,
        backfillDays,
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
  readonly tagId: string
  readonly allTags: readonly TagRecord[]
  readonly counts: { readonly included: number; readonly excluded: number }
  readonly backfillDays: 0 | 7 | 30 | 90
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
  <body class="space-youtube-page">
    ${renderHeader({ showSearch: false, showSidebarToggle: true })}
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
        ${renderBackfillPreference(args.backfillDays)}
        ${renderToolbar(args)}
        <datalist id="subscription-all-tags">${args.allTags.map((tag) => `<option value="${escapeHtml(tag.name)}" data-tag-id="${escapeHtml(tag.id)}"></option>`).join('')}</datalist>
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

function renderBackfillPreference(days: 0 | 7 | 30 | 90): string {
  const options = [
    [0, 'Future uploads only'],
    [7, 'Last 7 days'],
    [30, 'Last 30 days'],
    [90, 'Last 90 days'],
  ] as const
  return `<section class="backfill-preference" aria-labelledby="backfill-preference-title">
      <div>
        <strong id="backfill-preference-title">When a new subscription is discovered</strong>
        <span>Import recent uploads automatically. Existing subscriptions are not affected.</span>
      </div>
      <label>
        <span class="sr-only">Automatic recent video window</span>
        <select data-backfill-preference>${options.map(([value, label]) =>
          `<option value="${value}"${value === days ? ' selected' : ''}>${label}</option>`).join('')}</select>
      </label>
      <span class="preference-status" data-preference-status></span>
    </section>`
}

function renderSidebar(_args: { readonly active: 'subscriptions' }): string {
  return `<aside class="sidebar" data-sidebar>
      ${renderAppNavigation({ active: 'youtube', context: 'subscriptions' })}
      ${renderSidebarFooter('YouTube · subscriptions synced')}
    </aside>`
}

function renderToolbar(args: RenderArgs): string {
  // Filter chips — link to /subscriptions?filter=... and preserve
  // the current search. The "active" chip uses `data-active` so
  // the JS can detect clicks and re-route the search box.
  const chipHref = (f: SubscriptionFilter): string =>
    `/subscriptions?filter=${f}${args.search !== '' ? `&search=${encodeURIComponent(args.search)}` : ''}${args.tagId !== '' ? `&tag_id=${encodeURIComponent(args.tagId)}` : ''}`

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
        ${args.tagId !== '' ? `<input type="hidden" name="tag_id" value="${escapeHtml(args.tagId)}">` : ''}
        <input type="search" name="search" placeholder="Search channels\u2026" value="${escapeHtml(args.search)}" data-subscriptions-search aria-label="Search subscriptions">
        <button type="submit">Search</button>
        ${args.search !== '' ? `<a class="search-clear" href="/subscriptions?filter=${encodeURIComponent(args.filter)}${args.tagId !== '' ? `&tag_id=${encodeURIComponent(args.tagId)}` : ''}" aria-label="Clear search">\u00d7</a>` : ''}
      </form>`

  const selectedTag = args.allTags.find((tag) => tag.id === args.tagId)
  const tagFilterHtml = `<form class="subscriptions-tag-filter" method="get" action="/subscriptions" data-tag-filter-form>
      <input type="hidden" name="filter" value="${escapeHtml(args.filter)}">
      ${args.search !== '' ? `<input type="hidden" name="search" value="${escapeHtml(args.search)}">` : ''}
      <input type="hidden" name="tag_id" value="${escapeHtml(args.tagId)}" data-tag-filter-id>
      <label class="sr-only" for="subscription-tag-filter">Filter subscriptions by tag</label>
      <input id="subscription-tag-filter" type="text" list="subscription-all-tags" value="${escapeHtml(selectedTag?.name ?? '')}" placeholder="Filter by tag…" autocomplete="off" data-tag-filter-input>
      <button type="submit">Filter</button>
      ${args.tagId !== '' ? `<a class="search-clear" href="/subscriptions?filter=${encodeURIComponent(args.filter)}${args.search !== '' ? `&search=${encodeURIComponent(args.search)}` : ''}" aria-label="Clear tag filter">\u00d7</a>` : ''}
      <span class="tag-filter-status" data-tag-filter-status aria-live="polite"></span>
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
          ${tagFilterHtml}
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
        <a class="empty-cta" href="/subscriptions?filter=${encodeURIComponent(args.filter)}${args.tagId !== '' ? `&tag_id=${encodeURIComponent(args.tagId)}` : ''}">Clear search \u2192</a>
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
  const transcriptsChecked = s.autoFetchTranscripts ? ' checked' : ''
  const backfillStatus = renderBackfillStatus(s)
  const tags = s.tags.map((tag) => `<span class="subscription-tag" data-subscription-tag data-tag-id="${escapeHtml(tag.id)}">
      <span>#${escapeHtml(tag.name)}</span>
      <button type="button" data-subscription-tag-remove aria-label="Remove tag ${escapeHtml(tag.name)}">\u00d7</button>
    </span>`).join('')
  return `
        <li class="subscription-row" data-subscription-row data-subscription-id="${escapeHtml(s.id)}">
          <a class="channel-link" href="${escapeHtml(youtubeUrl)}" target="_blank" rel="noopener">
            ${thumbHtml}
            <span class="channel-title">${escapeHtml(s.channelTitle)}</span>
          </a>
          <div class="subscription-tags" data-subscription-tags>
            ${tags}
            <input type="text" list="subscription-all-tags" placeholder="Add tag…" autocomplete="off" data-subscription-tag-input aria-label="Add tag to ${escapeHtml(s.channelTitle)}">
            <button type="button" data-subscription-tag-add>Add</button>
          </div>
          <label class="toggle" title="Include in dashboard view">
            <input type="checkbox" data-toggle="is_included" ${includedChecked}>
            <span class="toggle-label">Included</span>
          </label>
          <label class="toggle" title="Reserve for future LLM job (no behavior in v3.0)">
            <input type="checkbox" data-toggle="is_important" ${importantChecked}>
            <span class="toggle-label">Important</span>
          </label>
          <label class="toggle" title="Automatically fetch captions for newly discovered videos">
            <input type="checkbox" data-toggle="auto_fetch_transcripts" ${transcriptsChecked}>
            <span class="toggle-label">Auto transcripts</span>
          </label>
          <div class="backfill-action">
            <select data-backfill-days aria-label="Recent video import window">
              <option value="7">7 days</option>
              <option value="30" selected>30 days</option>
              <option value="90">90 days</option>
            </select>
            <button type="button" data-backfill-button>Import recent videos</button>
          </div>
          <span class="backfill-result" data-backfill-result data-backfill-state="${escapeHtml(s.backfillStatus ?? '')}">${backfillStatus}</span>
          <span class="row-status" data-row-status></span>
        </li>`
}

function renderBackfillStatus(s: Subscription): string {
  if (s.backfillStatus === 'pending') return 'Queued…'
  if (s.backfillStatus === 'running') return 'Importing…'
  if (s.backfillStatus === 'failed') return `Failed${s.backfillRetryable ? ' · retry available' : ''}`
  if (s.backfillStatus === 'completed') {
    return `${s.lastBackfillCount} imported · ${s.lastBackfillSkippedCount} skipped`
  }
  return 'Not imported yet'
}

function renderPagination(args: RenderArgs): string {
  const pages = Math.max(1, Math.ceil(args.total / args.limit))
  if (pages <= 1) return ''
  const prev = args.page > 1 ? args.page - 1 : null
  const next = args.page < pages ? args.page + 1 : null
  const baseQuery = `filter=${args.filter}${args.search !== '' ? `&search=${encodeURIComponent(args.search)}` : ''}${args.tagId !== '' ? `&tag_id=${encodeURIComponent(args.tagId)}` : ''}`
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
        body[field] = next;
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
              var serverVal = payload.subscription[field];
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

    var tagInput = row.querySelector('[data-subscription-tag-input]');
    var tagAdd = row.querySelector('[data-subscription-tag-add]');
    var tagList = row.querySelector('[data-subscription-tags]');
    var subscriptionId = row.getAttribute('data-subscription-id');
    function addSubscriptionTag() {
      var name = tagInput && tagInput.value.trim();
      if (!name || !tagAdd || !tagInput) return;
      tagInput.disabled = true;
      tagAdd.disabled = true;
      var status = row.querySelector('[data-row-status]');
      flashRowStatus(status, 'adding tag…', 'pending');
      fetch('/api/subscriptions/' + encodeURIComponent(subscriptionId) + '/tags', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name }),
      }).then(readJsonResponse).then(function (payload) {
        if (!payload) return;
        if (payload.status !== 201) throw new Error(payload.body.message || payload.body.error || ('HTTP ' + payload.status));
        var existing = Array.prototype.find.call(tagList.querySelectorAll('[data-subscription-tag]'), function (chip) {
          return chip.getAttribute('data-tag-id') === payload.body.id;
        });
        if (!existing) tagList.insertBefore(createSubscriptionTagChip(payload.body), tagInput);
        tagInput.value = '';
        flashRowStatus(status, 'tag saved', 'ok');
      }).catch(function (err) {
        flashRowStatus(status, 'tag failed: ' + (err.message || 'network error'), 'error');
      }).finally(function () {
        tagInput.disabled = false;
        tagAdd.disabled = false;
        tagInput.focus();
      });
    }
    if (tagAdd && tagInput && tagList) {
      tagAdd.addEventListener('click', addSubscriptionTag);
      tagInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); addSubscriptionTag(); }
      });
      tagList.addEventListener('click', function (event) {
        var button = event.target.closest && event.target.closest('[data-subscription-tag-remove]');
        if (!button) return;
        var chip = button.closest('[data-subscription-tag]');
        if (!chip) return;
        button.disabled = true;
        var status = row.querySelector('[data-row-status]');
        flashRowStatus(status, 'removing tag…', 'pending');
        fetch('/api/subscriptions/' + encodeURIComponent(subscriptionId) + '/tags/' + encodeURIComponent(chip.getAttribute('data-tag-id')), {
          method: 'DELETE', credentials: 'same-origin',
        }).then(function (res) {
          if (res.status === 401) { window.location.href = '/api/login'; return null; }
          if (res.status !== 204) throw new Error('HTTP ' + res.status);
          chip.remove();
          flashRowStatus(status, 'tag removed', 'ok');
        }).catch(function (err) {
          button.disabled = false;
          flashRowStatus(status, 'remove failed: ' + (err.message || 'network error'), 'error');
        });
      });
    }

    var backfillButton = row.querySelector('[data-backfill-button]');
    var backfillDays = row.querySelector('[data-backfill-days]');
    var backfillResult = row.querySelector('[data-backfill-result]');
    if (backfillButton && backfillDays && backfillResult) {
      backfillButton.addEventListener('click', function () {
        backfillButton.disabled = true;
        backfillResult.textContent = 'Queueing…';
        fetch('/api/subscriptions/' + encodeURIComponent(subscriptionId) + '/backfill', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ days: Number(backfillDays.value) }),
        }).then(readJsonResponse).then(function (payload) {
          if (!payload) return;
          if (payload.status !== 202) throw new Error(payload.body.message || payload.body.error || ('HTTP ' + payload.status));
          renderBackfillState(backfillResult, backfillButton, payload.body.backfill);
          pollBackfill(subscriptionId, backfillResult, backfillButton);
        }).catch(function (err) {
          backfillButton.disabled = false;
          backfillResult.textContent = 'Failed: ' + (err.message || 'network error');
          backfillResult.setAttribute('data-backfill-state', 'failed');
        });
      });
      var initialState = backfillResult.getAttribute('data-backfill-state');
      if (initialState === 'pending' || initialState === 'running') {
        backfillButton.disabled = true;
        pollBackfill(subscriptionId, backfillResult, backfillButton);
      }
    }
  }

  function createSubscriptionTagChip(tag) {
    var chip = document.createElement('span');
    chip.className = 'subscription-tag';
    chip.setAttribute('data-subscription-tag', '');
    chip.setAttribute('data-tag-id', tag.id);
    var label = document.createElement('span');
    label.textContent = '#' + tag.name;
    var remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('data-subscription-tag-remove', '');
    remove.setAttribute('aria-label', 'Remove tag ' + tag.name);
    remove.textContent = '×';
    chip.appendChild(label);
    chip.appendChild(remove);
    return chip;
  }

  function readJsonResponse(res) {
    if (res.status === 401) {
      window.location.href = '/api/login';
      return null;
    }
    return res.json().then(function (body) { return { status: res.status, body: body }; });
  }

  function pollBackfill(subscriptionId, result, button) {
    window.setTimeout(function check() {
      fetch('/api/subscriptions/' + encodeURIComponent(subscriptionId) + '/backfill', {
        credentials: 'same-origin',
      }).then(readJsonResponse).then(function (payload) {
        if (!payload) return;
        if (payload.status !== 200) throw new Error('HTTP ' + payload.status);
        var state = payload.body.backfill;
        renderBackfillState(result, button, state);
        if (state.status === 'pending' || state.status === 'running') {
          window.setTimeout(check, 1000);
        }
      }).catch(function () {
        button.disabled = false;
        result.textContent = 'Could not read import status';
      });
    }, 350);
  }

  function renderBackfillState(result, button, state) {
    result.setAttribute('data-backfill-state', state.status || '');
    if (state.status === 'pending') result.textContent = 'Queued…';
    else if (state.status === 'running') result.textContent = 'Importing…';
    else if (state.status === 'completed') result.textContent = state.imported_count + ' imported · ' + state.skipped_count + ' skipped';
    else if (state.status === 'failed') result.textContent = 'Failed: ' + (state.error || 'unknown error') + (state.retryable ? ' Retry available.' : '');
    else result.textContent = 'Not imported yet';
    button.disabled = state.status === 'pending' || state.status === 'running';
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

  var tagFilterForm = document.querySelector('[data-tag-filter-form]');
  if (tagFilterForm) {
    tagFilterForm.addEventListener('submit', function (event) {
      var input = tagFilterForm.querySelector('[data-tag-filter-input]');
      var hidden = tagFilterForm.querySelector('[data-tag-filter-id]');
      var status = tagFilterForm.querySelector('[data-tag-filter-status]');
      var value = input.value.trim().toLowerCase();
      if (!value) { hidden.value = ''; return; }
      var options = document.querySelectorAll('#subscription-all-tags option');
      var match = Array.prototype.find.call(options, function (option) {
        return option.value.toLowerCase() === value;
      });
      if (!match) {
        event.preventDefault();
        status.textContent = 'Choose an existing tag';
        input.setAttribute('aria-invalid', 'true');
        return;
      }
      hidden.value = match.getAttribute('data-tag-id');
      input.removeAttribute('aria-invalid');
      status.textContent = '';
    });
  }

  var preference = document.querySelector('[data-backfill-preference]');
  var preferenceStatus = document.querySelector('[data-preference-status]');
  if (preference) {
    preference.addEventListener('change', function () {
      preference.disabled = true;
      if (preferenceStatus) preferenceStatus.textContent = 'Saving…';
      fetch('/api/youtube/preferences', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ new_subscription_backfill_days: Number(preference.value) }),
      }).then(readJsonResponse).then(function (payload) {
        if (!payload) return;
        if (payload.status !== 200) throw new Error(payload.body.message || payload.body.error || ('HTTP ' + payload.status));
        preference.disabled = false;
        if (preferenceStatus) preferenceStatus.textContent = 'Saved';
      }).catch(function (err) {
        preference.disabled = false;
        if (preferenceStatus) preferenceStatus.textContent = 'Failed: ' + (err.message || 'network error');
      });
    });
  }

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
.subscriptions-main { flex: 1; min-width: 0; padding: 1.5rem 2rem 4rem; max-width: 1100px; }
.page-heading { margin-bottom: 0.75rem; }
.page-eyebrow { display: inline-block; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; margin-bottom: 0.25rem; }
.page-heading h1 { margin: 0 0 0.4rem; font-size: 1.6rem; font-weight: 600; }
.page-heading p { margin: 0; color: var(--muted); font-size: 0.95rem; max-width: 38rem; }

.subscriptions-tabs { display: flex; gap: 0.25rem; margin: 1.25rem 0 1.5rem; border-bottom: 1px solid var(--border); }
.subscriptions-tab { padding: 0.5rem 0.9rem; color: var(--muted); text-decoration: none; font-size: 0.9rem; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.subscriptions-tab:hover { color: var(--text); }
.subscriptions-tab-active { color: var(--text); border-bottom-color: var(--accent); font-weight: 500; }

.backfill-preference { display: grid; grid-template-columns: minmax(220px, 1fr) auto minmax(3.5rem, auto); gap: 1rem; align-items: center; padding: 0.9rem 1rem; margin-bottom: 1rem; border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border)); border-radius: 0.8rem; background: color-mix(in srgb, var(--accent) 7%, var(--surface)); }
.backfill-preference strong { display: block; font-size: 0.9rem; }
.backfill-preference div span { display: block; color: var(--muted); font-size: 0.8rem; margin-top: 0.2rem; }
.backfill-preference select, .backfill-action select { border: 1px solid var(--border); border-radius: 0.45rem; background: var(--surface); color: var(--text); padding: 0.42rem 0.55rem; }
.preference-status { color: var(--muted); font-size: 0.78rem; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

.subscriptions-toolbar { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.75rem; }
.filter-chips { display: inline-flex; gap: 0.4rem; flex-wrap: wrap; }
.filter-chip { padding: 0.4rem 0.85rem; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); color: var(--text); text-decoration: none; font-size: 0.85rem; }
.filter-chip:hover { background: var(--surface-hover); }
.filter-chip-active { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
.filter-chip-active:hover { filter: brightness(0.95); }

.subscriptions-toolbar-right { margin-left: auto; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.subscriptions-search { display: inline-flex; gap: 0.4rem; align-items: center; }
.subscriptions-tag-filter { display: inline-flex; gap: 0.4rem; align-items: center; position: relative; }
.subscriptions-tag-filter input[type="text"] { padding: 0.4rem 0.7rem; font-size: 0.85rem; border: 1px solid var(--border); border-radius: 0.375rem; background: var(--surface); color: var(--text); width: 10rem; }
.subscriptions-tag-filter button { padding: 0.4rem 0.7rem; font-size: 0.85rem; border: 1px solid var(--border); border-radius: 0.375rem; background: var(--surface); color: var(--text); cursor: pointer; }
.tag-filter-status { position: absolute; top: calc(100% + .2rem); left: 0; color: var(--danger); font-size: .72rem; white-space: nowrap; }
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
.subscription-row { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(170px, .8fr) auto auto auto; gap: 0.65rem 1rem; align-items: center; padding: 0.8rem 1rem; background: color-mix(in srgb, var(--surface) 94%, transparent); border: 1px solid var(--border); border-radius: 0.8rem; transition: transform 160ms ease, border-color 160ms ease, background-color 160ms ease; }
.subscription-row:hover { transform: translateX(3px); border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); background: var(--surface); }
.channel-link { display: flex; align-items: center; gap: 0.7rem; min-width: 0; color: var(--text); text-decoration: none; }
.channel-link:hover .channel-title { color: var(--accent); }
.channel-thumb { width: 52px; height: 52px; border-radius: 999px; background: var(--surface-hover); object-fit: cover; flex-shrink: 0; display: inline-block; border: 2px solid color-mix(in srgb, var(--accent) 25%, var(--border)); }
.channel-thumb-fallback { display: inline-flex; align-items: center; justify-content: center; color: var(--muted); font-weight: 600; font-size: 1.1rem; }
.channel-title { font-weight: 500; font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.subscription-tags { display: flex; align-items: center; flex-wrap: wrap; gap: .35rem; min-width: 0; }
.subscription-tag { display: inline-flex; align-items: center; gap: .15rem; padding: .2rem .25rem .2rem .5rem; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border)); background: color-mix(in srgb, var(--accent) 8%, var(--surface)); color: var(--text); font-size: .75rem; }
.subscription-tag button { width: 1.25rem; height: 1.25rem; padding: 0; border: 0; border-radius: 999px; color: var(--muted); background: transparent; cursor: pointer; line-height: 1; }
.subscription-tag button:hover, .subscription-tag button:focus-visible { color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); }
.subscription-tags input { width: 6.5rem; min-width: 5rem; padding: .3rem .45rem; border: 1px solid var(--border); border-radius: .4rem; background: var(--surface); color: var(--text); font-size: .75rem; }
.subscription-tags > button { padding: .3rem .5rem; border: 1px solid var(--border); border-radius: .4rem; background: var(--surface); color: var(--text); cursor: pointer; font-size: .75rem; }
.subscription-tags > button:hover, .subscription-tags > button:focus-visible { border-color: var(--accent); color: var(--accent); }

.toggle { display: inline-flex; align-items: center; gap: 0.4rem; cursor: pointer; font-size: 0.85rem; color: var(--muted); user-select: none; }
.toggle input[type="checkbox"] { width: 1rem; height: 1rem; accent-color: var(--accent); cursor: pointer; }
.toggle-label { white-space: nowrap; }

.backfill-action { grid-column: 3 / 5; display: flex; gap: 0.4rem; justify-content: flex-end; align-items: center; }
.backfill-action button { border: 1px solid var(--border); border-radius: 0.45rem; background: var(--surface); color: var(--text); padding: 0.42rem 0.65rem; cursor: pointer; font-size: 0.8rem; }
.backfill-action button:hover { border-color: var(--accent); color: var(--accent); }
.backfill-action button:disabled { opacity: 0.6; cursor: wait; }
.backfill-result { grid-column: 5; color: var(--muted); font-size: 0.76rem; text-align: right; max-width: 15rem; }
.backfill-result[data-backfill-state="completed"] { color: var(--accent); }
.backfill-result[data-backfill-state="failed"] { color: var(--danger); }

.row-status { grid-column: 1; grid-row: 2; font-size: 0.8rem; min-width: 8rem; color: var(--muted); padding-left: 3.8rem; }
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
  .backfill-preference { grid-template-columns: 1fr; gap: 0.6rem; }
  .backfill-action, .backfill-result, .row-status { grid-column: 1; grid-row: auto; justify-content: flex-start; text-align: left; padding-left: 0; }
  .subscriptions-toolbar { flex-direction: column; align-items: stretch; }
  .subscriptions-toolbar-right { margin-left: 0; flex-direction: column; align-items: stretch; }
  .subscriptions-search { width: 100%; }
  .subscriptions-search input[type="search"] { flex: 1; min-width: 0; }
  .filter-chips { overflow-x: auto; padding-bottom: 0.25rem; }
  .channel-thumb { width: 40px; height: 40px; }
}
`
