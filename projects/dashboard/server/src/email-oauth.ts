// email-oauth.ts — issue #020
//
// HTTP layer for the Gmail OAuth flow + the disconnect endpoint:
//
//   GET  /oauth/start      — issue a state nonce, redirect to Google's
//                            consent screen (scope = gmail.readonly)
//   GET  /oauth/callback   — exchange the auth code, fetch the user's
//                            email, encrypt + store tokens, redirect
//                            back to /settings/email?status=...
//   DELETE /accounts/:id   — best-effort revoke at Google + remove the
//                            local row
//
// All three error paths end at `/settings/email?status=error&reason=...`
// so the UI can show a single, consistent banner instead of branching
// on which endpoint produced the failure.
//
// Design decisions (mirrors PRD-002):
//   * CSRF protection uses HMAC-signed state with a 10-minute TTL
//     (token-encryption.ts StateSigner). No server-side state storage
//     needed → no extra table, no cookie cleanup.
//   * We request `access_type=offline` + `prompt=consent` so Google
//     returns a refresh token on every link (refresh tokens are the
//     only ones we keep — access tokens expire).
//   * Token revocations are best-effort: a network failure here must
//     not block the local delete. The local delete is the source of
//     truth for "this dashboard no longer touches that Gmail account".

import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import type { Database } from './db.js'
import type { TokenCipher, StateSigner } from './token-encryption.js'
import type { AuthVariables } from './auth.js'
import {
  createEmailAccount,
  deleteEmailAccount,
  getEmailAccount,
  getEmailAccountByAddress,
} from './email-accounts.js'

// ─── Constants ────────────────────────────────────────────────────────────

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const GMAIL_PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile'

/** The exact scope requested on the consent screen. Must match the
 *  value the Gmail SDK accepts when verifying our refresh-token grant. */
export const OAUTH_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

const STATE_TTL_MS = 10 * 60 * 1000

// ─── Hono sub-app ─────────────────────────────────────────────────────────

export interface EmailOAuthDeps {
  readonly db: Database
  readonly cipher: TokenCipher
  readonly stateSigner: StateSigner
  readonly oauthClientId: string
  readonly oauthClientSecret: string
  readonly redirectUri: string
  readonly fetchFn?: typeof fetch
  readonly nowMs?: () => number
}

/**
 * Mounted at `/api/email`. Sub-routes:
 *   * `GET /oauth/start`
 *   * `GET /oauth/callback`
 *   * `DELETE /accounts/:id`
 *
 * The "email" namespace is reserved for #021+ (sync endpoints). If
 * future slices add `/api/email/sync`, mount the email-sync module on
 * the same parent in `app.ts` (Hono dispatches by exact path match).
 */
