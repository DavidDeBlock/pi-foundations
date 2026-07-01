// email-view.ts — issue #023
//
// Server-rendered HTML for the three email surfaces:
//
//   GET /email                    → inbox
//   GET /email/:id                → single email detail (plain body)
//   GET /email/thread/:threadId   → chronological thread
//
// All three pages share one renderer frame (header + sidebar + main)
// and one set of CSS classes. The pages call the same data layer the
// JSON API uses (`listEmails`, `getById`, `getThread`) — never reach
// into the DB directly. That keeps the JSON contract and the HTML
// contract reading the same rows.
//
// #023 design notes:
//   - The "Hide", "Tag", "Summarize" buttons on the detail page are
//     visual placeholders. Wiring lands in #024 (hide), #025 (tag),
//     and #027 (summarize). For now they alert "coming soon" via
//     inline `data-*` hooks so the JS can be added later without
//     re-touching the renderer.
//   - Provider filter ("Gmail") is a no-op in v1: every account is
//     Gmail. The pill is still rendered so the URL contract (?provider=gmail)
//     is established — a real filter lands when Outlook support ships.
//   - Pagination uses the keyset cursor returned by `listEmails` and
//     surfaces it as a "Next →" link. "Previous" is not supported —
//     keyset pagination only goes forward.
//   - Sidebar has an "Email" section with the Inbox link. The
//     existing `.sidebar-section` + `.sidebar-title` pattern is
//     reused so the visual language matches the styling pass.
//
// NOT responsible for:
//   - The JSON API (email-read.ts owns that)
//   - OAuth / sync / hide / tag / summarize (later slices)
//   - Mobile-specific layouts (the global responsive CSS at the
//     bottom of styles.css handles that)

import { Hono } from 'hono'
import type { AuthVariables } from './auth.js'
import type { Database } from './db.js'
import {
  listEmails,
  parseCommonFilters,
} from './email-read.js'
import { getById, getThread } from './email-retriever.js'
import {
  COMMON_HEAD,
  THEME_SCRIPT_TAG,
  HAMBURGER_SCRIPT_TAG,
  renderHeader,
} from './view-shared.js'

// ─── HTTP sub-app ─────────────────────────────────────────────────────────

/**
 * Hono sub-app for the three email UI pages. Mounted at `/email` by
 * `app.ts`. Mirrors the `emailReadApi` pattern (which is mounted at
 * `/api/email`): the two co-exist because Hono dispatches by exact
 * path match and the leading segments differ.
 */
