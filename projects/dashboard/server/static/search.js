// search.js — issue #009
//
// Browser-side handlers for the search UI. Loaded via a single
// `<script src="/static/search.js" defer>` tag on the /search page.
// No build step, no dependencies — plain DOM + fetch + debouncing.
//
// Responsibilities:
//   - Debounced search-as-you-type (150ms after the last keystroke).
//   - Fetch JSON from `/api/search?q=...&folder=...&tag=...&from=...&to=...`.
//   - Replace the results list in place (no full page reload).
//   - Honor the form's filter <select>s and date inputs.
//
// Auth: the page is already authenticated (HTTP Basic). `fetch()`
// inherits the browser's remembered credentials — no Authorization
// header needed in JS code.

'use strict'

// ─── Debounce ─────────────────────────────────────────────────────────────

/**
 * Wrap `fn` so it only fires after `delay` ms have elapsed since the
 * last call. The latest args win (older pending invocations are
 * dropped). Standard pattern; no need for a library.
 */
function debounce(fn, delay) {
  let timer = null
  return function (...args) {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn.apply(this, args)
    }, delay)
  }
}

// ─── API helper ───────────────────────────────────────────────────────────

/**
 * GET `/api/search?...` with the given query string. Returns parsed
 * JSON. Throws on 4xx/5xx (the body is attached as `err.message`).
 */
async function apiSearch(params) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`/api/search?${qs}`, { credentials: 'same-origin' })
  if (!res.ok) {
    throw new Error(`search → ${res.status} ${res.statusText}`)
  }
  return res.json()
}

// ─── Render ───────────────────────────────────────────────────────────────

/**
 * Render the results panel. Replaces the existing `<ul.results>`
 * (or appends if none). Also updates the status line.
 */
