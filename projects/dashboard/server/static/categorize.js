// categorize.js — issue #008
//
// Browser-side handlers for the categorize UI. Loaded via a single
// `<script src="/static/categorize.js" defer>` tag at the bottom of
// each categorize-enabled page. No build step, no dependencies — plain
// DOM + fetch + event delegation.
//
// Responsibilities (each maps to an AC in issue #008):
//   1. Inline title edit on bookmark card / detail page (click → input,
//      blur/Enter → POST /api/bookmarks/:id {title})
//   2. Folder picker: change the `<select data-folder-select>` and POST
//      /api/bookmarks/:id/move {folderId}
//   3. Tag input: Enter in the input → POST /api/bookmarks/:id
//      {tags: [...current, new], tagReplace: false}
//   4. Tag remove via × on chip: POST /api/bookmarks/:id
//      {tags: [...remaining], tagReplace: true}
//   5. Sidebar "+" button: open inline form to create folder, POST
//      /api/folders {name}, then prepend to the tree
//   6. Sidebar folder rename: double-click → edit → PATCH
//      /api/folders/:id {name}
//
// Status feedback: each card has a `<span data-actions-status>` that
// flashes "saved" (green) or the error message (red) for ~2s.
//
// Auth: the page is already authenticated server-side (HTTP Basic).
// fetch() inherits the browser's Basic credentials (the browser
// remembered the password from the initial 401 challenge). So we
// don't need to send Authorization headers from JS.

'use strict'

// ─── API helpers ──────────────────────────────────────────────────────────

/**
 * POST JSON to an /api/ endpoint. Returns parsed JSON on 2xx, throws
 * on 4xx/5xx with the error body attached.
 */
async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  })
  if (!res.ok) {
    let detail = ''
    try {
      const errBody = await res.json()
      detail = errBody.message || errBody.error || ''
    } catch (_) {
      detail = res.statusText
    }
    throw new Error(`POST ${url} → ${res.status} ${detail}`)
  }
  // Some endpoints (move) return JSON; sync POST returns JSON too.
  // Detail DELETE returns 204; we don't call apiPost for those.
  return res.json()
}

async function apiPatch(url, body) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  })
  if (!res.ok) {
    let detail = ''
    try {
      const errBody = await res.json()
      detail = errBody.message || errBody.error || ''
    } catch (_) {
      detail = res.statusText
    }
    throw new Error(`PATCH ${url} → ${res.status} ${detail}`)
  }
  return res.json()
}

async function apiDelete(url) {
  const res = await fetch(url, { method: 'DELETE', credentials: 'same-origin' })
  if (!res.ok && res.status !== 404) {
    throw new Error(`DELETE ${url} → ${res.status} ${res.statusText}`)
  }
  return res
}

// ─── Status feedback ──────────────────────────────────────────────────────

function flashStatus(cardOrContainer, message, ok) {
  const status = cardOrContainer.querySelector('[data-actions-status]')
  if (!status) return
  status.textContent = message
  status.className = ok ? 'saved-flash' : 'error-flash'
  clearTimeout(status._flashTimer)
  status._flashTimer = setTimeout(() => {
    status.textContent = ''
    status.className = ''
  }, 2500)
}

// ─── Bookmark edit handlers ───────────────────────────────────────────────

/**
 * Per-card event delegation for: title edit, folder move, tag add/remove,
 * delete button.
 *
 * Bound on `card` (a single `<li class="feed-item">` or the `<dl>` on
 * the detail page). One delegated handler per card so the listeners
 * are scoped and can clean up on re-render.
 */
