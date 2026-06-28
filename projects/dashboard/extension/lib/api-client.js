// api-client.js — fetch wrapper for the dashboard server.
//
// Adds Bearer auth from chrome.storage.local to every request, and
// throws an `ApiError` on non-2xx so callers can branch on `err.status`.
//
// The host permission for `serverUrl` must already be granted when this
// is called — the options page is responsible for requesting it.

import { getConfig } from './storage.js'

export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} body
   * @param {string} message
   */
  constructor(status, body, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export class ConfigMissingError extends Error {
  constructor() {
    super('Extension is not configured. Open the options page and save the server URL + API token.')
    this.name = 'ConfigMissingError'
  }
}

/**
 * Issue a request to the dashboard. The base URL is read from storage.
 *
 * @template T
 * @param {string} method - HTTP method (e.g. "GET", "POST")
 * @param {string} path - path relative to serverUrl, e.g. "/api/tokens"
 * @param {unknown} [body] - JSON-serializable request body
 * @returns {Promise<T>}
 */
export async function request(method, path, body) {
  const config = await getConfig()
  if (!config) throw new ConfigMissingError()

  const url = new URL(path, ensureTrailingSlash(config.serverUrl)).toString()
  const headers = {
    Authorization: `Bearer ${config.apiToken}`,
    Accept: 'application/json',
  }
  const init = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  let res
  try {
    res = await fetch(url, init)
  } catch (err) {
    // Network errors (DNS, connection refused, CORS) surface here.
    const message = err instanceof Error ? err.message : String(err)
    throw new ApiError(0, '', `Network error: ${message}`)
  }

  const text = await res.text()
  if (!res.ok) {
    throw new ApiError(res.status, text, `HTTP ${res.status} on ${method} ${path}`)
  }

  // JSON or empty — both are fine. An empty body returns `null` from
  // `JSON.parse('')` throws, so guard.
  if (text.length === 0) return /** @type {T} */ (/** @type {unknown} */ (null))
  try {
    return /** @type {T} */ (JSON.parse(text))
  } catch {
    // Non-JSON success body — return as raw text under a string.
    return /** @type {T} */ (/** @type {unknown} */ (text))
  }
}

/**
 * Validate a token against the server. Hits `GET /api/tokens` which
 * requires auth and returns the token list — works whether or not any
 * tokens have been generated yet (returns `{tokens: []}` on success).
 *
 * @param {string} serverUrl
 * @param {string} apiToken
 * @returns {Promise<{ ok: true } | { ok: false; status: number; reason: string }>}
 */
export async function validateToken(serverUrl, apiToken) {
  // Normalize: strip trailing slash so URL constructor behaves.
  const base = ensureTrailingSlash(serverUrl)
  const url = new URL('/api/tokens', base).toString()

  let res
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 0, reason: `Network error: ${message}` }
  }

  if (res.ok) return { ok: true }
  if (res.status === 401) return { ok: false, status: 401, reason: 'Token rejected (401)' }
  return { ok: false, status: res.status, reason: `HTTP ${res.status}` }
}

/**
 * @param {string} serverUrl
 * @returns {string}
 */
export function ensureTrailingSlash(serverUrl) {
  return serverUrl.endsWith('/') ? serverUrl : serverUrl + '/'
}