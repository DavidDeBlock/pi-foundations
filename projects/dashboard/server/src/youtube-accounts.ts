// youtube-accounts.ts — issue YT-001
//
// Storage helpers for the `youtube_accounts` table. Encapsulates the
// encrypt-on-write / decrypt-on-read boundary around the OAuth tokens
// so the rest of the codebase never sees a raw ciphertext column.
//
// Convention: every helper that takes a token (`create`, `updateTokens`)
// encrypts before INSERT/UPDATE; every helper that returns a token
// decrypts before returning. Helpers that don't expose tokens (list,
// delete, updateLastRefreshedAt) never touch the cipher.
//
// The shape returned to callers is `YouTubeAccount`, the unencrypted
// view used by the OAuth API and the settings page. `YouTubeAccountRow`
// is the raw DB shape with ciphertext columns — used only by tests
// and the OAuth client when verifying the encryption boundary.
//
// Mirrors email-accounts.ts (issue #020) exactly except for the
// schema differences (google_user_id, scopes, last_refreshed_at instead
// of last_sync_at).

import { randomUUID } from 'node:crypto'
import type { Database } from './db.js'
import type { TokenCipher } from './token-encryption.js'

// ─── Types ────────────────────────────────────────────────────────────────

export type YouTubeProvider = 'youtube'

export interface YouTubeAccount {
  readonly id: string
  readonly provider: YouTubeProvider
  readonly googleUserId: string
  readonly emailAddress: string
  readonly accessToken: string
  readonly refreshToken: string
  /** ISO 8601, or `null` if unknown. */
  readonly tokenExpiresAt: string | null
  /** Space-separated scopes Google granted with this token. */
  readonly scopes: string
  readonly connectedAt: string
  readonly lastRefreshedAt: string | null
}

/**
 * Plain view of the `youtube_accounts` row with ciphertext columns
 * included — used only by tests and the OAuth client (when verifying
 * the encryption boundary). Production code paths go through the
 * unencrypted `YouTubeAccount` shape.
 */
export interface YouTubeAccountRow {
  readonly id: string
  readonly provider: string
  readonly google_user_id: string
  readonly email_address: string
  readonly access_token_enc: string
  readonly refresh_token_enc: string
  readonly token_expires_at: string | null
  readonly scopes: string
  readonly connected_at: string
  readonly last_refreshed_at: string | null
}

// ─── Reads ────────────────────────────────────────────────────────────────

/**
 * List every connected account, decrypting tokens. Order: most-recently
 * connected first.
 */
export function listYouTubeAccounts(
  db: Database,
  cipher: TokenCipher,
): YouTubeAccount[] {
  const rows = db.all<YouTubeAccountRow>(
    `SELECT id, provider, google_user_id, email_address,
            access_token_enc, refresh_token_enc,
            token_expires_at, scopes, connected_at, last_refreshed_at
       FROM youtube_accounts
       ORDER BY connected_at DESC, id ASC`,
  )
  return rows.map((r) => rowToAccount(r, cipher))
}

/**
 * Fetch one account by id, decrypting tokens. Returns `null` when no
 * row matches.
 */
export function getYouTubeAccount(
  db: Database,
  cipher: TokenCipher,
  id: string,
): YouTubeAccount | null {
  const row = db.get<YouTubeAccountRow>(
    `SELECT id, provider, google_user_id, email_address,
            access_token_enc, refresh_token_enc,
            token_expires_at, scopes, connected_at, last_refreshed_at
       FROM youtube_accounts
       WHERE id = ?`,
    [id],
  )
  return row ? rowToAccount(row, cipher) : null
}

/**
 * Fetch one account by (provider, email_address), decrypting tokens.
 * Used by the OAuth callback to detect a re-link (already-known email)
 * vs a brand-new connect.
 */
export function getYouTubeAccountByEmail(
  db: Database,
  cipher: TokenCipher,
  provider: YouTubeProvider,
  emailAddress: string,
): YouTubeAccount | null {
  const row = db.get<YouTubeAccountRow>(
    `SELECT id, provider, google_user_id, email_address,
            access_token_enc, refresh_token_enc,
            token_expires_at, scopes, connected_at, last_refreshed_at
       FROM youtube_accounts
       WHERE provider = ? AND email_address = ?`,
    [provider, emailAddress],
  )
  return row ? rowToAccount(row, cipher) : null
}

// ─── Writes ───────────────────────────────────────────────────────────────

export interface CreateYouTubeAccountInput {
  readonly provider: YouTubeProvider
  readonly googleUserId: string
  readonly emailAddress: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly scopes: string
  /** ISO 8601, or omit to leave `token_expires_at` NULL. */
  readonly tokenExpiresAt?: string
}

/**
 * Insert a new connected account row with encrypted tokens. Returns
 * the unencrypted view (including the generated id). Throws on the
 * UNIQUE(provider, email_address) constraint — call
 * `getYouTubeAccountByEmail` first if you need to handle re-link.
 */
