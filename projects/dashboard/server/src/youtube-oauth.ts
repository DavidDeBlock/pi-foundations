// youtube-oauth.ts — issue YT-001
//
// The `YouTubeOAuthClient` deep module wraps the OAuth + Data API
// token lifecycle so downstream slices (YT-002 subscriptions sync,
// etc.) don't talk to Google directly. It exposes:
//
//   * getAuthorizationUrl(state)        — build the consent-screen URL
//   * exchangeCode(code)                — exchange auth code for tokens
//   * refresh(refreshToken)             — rotate access token
//   * revoke(token)                     — call Google's revoke endpoint
//   * refreshIfNeeded(account)          — auto-refresh if near expiry
//   * fetchUserIdentity(accessToken)    — Google userinfo lookup
//
// The `youtubeApi` Hono sub-app is the HTTP layer:
//   GET  /oauth/start                   — issue state, redirect to Google
//   GET  /oauth/callback                — verify state, complete flow
//   GET  /connection                    — connection status (JSON)
//   DELETE /connection                  — revoke + remove row
//
// All error paths end at `/settings/youtube?status=error&reason=...`
// so the UI can show a single, consistent banner instead of branching
// on which endpoint produced the failure.
//
// Design decisions (mirrors PRD-003 + the email slice's email-oauth.ts):
//   * CSRF protection uses HMAC-signed state with a 10-minute TTL
//     (token-encryption.ts StateSigner). No server-side state storage
//     needed → no extra table, no cookie cleanup.
//   * We request `access_type=offline` + `prompt=consent` so Google
//     returns a refresh token on every link.
//   * Token revocations are best-effort: a network failure here must
//     not block the local delete. The local delete is the source of
//     truth for "this dashboard no longer touches that YouTube account".
//   * Scope is exactly `youtube.readonly` (see OAUTH_SCOPE constant).
//     If `subscriptions.list` ever returns 403 insufficient-scope,
//     add `youtube.force-ssl` to OAUTH_SCOPE — the only change needed
//     (no schema, no DB migration; the `scopes` column will start
//     storing both).

import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import type { Database } from './db.js'
import type { TokenCipher, StateSigner } from './token-encryption.js'
import type { YouTubeSubscriptionsSync } from './youtube-subscriptions-sync.js'
import type { AuthVariables } from './auth.js'
import {
  createYouTubeAccount,
  deleteYouTubeAccount,
  getMostRecentYouTubeAccountId,
  getYouTubeAccount,
  getYouTubeAccountByEmail,
  listYouTubeAccounts,
  updateYouTubeAccountLastRefreshedAt,
  updateYouTubeAccountTokens,
  type YouTubeAccount,
} from './youtube-accounts.js'

// ─── Constants ────────────────────────────────────────────────────────────

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'

/**
 * The exact scope set requested on the consent screen.
 *
 * Three scopes are needed:
 *   * `youtube.readonly` — the minimum scope for `subscriptions.list`
 *     (YT-002) and the per-channel RSS feed. Read-only is intentional:
 *     the dashboard must NEVER be able to mutate the user's YouTube
 *     account (no uploads, no subscription writes, no playlist edits).
 *     Future slices that need write access (saves, playlists) should
 *     use a different scope and a different consent flow.
 *   * `openid` — base scope for any OpenID-Connect-flavoured identity
 *     verification. Required for the JWT `id_token` returned in the
 *     token-exchange response; not strictly required for the userinfo
 *     endpoint, but harmless and signals "we want OIDC identity".
 *   * `userinfo.email` — REQUIRED to make the v2 userinfo endpoint
 *     return the user's email field. With `openid` alone, the v2
 *     endpoint (`https://www.googleapis.com/oauth2/v2/userinfo`)
 *     returns a 200 with no `email` field. The user is then shown as
 *     `missing email` and the OAuth flow fails. (Switching to the
 *     OIDC v3 endpoint would let `openid` alone work, but the v2
 *     endpoint is what the existing code + tests target.)
 *
 * All three scopes are read-only — none grant any write access to the
 * user's YouTube account, channel, or subscriptions.
 *
 * If `subscriptions.list` ever returns 403 `insufficient authentication
 * scopes`, add `youtube.force-ssl` here:
 *   'https://www.googleapis.com/auth/youtube.readonly
 *    https://www.googleapis.com/auth/youtube.force-ssl
 *    openid https://www.googleapis.com/auth/userinfo.email'
 * No schema change needed — the `scopes` column stores whatever
 * Google returns. The UI displays the granted scopes verbatim.
 *
 * Negative regression assertions in `youtube-oauth.test.ts` catch
 * accidental scope creep (someone adding `youtube.upload` for a test).
 */