function wireCard(card) {
  const bookmarkId = card.dataset.bookmarkId
  if (!bookmarkId) return // not a bookmark card (e.g. sidebar)

  // ── Title edit ────────────────────────────────────────────────────────
  // Click the title link → swap to <input>. Blur or Enter → save.
  // Escape → cancel.
  const editBtn = card.querySelector('[data-edit-title]')
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      const titleEl = card.querySelector('.title a')
      if (!titleEl) return
      const current = titleEl.textContent
      const input = document.createElement('input')
      input.type = 'text'
      input.value = current
      input.className = 'title-input'
      const h3 = card.querySelector('.title')
      // Replace the link with the input.
      titleEl.replaceWith(input)
      input.focus()
      input.select()

      const finish = async (commit) => {
        if (commit) {
          const next = input.value.trim()
          if (next === '' || next === current) {
            // Empty or unchanged: cancel.
            commit = false
          } else {
            try {
              await apiPost(`/api/bookmarks/${bookmarkId}`, { title: next })
              flashStatus(card, 'saved', true)
            } catch (err) {
              flashStatus(card, err.message, false)
              commit = false // revert
            }
          }
        }
        // Restore the link (with the latest value).
        const newLink = document.createElement('a')
        newLink.href = titleEl ? titleEl.href : '#'
        newLink.target = '_blank'
        newLink.rel = 'noopener'
        newLink.textContent = commit ? input.value : current
        input.replaceWith(newLink)
      }

      input.addEventListener('blur', () => finish(true))
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          input.blur() // triggers blur handler
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      })
    })
  }

  // ── Folder move ───────────────────────────────────────────────────────
  // Change the <select> → POST /move → on success, update the displayed
  // path in place (no full reload).
  const folderSelect = card.querySelector('[data-folder-select]')
  if (folderSelect) {
    folderSelect.addEventListener('change', async () => {
      const folderId = folderSelect.value
      try {
        const result = await apiPost(`/api/bookmarks/${bookmarkId}/move`, {
          folderId,
        })
        // Update the displayed path if we got one back.
        const display = card.querySelector('[data-folder-display]')
        if (display) {
          const opt = folderSelect.querySelector(`option[value="${folderId}"]`)
          if (opt) display.textContent = opt.textContent
        }
        flashStatus(card, 'moved', true)
      } catch (err) {
        flashStatus(card, err.message, false)
      }
    })
  }

  // ── Tag remove (× button on chip) ─────────────────────────────────────
  card.addEventListener('click', async (e) => {
    const removeBtn = e.target.closest('[data-remove-tag]')
    if (!removeBtn) return
    e.preventDefault()
    const tagName = removeBtn.getAttribute('data-remove-tag')
    const remaining = collectCurrentTags(card).filter((t) => t !== tagName)
    try {
      await apiPost(`/api/bookmarks/${bookmarkId}`, {
        tags: remaining,
        tagReplace: true,
      })
      // Remove the chip from the DOM.
      const chip = removeBtn.closest('.tag')
      if (chip) chip.remove()
      flashStatus(card, 'tag removed', true)
    } catch (err) {
      flashStatus(card, err.message, false)
    }
  })

  // ── Tag input (Enter to add) ──────────────────────────────────────────
  const tagInput = card.querySelector('[data-tag-input]')
  if (tagInput) {
    tagInput.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      const raw = tagInput.value.trim()
      if (raw === '') return
      // Avoid duplicates within the current set.
      const current = collectCurrentTags(card)
      if (current.includes(raw)) {
        tagInput.value = ''
        return
      }
      try {
        await apiPost(`/api/bookmarks/${bookmarkId}`, {
          tags: [raw],
          tagReplace: false, // additive
        })
        // Add the chip to the DOM (server normalized the name).
        insertTagChip(card, tagInput.value.trim())
        tagInput.value = ''
        flashStatus(card, 'tag added', true)
      } catch (err) {
        flashStatus(card, err.message, false)
      }
    })
  }

  // ── Delete bookmark ───────────────────────────────────────────────────
  const deleteBtn = card.querySelector('[data-delete-bookmark]')
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!confirm('Delete this bookmark?')) return
      try {
        await apiDelete(`/api/bookmarks/${bookmarkId}`)
        // On the feed page, remove the card. On the detail page, redirect.
        if (card.classList.contains('feed-item')) {
          card.remove()
        } else {
          window.location.href = '/'
        }
      } catch (err) {
        flashStatus(card, err.message, false)
      }
    })
  }
}

/** Collect the current tag names visible on a card. */
function collectCurrentTags(card) {
  return Array.from(card.querySelectorAll('.tag[data-tag]'))
    .map((el) => el.getAttribute('data-tag'))
}

