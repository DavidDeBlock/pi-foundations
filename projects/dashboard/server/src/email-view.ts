// email-view.ts — issue #023 (inbox, detail, thread), #024 (hidden list + Hide/Unhide toggle), #025 (tag chips + Add-tag autocomplete + tag filter)
//
// Server-rendered HTML for the email surfaces:
//
//   GET /email                    → inbox (visible only)
//   GET /email/hidden             → hidden emails (#024; for unhide)
//   GET /email/:id                → single email detail (#024: renders hidden emails with an Unhide button)
//   GET /email/thread/:threadId   → chronological thread (hidden messages excluded)
//
// All four pages share one renderer frame (header + sidebar + main)
// and one set of CSS classes. The pages call the same data layer the
// JSON API uses (`listEmails`, `getById`, `getThread`,
// `getByIdIncludingHidden`, `listHiddenEmails`) — never reach into
// the DB directly. That keeps the JSON contract and the HTML
// contract reading the same rows.
//
// #024 design notes (deltas from #023):
//   - The Hide / Unhide button on the detail page is now wired. The
//     page uses `getByIdIncludingHidden` so hidden emails still
//     render (they get an "Unhide" button + a "Hidden" badge), and
//     clicking the button triggers a POST → page reload toggle
//     that matches server state.
//   - `GET /email/hidden` lists hidden emails sorted by `hidden_at
//     DESC` with an Unhide button per row, matching the API
//     `GET /api/email/hidden` shape.
//   - The Tag and Summarize buttons remain placeholders — those
//     land in #025 / #027 respectively.
//   - Provider filter is still a no-op (v1 is Gmail-only).
//   - Pagination is unchanged.
//
// NOT responsible for:
//   - The JSON API (email-read.ts owns that)
//   - OAuth / sync / tag / summarize (later slices)
//   - Mobile-specific layouts

import { Hono } from 'hono'
import type { AuthVariables } from './auth.js'
import type { Database } from './db.js'
import { looksLikeHtml, normalizeStoredEmailBody } from './email-body.js'
import type { EmailSyncWorker } from './email-sync-worker.js'
import {
  listEmails,
  parseCommonFilters,
} from './email-read.js'
import { getThread } from './email-retriever.js'
import {
  getByIdIncludingHidden,
  listHiddenEmails,
  type EmailDetailWithHidden,
} from './email-visibility.js'
import {
  getTagsForEmail,
  listAllTagsWithCounts,
} from './email-tags.js'
import {
  COMMON_HEAD,
  THEME_SCRIPT_TAG,
  HAMBURGER_SCRIPT_TAG,
  renderHeader,
  renderAppNavigation,
  renderSidebarFooter,
} from './view-shared.js'

// ─── HTTP sub-app ─────────────────────────────────────────────────────────

/**
 * Hono sub-app for the email UI pages. Mounted at `/email` by
 * `app.ts`. Mirrors the `emailReadApi` pattern (which is mounted at
 * `/api/email`): the two co-exist because Hono dispatches by exact
 * path match and the leading segments differ.
 *
 * `syncWorker` is optional; when present, the inbox renders a
 * server-side "Last synced X ago" + "Syncing now..." indicator
 * (#026). When absent (setup-only mode without OAuth/sync deps),
 * those parts are simply not rendered.
 */
export function emailViewApi(
  db: Database,
  syncWorker?: EmailSyncWorker,
): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  // ─── GET / ────────────────────────────────────────────────────────
  // Inbox. Query params mirror the JSON API: provider, label, unread,
  // from, tag (#025), cursor, limit. Subject-substring is intentionally
  // omitted here — the inbox is for browsing, search is for full-text
  // queries. The tag filter narrows to emails carrying the given
  // dashboard tag; the active tag is rendered as a chip in the
  // filter bar with a "clear" link.
  api.get('/', (c) => {
    const filters = parseCommonFilters(c, ['from', 'label'])
    const tags = listAllTagsWithCounts(db, 200)
    const response = listEmails(db, filters)
    // Sync summary (#026) — drives the "Last synced X ago" +
    // "Syncing now..." indicator at the top of the inbox.
    // Computed once at render time so the first paint matches
    // server truth; the JS below polls /api/email/sync/status
    // every 30s to keep it fresh.
    const syncSummary = computeSyncSummary(syncWorker, db)
    return c.html(
      renderInboxPage({
        filters: {
          from: filters.from ?? '',
          label: filters.label ?? '',
          unread: filters.unread,
          tag: filters.tag ?? '',
          provider: c.req.query('provider') ?? '',
        },
        response,
        tags,
        syncSummary,
      }),
    )
  })

  // ─── GET /hidden (#024) ───────────────────────────────────────────
  // List hidden emails for the Unhide UI. Declared BEFORE `/:id`
  // so the literal `/hidden` segment doesn't get captured by the
  // catch-all `/:id` route. Mirrors `GET /api/email/hidden`.
  api.get('/hidden', (c) => {
    const limitRaw = c.req.query('limit')
    let limit: number | undefined
    if (typeof limitRaw === 'string' && limitRaw !== '') {
      const n = Number(limitRaw)
      if (Number.isFinite(n)) limit = Math.floor(n)
    }
    const results = listHiddenEmails(db, limit)
    return c.html(renderHiddenListPage(results))
  })

  // ─── GET /thread/:threadId ────────────────────────────────────────
  // Declared BEFORE `/:id` so the literal `/thread/` segment doesn't
  // get captured by the `/:id` route.
  api.get('/thread/:threadId', (c) => {
    const threadId = c.req.param('threadId')
    if (!threadId) return c.html('<p>missing threadId</p>', 400)
    const messages = getThread(db, threadId)
    if (messages.length === 0) return c.html(renderThreadNotFound(threadId), 404)
    return c.html(renderThreadPage(threadId, messages))
  })

  // ─── GET /:id ─────────────────────────────────────────────────────
  // Single email detail (#024: renders hidden emails too;
  // #025: renders tags as chips + an Add-tag autocomplete input).
  // 404 only when the id is unknown; hidden emails render with an
  // "Unhide" button + a "(Hidden)" badge. The toggle persists
  // across reloads because the server re-renders from `hidden_at`
  // on every page load. Tags are read separately via
  // `getTagsForEmail` (issue #025) and passed alongside the detail
  // to the renderer.
  api.get('/:id', (c) => {
    const id = c.req.param('id')
    const detail = getByIdIncludingHidden(db, id)
    if (detail === null) return c.html(renderDetailNotFound(id), 404)
    const tags = getTagsForEmail(db, id)
    const allTags = listAllTagsWithCounts(db, 200).map((t) => t.tag)
    return c.html(renderDetailPage(detail, tags, allTags))
  })

  return api
}

// ─── Renderers ────────────────────────────────────────────────────────────

