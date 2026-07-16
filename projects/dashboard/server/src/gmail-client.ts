// gmail-client.ts — issue #020
//
// Deep module around the Gmail REST API. Encapsulates OAuth refresh on
// 401 and exponential backoff on 429 so the sync worker (#021) and
// downstream callers don't reimplement either policy. One instance is
// bound to a single connected `email_accounts` row; if a worker needs
// to fan out across accounts, it builds one client per account.
//
// Gmail endpoints (all `users/me`, no `--user-id` override needed):
//   GET /gmail/v1/users/me/messages              — paged list of message ids
//   GET /gmail/v1/users/me/messages/{id}?format=full — full message body
//   GET /gmail/v1/users/me/threads/{id}?format=full  — full thread
//
// Scope requested is exactly `gmail.readonly`. The PRD forbids
// `gmail.modify` / `gmail.send` / `gmail.compose`; `getScope()` is the
// assertion point tests use to catch a scope regression.
//
// Retry policy:
//   * 401 → POST to oauth2.googleapis.com/token to refresh, swap the
//     stored tokens, retry the original request once. A second 401
//     propagates `RefreshFailedError`.
//   * 429 → exponential backoff with jitter, up to `maxRetries` total
//     attempts. Honors `Retry-After` when Gmail sends one.
//   * Other non-2xx → throw `GmailApiError` immediately. Callers decide
//     whether to retry at a higher level (the sync worker does).
//
// Testability: every network call goes through `fetchFn`, injectable at
// construction. `sleepFn` is also injectable so 429-backoff tests run in
// zero real milliseconds.

import type { Database } from './db.js'
import type { TokenCipher } from './token-encryption.js'
import {
  getEmailAccount,
  updateEmailAccountTokens,
} from './email-accounts.js'
import { htmlToPlainText } from './email-body.js'

// ─── Constants ────────────────────────────────────────────────────────────

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** The exact scope we request. Tests assert on this string. */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

const DEFAULT_MAX_RETRIES = 5
const DEFAULT_BASE_BACKOFF_MS = 250

// ─── Public types ─────────────────────────────────────────────────────────

export interface RawEmailAddress {
  readonly name: string | null
  readonly email: string
}

/**
 * Normalised shape that downstream callers (the sync worker, the read
 * API, the LLM tools) consume. Decoded from Gmail's nested, base64url-
 * encoded payload at fetch time so the rest of the codebase never sees
 * the wire format.
 */
export interface RawEmail {
  readonly id: string
  readonly threadId: string
  /** ISO 8601 derived from Gmail's `internalDate` ms. */
  readonly internalDate: string
  readonly snippet: string
  readonly subject: string
  readonly from: RawEmailAddress | null
  readonly to: readonly RawEmailAddress[]
  readonly cc: readonly RawEmailAddress[]
  readonly bodyPlain: string
  readonly bodyHtml?: string | null
  readonly labels: readonly string[]
  readonly isUnread: boolean
}

/**
 * Minimal message metadata from `GET /messages`. Gmail's list endpoint
 * returns id + threadId only; snippets are NOT included unless the
 * caller explicitly opts in via `fields=`. We mirror that — callers
 * that want snippets should follow up with `getMessage(id)`.
 */
export interface RawEmailSummary {
  readonly id: string
  readonly threadId: string
}

export interface ListMessagesArgs {
  /** ISO 8601 lower bound (`q=after:<epoch-seconds>` filter). Omit for full scan. */
  readonly since?: string
  /** Opaque token from a previous response's `nextPageToken`. */
  readonly pageToken?: string
  /** Gmail's `maxResults`. Defaults to 100 (Gmail's max). */
  readonly maxResults?: number
}

export interface ListMessagesResponse {
  readonly messages: readonly RawEmailSummary[]
  readonly nextPageToken: string | null
}

// ─── Errors ──────────────────────────────────────────────────────────────