/** Insert a new tag chip before the input on a card. */
function insertTagChip(card, name) {
  const input = card.querySelector('[data-tag-input]')
  const tagList = card.querySelector('[data-tag-list]')
  if (!input || !tagList) return
  const chip = document.createElement('span')
  chip.className = 'tag'
  chip.setAttribute('data-tag', name)
  chip.textContent = name
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'tag-remove'
  remove.setAttribute('data-remove-tag', name)
  remove.title = 'Remove tag'
  remove.textContent = '×'
  chip.appendChild(remove)
  tagList.insertBefore(chip, input)
}

// ─── Sidebar handlers ─────────────────────────────────────────────────────

function wireSidebar(aside) {
  // Add folder button: open the form.
  const addBtn = aside.querySelector('[data-add-folder]')
  const form = aside.querySelector('[data-add-folder-form]')
  const cancelBtn = aside.querySelector('[data-cancel-add-folder]')
  if (addBtn && form) {
    addBtn.addEventListener('click', () => {
      form.dataset.open = 'true'
      const input = form.querySelector('input')
      if (input) input.focus()
    })
  }
  if (cancelBtn && form) {
    cancelBtn.addEventListener('click', () => {
      form.dataset.open = 'false'
      const input = form.querySelector('input')
      if (input) input.value = ''
    })
  }
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const input = form.querySelector('input')
      const name = input.value.trim()
      if (name === '') return
      try {
        const created = await apiPost('/api/folders', { name })
        // Insert the new folder at the top level of the sidebar.
        insertSidebarFolder(aside, created)
        input.value = ''
        form.dataset.open = 'false'
        flashStatus(form, 'added', true)
        // Also refresh the folder-select dropdowns on the page.
        refreshFolderSelects(aside, created)
      } catch (err) {
        flashStatus(form, err.message, false)
      }
    })
  }

  // Click on a folder-label link → navigate to filter by that folder.
  // A double-click (rename) sets `suppressNextClick = true` so the
  // page does NOT navigate away mid-rename.
  aside.addEventListener('click', (e) => {
    // Slice #016: chevron button collapses the folder subtree. We
    // intercept it BEFORE the folder-label handler below so we don't
    // accidentally navigate. The handler is registered first because
    // the chevron click also bubbles up to `aside`, and we want to
    // handle it without ever reaching the link-navigation branch.
    const chevron = e.target.closest('[data-toggle-folder]')
    if (chevron) {
      e.preventDefault()
      e.stopPropagation()
      const li = chevron.closest('li.sidebar-item')
      if (!li) return
      const collapsed = li.getAttribute('data-collapsed') === 'true'
      if (collapsed) {
        li.removeAttribute('data-collapsed')
        chevron.setAttribute('aria-expanded', 'true')
        chevron.setAttribute('aria-label', 'Collapse')
      } else {
        li.setAttribute('data-collapsed', 'true')
        chevron.setAttribute('aria-expanded', 'false')
        chevron.setAttribute('aria-label', 'Expand')
      }
      return
    }
    const link = e.target.closest('a.folder-label')
    if (!link) return
    if (suppressNextClick) {
      e.preventDefault()
      suppressNextClick = false
      return
    }
    // The link's default href handles navigation — nothing else to do.
  })

  // Double-click on a folder name → inline rename. We need to cancel
  // the default link navigation that the first click of the double-click
  // triggers — if we don't, the page navigates away before the rename
  // input appears. Track a short "double-click in progress" window
  // after dblclick and suppress the next click navigation.
  let suppressNextClick = false
  aside.addEventListener('dblclick', (e) => {
    const nameEl = e.target.closest('[data-folder-name]')
    if (!nameEl) return
    if (nameEl.dataset.editing === 'true') return
    e.preventDefault()              // suppress the second click's navigation
    suppressNextClick = true
    const folderId = nameEl.dataset.folderId
    const currentName = nameEl.textContent
    const input = document.createElement('input')
    input.type = 'text'
    input.value = currentName
    input.className = 'title-input'
    nameEl.dataset.editing = 'true'
    nameEl.replaceWith(input)
    input.focus()
    input.select()

    const finish = async (commit) => {
      let next = currentName
      if (commit) {
        next = input.value.trim()
        if (next === '' || next === currentName) {
          commit = false
        } else {
          try {
            await apiPatch(`/api/folders/${folderId}`, { name: next })
            flashStatus(aside.querySelector('[data-add-folder-form]') || aside, 'renamed', true)
          } catch (err) {
            flashStatus(aside.querySelector('[data-add-folder-form]') || aside, err.message, false)
            commit = false
          }
        }
      }
      const newEl = document.createElement('span')
      // Keep BOTH the legacy `folder-name` class (this is what the
      // dblclick handler queries to start a new rename) and the new
      // `sidebar-name` class introduced in slice #013 so the new
      // sidebar styling keeps applying after a rename.
      newEl.className = 'sidebar-name folder-name'
      newEl.setAttribute('data-folder-name', '')
      newEl.setAttribute('data-folder-id', folderId)
      newEl.title = 'Double-click to rename'
      newEl.textContent = commit ? input.value : currentName
      input.replaceWith(newEl)
    }
    input.addEventListener('blur', () => finish(true))
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        input.blur()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      }
    })
  })
}

