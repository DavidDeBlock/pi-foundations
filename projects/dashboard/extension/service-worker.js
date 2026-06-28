// service-worker.js — MV3 background service worker for Dashboard Sync.
//
// Lifecycle: install + activate (issue #004)
// Issue #005: trigger full sync on extension install + on every
//              browser startup when config exists.
// Issue #006: subscribe to chrome.bookmarks.* events (created/changed/
//              removed/moved) and POST a debounced full-tree sync on
//              each event. The server's BookmarkDiffer computes the
//              minimal CRUD ops; the extension doesn't compute deltas.
//
// Feedback-loop prevention: per write-tracker.js. In v1 the extension
// doesn't write to Chrome, so the ignore set is always empty and the
// mechanism is dormant. When v2 adds write-back, the chrome.bookmarks
// write wrappers will markWritten() before each API call.

import { getConfig, onConfigChange } from './lib/storage.js'
import { syncBookmarksToServer } from './lib/sync.js'
import { shouldIgnore } from './lib/write-tracker.js'

// ─── Lifecycle ────────────────────────────────────────────────────────────

// `install` fires the first time the extension loads, and again after
// any code change in the extension (Chrome dev trick). We always
// `skipWaiting()` so the new SW takes over immediately rather than
// waiting for open tabs to close.
self.addEventListener('install', () => {
  // eslint-disable-next-line no-console
  console.log('[dashboard] install')
  self.skipWaiting()
})

// `activate` fires when the SW becomes the active one. `clients.claim()`
// tells already-open pages to use this SW without a reload.
self.addEventListener('activate', (event) => {
  // eslint-disable-next-line no-console
  console.log('[dashboard] activate')
  event.waitUntil(self.clients.claim())
})

// ─── Sync triggers (#005) ───────────────────────────────────────────────

// On extension install (first load + every code change), attempt a
// sync. If the user hasn't configured the server yet (no config in
// storage), this is a no-op — they'll configure via the options page,
// which itself triggers a sync on successful save.
chrome.runtime.onInstalled.addListener(() => {
  triggerSync('onInstalled')
})

// On every browser startup, sync if config exists. This catches the
// case where the user has been adding bookmarks while Chrome was
// closed — Chrome fires onStartup when the browser process starts.
chrome.runtime.onStartup.addListener(() => {
  triggerSync('onStartup')
})

/**
 * Best-effort sync. Logs the result but never throws — the SW has no
 * UI surface to surface errors to, and unhandled rejections in MV3 SWs
 * are silently dropped (we log them via the unhandledrejection handler
 * below for debuggability).
 *
 * @param {string} trigger - human-readable label for the log line
 */
async function triggerSync(trigger) {
  const config = await getConfig()
  if (!config) {
    // eslint-disable-next-line no-console
    console.log(`[dashboard] sync skipped (${trigger}): not configured`)
    return
  }
  const result = await syncBookmarksToServer({ eventType: trigger })
  // eslint-disable-next-line no-console
  console.log(`[dashboard] sync (${trigger}):`, result)
}

// ─── Event-driven sync (#006) ──────────────────────────────────────────

// chrome.bookmarks.* events fire on every bookmark change the user
// makes in Chrome (via the bookmark manager, the address bar, sync
// from another device, etc.). Each listener schedules a debounced
// sync. The 300ms debounce coalesces bursts of events that fire in
// quick succession (e.g., a multi-bookmark move).
//
// The server's BookmarkDiffer (#006) computes the minimal CRUD ops
// from the full tree, so we don't need per-event delta logic on the
// extension side. This keeps the SW simple and idempotent — multiple
// events trigger one debounced full sync that ends up as a true
// no-op when nothing actually changed (differ emits zero ops).

const DEBOUNCE_MS = 300

/** Pending debounce timer, if any. */
let pendingTimer = null

/**
 * Generic event listener. Checks the write-tracker first (feedback
 * loop prevention); if not ignored, schedules a debounced sync.
 *
 * @param {string} eventType - which chrome.bookmarks event fired
 * @param {string} chromeId - the chromeId of the affected bookmark/folder
 */
function onBookmarkEvent(eventType, chromeId) {
  if (typeof chromeId === 'string' && shouldIgnore(chromeId)) {
    // eslint-disable-next-line no-console
    console.log(`[dashboard] ${eventType} ignored (own write): ${chromeId}`)
    return
  }
  scheduleSync(eventType, chromeId)
}

/**
 * Schedule a debounced sync. Multiple events within DEBOUNCE_MS are
 * coalesced into one sync.
 *
 * @param {string} eventType
 * @param {string} chromeId
 */
function scheduleSync(eventType, chromeId) {
  if (pendingTimer !== null) clearTimeout(pendingTimer)
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    triggerSync(eventType).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[dashboard] ${eventType} sync failed:`, err)
    })
  }, DEBOUNCE_MS)
  // eslint-disable-next-line no-console
  console.log(`[dashboard] ${eventType} queued (${DEBOUNCE_MS}ms debounce): ${chromeId}`)
}

chrome.bookmarks.onCreated.addListener((_id, node) => {
  onBookmarkEvent('onCreated', node.id)
})

chrome.bookmarks.onChanged.addListener((id, _changeInfo) => {
  onBookmarkEvent('onChanged', id)
})

chrome.bookmarks.onRemoved.addListener((id, _removeInfo) => {
  onBookmarkEvent('onRemoved', id)
})

chrome.bookmarks.onMoved.addListener((id, _moveInfo) => {
  onBookmarkEvent('onMoved', id)
})

// ─── Config change observation (debug + future hooks) ─────────────────────

// Other extension contexts (options page, popup) can update the saved
// config. Observing here is mostly for debugging today; future hooks
// (e.g., re-registering event listeners with a new token) can plug in
// here.
onConfigChange((config) => {
  if (config) {
    // eslint-disable-next-line no-console
    console.log('[dashboard] config updated', {
      serverUrl: config.serverUrl,
      savedAt: config.savedAt,
    })
  } else {
    // eslint-disable-next-line no-console
    console.log('[dashboard] config cleared')
  }
})

// ─── Error capture ────────────────────────────────────────────────────────

// Surface unhandled promise rejections and errors to the SW console —
// Chrome swallows these silently otherwise, which makes MV3 SW
// debugging painful.
self.addEventListener('unhandledrejection', (event) => {
  // eslint-disable-next-line no-console
  console.error('[dashboard] unhandled rejection', event.reason)
})

// ─── Re-exports for tests / advanced consumers ──────────────────────────
//
// Nothing else here — the chrome.bookmarks event listeners above are
// the issue #006 surface. Future v2 write wrappers (which would call
// `markWritten()` to prevent feedback loops) would live alongside them.