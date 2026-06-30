// email-accounts.ts — issue #020
//
// Storage helpers for the `email_accounts` table. Encapsulates the
// encrypt-on-write / decrypt-on-read boundary around the OAuth tokens
// so the rest of the codebase never sees a raw ciphertext column.
//
// Convention: every helper that takes a token (`create`, `updateTokens`)
// encrypts before INSERT/UPDATE; every helper that returns a token
// decrypts before returning. Helpers that don't expose tokens (list,
// delete, updateLastSyncAt) never touch the cipher.
//
// The shape returned to callers is `EmailAccount`, the unencrypted
// view used by the OAuth API and the settings page. `EmailAccountRow`
// is the raw DB shape with ciphertext columns.

import { randomUUID } from 'node:crypto'
import type { Database } from './db.js'
import type { TokenCipher } from './token-encryption.js'

// ─── Types ────────────────────────────────────────────────────────────────

export type EmailProvider = 'gmail'

export interface EmailAccount {
  readonly id: string
  readonly provider: EmailProvider
  readonly emailAddress: string
  readonly accessToken: string
  readonly refreshToken: string
  /** ISO 8601, or `null` if unknown. */
  readonly tokenExpiresAt: string | null
  readonly connectedAt: string
  readonly lastSyncAt: string | null
}

/**
 * Plain view of the `email_accounts` row with ciphertext columns
 * included — used only by tests and the differ (future). Production
 * code paths go through the unencrypted `EmailAccount` shape.
 */
export interface EmailAccountRow {
  readonly id: string
  readonly provider: string
  readonly email_address: string
  readonly access_token_enc: string
  readonly refresh_token_enc: string
  readonly token_expires_at: string | null
  readonly connected_at: string
  readonly last_sync_at: string | null
}

// ─── Reads ────────────────────────────────────────────────────────────────

/**
 * List every connected account, decrypting tokens. Order: most-recently
 * connected first.
 */
export function listEmailAccounts(
  db: Database,
  cipher: TokenCipher,
): EmailAccount[] {
  const rows = db.all<EmailAccountRow>(
    `SELECT id, provider, email_address, access_token_enc, refresh_token_enc,
            token_expires_at, connected_at, last_sync_at
       FROM email_accounts
       ORDER BY connected_at DESC, id ASC`,
  )
  return rows.map((r) => rowToAccount(r, cipher))
}

/**
 * Fetch one account by id, decrypting tokens. Returns `null` when no
 * row matches.
 */
export function getEmailAccount(
  db: Database,
  cipher: TokenCipher,
  id: string,
): EmailAccount | null {
  const row = db.get<EmailAccountRow>(
    `SELECT id, provider, email_address, access_token_enc, refresh_token_enc,
            token_expires_at, connected_at, last_sync_at
       FROM email_accounts
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
export function getEmailAccountByAddress(
  db: Database,
  cipher: TokenCipher,
  provider: EmailProvider,
  emailAddress: string,
): EmailAccount | null {
  const row = db.get<EmailAccountRow>(
    `SELECT id, provider, email_address, access_token_enc, refresh_token_enc,
            token_expires_at, connected_at, last_sync_at
       FROM email_accounts
       WHERE provider = ? AND email_address = ?`,
    [provider, emailAddress],
  )
  return row ? rowToAccount(row, cipher) : null
}

// ─── Writes ───────────────────────────────────────────────────────────────

export interface CreateEmailAccountInput {
  readonly provider: EmailProvider
  readonly emailAddress: string
  readonly accessToken: string
  readonly refreshToken: string
  /** ISO 8601, or omit to leave `token_expires_at` NULL. */
  readonly tokenExpiresAt?: string
}

/**
 * Insert a new connected account row with encrypted tokens. Returns
 * the unencrypted view (including the generated id). Throws on the
 * UNIQUE(provider, email_address) constraint — call `getEmailAccountByAddress`
 * first if you need to handle re-link.
 */
export function createEmailAccount(
  db: Database,
  cipher: TokenCipher,
  input: CreateEmailAccountInput,
): EmailAccount {
  const id = randomUUID()
  db.run(
    `INSERT INTO email_accounts
       (id, provider, email_address, access_token_enc, refresh_token_enc, token_expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.provider,
      input.emailAddress,
      cipher.encrypt(input.accessToken),
      cipher.encrypt(input.refreshToken),
      input.tokenExpiresAt ?? null,
    ],
  )
  // Read back to get server-defaulted `connected_at`.
  const row = db.get<EmailAccountRow>(
    `SELECT id, provider, email_address, access_token_enc, refresh_token_enc,
            token_expires_at, connected_at, last_sync_at
       FROM email_accounts WHERE id = ?`,
    [id],
  )
  if (!row) throw new Error('createEmailAccount: row missing after insert')
  return rowToAccount(row, cipher)
}

/**
 * Replace the encrypted tokens + expires-at on an existing account.
 * Used after a refresh-token exchange returns a new access token.
 *
 * No-op (returns `false`) if the row doesn't exist; the caller decides
 * whether that's an error.
 */
export function updateEmailAccountTokens(
  db: Database,
  cipher: TokenCipher,
  id: string,
  tokens: { readonly accessToken: string; readonly refreshToken: string; readonly tokenExpiresAt: string | null },
): boolean {
  const result = db.run(
    `UPDATE email_accounts
       SET access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?
       WHERE id = ?`,
    [cipher.encrypt(tokens.accessToken), cipher.encrypt(tokens.refreshToken), tokens.tokenExpiresAt, id],
  )
  return result.changes > 0
}

/**
 * Mark an account as having synced at `at` (defaults to now). Failure
 * is silent — last_sync_at is observability metadata, not a correctness
 * signal.
 */
export function updateEmailAccountLastSyncAt(
  db: Database,
  id: string,
  at: string = new Date().toISOString(),
): void {
  db.run(`UPDATE email_accounts SET last_sync_at = ? WHERE id = ?`, [at, id])
}

/**
 * Delete a connected account row. Returns `true` if a row was removed.
 * Does NOT revoke at Google — callers in the OAuth API do that as a
 * best-effort step before calling this.
 */
export function deleteEmailAccount(db: Database, id: string): boolean {
  const result = db.run('DELETE FROM email_accounts WHERE id = ?', [id])
  return result.changes > 0
}

// ─── Internal ────────────────────────────────────────────────────────────

function rowToAccount(row: EmailAccountRow, cipher: TokenCipher): EmailAccount {
  return {
    id: row.id,
    provider: row.provider as EmailProvider,
    emailAddress: row.email_address,
    accessToken: cipher.decrypt(row.access_token_enc),
    refreshToken: cipher.decrypt(row.refresh_token_enc),
    tokenExpiresAt: row.token_expires_at,
    connectedAt: row.connected_at,
    lastSyncAt: row.last_sync_at,
  }
}