/** Non-2xx response from the Gmail API that should not be retried by
 *  this module (anything other than 401/429). */
export class GmailApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'GmailApiError'
    this.status = status
  }
}

/** The refresh-token exchange failed (network error, invalid_grant, etc). */
export class RefreshFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshFailedError'
  }
}

// ─── GmailClient ──────────────────────────────────────────────────────────

export interface GmailClientDeps {
  readonly db: Database
  readonly cipher: TokenCipher
  /** Stored row id in `email_accounts`. Used to look up + persist tokens. */
  readonly accountId: string
  /** OAuth client id / secret for refresh-token exchanges. */
  readonly oauthClientId: string
  readonly oauthClientSecret: string
  /** Injected for tests. Defaults to global `fetch`. */
  readonly fetchFn?: typeof fetch
  /** Injected for tests. Defaults to `setTimeout`-based sleep. */
  readonly sleepFn?: (ms: number) => Promise<void>
  /** Total attempts including the initial call. Default 5. */
  readonly maxRetries?: number
  /** First backoff sleep; doubles on each retry, with jitter. Default 250ms. */
  readonly baseBackoffMs?: number
  /** Injected for tests; returns the current time for absolute-date
   *  reasons (Retry-After HTTP-date parsing). Default `Date.now`. */
  readonly nowMs?: () => number
}

export class GmailClient {
  readonly #db: Database
  readonly #cipher: TokenCipher
  readonly #accountId: string
  readonly #oauthClientId: string
  readonly #oauthClientSecret: string
  readonly #fetchFn: typeof fetch
  readonly #sleep: (ms: number) => Promise<void>
  readonly #maxRetries: number
  readonly #baseBackoffMs: number
  readonly #nowMs: () => number
  /** Single refresh per client lifetime — Gmail refresh tokens are not
   *  rate-limited but we don't want to thrash if the API is misbehaving. */
  #refreshUsedThisCall = false

  constructor(deps: GmailClientDeps) {
    this.#db = deps.db
    this.#cipher = deps.cipher
    this.#accountId = deps.accountId
    this.#oauthClientId = deps.oauthClientId
    this.#oauthClientSecret = deps.oauthClientSecret
    this.#fetchFn = deps.fetchFn ?? fetch
    this.#sleep = deps.sleepFn ?? defaultSleep
    this.#maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES
    this.#baseBackoffMs = deps.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS
    this.#nowMs = deps.nowMs ?? (() => Date.now())
  }

  /** The OAuth scope this module expects to be authorised under.
   *  Exported primarily so tests can assert no scope regression. */
  static getScope(): string {
    return GMAIL_READONLY_SCOPE
  }

  // ─── Public API ─────────────────────────────────────────────────────

  async listMessages(args: ListMessagesArgs = {}): Promise<ListMessagesResponse> {
    const params = new URLSearchParams()
    if (args.maxResults !== undefined) {
      params.set('maxResults', String(args.maxResults))
    }
    if (args.pageToken !== undefined) {
      params.set('pageToken', args.pageToken)
    }
    if (args.since !== undefined) {
      // Gmail's `q` after: filter takes unix seconds.
      const sinceSec = Math.floor(new Date(args.since).getTime() / 1000)
      if (Number.isFinite(sinceSec)) {
        params.set('q', `after:${sinceSec}`)
      }
    }
    const qs = params.toString()
    const url = `${GMAIL_API_BASE}/messages${qs ? `?${qs}` : ''}`

    const json = await this.#gmailFetch<{
      messages?: Array<{ id?: string; threadId?: string }>
      nextPageToken?: string
    }>(url)

