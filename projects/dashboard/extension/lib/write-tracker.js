// write-tracker.js — feedback-loop prevention for extension-driven writes.
//
// In v1 the extension is read-only on the Chrome side (per ADR-008 —
// no write-back to Chrome bookmarks). So this module is dormant: the
// set is always empty, and `shouldIgnore()` always returns false.
//
// When v2 adds write-back (e.g., the dashboard lets the user rename a
// bookmark from the UI, the extension updates Chrome via
// `chrome.bookmarks.update`), the write wrappers will call
// `markWritten(chromeId)` BEFORE the chrome.bookmarks API call. The
// chrome.bookmarks event fired by Chrome in response will then be
// matched by `shouldIgnore(chromeId)` and dropped — preventing the
// listener from POSTing the change back to the server, which would
// in turn (in a hypothetical write-back loop) write it back to Chrome,
// forever.
//
// Each entry has a TTL (default 2 seconds) so we don't permanently
// ignore legitimate user edits. After the TTL elapses, the chromeId
// is "forgotten" and the next event for it is processed normally.
//
// The TTL is short because Chrome's bookmark events fire essentially
// synchronously after the API call returns. If we get an event for a
// chromeId we just wrote >2 seconds ago, it's almost certainly a real
// user edit, not our echo.

const DEFAULT_TTL_MS = 2_000
const _written = new Map() // chromeId → expiresAt timestamp

/**
 * Record that the extension just wrote to this chromeId. The event
 * listener will ignore bookmark events for this chromeId until the
 * TTL elapses.
 *
 * @param {string} chromeId
 * @param {number} [ttlMs] - time-to-live in ms; default 2000
 */
export function markWritten(chromeId, ttlMs = DEFAULT_TTL_MS) {
  _written.set(chromeId, Date.now() + ttlMs)
}

/**
 * Returns true if the event for this chromeId should be ignored
 * (because it's our own write echo). Side effect: clears the entry
 * once consumed, so the same chromeId can be re-ignored on a
 * subsequent write.
 *
 * @param {string} chromeId
 * @returns {boolean}
 */
export function shouldIgnore(chromeId) {
  const expiresAt = _written.get(chromeId)
  if (expiresAt === undefined) return false
  if (Date.now() > expiresAt) {
    // TTL elapsed — legitimate event, not our echo
    _written.delete(chromeId)
    return false
  }
  // Within TTL — consume the entry. The next event for this chromeId
  // (if any) will be processed normally. This avoids the "stuck ignore"
  // edge case where a second write of the same bookmark would be ignored
  // because the first write's entry is still there.
  _written.delete(chromeId)
  return true
}

/**
 * Test/debug helper: clear all tracked writes. Not used in production.
 */
export function _clearForTests() {
  _written.clear()
}