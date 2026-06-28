// storage.js — typed wrapper around chrome.storage.local.
//
// One key (`config`) holds the user's server URL + API token. The token is
// stored in chrome.storage.local (not sync) so it never leaves the device
// — that's the right tradeoff for an API secret, even on a single device.
//
// Reads return `null` when nothing is saved yet so callers don't need to
// distinguish "empty object" from "no record".

const KEY_CONFIG = 'config'

/**
 * @typedef {Object} StoredConfig
 * @property {string} serverUrl - e.g. "http://192.168.0.136:8080"
 * @property {string} apiToken  - the plaintext Bearer token
 * @property {string} savedAt   - ISO 8601 timestamp of the last successful save
 */

/**
 * @returns {Promise<StoredConfig | null>}
 */
export async function getConfig() {
  const data = await chrome.storage.local.get(KEY_CONFIG)
  const value = data[KEY_CONFIG]
  if (!value || typeof value !== 'object') return null
  // Defensive normalization in case older records are missing fields.
  if (typeof value.serverUrl !== 'string' || typeof value.apiToken !== 'string') {
    return null
  }
  return /** @type {StoredConfig} */ (value)
}

/**
 * @param {StoredConfig} config
 * @returns {Promise<void>}
 */
export async function setConfig(config) {
  await chrome.storage.local.set({ [KEY_CONFIG]: config })
}

/**
 * @returns {Promise<void>}
 */
export async function clearConfig() {
  await chrome.storage.local.remove(KEY_CONFIG)
}

/**
 * Subscribe to config changes. Used by the service worker to react to
 * options-page edits without polling. Returns the unsubscribe function.
 *
 * @param {(config: StoredConfig | null) => void} listener
 * @returns {() => void}
 */
export function onConfigChange(listener) {
  const wrapped = (changes, area) => {
    if (area !== 'local') return
    if (!Object.prototype.hasOwnProperty.call(changes, KEY_CONFIG)) return
    const next = changes[KEY_CONFIG]?.newValue ?? null
    // Run listener in a microtask so async listeners don't run inside
    // Chrome's storage callback.
    queueMicrotask(() => listener(next))
  }
  chrome.storage.onChanged.addListener(wrapped)
  return () => chrome.storage.onChanged.removeListener(wrapped)
}