// options.js — wiring for the Dashboard Sync options page.
//
// Flow on Save:
//   1. Read URL + token from form
//   2. Validate URL shape (basic; full validation happens server-side)
//   3. Request host permission for the origin via chrome.permissions
//      (no-op if already granted)
//   4. Validate token against GET /api/tokens
//   5. If both succeed, persist to chrome.storage.local and show success
//
// Any failure shows a clear, actionable error and leaves storage untouched.

import { getConfig, setConfig, clearConfig } from '../lib/storage.js'
import { validateToken } from '../lib/api-client.js'
import { syncBookmarksToServer } from '../lib/sync.js'

// ─── DOM refs ─────────────────────────────────────────────────────────────

const form = /** @type {HTMLFormElement} */ (document.getElementById('config-form'))
const urlInput = /** @type {HTMLInputElement} */ (document.getElementById('server-url'))
const tokenInput = /** @type {HTMLInputElement} */ (document.getElementById('api-token'))
const saveButton = /** @type {HTMLButtonElement} */ (document.getElementById('save-button'))
const clearButton = /** @type {HTMLButtonElement} */ (document.getElementById('clear-button'))
const status = /** @type {HTMLDivElement} */ (document.getElementById('status'))
const savedInfo = /** @type {HTMLElement} */ (document.getElementById('saved-info'))
const savedServer = /** @type {HTMLElement} */ (document.getElementById('saved-server'))
const savedAt = /** @type {HTMLElement} */ (document.getElementById('saved-at'))

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * @param {'info' | 'success' | 'error'} kind
 * @param {string} message
 */
function showStatus(kind, message) {
  status.hidden = false
  status.className = `status ${kind}`
  // textContent (not innerHTML) so server-supplied content can't inject
  // HTML into the options page.
  status.textContent = message
}

function hideStatus() {
  status.hidden = true
  status.textContent = ''
  status.className = 'status'
}

/**
 * Set both buttons' disabled state in one place so the submit handler
 * doesn't need to remember.
 * @param {boolean} busy
 */