interface InboxPageArgs {
  readonly filters: {
    readonly from: string
    readonly label: string
    readonly unread: boolean | undefined
    /** Active tag filter (#025). Empty string = no filter. */
    readonly tag: string
    readonly provider: string
  }
  /** Sync observability (#026) — drives the indicator at the top
   *  of the inbox. Computed by `computeSyncSummary` once per render
   *  and kept fresh on the client via a 30-second poll against
   *  `/api/email/sync/status`. */
  readonly syncSummary: SyncSummary
  readonly response: {
    readonly results: ReadonlyArray<{
      readonly id: string
      readonly threadId: string
      readonly subject: string
      readonly sender: string
      readonly senderEmail: string
      readonly receivedAt: string
      readonly snippet: string
      readonly isUnread: boolean
      readonly labels: readonly string[]
    }>
    readonly nextCursor: string | null
  }
  /**
   * All dashboard tags with their counts (#025). Used to render the
   * "All tags" autocomplete in the inbox filter bar and to render
   * tag chips alongside each email row (deferred — for v1 we just
   * expose the active-tag chip in the filter bar; the autocomplete
   * is on the detail page).
   */
  readonly tags: ReadonlyArray<{ readonly tag: string; readonly count: number }>
}

function renderInboxPage(args: InboxPageArgs): string {
  const rowsHtml = args.response.results.length === 0
    ? renderInboxEmpty()
    : `<ul class="email-list">${args.response.results.map(renderInboxRow).join('')}</ul>`

  const paginationHtml = renderInboxPagination(args.response.nextCursor, args.filters)
  // Skip the sync updater when there's nothing to poll (#026).
  // A page with no accounts still renders the indicator element so
  // the markup is consistent across modes, but the JS short-
  // circuits when `data-state="no-accounts"`.
  const syncScriptHtml = args.syncSummary.accounts.length === 0
    ? ''
    : `<script>${EMAIL_SYNC_SCRIPT}</script>`

  return `<!doctype html>
<html lang="en">
  <head>
${COMMON_HEAD}
    <title>Inbox — Dashboard</title>
    <meta name="robots" content="noindex">
    <style>${EMAIL_VIEW_STYLES}</style>
  </head>
  <body>
    ${renderHeader()}
    <div class="layout">
      ${renderEmailSidebar({ active: 'inbox' })}
      <main class="email-main">
        <header class="email-page-header">
          <h1 class="email-page-title">Inbox</h1>
          <div class="email-page-meta">
            <span class="email-page-count">${args.response.results.length} message${args.response.results.length === 1 ? '' : 's'}</span>
            ${renderSyncIndicator(args.syncSummary)}
          </div>
        </header>
        ${renderInboxFilters(args.filters)}
        ${rowsHtml}
        ${paginationHtml}
      </main>
    </div>
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
    <script>${EMAIL_HIDE_SCRIPT}</script>
    ${syncScriptHtml}
  </body>
</html>`
}

function renderInboxRow(r: InboxPageArgs['response']['results'][number]): string {
  const unreadClass = r.isUnread ? ' email-row-unread' : ''
  const relative = formatRelativeTime(r.receivedAt)
  return `
            <li class="email-row${unreadClass}" data-email-row="${escapeHtml(r.id)}">
              <span class="email-unread-dot" aria-hidden="true"></span>
              <a class="email-sender" href="${inboxFilterHref({ from: r.senderEmail })}">${escapeHtml(r.sender)}</a>
              <div class="email-content">
                <a class="email-subject" href="/email/${encodeURIComponent(r.id)}">${escapeHtml(r.subject)}</a>
                <span class="email-snippet">${escapeHtml(r.snippet)}</span>
              </div>
              <span class="email-time" title="${escapeHtml(r.receivedAt)}">${escapeHtml(relative)}</span>
              <span class="email-provider-gmail source-badge" aria-label="Gmail">Gmail</span>
            </li>`
}

function renderInboxEmpty(): string {
  return `
        <div class="email-empty" role="status">
          <div class="email-empty-icon" aria-hidden="true">\u2709\ufe0f</div>
          <p class="email-empty-message">No messages match your filters.</p>
        </div>`
}

function renderInboxFilters(filters: InboxPageArgs['filters']): string {
  // Provider pill is always-on (v1 is Gmail-only). Rendered as a
  // <span> rather than a link so it reads as the current state, not
  // a navigable control. Once a real second provider ships, swap
  // for an <a> and add a no-op for "all".
  const providerPill = `
          <span class="email-filter email-filter-active" aria-label="Provider: Gmail (only provider in v1)">Gmail</span>`

  const labelPills = [
    { id: '',         label: 'All' },
    { id: 'INBOX',    label: 'Inbox' },
    { id: 'SENT',     label: 'Sent' },
    { id: 'STARRED',  label: 'Starred' },
  ]
  const labelHtml = labelPills.map((p) => {
    const active = (filters.label || '') === p.id
    return `<a class="email-filter${active ? ' email-filter-active' : ''}" href="${inboxFilterHref({ label: p.id })}" data-email-label-filter="${escapeHtml(p.id)}">${escapeHtml(p.label)}</a>`
  }).join('')

  const unreadActive = filters.unread === true
  const unreadHtml = `<a class="email-filter${unreadActive ? ' email-filter-active' : ''}" href="${inboxFilterHref({ unread: unreadActive ? '' : '1' })}">Unread only</a>`

  const fromValue = escapeHtml(filters.from)
  const fromHtml = `
          <form class="email-from-filter" method="get" action="/email">
            <input type="search" name="from" placeholder="From\u2026" value="${fromValue}" aria-label="Filter by sender">
            <button type="submit">Apply</button>
            ${filters.from ? `<a class="email-filter-clear" href="${inboxFilterHref({ from: '' })}">Clear</a>` : ''}
          </form>`

  // Active-tag chip (#025). When a tag filter is set, render a
  // "Tagged #launch \u00d7" chip with a clear link so the user can
  // see what's narrowing their inbox.
  const tagChipHtml = filters.tag
    ? `<span class="email-filter email-filter-tag email-filter-active" data-email-active-tag>
            Tagged <code>#${escapeHtml(filters.tag)}</code>
            <a class="email-filter-clear" href="${inboxFilterHref({ tag: '' })}" aria-label="Clear tag filter">\u00d7</a>
          </span>`
    : ''

  // Preserve other filters when applying from-substring. The form
  // has to repeat them as hidden inputs since it's a GET form.
  const hidden = hiddenPreserveExcept(filters, ['from'])
  return `
        <div class="email-filters" role="toolbar">
          ${providerPill}
          ${labelHtml}
          ${unreadHtml}
          ${tagChipHtml}
          ${fromHtml}
          ${hidden}
        </div>`
}

function renderInboxPagination(nextCursor: string | null, filters: InboxPageArgs['filters']): string {
  if (nextCursor === null) return ''
  const href = `/email?${new URLSearchParams({ ...filtersToParams(filters), cursor: nextCursor }).toString()}`
  return `
        <nav class="email-pagination" aria-label="Inbox pagination">
          <a class="email-pagination-next" href="${escapeHtml(href)}">Next page \u2192</a>
        </nav>`
}

