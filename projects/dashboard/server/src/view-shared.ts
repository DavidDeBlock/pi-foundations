// view-shared.ts — issue #011
//
// Shared HTML for the page <head>. Centralised so that adding a new
// stylesheet, font preload, or analytics tag only requires editing one
// place rather than five (one per view). Also emits the FOUC-prevention
// inline script that sets [data-theme] on <html> before the stylesheet
// loads — the same script that drives `static/theme.js`'s toggle.
//
// Ordering matters here:
//   1. <meta charset> first (so the parser knows the encoding)
//   2. <meta viewport> early (so mobile sizing is correct from the start)
//   3. <link rel="preload" as="font"> for the three fonts we use
//   4. <title> (page-specific, supplied by caller)
//   5. The bootstrap <script> (inline, synchronous; runs before CSS)
//   6. <link rel="stylesheet"> (last so it doesn't block font preloads)
//
// The inline styles that views still emit AFTER this head fragment win
// the cascade where they overlap, so existing pages render unchanged
// while the foundation is in place. The plan is to delete those inline
// blocks one view at a time in issues #012 onwards.

import { THEME_BOOTSTRAP_SCRIPT } from './theme.js'

/**
 * The fixed portion of every page's <head>: charset, viewport, font
 * preloads, the theme bootstrap script, and the main stylesheet link.
 *
 * Exported as a string so views can interpolate it directly into their
 * template literal. Whitespace is preserved literally — the HTML
 * response will have it inline.
 */
export const COMMON_HEAD = `    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="preload" href="/static/fonts/Inter-Regular.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/static/fonts/Inter-SemiBold.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/static/fonts/JetBrainsMono-Regular.woff2" as="font" type="font/woff2" crossorigin>
    <script>${THEME_BOOTSTRAP_SCRIPT}</script>
    <link rel="stylesheet" href="/static/styles.css">`

/**
 * The <script> tag that loads `static/theme.js`. Place at the end of
 * <body> alongside any other browser-side scripts. `defer` is omitted
 * because theme.js uses `DOMContentLoaded`; an async load would race
 * with the toggle buttons already in the DOM.
 */
export const THEME_SCRIPT_TAG = `<script src="/static/theme.js"></script>`

/**
 * The <script> tag that loads `static/clipboard.js`. Place at the end
 * of <body> alongside the theme script. The handler is global
 * (event-delegated) so it can be loaded once per page regardless of
 * how many cards the page renders.
 */
export const CLIPBOARD_SCRIPT_TAG = `<script src="/static/clipboard.js"></script>`

/**
 * The standard theme-toggle button. It's `data-theme-toggle` so
 * `static/theme.js` can find it via event delegation. This button is
 * embedded inside the site header (see `renderHeader`) so it no
 * longer needs `position: fixed` styling — the floating-placeholder
 * class from #011 is gone.
 *
 * Exposed as a function (not a constant) in case future slices need
 * to vary its attributes; the current implementation is context-free.
 */
export function renderThemeToggle(): string {
  return `<button type="button" class="theme-toggle" data-theme-toggle aria-label="Toggle theme" title="Toggle theme">\u2600</button>`
}

/**
 * Local HTML escaper. Each view module duplicates this to avoid a
 * shared util module (small enough that duplication is cheaper than
 * the import chain).
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Options for the sticky site header.
 *
 * `initialQuery` — pre-fills the search input. Used by the search
 *   page so the user's query survives a refresh.
 * `showSearch` — set to false on pages where the search input
 *   doesn't make sense (currently never — every page has it).
 */
export interface HeaderOptions {
  readonly initialQuery?: string
  readonly showSearch?: boolean
  /** Render the mobile sidebar trigger. Pages without a sidebar should
   * leave this false so they do not expose a control with no target. */
  readonly showSidebarToggle?: boolean
}

/**
 * Render the sticky site header. Slice 5 of the styling pass.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ ⊞ Dashboard     [search…] [Search]  [☀]  Settings  Logout      │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Layout (56px tall, sticky to viewport top):
 *   - Left: brand (icon + wordmark, links to `/`)
 *   - Right: search form, theme toggle, settings link, logout link
 *
 * The header is rendered into every page (feed, detail, search,
 * settings) so all surfaces share one frame and the theme toggle is
 * always one click away.
 */
export function renderHeader(opts: HeaderOptions = {}): string {
  const initialQuery = escapeHtml(opts.initialQuery ?? '')
  const showSearch = opts.showSearch !== false
  const searchForm = showSearch
    ? `<form class="search-form" data-search-form method="get" action="/search" role="search">
      <input type="search" name="q" placeholder="Search\u2026" value="${initialQuery}" data-search-input aria-label="Search">
      <button type="submit" class="search-button">Search</button>
    </form>`
    : ''
  const sidebarToggle = opts.showSidebarToggle !== false
    ? `<button type="button" class="hamburger" data-hamburger aria-label="Toggle navigation" aria-expanded="false" title="Open navigation"><span aria-hidden="true">\u2630</span></button>`
    : ''
  return `<header class="site-header">
    <div class="header-left">
      ${sidebarToggle}
      <a class="brand" href="/">
        <span class="brand-icon" aria-hidden="true">\u229e</span>
        <span class="brand-name">Dashboard</span>
      </a>
    </div>
    <div class="header-right">
      ${searchForm}
      <a class="mobile-search-link" href="/search" aria-label="Search" title="Search"><span aria-hidden="true">\u2315</span></a>
      ${renderThemeToggle()}
      <a class="settings-link" href="/settings" title="Settings">Settings</a>
      <a class="logout-link" href="/api/logout" title="Sign out">Logout</a>
    </div>
  </header>`
}