function setBusy(busy) {
  saveButton.disabled = busy
  clearButton.disabled = busy
  if (busy) saveButton.textContent = 'Saving…'
  else saveButton.textContent = 'Save and validate'
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isValidUrlShape(value) {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * @param {string} serverUrl
 * @returns {string[]}
 */
function originPatterns(serverUrl) {
  // chrome.permissions takes patterns like `http://host:port/*`.
  const u = new URL(serverUrl)
  return [`${u.protocol}//${u.host}/*`]
}

/**
 * @param {string} originPattern
 * @returns {Promise<boolean>}
 */
async function ensureHostPermission(originPattern) {
  const already = await chrome.permissions.contains({ origins: [originPattern] })
  if (already) return true
  return chrome.permissions.request({ origins: [originPattern] })
}

// ─── Initial load ─────────────────────────────────────────────────────────

/**
 * Hydrate the form from chrome.storage.local. Wrapped so any single
 * failure (bad date string, missing field, DOM race) surfaces in the
 * status area instead of silently leaving the form empty.
 */
async function hydrateFromStorage() {
  let existing
  try {
    existing = await getConfig()
  } catch (err) {
    showStatus('error', `Could not read saved settings: ${describeError(err)}`)
    return
  }

  if (!existing) {
    // First-time user — no saved settings, nothing to hydrate.
    return
  }

  // Each DOM write in its own try/catch so one failure doesn't blank
  // the others. The most likely thrower is `new Date(savedAt)` if the
  // ISO string got mangled somehow — we want the inputs filled even if
  // the saved-at display fails.
  try { urlInput.value = existing.serverUrl } catch { /* element not ready */ }
  try { tokenInput.value = existing.apiToken } catch { /* element not ready */ }
  try {
    savedServer.textContent = existing.serverUrl
  } catch { /* savedServer missing */ }

  try {
    if (existing.savedAt) {
      const d = new Date(existing.savedAt)
      // `new Date(badString)` doesn't throw — it returns an Invalid Date
      // whose `toLocaleString()` returns the string "Invalid Date".
      // Detect that explicitly so the user doesn't see "Invalid Date".
      savedAt.textContent = Number.isNaN(d.getTime())
        ? 'unknown'
        : d.toLocaleString()
    } else {
      savedAt.textContent = 'unknown'
    }
  } catch {
    savedAt.textContent = 'unknown'
  }

  savedInfo.hidden = false
  // Brief status so the user can see hydration actually happened.
  showStatus('info', 'Loaded saved settings. The token is shown as ••••• — re-enter to rotate.')
}

hydrateFromStorage()

// ─── Submit handler ───────────────────────────────────────────────────────

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  hideStatus()

  const serverUrl = urlInput.value.trim()
  const apiToken = tokenInput.value.trim()

  if (!isValidUrlShape(serverUrl)) {
    showStatus(
      'error',
      'Server URL must start with http:// or https:// and include a host (e.g. http://192.168.0.136:8080).',
    )
    return
  }

  if (apiToken.length === 0) {
    showStatus('error', 'API token is required.')
    return
  }

  setBusy(true)

  try {
    // Step 1: ensure host permission for the origin.
    const [pattern] = originPatterns(serverUrl)
    const granted = await ensureHostPermission(pattern)
    if (!granted) {
      showStatus(
        'error',
        `Host permission for ${pattern} was not granted. The extension cannot reach the server without it.`,
      )
      return
    }

    // Step 2: validate the token against the server.
    showStatus('info', 'Validating token…')
    const validation = await validateToken(serverUrl, apiToken)
    if (!validation.ok) {
      showStatus('error', `Token validation failed: ${validation.reason}`)
      return
    }

    // Step 3: persist.
    const savedAtIso = new Date().toISOString()
    await setConfig({ serverUrl, apiToken, savedAt: savedAtIso })

    savedServer.textContent = serverUrl
    savedAt.textContent = new Date(savedAtIso).toLocaleString()
    savedInfo.hidden = false
    showStatus('success', 'Settings saved. Token validated against the server.')

    // Step 4 (issue #005): initial sync of Chrome bookmarks into the
    // dashboard. This is the "first run" flow — once config is saved,
    // immediately push the bookmark tree so the dashboard reflects it.
    // Tag the sync as "options_save" so the server can distinguish it
    // from event-driven syncs in logs.
    showStatus('info', 'Syncing bookmarks from Chrome…')
    const syncResult = await syncBookmarksToServer({ eventType: 'options_save' })
    if (syncResult.ok) {
      showStatus(
        'success',
        `Settings saved. Synced ${syncResult.bookmarkCount} bookmarks across ${syncResult.folderCount} folders.`,
      )
    } else {
      // Settings are saved; sync can be retried by editing & saving
      // again, or by restarting the browser. Don't surface as a hard
      // error — token validation already passed.
      showStatus(
        'error',
        `Settings saved, but bookmark sync failed: ${syncResult.reason}. You can retry by editing and saving again.`,
      )
    }
  } catch (err) {
    showStatus('error', `Could not save: ${describeError(err)}`)
  } finally {
    setBusy(false)
  }
})

// ─── Clear handler ────────────────────────────────────────────────────────

clearButton.addEventListener('click', async () => {
  hideStatus()
  setBusy(true)
  try {
    await clearConfig()
    urlInput.value = ''
    tokenInput.value = ''
    savedInfo.hidden = true
    showStatus('info', 'Saved settings cleared.')
  } catch (err) {
    showStatus('error', `Could not clear: ${describeError(err)}`)
  } finally {
    setBusy(false)
  }
})

// ─── Misc ─────────────────────────────────────────────────────────────────

/**
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  if (err instanceof Error) return err.message
  return String(err)
}