export const OAUTH_SCOPE = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ')

/**
 * Refresh window — auto-refresh if the access token expires within
 * this many milliseconds. 5 minutes matches Google's typical
 * "near-expiry" semantics and gives one retry cushion if a refresh
 * network call fails.
 */
export const REFRESH_WINDOW_MS = 5 * 60 * 1000

const STATE_TTL_MS = 10 * 60 * 1000

// ─── YouTubeOAuthClient ───────────────────────────────────────────────────

export interface YouTubeOAuthClientDeps {
  readonly db: Database
  readonly cipher: TokenCipher
  readonly oauthClientId: string
  readonly oauthClientSecret: string
  readonly redirectUri: string
  readonly fetchFn?: typeof fetch
  readonly nowMs?: () => number
}

/**
 * Encapsulates the YouTube/Google OAuth + token lifecycle. All HTTP
 * calls to Google's endpoints go through the injected `fetchFn` so
 * tests can mock without binding to the network.
 *
 * Has `db` + `cipher` access so `refreshIfNeeded` can persist the
 * rotated access token without the caller having to do that work.
 * The CRUD helpers (youtube-accounts.ts) are still public so the
 * HTTP layer can read/write rows directly when it doesn't need
 * OAuth knowledge (e.g. the disconnect endpoint).
 */
export class YouTubeOAuthClient {
  private readonly db: Database
  private readonly cipher: TokenCipher
  private readonly oauthClientId: string
  private readonly oauthClientSecret: string
  private readonly redirectUri: string
  private readonly fetchFn: typeof fetch
  private readonly nowMs: () => number

  constructor(deps: YouTubeOAuthClientDeps) {
    this.db = deps.db
    this.cipher = deps.cipher
    this.oauthClientId = deps.oauthClientId
    this.oauthClientSecret = deps.oauthClientSecret
    this.redirectUri = deps.redirectUri
    this.fetchFn = deps.fetchFn ?? fetch
    this.nowMs = deps.nowMs ?? (() => Date.now())
  }