/**
 * Insert a newly created folder at the top of the sidebar tree.
 *
 * Mirrors the markup produced by `renderFolderTree` in activity-feed.ts
 * so the new <li> picks up the same CSS (icon, chevron slot, active
 * state) without needing a server round-trip. Slice #013 added the
 * icon + chevron wrapper, so this client-side helper must match.
 */
function insertSidebarFolder(aside, folder) {
  // Find the first <ul> in the aside (the top-level folder list).
  const topUl = aside.querySelector('ul')
  if (!topUl) return
  const li = document.createElement('li')
  li.className = 'sidebar-item'
  li.setAttribute('data-folder-id', folder.id)
  li.setAttribute('data-depth', '0')
  const a = document.createElement('a')
  a.className = 'folder-label'
  a.href = `/?folder=${encodeURIComponent(folder.id)}`
  const icon = document.createElement('span')
  icon.className = 'sidebar-icon'
  icon.setAttribute('aria-hidden', 'true')
  icon.textContent = '\ud83d\udcc1' // 📁
  const span = document.createElement('span')
  // Both classes: `folder-name` for the rename hook, `sidebar-name`
  // for the slice-#013 styling.
  span.className = 'sidebar-name folder-name'
  span.setAttribute('data-folder-name', '')
  span.setAttribute('data-folder-id', folder.id)
  span.title = 'Double-click to rename'
  span.textContent = folder.name
  a.appendChild(icon)
  a.appendChild(span)
  li.appendChild(a)
  topUl.appendChild(li)
}

/** Add a new option to every folder-select on the page. */
function refreshFolderSelects(_aside, folder) {
  for (const sel of document.querySelectorAll('[data-folder-select]')) {
    const opt = document.createElement('option')
    opt.value = folder.id
    opt.textContent = folder.name
    sel.appendChild(opt)
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────

function init() {
  for (const card of document.querySelectorAll('[data-bookmark-id]')) {
    wireCard(card)
  }
  // Detail page uses <dl> for the same fields; wire its bookmarkId too.
  // The detail page sets data-bookmark-id on the <dl>? No — we set it
  // on the <body> via a wrapping element. Easier: any [data-folder-select]
  // or [data-edit-title] outside a feed-item is part of the detail page.
  for (const scope of document.querySelectorAll(
    '[data-folder-select], [data-edit-title], [data-delete-bookmark]',
  )) {
    if (scope.closest('[data-bookmark-id]')) continue // already wired
    // The detail page wraps things in <dl>; treat the closest <dl> as the card.
    const card = scope.closest('dl') || document.body
    if (!card.dataset.bookmarkId) {
      // Find the bookmark id from the data-folder-select nearest.
      // (The detail page embeds the id via the rendered markup.)
      const idMatch = document.body.innerHTML.match(/data-bookmark-id="([^"]+)"/)
      if (idMatch) card.dataset.bookmarkId = idMatch[1]
    }
    wireCard(card)
  }
  const aside = document.querySelector('aside')
  if (aside) wireSidebar(aside)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}