export function createYouTubeAccount(
  db: Database,
  cipher: TokenCipher,
  input: CreateYouTubeAccountInput,
): YouTubeAccount {
  const id = randomUUID()
  db.run(
    `INSERT INTO youtube_accounts
       (id, provider, google_user_id, email_address,
        access_token_enc, refresh_token_enc, token_expires_at, scopes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.provider,
      input.googleUserId,
      input.emailAddress,
      cipher.encrypt(input.accessToken),
      cipher.encrypt(input.refreshToken),
      input.tokenExpiresAt ?? null,
      input.scopes,
    ],
  )
  // Read back to get server-defaulted `connected_at`.
  const row = db.get<YouTubeAccountRow>(
    `SELECT id, provider, google_user_id, email_address,
            access_token_enc, refresh_token_enc,
            token_expires_at, scopes, connected_at, last_refreshed_at
       FROM youtube_accounts WHERE id = ?`,
    [id],
  )
  if (!row) throw new Error('createYouTubeAccount: row missing after insert')
  return rowToAccount(row, cipher)
}

/**
 * Replace the encrypted tokens + expires-at on an existing account.
 * Used by `YouTubeOAuthClient.refreshIfNeeded` after a refresh-token
 * exchange returns a new access token.
 *
 * No-op (returns `false`) if the row doesn't exist; the caller decides
 * whether that's an error.
 */
export function updateYouTubeAccountTokens(
  db: Database,
  cipher: TokenCipher,
  id: string,
  tokens: {
    readonly accessToken: string
    readonly refreshToken: string
    readonly tokenExpiresAt: string | null
  },
): boolean {
  const result = db.run(
    `UPDATE youtube_accounts
       SET access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?
       WHERE id = ?`,
    [
      cipher.encrypt(tokens.accessToken),
      cipher.encrypt(tokens.refreshToken),
      tokens.tokenExpiresAt,
      id,
    ],
  )
  return result.changes > 0
}

/**
 * Apply a fresh OAuth grant to an existing local account without changing its
 * id. The id owns dashboard-local subscriptions, playlists, tags, and sync
 * preferences, so reauthorization must never replace the row.
 */
export function reauthorizeYouTubeAccount(
  db: Database,
  cipher: TokenCipher,
  id: string,
  input: CreateYouTubeAccountInput,
): boolean {
  const result = db.run(
    `UPDATE youtube_accounts
       SET google_user_id = ?, email_address = ?,
           access_token_enc = ?, refresh_token_enc = ?,
           token_expires_at = ?, scopes = ?,
           connected_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
           last_refreshed_at = NULL
       WHERE id = ? AND provider = ?`,
    [
      input.googleUserId,
      input.emailAddress,
      cipher.encrypt(input.accessToken),
      cipher.encrypt(input.refreshToken),
      input.tokenExpiresAt ?? null,
      input.scopes,
      id,
      input.provider,
    ],
  )
  return result.changes > 0
}

/**
 * Mark an account as having had its access token rotated at `at`
 * (defaults to now). Failure is silent — `last_refreshed_at` is
 * observability metadata, not a correctness signal.
 */
export function updateYouTubeAccountLastRefreshedAt(
  db: Database,
  id: string,
  at: string = new Date().toISOString(),
): void {
  db.run(`UPDATE youtube_accounts SET last_refreshed_at = ? WHERE id = ?`, [at, id])
}

/**
 * Delete a connected account row. Returns `true` if a row was removed.
 * Does NOT revoke at Google — callers in the OAuth API do that as a
 * best-effort step before calling this.
 */
export function deleteYouTubeAccount(db: Database, id: string): boolean {
  const result = db.run('DELETE FROM youtube_accounts WHERE id = ?', [id])
  return result.changes > 0
}

/**
 * Return the most-recently-connected account's id without decrypting
 * any tokens. Returns `null` when no row exists.
 *
 * Used by the disconnect flow (`DELETE /api/youtube/connection` +
 * `POST /settings/youtube/disconnect`) when the row's ciphertext
 * cannot be decrypted (e.g. the encryption key was rotated). In
 * that case the caller wants to delete the row anyway — the user is
 * asking to disconnect — but `listYouTubeAccounts` / `getYouTubeAccount`
 * throw before returning the id. This helper sidesteps the
 * decryption step entirely so the local delete still succeeds.
 *
 * The `LIMIT 1` mirrors `listYouTubeAccounts`'s ordering (most-recent
 * first), so callers get the same row.
 */
export function getMostRecentYouTubeAccountId(db: Database): string | null {
  const row = db.get<{ id: string }>(
    'SELECT id FROM youtube_accounts ORDER BY connected_at DESC, id ASC LIMIT 1',
  )
  return row?.id ?? null
}

// ─── Internal ────────────────────────────────────────────────────────────

function rowToAccount(row: YouTubeAccountRow, cipher: TokenCipher): YouTubeAccount {
  return {
    id: row.id,
    provider: row.provider as YouTubeProvider,
    googleUserId: row.google_user_id,
    emailAddress: row.email_address,
    accessToken: cipher.decrypt(row.access_token_enc),
    refreshToken: cipher.decrypt(row.refresh_token_enc),
    tokenExpiresAt: row.token_expires_at,
    scopes: row.scopes,
    connectedAt: row.connected_at,
    lastRefreshedAt: row.last_refreshed_at,
  }
}