  /**
   * Build the consent-screen URL. The caller passes in the
   * already-signed state from `StateSigner.sign(nonce, nowMs)`.
   * Returns a fully-formed URL string ready for `c.redirect()`.
   */
  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.oauthClientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: OAUTH_SCOPE,
      // offline + consent guarantees a refresh token on every link,
      // not just the first. Google's servers remember prior consents
      // and won't return a new refresh_token unless forced.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    })
    return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`
  }

  /**
   * Exchange an authorization code for tokens. Throws if Google's
   * endpoint returns a non-2xx response — the HTTP layer catches
   * and redirects with a typed `token_exchange_failed:<detail>`
   * reason so the UI can show what went wrong.
   */
  async exchangeCode(code: string): Promise<GoogleTokenResponse> {
    const res = await this.fetchFn(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.oauthClientId,
        client_secret: this.oauthClientSecret,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    })
    if (!res.ok) {
      const detail = await safeText(res)
      throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`)
    }
    return (await res.json()) as GoogleTokenResponse
  }

  /**
   * Rotate an access token using a refresh token. Returns the new
   * access token + its expiry in seconds. Google's refresh_token
   * grant does NOT return a new refresh token — the existing one
   * keeps working — so callers should keep using the old
   * `refreshToken`.
   */
  async refresh(
    refreshToken: string,
  ): Promise<{ access_token: string; expires_in: number }> {
    const res = await this.fetchFn(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.oauthClientId,
        client_secret: this.oauthClientSecret,
        grant_type: 'refresh_token',
      }).toString(),
    })
    if (!res.ok) {
      const detail = await safeText(res)
      throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`)
    }
    const data = (await res.json()) as {
      access_token?: unknown
      expires_in?: unknown
    }
    if (typeof data.access_token !== 'string' || data.access_token === '') {
      throw new Error('refresh response missing access_token')
    }
    return {
      access_token: data.access_token,
      expires_in: typeof data.expires_in === 'number' ? data.expires_in : 3600,
    }
  }

  /**
   * Best-effort revoke at Google. Throws on network/HTTP failure —
   * callers (the disconnect endpoint) catch and ignore because the
   * local delete is the source of truth for "this dashboard no
   * longer touches that Google account".
   */
  async revoke(token: string): Promise<void> {
    await this.fetchFn(
      `${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`,
      { method: 'POST' },
    )
  }

  /**
   * If the account's access token is missing expiry OR expires within
   * `REFRESH_WINDOW_MS`, rotate it transparently. Persists the new
   * access token + `expires_at` + `last_refreshed_at` to the DB.
   *
   * Returns the fresh tokens so the caller can use them immediately
   * for a Data API call — no re-decrypt needed.
   *
   * Used by YT-002's `SubscriptionsFetcher` so each Data API call
   * (subscriptions.list, channels.list, etc.) doesn't need to know
   * about token expiry at all.
   */
  async refreshIfNeeded(
    account: YouTubeAccount,
  ): Promise<{
    accessToken: string
    expiresAt: string | null
    refreshed: boolean
  }> {
    const now = this.nowMs()
    if (account.tokenExpiresAt !== null) {
      const expiresAtMs = new Date(account.tokenExpiresAt).getTime()
      if (Number.isFinite(expiresAtMs) && expiresAtMs - now > REFRESH_WINDOW_MS) {
        return {
          accessToken: account.accessToken,
          expiresAt: account.tokenExpiresAt,
          refreshed: false,
        }
      }
    }
    const fresh = await this.refresh(account.refreshToken)
    const expiresAt = new Date(now + fresh.expires_in * 1000).toISOString()
    updateYouTubeAccountTokens(this.db, this.cipher, account.id, {
      accessToken: fresh.access_token,
      // Google does NOT return a new refresh token on a refresh_token
      // grant (the existing one keeps working); keep the old one.
      refreshToken: account.refreshToken,
      tokenExpiresAt: expiresAt,
    })
    updateYouTubeAccountLastRefreshedAt(this.db, account.id, new Date(now).toISOString())
    return { accessToken: fresh.access_token, expiresAt, refreshed: true }
  }

  /**
   * Fetch the Google user identity for a freshly-exchanged access
   * token. Throws on HTTP failure, missing fields, or an unverified
   * email. The callback handler in `youtubeApi` catches and
   * redirects with a typed `userinfo_failed:<detail>` reason.
   */
  async fetchUserIdentity(
    accessToken: string,
  ): Promise<{ googleUserId: string; email: string }> {
    const res = await this.fetchFn(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      const detail = await safeText(res)
      throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`)
    }
    const profile = (await res.json()) as {
      id?: unknown
      email?: unknown
      verified_email?: unknown
    }
    if (typeof profile.id !== 'string' || profile.id === '') {
      throw new Error('userinfo response missing id')
    }
    if (typeof profile.email !== 'string' || profile.email === '') {
      throw new Error('userinfo response missing email')
    }
    if (profile.verified_email === false) {
      throw new Error('userinfo email is not verified')
    }
    return { googleUserId: profile.id, email: profile.email }
  }
}

// ─── Wire types (internal) ────────────────────────────────────────────────

interface GoogleTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

// ─── Hono sub-app ─────────────────────────────────────────────────────────