function renderThreadPage(_threadId: string, messages: ReadonlyArray<{
  readonly id: string
  readonly threadId: string
  readonly subject: string
  readonly sender: string
  readonly senderEmail: string
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly receivedAt: string
  readonly bodyPlain: string
  readonly bodyHtml: string | null
  readonly isUnread: boolean
  readonly labels: readonly string[]
}>): string {
  const subject = messages[0]?.subject ?? '(no subject)'
  const itemsHtml = messages.map((m) => renderThreadMessage(m)).join('')
  return `<!doctype html>
<html lang="en">
  <head>
${COMMON_HEAD}
    <title>${escapeHtml(subject)} \u2014 Dashboard</title>
    <meta name="robots" content="noindex">
    <style>${EMAIL_VIEW_STYLES}</style>
  </head>
  <body>
    ${renderHeader()}
    <div class="layout">
      ${renderEmailSidebar({ active: 'inbox' })}
      <main class="email-main">
        <header class="email-page-header">
          <h1 class="email-page-title">${escapeHtml(subject)}</h1>
          <span class="email-page-meta">${messages.length} message${messages.length === 1 ? '' : 's'} in thread</span>
        </header>
        <nav class="email-breadcrumb"><a href="/email">\u2190 Back to inbox</a></nav>
        <div class="email-thread">${itemsHtml}
        </div>
      </main>
    </div>
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
  </body>
</html>`
}

function renderThreadMessage(m: {
  readonly id: string
  readonly threadId: string
  readonly subject: string
  readonly sender: string
  readonly senderEmail: string
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly receivedAt: string
  readonly bodyPlain: string
  readonly bodyHtml: string | null
  readonly isUnread: boolean
  readonly labels: readonly string[]
}): string {
  const date = formatAbsoluteDate(m.receivedAt)
  const toLine = m.to.length > 0
    ? `<dt>To</dt><dd>${m.to.map(escapeHtml).join(', ')}</dd>`
    : ''
  const ccLine = m.cc.length > 0
    ? `<dt>Cc</dt><dd>${m.cc.map(escapeHtml).join(', ')}</dd>`
    : ''
  const unreadClass = m.isUnread ? ' email-thread-msg-unread' : ''
  return `
          <article class="email-thread-msg${unreadClass}" data-thread-msg-id="${escapeHtml(m.id)}">
            <header class="email-thread-msg-header">
              <h2 class="email-thread-msg-subject"><a href="/email/${encodeURIComponent(m.id)}">${escapeHtml(m.subject)}</a></h2>
              <span class="email-thread-msg-time"><time datetime="${escapeHtml(m.receivedAt)}">${escapeHtml(date)}</time></span>
            </header>
            <dl class="email-thread-msg-meta">
              <dt>From</dt>
              <dd>${escapeHtml(m.sender)} &lt;${escapeHtml(m.senderEmail)}&gt;</dd>
              ${toLine}
              ${ccLine}
            </dl>
            ${renderEmailBody(m.bodyPlain, m.bodyHtml, 'email-thread-msg-body')}
          </article>`
}

function renderThreadNotFound(threadId: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
${COMMON_HEAD}
    <title>Thread not found \u2014 Dashboard</title>
    <meta name="robots" content="noindex">
    <style>${EMAIL_VIEW_STYLES}</style>
  </head>
  <body>
    ${renderHeader()}
    <div class="layout">
      ${renderEmailSidebar({ active: 'inbox' })}
      <main class="email-main">
        <h1>Thread not found</h1>
        <p>No messages belong to thread <code>${escapeHtml(threadId)}</code>.</p>
        <nav><a href="/email">\u2190 Back to inbox</a></nav>
      </main>
    </div>
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
  </body>
</html>`
}

function renderDetailPage(
  d: EmailDetailWithHidden,
  tags: readonly string[],
  allTags: readonly string[],
): string {
  const date = formatAbsoluteDate(d.receivedAt)
  const toLine = d.to.length > 0
    ? `<dt>To</dt><dd>${d.to.map(escapeHtml).join(', ')}</dd>`
    : ''
  const ccLine = d.cc.length > 0
    ? `<dt>Cc</dt><dd>${d.cc.map(escapeHtml).join(', ')}</dd>`
    : ''
  const labelsHtml = d.labels.length > 0
    ? `<div class="email-detail-labels">${d.labels.map((l) => `<span class="tag">${escapeHtml(l)}</span>`).join('')}</div>`
    : ''
  // #024: when hidden, render an "Unhide" button + a (Hidden) badge.
  // The button text + data-email-action reflect server state on every
  // page load, so a reload always lands on the right toggle.
  const isHidden = d.hiddenAt !== null
  const hideAction = isHidden ? 'unhide' : 'hide'
  const hideLabel = isHidden ? 'Unhide' : 'Hide'
  const hideTitle = isHidden
    ? `Hidden ${escapeHtml(d.hiddenAt ?? '')} — click to restore to default view`
    : 'Hide from inbox, search, and thread (this stays on your dashboard only)'
  const hiddenBadge = isHidden
    ? `<span class="email-detail-hidden-badge" data-email-detail-hidden>Hidden</span>`
    : ''

  // #025: tag chips + add-tag input with autocomplete.
  // Each existing tag is a chip with a × button that removes it
  // (the × button posts DELETE to /api/email/:id/tags/:tag via the
  // shared `EMAIL_TAG_SCRIPT`). The input has a datalist sourced
  // from /api/email/tags so the browser shows existing tags as the
  // user types; pressing Enter adds the typed value (the API
  // normalizes on the server, so any capitalization or leading #
  // is canonicalized).
  const tagsHtml = renderTagChips(tags, d.id)
  const allTagsJson = JSON.stringify(allTags)
  return `<!doctype html>
<html lang="en">
  <head>
${COMMON_HEAD}
    <title>${escapeHtml(d.subject)} \u2014 Dashboard</title>
    <meta name="robots" content="noindex">
    <style>${EMAIL_VIEW_STYLES}</style>
  </head>
  <body>
    ${renderHeader()}
    <div class="layout">
      ${renderEmailSidebar({ active: 'inbox' })}
      <main class="email-main">
        <nav class="email-breadcrumb"><a href="/email">\u2190 Back to inbox</a></nav>
        <article class="email-detail" data-email-hidden="${isHidden ? 'true' : 'false'}" data-email-id="${escapeHtml(d.id)}">
          <header class="email-detail-header">
            <h1 class="email-detail-subject">${escapeHtml(d.subject)} ${hiddenBadge}</h1>
            <p class="email-detail-sender">${escapeHtml(d.sender)} &lt;<a href="${inboxFilterHref({ from: d.senderEmail })}">${escapeHtml(d.senderEmail)}</a>&gt;</p>
            <dl class="email-detail-meta">
              ${toLine}
              ${ccLine}
              <dt>Date</dt>
              <dd><time datetime="${escapeHtml(d.receivedAt)}">${escapeHtml(date)}</time></dd>
              <dt>Thread</dt>
              <dd><a href="/email/thread/${encodeURIComponent(d.threadId)}">View all messages in this thread \u2192</a></dd>
            </dl>
            ${labelsHtml}
          </header>
          ${tagsHtml}
          ${renderEmailBody(d.bodyPlain, d.bodyHtml, 'email-detail-body')}
          <footer class="email-detail-actions" data-email-actions>
            <button type="button" data-email-action="${hideAction}" data-email-hide-button title="${hideTitle}">${hideLabel}</button>
            <button type="button" data-email-action="summarize" disabled title="Summarize is wired in issue #027">Summarize</button>
            <span class="email-action-hint" data-email-action-hint>Summarize arrives in #027</span>
          </footer>
        </article>
      </main>
    </div>
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
    <script>${EMAIL_HIDE_SCRIPT}</script>
    <script>${EMAIL_TAG_SCRIPT}</script>
    <script type="application/json" id="email-all-tags" data-email-all-tags>${escapeHtml(allTagsJson)}</script>
  </body>
</html>`
}

/**
 * Render the tag-chips block (#025). Each tag is a chip with a
 * × button that removes it; the input below adds a new tag (or
 * picks an existing one from the autocomplete datalist).
 */
function renderTagChips(tags: readonly string[], emailId: string): string {
  const chipsHtml = tags.length === 0
    ? `<span class="email-detail-tags-empty" data-email-tags-empty>No tags yet.</span>`
    : `<ul class="email-detail-tag-chips" data-email-tag-chips>
        ${tags.map((t) => `
          <li class="email-tag-chip" data-email-tag-chip data-tag="${escapeHtml(t)}">
            <a class="email-tag-chip-filter" href="${escapeHtml(inboxFilterHref({ tag: t }))}" title="Show all emails tagged #${escapeHtml(t)}">#${escapeHtml(t)}</a>
            <button type="button" class="email-tag-chip-remove" data-email-tag-remove data-tag="${escapeHtml(t)}" aria-label="Remove tag #${escapeHtml(t)}" data-email-id="${escapeHtml(emailId)}">\u00d7</button>
          </li>
        `).join('')}
      </ul>`

  const inputHtml = `
    <form class="email-detail-tag-form" data-email-tag-form method="post" onsubmit="return false">
      <input type="text" name="tag" placeholder="Add tag\u2026" autocomplete="off" list="email-all-tags-list" data-email-tag-input aria-label="Add tag">
      <button type="button" data-email-tag-add>Add</button>
      <span class="email-tag-error" data-email-tag-error></span>
    </form>`

  return `
    <section class="email-detail-tags" data-email-detail-tags>
      <h2 class="email-detail-tags-heading">Tags</h2>
      ${chipsHtml}
      ${inputHtml}
      <datalist id="email-all-tags-list"></datalist>
    </section>`
}

function renderDetailNotFound(id: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
${COMMON_HEAD}
    <title>Email not found \u2014 Dashboard</title>
    <meta name="robots" content="noindex">
    <style>${EMAIL_VIEW_STYLES}</style>
  </head>
  <body>
    ${renderHeader()}
    <div class="layout">
      ${renderEmailSidebar({ active: 'inbox' })}
      <main class="email-main">
        <h1>Email not found</h1>
        <p>No email with id <code>${escapeHtml(id)}</code>.</p>
        <nav><a href="/email">\u2190 Back to inbox</a></nav>
      </main>
    </div>
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
  </body>
</html>`
}