export function emailViewApi(db: Database): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  // ─── GET / ────────────────────────────────────────────────────────
  // Inbox. Query params mirror the JSON API: provider, label, unread,
  // from, cursor, limit. Subject-substring is intentionally omitted
  // here — the inbox is for browsing, search is for full-text queries.
  api.get('/', (c) => {
    const filters = parseCommonFilters(c, ['from', 'label'])
    const response = listEmails(db, filters)
    return c.html(
      renderInboxPage({
        filters: {
          from: filters.from ?? '',
          label: filters.label ?? '',
          unread: filters.unread,
          provider: c.req.query('provider') ?? '',
        },
        response,
      }),
    )
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
  // Single email detail. 404 when the id is unknown OR hidden (the
  // retriever filters both into `null`).
  api.get('/:id', (c) => {
    const id = c.req.param('id')
    const detail = getById(db, id)
    if (detail === null) return c.html(renderDetailNotFound(id), 404)
    return c.html(renderDetailPage(detail))
  })

  return api
}

// ─── Renderers ────────────────────────────────────────────────────────────

interface InboxPageArgs {
  readonly filters: {
    readonly from: string
    readonly label: string
    readonly unread: boolean | undefined
    readonly provider: string
  }
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
}

function renderInboxPage(args: InboxPageArgs): string {
  const rowsHtml = args.response.results.length === 0
    ? renderInboxEmpty()
    : `<ul class="email-list">${args.response.results.map(renderInboxRow).join('')}</ul>`

  const paginationHtml = renderInboxPagination(args.response.nextCursor, args.filters)

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
          <span class="email-page-meta">${args.response.results.length} message${args.response.results.length === 1 ? '' : 's'}</span>
        </header>
        ${renderInboxFilters(args.filters)}
        ${rowsHtml}
        ${paginationHtml}
      </main>
    </div>
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
    <script>${EMAIL_VIEW_SCRIPT}</script>
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

  // Preserve other filters when applying from-substring. The form
  // has to repeat them as hidden inputs since it's a GET form.
  const hidden = hiddenPreserveExcept(filters, ['from'])
  return `
        <div class="email-filters" role="toolbar">
          ${providerPill}
          ${labelHtml}
          ${unreadHtml}
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
            <pre class="email-thread-msg-body">${escapeHtml(m.bodyPlain)}</pre>
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

function renderDetailPage(d: {
  readonly id: string
  readonly threadId: string
  readonly subject: string
  readonly sender: string
  readonly senderEmail: string
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly receivedAt: string
  readonly bodyPlain: string
  readonly isUnread: boolean
  readonly labels: readonly string[]
}): string {
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
        <article class="email-detail">
          <header class="email-detail-header">
            <h1 class="email-detail-subject">${escapeHtml(d.subject)}</h1>
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
          <pre class="email-detail-body">${escapeHtml(d.bodyPlain)}</pre>
          <footer class="email-detail-actions" data-email-actions>
            <button type="button" data-email-action="hide" disabled title="Hide is wired in issue #024">Hide</button>
            <button type="button" data-email-action="tag" disabled title="Tagging is wired in issue #025">Tag</button>
            <button type="button" data-email-action="summarize" disabled title="Summarize is wired in issue #027">Summarize</button>
            <span class="email-action-hint" data-email-action-hint>Action handlers arrive in #024 / #025 / #027</span>
          </footer>
        </article>
      </main>
    </div>
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
  </body>
</html>`
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
        <p>No email with id <code>${escapeHtml(id)}</code> (or it was hidden).</p>
        <nav><a href="/email">\u2190 Back to inbox</a></nav>
      </main>
    </div>
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
  </body>
</html>`
}

// ─── Sidebar ──────────────────────────────────────────────────────────────

interface EmailSidebarArgs {
  readonly active: 'inbox' | 'thread' | 'detail'
}

/**
 * Render the sidebar for the email pages. The "Email" section title
 * matches the styling pass (#013) — `.sidebar-section` + `.sidebar-title`
 * + a single `.compartment-nav`-style list. The Inbox link is the
 * only entry right now; future slices add labels / search / etc.
 *
 * The active item gets `.compartment-button-active` so the visual
 * state matches the existing styling.
 */
function renderEmailSidebar(args: EmailSidebarArgs): string {
  const inboxActive = args.active === 'inbox' ? ' compartment-button-active' : ''
  return `
      <aside class="sidebar" data-sidebar>
        <div class="sidebar-section">
          <h2 class="sidebar-title">Email</h2>
          <ul class="compartment-nav">
            <li>
              <a class="compartment-button${inboxActive}" href="/email" data-email-nav="inbox">
                <span class="compartment-icon" aria-hidden="true">\u2709\ufe0f</span>
                <span class="compartment-label">Inbox</span>
              </a>
            </li>
          </ul>
        </div>
        <div class="sidebar-section sidebar-folder-section">
          <h2 class="sidebar-title">Account</h2>
          <p class="sidebar-account-note" data-sidebar-account>Gmail &mdash; synced messages only.</p>
        </div>
      </aside>`
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Build a /email link that preserves the current filter set, with the
 *  listed overrides set to new values (or cleared if empty). */
function inboxFilterHref(overrides: {
  readonly from?: string
  readonly label?: string
  readonly unread?: string
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
  if (overrides.cursor !== undefined && overrides.cursor !== '') params.set('cursor', overrides.cursor)
  const q = params.toString()
  return q ? `/email?${q}` : '/email'
}

function filtersToParams(filters: InboxPageArgs['filters']): Record<string, string> {
  const out: Record<string, string> = {}
  if (filters.from) out.from = filters.from
  if (filters.label) out.label = filters.label
  if (filters.unread === true) out.unread = '1'
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

// ─── Styles ───────────────────────────────────────────────────────────────

const EMAIL_VIEW_STYLES = `
.email-main { flex: 1; min-width: 0; padding: 1.5rem 2rem; max-width: 960px; }
.email-page-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 1.25rem; }
.email-page-title { margin: 0; font-size: 1.5rem; font-weight: 600; }
.email-page-meta { color: var(--muted); font-size: 0.85rem; }
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
.email-detail-subject { margin: 0 0 0.5rem; font-size: 1.4rem; font-weight: 600; }
.email-detail-sender { margin: 0 0 1rem; color: var(--muted); font-size: 0.95rem; }
.email-detail-meta { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; font-size: 0.875rem; color: var(--text); margin: 0 0 1rem; }
.email-detail-meta dt { color: var(--muted); font-weight: 500; }
.email-detail-meta dd { margin: 0; }
.email-detail-meta a { color: var(--accent); text-decoration: none; }
.email-detail-meta a:hover { text-decoration: underline; }
.email-detail-labels { margin-bottom: 1rem; }
.email-detail-body { white-space: pre-wrap; word-wrap: break-word; font-family: inherit; margin: 0 0 1.5rem; font-size: 0.95rem; line-height: 1.5; }
.email-detail-actions { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; padding-top: 1rem; border-top: 1px solid var(--border); }
.email-detail-actions button { padding: 0.4rem 0.85rem; font-size: 0.85rem; border: 1px solid var(--border); border-radius: 0.375rem; background: var(--surface); color: var(--text); cursor: pointer; }
.email-detail-actions button:disabled { cursor: not-allowed; opacity: 0.5; }
.email-action-hint { color: var(--muted); font-size: 0.8rem; }
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
@media (max-width: 720px) {
  .email-main { padding: 1rem; }
  .email-detail { padding: 1rem; }
  .email-thread-msg { padding: 0.875rem; }
  .email-from-filter { margin-left: 0; margin-top: 0.5rem; width: 100%; }
  .email-from-filter input[type="search"] { flex: 1; min-width: 0; }
}
`

// Inline script placeholder. The Hide/Tag/Summarize buttons are
// `disabled` so they cannot fire — the data-* hooks are present so
// a future JS file can hook them without re-rendering the page.
const EMAIL_VIEW_SCRIPT = `(function(){
  // No-op for now. Action handlers land in #024 (hide), #025 (tag),
  // #027 (summarize). The buttons stay disabled so there's no
  // confused click path; the hint text explains why.
})();`