export interface YouTubeApiDeps {
  readonly db: Database
  readonly cipher: TokenCipher
  readonly client: YouTubeOAuthClient
  readonly stateSigner: StateSigner
  /**
   * Optional subscriptions sync (issue YT-002). When provided,
   * the OAuth callback fires a fire-and-forget sync right after
   * the account row is created/updated, so the user's Subscriptions
   * page is populated within ~30s of granting OAuth instead of
   * waiting for the next daily tick. Errors are logged but do NOT
   * fail the OAuth flow — the daily scheduler + manual "Sync now"
   * button are the durable backstops.
   */
  readonly autoSyncOnGrant?: YouTubeSubscriptionsSync
}

/**
 * Mounted at `/api/youtube`. Sub-routes:
 *   * `GET /oauth/start`
 *   * `GET /oauth/callback`
 *   * `GET /connection`
 *   * `DELETE /connection`
 *
 * Single-account in v3.0 — David has one Google account. The DB
 * allows N rows (UNIQUE on email_address, not on count), but the
 * routes read the most-recently-connected account. If a future
 * slice needs multi-account, switch these to operate on `id`.
 */
export function youtubeApi(deps: YouTubeApiDeps): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()
  const client = deps.client
  const nowMs = (): number => Date.now()

  // ─── GET /oauth/start ───────────────────────────────────────────────
  api.get('/oauth/start', (c) => {
    const nonce = randomBytes(16).toString('base64url')
    const issuedAtMs = nowMs()
    const state = deps.stateSigner.sign(nonce, issuedAtMs)
    return c.redirect(client.getAuthorizationUrl(state), 302)
  })

  // ─── GET /oauth/callback ────────────────────────────────────────────
  api.get('/oauth/callback', async (c) => {
    const code = c.req.query('code')
    const state = c.req.query('state')
    const errorParam = c.req.query('error')

    if (errorParam) {
      return redirectWithError(c, c.req.query('error_description') ?? errorParam)
    }
    if (!code || !state) {
      return redirectWithError(c, 'missing_params')
    }

    const verified = deps.stateSigner.verify(state, nowMs())
    if (!verified) {
      return redirectWithError(c, 'invalid_or_expired_state')
    }
    if (nowMs() - verified.issuedAtMs > STATE_TTL_MS) {
      return redirectWithError(c, 'expired_state')
    }

    let tokens: GoogleTokenResponse
    try {
      tokens = await client.exchangeCode(code)
    } catch (err: unknown) {
      return redirectWithError(
        c,
        `token_exchange_failed: ${err instanceof Error ? err.message : 'unknown'}`,
      )
    }

    const accessToken = tokens.access_token
    const newRefreshToken = tokens.refresh_token
    if (typeof accessToken !== 'string' || accessToken === '') {
      return redirectWithError(c, 'no_access_token')
    }
    if (typeof newRefreshToken !== 'string' || newRefreshToken === '') {
      // No refresh token means Google didn't issue one — happens when
      // the user previously granted access on this client+scope combo.
      // `prompt=consent` is supposed to force a fresh grant; the
      // failure mode is rare but worth surfacing clearly so the
      // operator knows to re-authorise via a fresh Google flow.
      return redirectWithError(c, 'no_refresh_token')
    }

    let identity: { googleUserId: string; email: string }
    try {
      identity = await client.fetchUserIdentity(accessToken)
    } catch (err: unknown) {
      return redirectWithError(
        c,
        `userinfo_failed: ${err instanceof Error ? err.message : 'unknown'}`,
      )
    }

    const expiresAt = new Date(
      nowMs() + (typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600) * 1000,
    ).toISOString()

    try {
      // If a row already exists for (provider, email_address), the
      // UNIQUE index throws on insert. Replace it: drop the old row
      // and insert the new one with refreshed tokens. A user wanting
      // to re-link re-runs the OAuth flow; we manage the swap
      // transparently here so they don't have to manually disconnect.
      const existing = getYouTubeAccountByEmail(
        deps.db,
        deps.cipher,
        'youtube',
        identity.email,
      )
      if (existing) {
        deleteYouTubeAccount(deps.db, existing.id)
      }
      createYouTubeAccount(deps.db, deps.cipher, {
        provider: 'youtube',
        googleUserId: identity.googleUserId,
        emailAddress: identity.email,
        accessToken,
        refreshToken: newRefreshToken,
        tokenExpiresAt: expiresAt,
        scopes: typeof tokens.scope === 'string' ? tokens.scope : OAUTH_SCOPE,
      })
    } catch (err: unknown) {
      return redirectWithError(
        c,
        `store_failed: ${err instanceof Error ? err.message : 'unknown'}`,
      )
    }

    // Fire-and-forget subscriptions auto-sync (issue YT-002).
    // Goal: the user's Subscriptions page is populated within
    // ~30s of granting OAuth instead of waiting for the next
    // daily tick. We deliberately do NOT await this — the user
    // has just landed on /settings/youtube and the sync is a
    // background import. Errors are logged so the operator sees
    // them; they don't fail the OAuth flow because the daily
    // scheduler + manual Sync-now button are the durable backstops.
    if (deps.autoSyncOnGrant !== undefined) {
      void deps.autoSyncOnGrant
        .sync()
        .then((result) => {
          // eslint-disable-next-line no-console
          console.log(
            `[youtube-oauth] auto-sync on grant: +${result.added} ~${result.updated} -${result.removed} =${result.unchanged} (${result.total} total)`,
          )
        })
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error(
            `[youtube-oauth] auto-sync on grant failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        })
    }

    return c.redirect('/settings/youtube?status=connected', 302)
  })

  // ─── GET /connection ────────────────────────────────────────────────
  api.get('/connection', (c) => {
    const accounts = listYouTubeAccounts(deps.db, deps.cipher)
    if (accounts.length === 0) {
      return c.json({ connected: false })
    }
    const a = accounts[0]!
    return c.json({
      connected: true,
      google_user_id: a.googleUserId,
      email_address: a.emailAddress,
      connected_at: a.connectedAt,
      last_refreshed_at: a.lastRefreshedAt,
      token_expires_at: a.tokenExpiresAt,
      scopes: a.scopes,
    })
  })

  // ─── DELETE /connection ─────────────────────────────────────────────
  api.delete('/connection', async (c) => {
    // Find the most-recently-connected row by ID without decrypting
    // — see `getMostRecentYouTubeAccountId` for the rationale. We
    // can't use `listYouTubeAccounts` here because decryption can
    // throw after a key rotation, and we still want the local
    // delete to succeed in that case.
    const accountId = getMostRecentYouTubeAccountId(deps.db)
    if (accountId === null) {
      return c.json({ ok: false, error: 'not_found' }, 404)
    }

    // Try to read the decrypted access token for the revoke step.
    // If decryption fails (key rotated, corrupt ciphertext), skip
    // the revoke and proceed straight to the local delete.
    let accessToken: string | null = null
    try {
      const account = getYouTubeAccount(deps.db, deps.cipher, accountId)
      accessToken = account?.accessToken ?? null
    } catch {
      // Decryption failed; accessToken stays null — skip the revoke.
    }

    if (accessToken !== null) {
      try {
        await client.revoke(accessToken)
      } catch {
        // Intentionally swallow — local delete is the source of truth.
      }
    }

    deleteYouTubeAccount(deps.db, accountId)
    return new Response(null, { status: 204 })
  })

  return api
}

function redirectWithError(
  c: { redirect(url: string, status?: number): Response },
  reason: string,
): Response {
  // Sanitise the reason to a single string token for the URL — we
  // don't want free-form error text reflected in our HTML.
  const token = reason.replace(/[^a-z0-9_:.-]/gi, '_').slice(0, 80)
  return c.redirect(`/settings/youtube?status=error&reason=${encodeURIComponent(token)}`, 302)
}