// ─── renderHiddenListPage (#024) ──────────────────────────────────────────

/**
 * Server-rendered "Hidden emails" page at `/email/hidden`. Mirrors
 * the inbox list shape so the same row styles apply: sender +
 * subject + snippet + received time + an Unhide button per row.
 * Sorted by hidden_at DESC (most recently hidden first).
 */
function renderHiddenListPage(rows: ReadonlyArray<{
  readonly id: string
  readonly threadId: string
  readonly accountId: string
  readonly subject: string
  readonly sender: string
  readonly senderEmail: string
  readonly receivedAt: string
  readonly snippet: string
  readonly isUnread: boolean
  readonly labels: readonly string[]
  readonly hiddenAt: string
}>): string {
  const rowsHtml = rows.length === 0
    ? `
        <div class="email-empty" role="status">
          <div class="email-empty-icon" aria-hidden="true">\ud83e\udd75</div>
          <p class="email-empty-message">No hidden messages.</p>
        </div>`
    : `<ul class="email-list email-list-hidden">${rows.map(renderHiddenRow).join('')}</ul>`

  return `<!doctype html>
<html lang="en">
  <head>
${COMMON_HEAD}
    <title>Hidden emails \u2014 Dashboard</title>
    <meta name="robots" content="noindex">
    <style>${EMAIL_VIEW_STYLES}</style>
  </head>
  <body>
    ${renderHeader()}
    <div class="layout">
      ${renderEmailSidebar({ active: 'hidden' })}
      <main class="email-main">
        <header class="email-page-header">
          <h1 class="email-page-title">Hidden emails</h1>
          <span class="email-page-meta">${rows.length} message${rows.length === 1 ? '' : 's'} hidden</span>
        </header>
        <p class="email-page-blurb">Hidden messages stay out of your inbox, search, and thread view. Click Unhide to restore.</p>
        ${rowsHtml}
      </main>
    </div>
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
    <script>${EMAIL_HIDE_SCRIPT}</script>
  </body>
</html>`
}

function renderHiddenRow(r: {
  readonly id: string
  readonly threadId: string
  readonly accountId: string
  readonly subject: string
  readonly sender: string
  readonly senderEmail: string
  readonly receivedAt: string
  readonly snippet: string
  readonly isUnread: boolean
  readonly labels: readonly string[]
  readonly hiddenAt: string
}): string {
  const unreadClass = r.isUnread ? ' email-row-unread' : ''
  const relativeReceived = formatRelativeTime(r.receivedAt)
  return `
            <li class="email-row${unreadClass}" data-email-row="${escapeHtml(r.id)}">
              <span class="email-unread-dot" aria-hidden="true"></span>
              <a class="email-sender" href="/email/${encodeURIComponent(r.id)}">${escapeHtml(r.sender)}</a>
              <div class="email-content">
                <a class="email-subject" href="/email/${encodeURIComponent(r.id)}">${escapeHtml(r.subject)}</a>
                <span class="email-snippet">${escapeHtml(r.snippet)}</span>
              </div>
              <span class="email-time" title="received ${escapeHtml(r.receivedAt)}">${escapeHtml(relativeReceived)}</span>
              <span class="email-provider-gmail source-badge" aria-label="Gmail">Gmail</span>
              <button type="button" class="email-row-action" data-email-action="unhide" data-email-hide-button data-email-id="${escapeHtml(r.id)}" title="Hidden ${escapeHtml(r.hiddenAt)} \u2014 click to restore">Unhide</button>
            </li>`
}

