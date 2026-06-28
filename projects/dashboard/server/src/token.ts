import bcrypt from 'bcryptjs'
import { createHash, randomBytes } from 'node:crypto'

const TOKEN_BYTES = 32 // 256 bits of entropy

/**
 * Generate a new plaintext API token.
 *
 * 32 bytes from a CSPRNG, encoded as base64url (no padding) → 43 chars.
 * Safe to transmit as `Authorization: Bearer <token>` and to paste into
 * config files — entropy is high enough that no passphrase is needed.
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/**
 * Bcrypt hash of a plaintext token.
 *
 * The hash includes a per-token salt; the same plaintext produces a
 * different hash on each call. This is the `verifyHash` stored alongside
 * the `lookupHash` for two-step auth.
 */
export function hashToken(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, 10)
}

/**
 * Constant-time bcrypt comparison of a plaintext token against a stored hash.
 */
export function verifyToken(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash)
}

/**
 * Fast deterministic lookup hash for a token (SHA-256, hex).
 *
 * Used to find a candidate token record in O(1) before doing the slow
 * bcrypt verify. Without this, every authenticated request would have to
 * bcrypt-compare against every stored token — too slow once a user has
 * more than a handful of tokens (bcrypt at cost 10 ≈ 100ms per compare).
 *
 * SHA-256 of a 256-bit-random plaintext is unguessable, so this hash is
 * safe to store: an attacker who steals the DB still can't forge a token.
 */
export function lookupHash(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}