export function emailApi(deps: EmailOAuthDeps): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()
  const fetchFn = deps.fetchFn ?? fetch
  const nowMs = deps.nowMs ?? (() => Date.now())

  // ─── GET /oauth/start ───────────────────────────────────────────────
  api.get('/oauth/start', (c) => {
    const nonce = randomBytes(16).toString('base64url')
    const issuedAtMs = nowMs()
    const state = deps.stateSigner.sign(nonce, issuedAtMs)

    const params = new URLSearchParams({
      client_id: deps.oauthClientId,
      redirect_uri: deps.redirectUri,
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
    return c.redirect(`${GOOGLE_AUTHORIZE_URL}?${params.toString()}`, 302)
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
      tokens = await exchangeCodeForTokens(fetchFn, {
        code,
        clientId: deps.oauthClientId,
        clientSecret: deps.oauthClientSecret,
        redirectUri: deps.redirectUri,
      })
    } catch (err: unknown) {
      return redirectWithError(
        c,
        `token_exchange_failed: ${err instanceof Error ? err.message : 'unknown'}`,
      )
    }

    // After this point we have the tokens; grab the fields we need
    // into local consts so TS narrowing sticks across the call sites
    // below (intervening reads would otherwise widen back to
    // `string | undefined`).
    const accessToken = tokens.access_token
    const newRefreshToken = tokens.refresh_token
    if (typeof accessToken !== 'string' || accessToken === '') {
      return redirectWithError(c, 'no_access_token')
    }
    if (typeof newRefreshToken !== 'string' || newRefreshToken === '') {
      // No refresh token means Google didn't issue one — happens when
      // the user previously granted access on this client+scope combo.
      // `prompt=consent` is supposed to force a fresh grant; the failure
      // mode is rare but worth surfacing clearly so the operator knows
      // to re-authorise via a fresh Google account flow.
      return redirectWithError(c, 'no_refresh_token')
    }

    let emailAddress: string
    try {
      emailAddress = await fetchGmailEmailAddress(fetchFn, accessToken)
    } catch (err: unknown) {
      return redirectWithError(
        c,
        `gmail_profile_failed: ${err instanceof Error ? err.message : 'unknown'}`,
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
      const existing = getEmailAccountByAddress(deps.db, deps.cipher, 'gmail', emailAddress)
      if (existing) {
        deleteEmailAccount(deps.db, existing.id)
      }

      createEmailAccount(deps.db, deps.cipher, {
        provider: 'gmail',
        emailAddress,
        accessToken,
        refreshToken: newRefreshToken,
        tokenExpiresAt: expiresAt,
      })
    } catch (err: unknown) {
      return redirectWithError(
        c,
        `store_failed: ${err instanceof Error ? err.message : 'unknown'}`,
      )
    }

    return c.redirect('/settings/email?status=connected', 302)
  })

  // ─── DELETE /accounts/:id ───────────────────────────────────────────
  api.delete('/accounts/:id', async (c) => {
    const id = c.req.param('id')
    // Try to decrypt the row for the revoke step. If decryption fails
    // (e.g. the encryption key was rotated, the ciphertext was
    // tampered with, or the row is otherwise unreadable), fall
    // through to the local delete. The user is asking to disconnect;
    // we should honour that even if we can't talk to Google on their
    // behalf anymore.
    let accessToken: string | null = null
    try {
      const account = getEmailAccount(deps.db, deps.cipher, id)
      if (!account) {
        return c.json({ ok: false, error: 'not_found' }, 404)
      }
      accessToken = account.accessToken
    } catch {
      // Decryption failed; accessToken stays null — skip the revoke
      // and proceed straight to the local delete.
    }

    // Revoke the access token at Google. The access token is sufficient
    // — Google's revoke endpoint accepts either access or refresh tokens.
    // Best-effort: a failure here must not block the local delete.
    if (accessToken !== null) {
      try {
        await fetchFn(
          `${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(accessToken)}`,
          { method: 'POST' },
        )
      } catch {
        // Intentionally swallow — local delete is the source of truth.
      }
    }

    deleteEmailAccount(deps.db, id)
    return new Response(null, { status: 204 })
  })

  return api
}

// ─── Internal helpers ─────────────────────────────────────────────────────

interface GoogleTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
}

async function exchangeCodeForTokens(
  fetchFn: typeof fetch,
  args: {
    code: string
    clientId: string
    clientSecret: string
    redirectUri: string
  },
): Promise<GoogleTokenResponse> {
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: args.code,
      client_id: args.clientId,
      client_secret: args.clientSecret,
      redirect_uri: args.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  })
  if (!res.ok) {
    const detail = await safeText(res)
    throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`)
  }
  return (await res.json()) as GoogleTokenResponse
}

async function fetchGmailEmailAddress(
  fetchFn: typeof fetch,
  accessToken: string,
): Promise<string> {
  const res = await fetchFn(GMAIL_PROFILE_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const detail = await safeText(res)
    throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`)
  }
  const profile = (await res.json()) as { emailAddress?: unknown }
  if (typeof profile.emailAddress !== 'string' || profile.emailAddress === '') {
    throw new Error('profile response missing emailAddress')
  }
  return profile.emailAddress
}

function redirectWithError(c: { redirect(url: string, status?: number): Response }, reason: string): Response {
  // Sanitise the reason to a single string token for the URL — we
  // don't want free-form error text reflected in our HTML.
  const token = reason.replace(/[^a-z0-9_:.-]/gi, '_').slice(0, 80)
  return c.redirect(`/settings/email?status=error&reason=${encodeURIComponent(token)}`, 302)
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