// ─── Sync summary (#026) ────────────────────────────────────────────────────
//
// The inbox renders a compact "Last synced X ago" / "Syncing now..."
// indicator in the page header. The JS below keeps it fresh by
// polling `/api/email/sync/status` every 30 seconds. Initial values
// come from `computeSyncSummary(syncWorker, db)` so the first paint
// matches server truth without an extra round-trip.

export interface SyncSummary {
  /** Most-recent sync across all connected accounts, or null. */
  readonly lastSyncAt: string | null
  /** True if ANY connected account currently has inProgress=true. */
  readonly inProgress: boolean
  /** Per-account detail for the status pill. Empty if no worker
   *  was injected (setup-only mode). */
  readonly accounts: ReadonlyArray<{
    readonly accountId: string
    readonly emailAddress: string
    readonly lastSyncAt: string | null
    readonly inProgress: boolean
  }>
  /** Server clock in ms — passed through so the JS updater can
   *  compute "X ago" without trusting client-time. */
  readonly serverNowMs: number
}

export function computeSyncSummary(
  syncWorker: EmailSyncWorker | undefined,
  db: Database,
): SyncSummary {
  // Read directly from the DB / worker when the slice is wired up;
  // return a "no accounts" shape when the optional worker is absent
  // (setup-only mode without OAuth/sync).
  if (!syncWorker) {
    return {
      lastSyncAt: null,
      inProgress: false,
      accounts: [],
      serverNowMs: Date.now(),
    }
  }
  // We deliberately don't decrypt here — the worker doesn't need
  // the email address, only the id + status. Iterate the bare
  // accounts table.
  const accounts = db.all<{ id: string; email_address: string }>(
    `SELECT id, email_address FROM email_accounts ORDER BY connected_at DESC, id ASC`,
  )
  const rows = accounts.map((a) => {
    const s = syncWorker.status(a.id)
    return {
      accountId: a.id,
      emailAddress: a.email_address,
      lastSyncAt: s.lastSyncAt,
      inProgress: s.inProgress,
    }
  })
  // The "last synced" line at the top reports the most-recent
  // (across all accounts). `acc.lastSyncAt` is an ISO string — we
  // compare by Date.valueOf so timestamps in the same second still
  // pick the latest.
  let bestSync: string | null = null
  for (const a of rows) {
    if (a.lastSyncAt === null) continue
    if (bestSync === null || Date.parse(a.lastSyncAt) > Date.parse(bestSync)) {
      bestSync = a.lastSyncAt
    }
  }
  return {
    lastSyncAt: bestSync,
    inProgress: rows.some((r) => r.inProgress),
    accounts: rows,
    serverNowMs: Date.now(),
  }
}

/** Render the compact indicator in the inbox header. */
function renderSyncIndicator(sync: SyncSummary): string {
  // The wrapper carries data-* attributes so the JS below can
  // swap the inner text without re-rendering the rest of the
  // page. When there are no accounts at all we render an empty
  // placeholder so the JS still has a mount point.
  if (sync.accounts.length === 0) {
    return `<span class="email-sync-indicator" data-email-sync-indicator data-state="no-accounts"></span>`
  }
  const lastSyncText = sync.lastSyncAt
    ? `Last synced <time data-email-sync-last="${escapeHtml(sync.lastSyncAt)}" title="${escapeHtml(sync.lastSyncAt)}">${escapeHtml(formatSyncTime(sync.lastSyncAt, sync.serverNowMs))}</time>`
    : 'Never synced'
  const inProgressHtml = sync.inProgress
    ? `<span class="email-sync-spinner" data-email-sync-spinner>
            <span class="email-sync-spinner-mark" aria-hidden="true">\u21bb</span>
            <span class="email-sync-spinner-label">Syncing now\u2026</span>
          </span>`
    : '<span class="email-sync-spinner" data-email-sync-spinner hidden></span>'
  return `
        <span class="email-sync-indicator" data-email-sync-indicator data-state="${sync.inProgress ? 'syncing' : 'idle'}">
          <span class="email-sync-last" data-email-sync-last>${lastSyncText}</span>
          ${inProgressHtml}
        </span>`
}

/** Compact relative time for the "Last synced X ago" line. Same
 *  shape as `formatRelativeTime` in activity-feed.ts — kept local
 *  to avoid a shared helper for a 12-line function. */
function formatSyncTime(iso: string, nowMs: number): string {
  const then = new Date(iso).valueOf()
  if (Number.isNaN(then)) return iso
  const diffMs = nowMs - then
  if (diffMs < 0) return 'just now'
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day === 1) return 'yesterday'
  if (day < 7) return `${day}d ago`
  // Older than a week — absolute date. Match activity-feed.ts shape
  // ("Mar 15" same year, "Mar 2025" otherwise) so the dashboard feels
  // consistent.
  const d = new Date(then)
  const now = new Date(nowMs)
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

// ─── Sidebar ──────────────────────────────────────────────────────────────

interface EmailSidebarArgs {
  readonly active: 'inbox' | 'thread' | 'detail' | 'hidden'
}

/**
 * Render the sidebar for the email pages. The "Email" section title
 * matches the styling pass (#013) — `.sidebar-section` + `.sidebar-title`
 * + a single `.compartment-nav`-style list. Inbox is the primary
 * entry; the Hidden link (#024) lands here too.
 *
 * The active item gets `.compartment-button-active` so the visual
 * state matches the existing styling.
 */
