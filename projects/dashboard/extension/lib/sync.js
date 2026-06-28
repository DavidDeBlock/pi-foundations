// sync.js — Chrome bookmarks → Dashboard server.
//
// Flow:
//   1. Read the full bookmark tree via chrome.bookmarks.getTree()
//   2. Flatten the nested tree into the server's expected shape:
//        folders: [{ chromeId, parentChromeId, name }, ...]
//        bookmarks: [{ chromeId, url, title, folderChromeId, ... }, ...]
//   3. POST to /api/bookmarks/sync
//   4. Return a summary so the caller (SW or options page) can show
//      "synced N bookmarks across M folders" feedback.
//
// The flattening step skips Chrome's synthetic root node (id "0") so
// the top-level folders ("Bookmarks bar", "Other bookmarks", etc.)
// become root folders in our DB. Bookmarks always live inside folders —
// a bookmark at the Chrome root would be malformed.

import { request } from './api-client.js'

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Read all Chrome bookmarks and push them to the server.
 *
 * @param {object} [opts]
 * @param {string} [opts.eventType] - which chrome.bookmarks event triggered
 *   this sync (e.g. 'onCreated', 'onChanged'). Sent in the request
 *   payload as `syncedFrom` so the server can log it.
 * @returns {Promise<
 *   | { ok: true;  folderCount: number; bookmarkCount: number }
 *   | { ok: false; reason: string }
 * >}
 */
export async function syncBookmarksToServer({ eventType } = {}) {
  let tree
  try {
    tree = await chrome.bookmarks.getTree()
  } catch (err) {
    return {
      ok: false,
      reason: `Could not read Chrome bookmarks: ${describeError(err)}`,
    }
  }

  const { folders, bookmarks } = flattenTree(tree)

  // Mark this sync as extension-initiated so the server can log it.
  // For initial startup syncs (no eventType), use 'extension_startup';
  // for event-driven syncs, prefix the event type so the server log
  // shows exactly what triggered the sync.
  const syncedFrom = eventType
    ? `extension_event:${eventType}`
    : 'extension_startup'

  try {
    await request('POST', '/api/bookmarks/sync', {
      folders,
      bookmarks,
      syncedFrom,
    })
    return { ok: true, folderCount: folders.length, bookmarkCount: bookmarks.length }
  } catch (err) {
    // `request` throws ApiError on non-2xx with the status + body
    // attached. Surface a short reason for the UI.
    return {
      ok: false,
      reason: err && typeof err === 'object' && 'message' in err
        ? /** @type {Error} */ (err).message
        : String(err),
    }
  }
}

// ─── Internal: tree flattening ───────────────────────────────────────────

/**
 * Flatten Chrome's nested bookmark tree into the server's input shape.
 * Exported for unit tests.
 *
 * @param {Array} tree - output of chrome.bookmarks.getTree()
 * @returns {{ folders: Array, bookmarks: Array }}
 */
export function flattenTree(tree) {
  const folders = []
  const bookmarks = []

  // Chrome's top-level is a synthetic node with id "0". Its children
  // are the user-visible top-level folders (Bookmarks bar, Other
  // bookmarks, Mobile bookmarks). Skip the synthetic root so those
  // children become roots in our DB.
  for (const root of tree) {
    walk(root, null, folders, bookmarks)
  }

  return { folders, bookmarks }
}

/**
 * @param {{
 *   id: string,
 *   title?: string,
 *   url?: string,
 *   children?: Array,
 *   parentId?: string,
 *   dateAdded?: number,
 *   dateLastModified?: number,
 * }} node
 * @param {string | null} parentChromeId
 * @param {Array} folders
 * @param {Array} bookmarks
 */
function walk(node, parentChromeId, folders, bookmarks) {
  // Skip Chrome's synthetic root node. Its id is always "0".
  if (node.id === '0') {
    for (const child of node.children ?? []) {
      walk(child, null, folders, bookmarks)
    }
    return
  }

  // A node with a `url` is a bookmark. URL is the authoritative
  // discriminator: folders don't have URLs, only bookmarks do. We
  // check URL first so bookmarks that happen to have an empty
  // `children: []` array (which can happen via certain API surfaces
  // or test polyfills) are still classified correctly.
  if (typeof node.url === 'string') {
    bookmarks.push({
      chromeId: node.id,
      url: node.url,
      title: node.title ?? '',
      folderChromeId: /** @type {string} */ (parentChromeId),
      ...(node.dateAdded != null
        ? { createdAt: new Date(node.dateAdded).toISOString() }
        : {}),
      ...(node.dateLastModified != null
        ? { updatedAt: new Date(node.dateLastModified).toISOString() }
        : {}),
    })
    return
  }

  // A node without a URL but with children is a folder.
  if (Array.isArray(node.children)) {
    folders.push({
      chromeId: node.id,
      parentChromeId,
      name: node.title ?? '',
    })
    for (const child of node.children) {
      walk(child, node.id, folders, bookmarks)
    }
  }
  // else: malformed node (no url, no children) — skip silently.
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  if (err instanceof Error) return err.message
  return String(err)
}