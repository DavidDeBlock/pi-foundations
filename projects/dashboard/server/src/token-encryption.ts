// token-encryption.ts — issue #020
//
// Two small, distinct, pure capabilities on top of a single 32-byte
// secret (loaded from EMAIL_TOKEN_ENCRYPTION_KEY):
//
//   1. Token cipher — AES-256-GCM encryption of OAuth tokens at rest in
//      SQLite. Pairs (iv, tag, ciphertext) travel as base64 joined by
//      dots; this is the on-the-wire format stored in the
//      `access_token_enc` / `refresh_token_enc` columns.
//
//   2. State signer — HMAC-SHA256 signing of the OAuth `state` query
//      parameter. The signed state encodes an HMAC-protected CSRF nonce
//      plus an `issuedAtMs` timestamp; `verify()` enforces both the
//      signature and the timestamp window. We reuse the same 32-byte
//      secret — different purpose (encrypt vs. sign), still 256 bits,
//      both well within HMAC-SHA256's 64-byte block-size limit.
//
// Keeping both on one key matches the PRD: one operator-managed secret
// to rotate (deferred — and irrelevant at v1).

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// ─── Constants ────────────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32  // 256 bits, AES-256
const IV_LENGTH = 12   // 96 bits, the GCM-recommended nonce size
const HMAC_ALGORITHM = 'sha256'
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000  // 10 minutes

// ─── Key parsing ──────────────────────────────────────────────────────────

/**
 * Parse a hex-encoded 32-byte key from an env var.
 *
 * Accepted form: 64 hex characters. We could also accept base64, but
 * hex is unambiguous and easy to copy from a `openssl rand -hex 32`
 * command — which is the workflow /settings/email documents.
 */
export function parseEncryptionKey(raw: string): Buffer {
  if (typeof raw !== 'string' || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      'must be a 64-character hex string (32 bytes); generate one with `openssl rand -hex 32`.',
    )
  }
  return Buffer.from(raw, 'hex')
}

// ─── Token cipher (AES-256-GCM) ───────────────────────────────────────────

export interface TokenCipher {
  /** Encrypt `plaintext` (UTF-8). Returns `iv.tag.ciphertext` in base64. */
  encrypt(plaintext: string): string
  /** Reverse of `encrypt`. Throws on tampering (auth tag mismatch) or
   *  malformed ciphertext — both surface as a thrown error. */
  decrypt(ciphertext: string): string
}

export function createTokenCipher(key: Buffer): TokenCipher {
  assertKey(key)

  return {
    encrypt(plaintext) {
      if (typeof plaintext !== 'string') {
        throw new Error('plaintext must be a string')
      }
      const iv = randomBytes(IV_LENGTH)
      const cipher = createCipheriv(ALGORITHM, key, iv)
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`
    },
    decrypt(blob) {
      if (typeof blob !== 'string') {
        throw new Error('malformed ciphertext: input is not a string')
      }
      const parts = blob.split('.')
      if (parts.length !== 3) {
        throw new Error('malformed ciphertext: expected 3 dot-separated parts')
      }
      const [ivPart, tagPart, ctPart] = parts
      // Buffer.from with 'base64' is lenient about whitespace but throws
      // on invalid characters. The three pieces below may all reject
      // invalid input; the first one to fail defines the error.
      let iv: Buffer
      let tag: Buffer
      let ct: Buffer
      try {
        iv = Buffer.from(ivPart, 'base64')
        tag = Buffer.from(tagPart, 'base64')
        ct = Buffer.from(ctPart, 'base64')
      } catch (err: unknown) {
        throw new Error(`malformed ciphertext (bad base64): ${errMessage(err)}`)
      }
      if (iv.length !== IV_LENGTH) {
        throw new Error(`malformed ciphertext: iv must be ${IV_LENGTH} bytes, got ${iv.length}`)
      }
      if (tag.length !== 16) {
        throw new Error(`malformed ciphertext: auth tag must be 16 bytes, got ${tag.length}`)
      }
      const decipher = createDecipheriv(ALGORITHM, key, iv)
      decipher.setAuthTag(tag)
      const pt = Buffer.concat([decipher.update(ct), decipher.final()])
      return pt.toString('utf8')
    },
  }
}

// ─── State signer (HMAC-SHA256) ───────────────────────────────────────────

export interface SignedState {
  readonly nonce: string
  readonly issuedAtMs: number
}

export interface StateSigner {
  /** Sign a nonce + timestamp into a transportable, dot-separated state.
   *  Format: `<nonce>.<issuedAtMs>.<base64url-sig>` */
  sign(nonce: string, issuedAtMs: number): string
  /** Constant-time verify. Returns the parsed payload on success, `null`
   *  on any tampering, malformed input, or replay (timestamp out of TTL). */
  verify(state: string, nowMs?: number): SignedState | null
}

export function createStateSigner(key: Buffer): StateSigner {
  assertKey(key)

  function hmac(payload: string): string {
    return createHmac(HMAC_ALGORITHM, key).update(payload).digest('base64url')
  }

  return {
    sign(nonce, issuedAtMs) {
      const payload = `${nonce}.${issuedAtMs}`
      const sig = hmac(payload)
      return `${nonce}.${issuedAtMs}.${sig}`
    },
    verify(state, nowMs = Date.now()) {
      if (typeof state !== 'string') return null
      const parts = state.split('.')
      if (parts.length !== 3) return null
      const [nonce, issuedAtStr, sig] = parts
      const issuedAtMs = Number(issuedAtStr)
      if (!Number.isFinite(issuedAtMs)) return null

      const expected = hmac(`${nonce}.${issuedAtMs}`)
      // timingSafeEqual throws on length mismatch — wrap so a forged
      // signature simply fails verification instead of throwing.
      let sigBuf: Buffer
      let expectedBuf: Buffer
      try {
        sigBuf = Buffer.from(sig, 'base64url')
        expectedBuf = Buffer.from(expected, 'base64url')
      } catch {
        return null
      }
      if (sigBuf.length !== expectedBuf.length || sigBuf.length === 0) {
        return null
      }
      if (!timingSafeEqual(sigBuf, expectedBuf)) {
        return null
      }

      const skew = nowMs - issuedAtMs
      // Reject both stale (> TTL) and suspiciously-future timestamps
      // (clock skew shouldn't exceed a minute, so 60s of slack is plenty).
      if (skew > OAUTH_STATE_TTL_MS || skew < -60_000) {
        return null
      }
      return { nonce, issuedAtMs }
    },
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key)) {
    throw new TypeError(`encryption key must be a Buffer, got ${typeof key}`)
  }
  if (key.length !== KEY_LENGTH) {
    throw new Error(`encryption key must be ${KEY_LENGTH} bytes (got ${key.length})`)
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