function renderEmailSidebar(args: EmailSidebarArgs): string {
  const context = args.active === 'hidden' ? 'hidden' : 'inbox'
  return `
      <aside class="sidebar" data-sidebar>
        ${renderAppNavigation({ active: 'email', context })}
        ${renderSidebarFooter('Gmail · synced messages')}
      </aside>`
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Build a /email link that preserves the current filter set, with the
 *  listed overrides set to new values (or cleared if empty). */
function inboxFilterHref(overrides: {
  readonly from?: string
  readonly label?: string
  readonly unread?: string
  readonly tag?: string
  readonly cursor?: string
}): string {
  // The current request is not in scope here; we only know the
  // *target* state. The caller passes a complete filter snapshot
  // via `filtersToParams` when needed. For a one-arg override we
  // use the override values as the new filter set, omitting the
  // rest. (We can't merge with the *previous* request state without
  // a JS round-trip — the override link is the *full* new state.)
  const params = new URLSearchParams()
  if (overrides.from !== undefined && overrides.from !== '') params.set('from', overrides.from)
  if (overrides.label !== undefined && overrides.label !== '') params.set('label', overrides.label)
  if (overrides.unread !== undefined && overrides.unread !== '') params.set('unread', overrides.unread)
  if (overrides.tag !== undefined && overrides.tag !== '') params.set('tag', overrides.tag)
  if (overrides.cursor !== undefined && overrides.cursor !== '') params.set('cursor', overrides.cursor)
  const q = params.toString()
  return q ? `/email?${q}` : '/email'
}

function filtersToParams(filters: InboxPageArgs['filters']): Record<string, string> {
  const out: Record<string, string> = {}
  if (filters.from) out.from = filters.from
  if (filters.label) out.label = filters.label
  if (filters.unread === true) out.unread = '1'
  if (filters.tag) out.tag = filters.tag
  if (filters.provider) out.provider = filters.provider
  return out
}

/** Render hidden inputs for the from-filter form so other filters
 *  survive the GET submit. Skips the keys listed in `skip`. */
function hiddenPreserveExcept(
  filters: InboxPageArgs['filters'],
  skip: readonly string[],
): string {
  const params = filtersToParams(filters)
  const skipSet = new Set(skip)
  return Object.entries(params)
    .filter(([k]) => !skipSet.has(k))
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('')
}

/** ISO timestamp → short human relative ("2h ago", "yesterday", "Mar 5").
 *  Renders the raw ISO into `title=` for hover. */
function formatRelativeTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.valueOf())) return iso
  const now = Date.now()
  const deltaMs = now - d.getTime()
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatAbsoluteDate(iso: string): string {
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderEmailBody(bodyPlain: string, bodyHtml: string | null, className: string): string {
  // Rows synced before migration 011 may contain raw HTML in body_plain.
  const html = bodyHtml ?? (looksLikeHtml(bodyPlain) ? bodyPlain : null)
  if (html === null) {
    return `<pre class="${className}">${escapeHtml(normalizeStoredEmailBody(bodyPlain))}</pre>`
  }

  const safeBody = html
    .replace(/<(script|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?:meta|base|link)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, '')
  const srcdoc = `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:;">
<base target="_blank">
<style>:root{color-scheme:light only}html{background:#fff}body{box-sizing:border-box;margin:0;padding:20px;color:#1f2937;background:#fff;font:14px/1.55 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#2563eb}</style>
</head><body>${safeBody}</body></html>`
  return `<iframe class="${className} email-html-body" title="Rendered email content" sandbox referrerpolicy="no-referrer" loading="lazy" srcdoc="${escapeHtml(srcdoc)}"></iframe>`
}

// ─── Styles ───────────────────────────────────────────────────────────────

const EMAIL_VIEW_STYLES = `
.email-main { flex: 1; min-width: 0; padding: 1.5rem 2rem; max-width: 960px; }
.email-page-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 1.25rem; }
.email-page-title { margin: 0; font-size: 1.5rem; font-weight: 600; }
.email-page-meta { color: var(--muted); font-size: 0.85rem; display: flex; flex-direction: column; gap: 0.25rem; align-items: flex-end; }
.email-page-count { display: inline-block; }
.email-sync-indicator { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; font-size: 0.8rem; }
.email-sync-spinner { display: inline-flex; align-items: center; gap: 0.3rem; color: var(--accent); font-weight: 500; }
.email-sync-spinner[hidden] { display: none; }
.email-sync-spinner-mark { display: inline-block; animation: email-sync-spin 1.1s linear infinite; font-size: 0.95rem; }
@keyframes email-sync-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.email-sync-indicator[data-state="no-accounts"]::before { content: ''; }
.email-breadcrumb { margin-bottom: 1rem; }
.email-breadcrumb a { color: var(--accent); text-decoration: none; font-size: 0.875rem; }
.email-breadcrumb a:hover { text-decoration: underline; }
.sidebar-account-note { color: var(--muted); font-size: 0.8rem; padding: 0 0.6rem; margin: 0.25rem 0 0; }
.email-empty { padding: 3rem 1rem; text-align: center; color: var(--muted); border: 1px dashed var(--border); border-radius: 0.5rem; }
.email-empty-icon { font-size: 2.5rem; margin-bottom: 0.5rem; }
.email-empty-message { margin: 0; }
.email-from-filter { display: flex; gap: 0.4rem; margin-left: auto; }
.email-from-filter input[type="search"] { padding: 0.35rem 0.6rem; font-size: 0.85rem; border: 1px solid var(--border); border-radius: 0.375rem; background: var(--surface); color: var(--text); min-width: 12rem; }
.email-from-filter button { padding: 0.35rem 0.75rem; font-size: 0.85rem; border: 1px solid var(--border); border-radius: 0.375rem; background: var(--surface); color: var(--text); cursor: pointer; }
.email-from-filter button:hover { background: var(--surface-hover); }
.email-filter-clear { color: var(--muted); text-decoration: none; font-size: 0.8rem; align-self: center; }
.email-filter-clear:hover { color: var(--text); }
.email-pagination { display: flex; justify-content: flex-end; margin-top: 1rem; }
.email-pagination-next { color: var(--accent); text-decoration: none; font-size: 0.875rem; }
.email-pagination-next:hover { text-decoration: underline; }
.email-detail { background: var(--surface); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1.5rem; }
.email-detail[data-email-hidden="true"] { border-left: 3px solid var(--muted); }
.email-detail-subject { margin: 0 0 0.5rem; font-size: 1.4rem; font-weight: 600; }
.email-detail-sender { margin: 0 0 1rem; color: var(--muted); font-size: 0.95rem; }
.email-detail-meta { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; font-size: 0.875rem; color: var(--text); margin: 0 0 1rem; }
.email-detail-meta dt { color: var(--muted); font-weight: 500; }
.email-detail-meta dd { margin: 0; }
.email-detail-meta a { color: var(--accent); text-decoration: none; }
.email-detail-meta a:hover { text-decoration: underline; }
.email-detail-labels { margin-bottom: 1rem; }
.email-detail-body { white-space: pre-wrap; word-wrap: break-word; font-family: inherit; margin: 0 0 1.5rem; font-size: 0.95rem; line-height: 1.5; }
.email-html-body { display: block; width: 100%; min-height: 32rem; border: 1px solid var(--border); border-radius: 0.5rem; background: #fff; color-scheme: light; }
.email-detail-actions { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; padding-top: 1rem; border-top: 1px solid var(--border); }
.email-detail-actions button { padding: 0.4rem 0.85rem; font-size: 0.85rem; border: 1px solid var(--border); border-radius: 0.375rem; background: var(--surface); color: var(--text); cursor: pointer; }
.email-detail-actions button:disabled { cursor: not-allowed; opacity: 0.5; }
.email-action-hint { color: var(--muted); font-size: 0.8rem; }
.email-detail-hidden-badge { display: inline-block; font-size: 0.7rem; font-weight: 500; padding: 0.15rem 0.5rem; border-radius: 999px; background: var(--muted); color: var(--surface); margin-left: 0.5rem; vertical-align: middle; }
.email-page-blurb { color: var(--muted); font-size: 0.9rem; margin: 0 0 1.25rem; }
.email-row-action { padding: 0.3rem 0.7rem; font-size: 0.8rem; border: 1px solid var(--border); border-radius: 0.375rem; background: var(--surface); color: var(--text); cursor: pointer; flex-shrink: 0; }
.email-row-action:hover { background: var(--surface-hover); }
.email-row-action:disabled { cursor: not-allowed; opacity: 0.5; }
.email-thread { display: flex; flex-direction: column; gap: 1rem; }
.email-thread-msg { background: var(--surface); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1.25rem; }
.email-thread-msg-unread { border-left: 3px solid var(--accent); }
.email-thread-msg-header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: 0.5rem; }
.email-thread-msg-subject { margin: 0; font-size: 1.05rem; font-weight: 500; }
.email-thread-msg-subject a { color: var(--text); text-decoration: none; }
.email-thread-msg-subject a:hover { color: var(--accent); }
.email-thread-msg-time { color: var(--muted); font-size: 0.8rem; flex-shrink: 0; }
.email-thread-msg-meta { display: grid; grid-template-columns: max-content 1fr; gap: 0.2rem 1rem; font-size: 0.85rem; color: var(--text); margin: 0 0 1rem; }
.email-thread-msg-meta dt { color: var(--muted); font-weight: 500; }
.email-thread-msg-meta dd { margin: 0; }
.email-thread-msg-body { white-space: pre-wrap; word-wrap: break-word; font-family: inherit; margin: 0; font-size: 0.9rem; line-height: 1.5; }
.email-thread-msg-body.email-html-body { min-height: 20rem; }
/* ─── Tags (#025) ────────────────────────────────────────────────── */
.email-detail-tags { margin: 0 0 1.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border); }
.email-detail-tags-heading { margin: 0.5rem 0 0.5rem; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
.email-detail-tag-chips { list-style: none; padding: 0; margin: 0 0 0.75rem; display: flex; flex-wrap: wrap; gap: 0.4rem; }
.email-tag-chip { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.2rem 0.25rem 0.2rem 0.55rem; background: var(--surface-hover); border: 1px solid var(--border); border-radius: 999px; font-size: 0.8rem; }
.email-tag-chip-filter { color: var(--accent); text-decoration: none; font-weight: 500; }
.email-tag-chip-filter:hover { text-decoration: underline; }
.email-tag-chip-remove { background: transparent; border: 0; color: var(--muted); cursor: pointer; font-size: 0.95rem; padding: 0 0.4rem; border-radius: 999px; }
.email-tag-chip-remove:hover { background: var(--surface); color: var(--text); }
.email-detail-tags-empty { color: var(--muted); font-size: 0.85rem; margin: 0 0 0.75rem; display: inline-block; }
.email-detail-tag-form { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
.email-detail-tag-form input[type="text"] { padding: 0.3rem 0.6rem; font-size: 0.85rem; border: 1px solid var(--border); border-radius: 0.375rem; background: var(--surface); color: var(--text); min-width: 12rem; }
.email-detail-tag-form button { padding: 0.3rem 0.75rem; font-size: 0.85rem; border: 1px solid var(--border); border-radius: 0.375rem; background: var(--surface); color: var(--text); cursor: pointer; }
.email-detail-tag-form button:hover { background: var(--surface-hover); }
.email-tag-error { color: #b54545; font-size: 0.8rem; min-height: 1em; }
.email-filter-tag { display: inline-flex; align-items: center; gap: 0.4rem; }
.email-filter-tag code { font-family: ui-monospace, "SF Mono", monospace; font-size: 0.8rem; background: var(--surface); padding: 0.05rem 0.35rem; border-radius: 0.25rem; }
@media (max-width: 720px) {
  .email-main { padding: 1rem; }
  .email-detail { padding: 1rem; }
  .email-thread-msg { padding: 0.875rem; }
  .email-from-filter { margin-left: 0; margin-top: 0.5rem; width: 100%; }
  .email-from-filter input[type="search"] { flex: 1; min-width: 0; }
  .email-detail-tag-form { width: 100%; }
  .email-detail-tag-form input[type="text"] { flex: 1; min-width: 0; }
}
`

// Email action handler (#024). Wires the Hide / Unhide button on
// the detail page AND the Unhide button on the hidden list page.
// Both call the same JSON endpoints (POST /api/email/:id/hide and
// POST /api/email/:id/unhide). On success we reload — the page is
// server-rendered from `hidden_at` so a reload is the source of
// truth and avoids a stale local toggle.
//
// Tag and Summarize remain disabled buttons for #025 / #027 to wire
// up; the script ignores them.
const EMAIL_HIDE_SCRIPT = `(function(){
  function bindHideButton(btn){
    if (btn.__emailHideBound) return;
    btn.__emailHideBound = true;
    btn.addEventListener('click', async function(ev){
      ev.preventDefault();
      if (btn.disabled) return;
      var article = btn.closest('article');
      var emailId = btn.getAttribute('data-email-id');
      if (!emailId) {
        // Inbox rows don't carry data-email-id; pull from the row.
        var row = btn.closest('[data-email-row]');
        if (row) emailId = row.getAttribute('data-email-row');
      }
      if (!emailId) return;
      var action = btn.getAttribute('data-email-action');
      if (action !== 'hide' && action !== 'unhide') return;
      btn.disabled = true;
      try {
        var res = await fetch('/api/email/' + encodeURIComponent(emailId) + '/' + action, {
          method: 'POST',
          credentials: 'include',
        });
        if (res.status === 401) {
          // Auth lapsed mid-session — bounce the browser to the auth prompt.
          window.location.href = '/api/login';
          return;
        }
        if (!res.ok && res.status !== 204) {
          throw new Error('HTTP ' + res.status);
        }
        // Reload so the server-rendered state reflects the new hidden flag.
        window.location.reload();
      } catch (err) {
        btn.disabled = false;
        if (article) {
          var hint = article.querySelector('[data-email-action-hint]');
          if (hint) hint.textContent = 'Failed to update: ' + (err && err.message ? err.message : 'unknown');
          else alert('Failed to update hide state: ' + err);
        } else {
          alert('Failed to update hide state: ' + err);
        }
      }
    }, false);
  }
  var buttons = document.querySelectorAll('[data-email-hide-button]');
  for (var i = 0; i < buttons.length; i++) bindHideButton(buttons[i]);
})();`

// Tag CRUD handler (#025). Wires the add-tag input, the chip
// × buttons (DELETE), and the autocomplete datalist. The server
// is the source of truth — after any mutation we reload so the
// rendered chips reflect the canonical state.
//
// The autocomplete datalist is populated from a `<script
// type="application/json">` block rendered by the server, so the
// user gets existing tags as suggestions even before any network
// round-trip. The block contains the normalized tag strings
// (e.g. ["launch","waiting-on-sarah","work/urgent"]); we map
// each into a <option value="..."> for the browser's built-in
// combobox UI.
const EMAIL_TAG_SCRIPT = `(function(){
  // ─── Datalist population ──────────────────────────────────────────────
  var dl = document.getElementById('email-all-tags-list');
  var jsonEl = document.getElementById('email-all-tags');
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

  // ─── Add tag ────────────────────────────────────────────────────────
  var addBtn = document.querySelector('[data-email-tag-add]');
  var input = document.querySelector('[data-email-tag-input]');
  var errEl = document.querySelector('[data-email-tag-error]');
  function setError(msg){
    if (errEl) errEl.textContent = msg || '';
  }
  async function doAdd(){
    if (!input) return;
    var raw = input.value.trim();
    if (!raw){ setError('Type a tag first.'); return; }
    var article = document.querySelector('[data-email-id]');
    if (!article) return;
    var emailId = article.getAttribute('data-email-id');
    if (!emailId) return;
    setError('');
    if (addBtn) addBtn.disabled = true;
    try {
      var res = await fetch('/api/email/' + encodeURIComponent(emailId) + '/tags', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ tag: raw }),
      });
      if (res.status === 401) { window.location.href = '/api/login'; return; }
      if (res.status === 400) {
        var body = {};
        try { body = await res.json(); } catch (e) { /* ignore */ }
        setError((body && body.message) ? body.message : 'Invalid tag.');
        if (addBtn) addBtn.disabled = false;
        return;
      }
      if (res.status === 404) {
        setError('Email not found.');
        if (addBtn) addBtn.disabled = false;
        return;
      }
      if (!res.ok && res.status !== 204) {
        throw new Error('HTTP ' + res.status);
      }
      // Success — reload to read the canonical chip list.
      window.location.reload();
    } catch (err) {
      if (addBtn) addBtn.disabled = false;
      setError('Failed to add tag: ' + (err && err.message ? err.message : 'unknown'));
    }
  }
  if (addBtn) addBtn.addEventListener('click', function(ev){ ev.preventDefault(); doAdd(); });
  if (input) input.addEventListener('keydown', function(ev){
    if (ev.key === 'Enter') { ev.preventDefault(); doAdd(); }
  });

  // ─── Remove tag (× on each chip) ────────────────────────────────────
  var removeBtns = document.querySelectorAll('[data-email-tag-remove]');
  for (var i = 0; i < removeBtns.length; i++) (function(btn){
    btn.addEventListener('click', async function(ev){
      ev.preventDefault();
      var tag = btn.getAttribute('data-tag');
      var emailId = btn.getAttribute('data-email-id');
      if (!tag || !emailId) return;
      btn.disabled = true;
      try {
        var res = await fetch('/api/email/' + encodeURIComponent(emailId) + '/tags/' + encodeURIComponent(tag), {
          method: 'DELETE',
          credentials: 'include',
        });
        if (res.status === 401) { window.location.href = '/api/login'; return; }
        if (!res.ok && res.status !== 204) {
          throw new Error('HTTP ' + res.status);
        }
        window.location.reload();
      } catch (err) {
        btn.disabled = false;
        setError('Failed to remove tag: ' + (err && err.message ? err.message : 'unknown'));
      }
    });
  })(removeBtns[i]);
})();`

// ─── Sync indicator updater (#026) ─────────────────────────────────
//
// Polls /api/email/sync/status every 30 seconds and keeps the
// "Last synced X ago" + "Syncing now..." indicator at the top of
// the inbox up to date without a full page reload. We use the
// server's `nowMs` from the response to compute "ago" so the
// displayed value is wall-clock consistent with the server's
// lastSyncAt timestamps (no client-clock drift weirdness).
//
// The script is the ONLY client code coupled to the sync slice
// — the rest of the inbox is server-rendered. When the indicator
// is missing (e.g. no accounts connected, or a setup-only-mode
// server), the script short-circuits and installs nothing.
const EMAIL_SYNC_SCRIPT = `(function(){
  var indicator = document.querySelector('[data-email-sync-indicator]');
  if (!indicator) return;
  if (indicator.getAttribute('data-state') === 'no-accounts') return;

  var POLL_MS = 30000; // 30s — matches the AC.
  var serverNowMsInitial = Number(indicator.getAttribute('data-server-now-ms') || Date.now());
  var clientOffsetMs = Date.now() - serverNowMsInitial;

  function serverNowMs(){
    return Date.now() - clientOffsetMs;
  }

  function formatRelative(iso){
    var then = new Date(iso).valueOf();
    if (isNaN(then)) return iso;
    var diffMs = serverNowMs() - then;
    if (diffMs < 0) return 'just now';
    var sec = Math.floor(diffMs / 1000);
    if (sec < 60) return 'just now';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    var day = Math.floor(hr / 24);
    if (day === 1) return 'yesterday';
    if (day < 7) return day + 'd ago';
    var d = new Date(then);
    var now = new Date(serverNowMs());
    var sameYear = d.getFullYear() === now.getFullYear();
    var opts = { month: 'short', day: 'numeric' };
    if (!sameYear) opts.year = 'numeric';
    return d.toLocaleString('en-US', opts);
  }

  function latestSync(accounts){
    var best = null;
    var bestMs = -1;
    for (var i = 0; i < accounts.length; i++) {
      var a = accounts[i];
      if (!a.lastSyncAt) continue;
      var ms = new Date(a.lastSyncAt).valueOf();
      if (isNaN(ms)) continue;
      if (ms > bestMs) { bestMs = ms; best = a.lastSyncAt; }
    }
    return best;
  }

  function applyStatus(payload){
    if (!payload || !Array.isArray(payload.accounts)) return;
    // The server's clock is the source of truth for "ago". Pull
    // it from the response so clock-skew between the dashboard
    // box and the browser doesn't visibly drift.
    if (typeof payload.nowMs === 'number') {
      clientOffsetMs = Date.now() - payload.nowMs;
    }
    var lastSync = latestSync(payload.accounts);
    var inProgress = false;
    for (var i = 0; i < payload.accounts.length; i++) {
      if (payload.accounts[i].inProgress) { inProgress = true; break; }
    }
    var lastEl = indicator.querySelector('[data-email-sync-last]');
    var spinner = indicator.querySelector('[data-email-sync-spinner]');
    if (lastEl) {
      if (lastSync) {
        var safeIso = String(lastSync).replace(/"/g, '&quot;');
        lastEl.innerHTML = 'Last synced <time data-email-sync-last="' + safeIso + '" title="' + safeIso + '">' + formatRelative(lastSync) + '</time>';
      } else {
        lastEl.textContent = 'Never synced';
      }
    }
    if (spinner) {
      if (inProgress) {
        spinner.removeAttribute('hidden');
        spinner.innerHTML = '<span class="email-sync-spinner-mark" aria-hidden="true">\u21bb</span><span class="email-sync-spinner-label">Syncing now\u2026</span>';
      } else {
        spinner.setAttribute('hidden', '');
        spinner.innerHTML = '';
      }
    }
    indicator.setAttribute('data-state', inProgress ? 'syncing' : 'idle');
  }

  function poll(){
    fetch('/api/email/sync/status', { credentials: 'same-origin' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(p){ if (p) applyStatus(p); })
      .catch(function(){ /* network blip — try again next tick */ });
  }

  // First refresh happens after 30s — the page already shows
  // authoritative server-time "X ago" from the initial render.
  setInterval(poll, POLL_MS);
})();`