    return {
      messages: (json.messages ?? [])
        .filter((m): m is { id: string; threadId: string } =>
          typeof m.id === 'string' && typeof m.threadId === 'string')
        .map((m) => ({ id: m.id, threadId: m.threadId })),
      nextPageToken: json.nextPageToken ?? null,
    }
  }

  async getMessage(id: string): Promise<RawEmail> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('getMessage: id is required')
    }
    const url = `${GMAIL_API_BASE}/messages/${encodeURIComponent(id)}?format=full`
    const json = await this.#gmailFetch<GmailMessageFull>(url)
    return parseGmailMessage(json)
  }

  async getThread(id: string): Promise<RawEmail[]> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('getThread: id is required')
    }
    const url = `${GMAIL_API_BASE}/threads/${encodeURIComponent(id)}?format=full`
    const json = await this.#gmailFetch<{
      messages?: GmailMessageFull[]
    }>(url)
    return (json.messages ?? []).map(parseGmailMessage)
  }

  // ─── Fetch with retry + refresh ─────────────────────────────────────

  async #gmailFetch<T>(url: string): Promise<T> {
    let attempt = 0
    while (true) {
      const token = this.#currentAccessToken()
      const res = await this.#doFetch(url, token)

      if (res.status === 401) {
        // First 401 → refresh once and retry. A second 401 after the
        // refresh means the new access token didn't help → that's a
        // credentials problem, not a transient API error, so it
        // surfaces as `RefreshFailedError`.
        if (!this.#refreshUsedThisCall) {
          this.#refreshUsedThisCall = true
          try {
            await this.#refreshTokens()
          } catch (err: unknown) {
            throw new RefreshFailedError(
              `token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
          // Loop again with the fresh token.
          continue
        }
        throw new RefreshFailedError(
          `still unauthorised after refresh (401 from ${url})`,
        )
      }

      if (res.status === 429) {
        // Honour Retry-After when present; otherwise exponential backoff.
        // `maxRetries` is retries-after-initial, so we sleep before each
        // retry and give up after we've slept `maxRetries` times.
        attempt++
        if (attempt > this.#maxRetries) {
          throw new GmailApiError(
            429,
            `Gmail API rate-limited after ${attempt} attempts`,
          )
        }
        const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), this.#nowMs())
        const backoffMs = retryAfterMs ?? backoffWithJitter(this.#baseBackoffMs, attempt)
        await this.#sleep(backoffMs)
        continue
      }

      if (res.status < 200 || res.status >= 300) {
        let detail = ''
        try {
          detail = (await res.text()).slice(0, 500)
        } catch {
          // ignore — status code + empty detail is enough to diagnose.
        }
        throw new GmailApiError(
          res.status,
          `Gmail API ${res.status} on ${url}: ${detail || res.statusText}`,
        )
      }

      // 2xx — parse and return.
      try {
        return (await res.json()) as T
      } catch (err: unknown) {
        throw new GmailApiError(res.status, `invalid JSON in 2xx response: ${errMessage(err)}`)
      }
    }
  }

  async #doFetch(url: string, accessToken: string): Promise<Response> {
    return this.#fetchFn(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
  }

  // ─── Token refresh ──────────────────────────────────────────────────

  #currentAccessToken(): string {
    const account = getEmailAccount(this.#db, this.#cipher, this.#accountId)
    if (!account) {
      throw new Error(`email_accounts row ${this.#accountId} not found`)
    }
    return account.accessToken
  }

  async #refreshTokens(): Promise<void> {
    const account = getEmailAccount(this.#db, this.#cipher, this.#accountId)
    if (!account) throw new Error('email_accounts row missing during refresh')

    const body = new URLSearchParams({
      client_id: this.#oauthClientId,
      client_secret: this.#oauthClientSecret,
      refresh_token: account.refreshToken,
      grant_type: 'refresh_token',
    })

    const res = await this.#fetchFn(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!res.ok) {
      let detail = ''
      try {
        detail = await res.text()
      } catch {
        // ignore
      }
      throw new RefreshFailedError(`refresh endpoint returned ${res.status}: ${detail.slice(0, 200)}`)
    }

    const json = (await res.json()) as {
      access_token?: string
      expires_in?: number
      refresh_token?: string
    }
    if (typeof json.access_token !== 'string') {
      throw new RefreshFailedError('refresh response missing access_token')
    }
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600
    const expiresAt = new Date(this.#nowMs() + expiresIn * 1000).toISOString()

    updateEmailAccountTokens(this.#db, this.#cipher, this.#accountId, {
      accessToken: json.access_token,
      // Google does not always rotate refresh tokens; keep the old one
      // when the response omits it. (Some OAuth flows also never
      // include it — the standard "if absent, keep" semantic.)
      refreshToken: json.refresh_token ?? account.refreshToken,
      tokenExpiresAt: expiresAt,
    })
  }
}

// ─── Gmail message parsing ───────────────────────────────────────────────

/**
 * Subset of Gmail's `messages` resource that we actually consume. Fields
 * that aren't relevant to the mirror are typed loosely (`unknown`) — we
 * never branch on them, only ignore them. Keeps the wire format stable
 * against future, irrelevant Gmail additions.
 *
 * Format reference: https://developers.google.com/gmail/api/reference/rest/v1/users.messages
 */
interface GmailMessageFull {
  id: string
  threadId: string
  internalDate?: string
  snippet?: string
  labelIds?: string[]
  payload?: {
    mimeType?: string
    headers?: Array<{ name?: string; value?: string }>
    body?: { data?: string }
    parts?: GmailMessagePart[]
  }
}

interface GmailMessagePart {
  partId?: string
  mimeType?: string
  filename?: string
  body?: { data?: string; attachmentId?: string }
  parts?: GmailMessagePart[]
  headers?: Array<{ name?: string; value?: string }>
}

function parseGmailMessage(msg: GmailMessageFull): RawEmail {
  const headers = parseHeaders(msg.payload?.headers ?? [])
  const bodyHtml = extractHtmlBody(msg.payload)
  const bodyPlain = extractPlainTextBody(msg.payload) ?? (bodyHtml ? htmlToPlainText(bodyHtml) : '')
  const from = parseAddress(headers['from'] ?? '')
  const to = parseAddressList(headers['to'] ?? '')
  const cc = parseAddressList(headers['cc'] ?? [])

  const internalDateIso = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString()
    : new Date(0).toISOString()

  return {
    id: msg.id,
    threadId: msg.threadId,
    internalDate: internalDateIso,
    snippet: msg.snippet ?? '',
    subject: headers['subject'] ?? '',
    from,
    to,
    cc,
    bodyPlain,
    bodyHtml,
    labels: msg.labelIds ?? [],
    isUnread: (msg.labelIds ?? []).includes('UNREAD'),
  }
}

function parseHeaders(
  headers: ReadonlyArray<{ name?: string; value?: string }>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const h of headers) {
    if (typeof h.name === 'string' && typeof h.value === 'string') {
      out[h.name.toLowerCase()] = h.value
    }
  }
  return out
}

function extractPlainTextBody(
  payload: GmailMessageFull['payload'],
): string | null {
  if (!payload) return null

  // Simple (non-multipart) message: the body sits directly on `payload.body`.
  if (payload.body?.data && !payload.parts) {
    return payload.mimeType?.toLowerCase() === 'text/html'
      ? null
      : decodeBase64Url(payload.body.data)
  }

  // Multipart: walk the part tree depth-first. Prefer text/plain when
  // present (RFC 2046 multipart/alternative carries BOTH text/plain and
  // text/html; we want the plain one). Fall back to any data-bearing
  // part so we still surface something if the sender omitted the type.
  if (payload.parts) {
    const flat = flattenParts(payload.parts)
    for (const part of flat) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data)
      }
    }
    for (const part of flat) {
      if (part.body?.data && part.mimeType?.startsWith('text/') && part.mimeType !== 'text/html') {
        return decodeBase64Url(part.body.data)
      }
    }
  }

  return null
}