/**
 * The variant of empty state to render. Each variant maps to a copy
 * choice that fits the page context (feed vs. search vs. folder).
 *
 *  - `no-bookmarks`  — the dashboard has no Chrome bookmarks synced.
 *                      Shown on the feed when `totalItems === 0` and
 *                      no folder filter is active.
 *  - `empty-folder`  — a folder (or folder subtree) has no items.
 *  - `no-results`    — a search query returned zero hits.
 *  - `empty-tag`     — a tag filter returned zero hits.
 *
 * The icon and CTA hint at the most likely next step (install the
 * extension, clear the filter, etc.). Discriminated union keeps the
 * caller from accidentally omitting required fields per variant.
 */
export type EmptyState =
  | { readonly kind: 'no-bookmarks' }
  | { readonly kind: 'empty-folder'; readonly folderPath: string }
  | { readonly kind: 'no-results'; readonly query: string }
  | { readonly kind: 'empty-tag'; readonly tag: string }

/**
 * Render a centred "empty-state" panel: icon + message + optional CTA.
 * Used by the feed (no bookmarks / empty folder), search (no hits),
 * and tag filters (no matches). Pure HTML — the surrounding `.layout`
 * and `.empty-state` styling lives in `static/styles.css`.
 *
 * Slice #015 unified the four places that previously emitted inline
 * `<p class="empty">…</p>` blocks of varying lengths. The new shape
 * is one component used everywhere, with a clearer call-to-action
 * per variant.
 */
export function renderEmptyState(state: EmptyState): string {
  let icon = ''
  let message = ''
  let cta = ''
  switch (state.kind) {
    case 'no-bookmarks':
      icon = '\ud83d\udcec' // 📭
      message = 'No bookmarks synced yet.'
      cta = '<a class="empty-cta" href="/settings">View setup guide \u2192</a>'
      break
    case 'empty-folder':
      icon = '\ud83d\udcc1' // 📁
      message = `No bookmarks in <strong>${escapeHtml(state.folderPath)}</strong> or its subfolders.`
      cta = '<a class="empty-cta" href="/">Show all bookmarks \u2192</a>'
      break
    case 'no-results':
      icon = '\ud83d\udd0d' // 🔍
      message = `No bookmarks match <strong>${escapeHtml(state.query)}</strong>.`
      cta = '<a class="empty-cta" href="/">Browse all bookmarks \u2192</a>'
      break
    case 'empty-tag':
      icon = '\ud83c\udff7\ufe0f' // 🏷
      message = `No bookmarks tagged <strong>${escapeHtml(state.tag)}</strong>.`
      cta = '<a class="empty-cta" href="/">Browse all bookmarks \u2192</a>'
      break
  }
  return `<div class="empty-state" role="status">
    <div class="empty-icon" aria-hidden="true">${icon}</div>
    <p class="empty-message">${message}</p>
    ${cta}
  </div>`
}

/**
 * Inline <script> that wires the mobile hamburger button (added in
 * slice #015) to the sidebar's `data-open` attribute. The sidebar
 * CSS uses `[data-open="true"]` to translate itself into view on
 * small viewports.
 *
 * Kept inline (not in a separate static asset) because it's 6 lines,
 * has no dependencies, and avoids a fourth round-trip on page load.
 * Matches the same pattern as the theme toggle: small IIFE, no
 * module imports, runs on every page.
 */
export const HAMBURGER_SCRIPT_TAG = `<script>
(function () {
  var body = document.body
  var sidebar = document.querySelector('.sidebar')
  var btn = document.querySelector('[data-hamburger]')
  if (!sidebar || !btn) return

  function setOpen(open) {
    sidebar.setAttribute('data-open', open ? 'true' : 'false')
    btn.setAttribute('aria-expanded', open ? 'true' : 'false')
    btn.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation')
    body.classList.toggle('sidebar-open', open)
  }

  document.addEventListener('click', function (e) {
    var target = e.target && e.target.closest ? e.target : null
    if (!target) return
    var toggle = target.closest('[data-hamburger]')
    if (toggle) {
      setOpen(sidebar.getAttribute('data-open') !== 'true')
      return
    }
    if (body.classList.contains('sidebar-open') && !target.closest('.sidebar')) {
      setOpen(false)
    }
    if (target.closest('.sidebar a')) setOpen(false)
  })

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && body.classList.contains('sidebar-open')) {
      setOpen(false)
      btn.focus()
    }
  })
})()
</script>`