function renderResults(panel, response) {
  const emptyState = panel.querySelector('.empty-state')
  if (emptyState) emptyState.remove()
  const pagination = panel.querySelector('.pagination')
  if (pagination) pagination.remove()
  // Update the status line (replacing whatever was there).
  const status = panel.querySelector('[data-search-status]')
  if (status) {
    if (response.mode === 'empty') {
      status.innerHTML = 'Type a query above to search bookmarks.'
    } else if (response.results.length === 0) {
      status.innerHTML = `No matches for <strong>${escapeHtml(response.query)}</strong>.`
    } else {
      const fuzzy = response.mode === 'fuzzy'
        ? ' <span class="fuzzy">(fuzzy match)</span>'
        : ''
      status.innerHTML = `${response.results.length} result${response.results.length === 1 ? '' : 's'} for <strong>${escapeHtml(response.query)}</strong>${fuzzy}`
    }
  }

  // Replace the results list (or insert if absent).
  let list = panel.querySelector('ul.results')
  if (list) list.remove()
  if (response.results.length > 0) {
    list = document.createElement('ul')
    list.className = 'results'
    for (const r of response.results) {
      const li = document.createElement('li')
      li.className = 'result'
      li.dataset.bookmarkId = r.id

      const h3 = document.createElement('h3')
      const a = document.createElement('a')
      a.href = r.url
      a.target = '_blank'
      a.rel = 'noopener'
      a.textContent = r.title
      h3.appendChild(a)

      const snip = document.createElement('p')
      snip.className = 'snippet'
      // The snippet is server-rendered HTML with <mark> tags. We use
      // innerHTML because that's the whole point — the server already
      // escaped user-controlled values. (See search.ts makeFuzzySnippet
      // + FTS5 snippet(), both of which escape before wrapping in <mark>.)
      snip.innerHTML = r.snippet

      const meta = document.createElement('p')
      meta.className = 'meta'
      const folderSpan = document.createElement('span')
      folderSpan.textContent = r.folderPath
      meta.appendChild(folderSpan)
      meta.appendChild(document.createTextNode(' \u00b7 '))
      for (const tag of r.tags) {
        const tagEl = document.createElement('span')
        tagEl.className = 'tag'
        tagEl.textContent = tag
        meta.appendChild(tagEl)
      }

      li.appendChild(h3)
      li.appendChild(snip)
      li.appendChild(meta)
      list.appendChild(li)
    }
    panel.appendChild(list)
  }
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ─── Form wiring ──────────────────────────────────────────────────────────

/**
 * Wire the search form. Hooks:
 *   - Input on the search box → debounced fetch → renderResults.
 *   - Change on folder/tag selects → immediate fetch (the user
 *     picked a filter; don't make them also press Enter).
 *   - Change on date inputs → immediate fetch (same rationale).
 *   - Submit → prevent default (we already handled it live); optionally
 *     update the URL so the page is shareable.
 */
function wireForm(form, panel) {
  const input = form.querySelector('[data-search-input]')
  const folderSel = form.querySelector('[data-search-folder]')
  const tagSel = form.querySelector('[data-search-tag]')
  const fromDate = form.querySelector('input[name=from]')
  const toDate = form.querySelector('input[name=to]')

  async function runSearch() {
    const params = {
      q: input ? input.value.trim() : '',
      folder: folderSel ? folderSel.value : '',
      tag: tagSel ? tagSel.value : '',
      from: fromDate ? fromDate.value : '',
      to: toDate ? toDate.value : '',
    }
    // Skip the fetch for an empty query (the empty-mode response
    // would just be `mode: 'empty'` — pointless round-trip).
    if (params.q === '' && params.folder === '' && params.tag === '' &&
        params.from === '' && params.to === '') {
      renderResults(panel, { mode: 'empty', query: '', results: [], totalCount: 0 })
      return
    }
    try {
      const response = await apiSearch(params)
      renderResults(panel, response)
      // Update the URL so the search is shareable / bookmarkable
      // without a full page reload.
      const qs = new URLSearchParams(params)
      // Preserve ?page if present (for pagination round-trips).
      const currentPage = new URLSearchParams(window.location.search).get('page')
      if (currentPage && currentPage !== '1') qs.set('page', currentPage)
      const newUrl = `${window.location.pathname}${qs.toString() ? '?' + qs.toString() : ''}`
      window.history.replaceState({}, '', newUrl)
    } catch (err) {
      renderResults(panel, { mode: 'empty', query: input.value, results: [], totalCount: 0 })
      const status = panel.querySelector('[data-search-status]')
      if (status) status.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`
    }
  }

  // Debounced search-as-you-type. 150ms is the AC target — long enough
  // to coalesce typing bursts, short enough to feel instant.
  const debouncedSearch = debounce(runSearch, 150)

  if (input) {
    input.addEventListener('input', debouncedSearch)
  }
  for (const el of [folderSel, tagSel, fromDate, toDate]) {
    if (el) el.addEventListener('change', runSearch)
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    runSearch()
  })

  // If the page loaded with `?q=...` in the URL (deep link), don't
  // wait for the user to type — fetch immediately so the page already
  // shows results on first paint. (Server-rendered HTML also includes
  // the initial results, so this only matters if the user navigates
  // client-side to a different query.)
  const initialQ = new URLSearchParams(window.location.search).get('q') || ''
  if (initialQ !== '' && input && input.value === '') {
    input.value = initialQ
    runSearch()
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────

function init() {
  const form = document.querySelector('[data-search-form]')
  if (!form) return
  // The "panel" is the area below the form where the status line +
  // results list live. We create a wrapper if the page doesn't have
  // one, so this script works on any page that includes a
  // [data-search-form] + [data-search-status] pair.
  let panel = document.querySelector('[data-search-panel]')
  if (!panel) {
    panel = document.createElement('div')
    panel.setAttribute('data-search-panel', '')
    const status = document.createElement('p')
    status.setAttribute('data-search-status', '')
    status.className = 'search-status'
    panel.appendChild(status)
    form.parentNode.insertBefore(panel, form.nextSibling)
  }
  wireForm(form, panel)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