function extractHtmlBody(payload: GmailMessageFull['payload']): string | null {
  if (!payload) return null
  if (payload.body?.data && !payload.parts && payload.mimeType?.toLowerCase() === 'text/html') {
    return decodeBase64Url(payload.body.data)
  }
  if (!payload.parts) return null
  const part = flattenParts(payload.parts).find(
    (candidate) => candidate.mimeType?.toLowerCase() === 'text/html' && candidate.body?.data,
  )
  return part?.body?.data ? decodeBase64Url(part.body.data) : null
}

function flattenParts(parts: GmailMessagePart[]): GmailMessagePart[] {
  const out: GmailMessagePart[] = []
  const stack = [...parts]
  while (stack.length > 0) {
    const p = stack.shift()!
    out.push(p)
    if (p.parts) stack.unshift(...p.parts)
  }
  return out
}

function decodeBase64Url(s: string): string {
  // Gmail uses URL-safe base64 (no padding). Node tolerates either; the
  // padding fallback below handles the stripped-pad case in case a
  // Gmail response happens to omit some.
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4)
  return Buffer.from(padded, 'base64url').toString('utf8')
}

function parseAddress(value: string): RawEmailAddress | null {
  const list = parseAddressList(value)
  return list[0] ?? null
}

/** Parse a header value (To, Cc, possibly with commas) into addresses.
 *  Handles `"Name" <addr@host>` and bare `addr@host`. */
function parseAddressList(value: string | string[]): RawEmailAddress[] {
  // Multi-valued headers arrive as a string from Gmail; the rare case
  // where the header value itself is an array would happen only if
  // Gmail duplicated the header, which we tolerate for robustness.
  const raw = Array.isArray(value) ? value.join(', ') : value
  if (raw.trim() === '') return []

  // Split on commas that aren't inside angle brackets.
  const tokens = splitOnTopLevelCommas(raw)
  const out: RawEmailAddress[] = []
  for (const tok of tokens) {
    const trimmed = tok.trim()
    if (trimmed === '') continue
    const m = /^(?:"?(.*?)?"?\s*)?<([^>]+)>\s*$/.exec(trimmed)
    if (m) {
      const name = (m[1] ?? '').trim()
      const email = (m[2] ?? '').trim()
      if (email) out.push({ name: name === '' ? null : name, email })
    } else if (trimmed.includes('@')) {
      out.push({ name: null, email: trimmed })
    }
  }
  return out
}

function splitOnTopLevelCommas(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let inQuotes = false
  let buf = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"' && s[i - 1] !== '\\') inQuotes = !inQuotes
    if (!inQuotes) {
      if (c === '<') depth++
      else if (c === '>') depth--
    }
    if (c === ',' && depth === 0 && !inQuotes) {
      out.push(buf)
      buf = ''
    } else {
      buf += c
    }
  }
  if (buf.length > 0) out.push(buf)
  return out
}

// ─── Retry-after / backoff helpers ────────────────────────────────────────

function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  if (value === null) return null
  // Could be either a delta-seconds count or an HTTP-date.
  const asNumber = Number(value)
  if (Number.isFinite(asNumber) && asNumber >= 0) return asNumber * 1000
  const asDate = Date.parse(value)
  if (Number.isFinite(asDate)) {
    const diff = asDate - nowMs
    return diff > 0 ? diff : 0
  }
  return null
}

function backoffWithJitter(baseMs: number, attempt: number): number {
  // Exponential backoff: base * 2^(attempt-1), capped at 30s. Add up to
  // ±25% jitter so multiple clients don't synchronise their retries.
  const exp = baseMs * 2 ** Math.max(0, attempt - 1)
  const cap = 30_000
  const clamped = Math.min(cap, exp)
  const jitter = clamped * 0.25 * (Math.random() * 2 - 1)
  return Math.max(0, Math.round(clamped + jitter))
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
