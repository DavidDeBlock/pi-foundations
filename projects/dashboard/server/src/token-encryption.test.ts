// token-encryption.test.ts — issue #020
//
// Unit tests for the at-rest encryption (AES-256-GCM) and the OAuth
// state signer (HMAC-SHA256). Coverage goals:
//   * Round-trip for both: encrypt → decrypt returns the original
//   * Tamper-detection on the cipher (bit flip → throws)
//   * Distinct ciphertexts for identical plaintexts (random IV)
//   * HMAC verification rejects every kind of input mutation
//   * State timestamp window (replay + clock-skew rejection)
//
// High-value boundary cases — these are the deep module's contract.

import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  createStateSigner,
  createTokenCipher,
  parseEncryptionKey,
} from './token-encryption.js'

// ─── parseEncryptionKey ───────────────────────────────────────────────────

describe('parseEncryptionKey', () => {
  it('parses a 64-char hex string into a 32-byte Buffer', () => {
    const key = parseEncryptionKey('a'.repeat(64))
    expect(key).toBeInstanceOf(Buffer)
    expect(key.length).toBe(32)
  })

  it('accepts mixed-case hex', () => {
    const lower = parseEncryptionKey('abcdef0123456789'.repeat(4))
    const upper = parseEncryptionKey('ABCDEF0123456789'.repeat(4))
    expect(lower.equals(upper)).toBe(true)
  })

  it('rejects wrong-length strings', () => {
    expect(() => parseEncryptionKey('aa')).toThrow(/64-character hex/)
    expect(() => parseEncryptionKey('a'.repeat(63))).toThrow(/64-character hex/)
    expect(() => parseEncryptionKey('a'.repeat(65))).toThrow(/64-character hex/)
  })

  it('rejects non-hex characters', () => {
    expect(() => parseEncryptionKey('z'.repeat(64))).toThrow(/64-character hex/)
    expect(() => parseEncryptionKey('g'.repeat(64))).toThrow(/64-character hex/)
  })

  it('rejects empty / non-string input', () => {
    expect(() => parseEncryptionKey('')).toThrow(/64-character hex/)
  })
})

// ─── createTokenCipher ────────────────────────────────────────────────────

describe('createTokenCipher — construction', () => {
  it('throws when the key is the wrong length', () => {
    expect(() => createTokenCipher(Buffer.alloc(16))).toThrow(/32 bytes/)
    expect(() => createTokenCipher(Buffer.alloc(64))).toThrow(/32 bytes/)
  })

  it('throws when the key is not a Buffer', () => {
    // @ts-expect-error — exercising runtime guard against misuse.
    expect(() => createTokenCipher('not a buffer')).toThrow(/Buffer/)
  })
})

describe('createTokenCipher — round-trip', () => {
  function newCipher() {
    return createTokenCipher(randomBytes(32))
  }

  it('encrypt → decrypt returns the original plaintext', () => {
    const cipher = newCipher()
    const pt = 'ya29.a0AfH6SMBxxxx-fake-google-access-token'
    const ct = cipher.encrypt(pt)
    expect(ct).not.toBe(pt)
    expect(ct).toContain('.') // iv.tag.ciphertext form
    expect(cipher.decrypt(ct)).toBe(pt)
  })

  it('produces distinct ciphertexts for the same plaintext (random IV)', () => {
    const cipher = newCipher()
    const pt = 'same-input-twice'
    const ct1 = cipher.encrypt(pt)
    const ct2 = cipher.encrypt(pt)
    expect(ct1).not.toBe(ct2)
    expect(cipher.decrypt(ct1)).toBe(pt)
    expect(cipher.decrypt(ct2)).toBe(pt)
  })

  it('round-trips Unicode and emoji plaintexts', () => {
    const cipher = newCipher()
    const samples = [
      'plain ascii',
      'caf\u00e9 \u4e2d\u6587', // "café 中文"
      'emoji \ud83d\ude00\ud83d\udcac', // "emoji 😀💬"
      'whitespace\u2028separator\u2029here',
    ]
    for (const pt of samples) {
      expect(cipher.decrypt(cipher.encrypt(pt))).toBe(pt)
    }
  })

  it('round-trips the empty string', () => {
    const cipher = newCipher()
    const ct = cipher.encrypt('')
    expect(cipher.decrypt(ct)).toBe('')
  })
})

describe('createTokenCipher — tamper detection', () => {
  function newCipher() {
    return createTokenCipher(randomBytes(32))
  }

  it('throws when the ciphertext is malformed (wrong number of parts)', () => {
    const cipher = newCipher()
    expect(() => cipher.decrypt('only.two')).toThrow(/malformed ciphertext/)
    expect(() => cipher.decrypt('one.two.three.four')).toThrow(/malformed ciphertext/)
  })

  it('throws when the auth tag is corrupted (GCM integrity check)', () => {
    const cipher = newCipher()
    const ct = cipher.encrypt('hello')
    const parts = ct.split('.')
    // Flip a byte in the tag (second part).
    const tagBuf = Buffer.from(parts[1]!, 'base64')
    tagBuf[0] = tagBuf[0]! ^ 0x01
    parts[1] = tagBuf.toString('base64')
    const tampered = parts.join('.')
    expect(() => cipher.decrypt(tampered)).toThrow(/unsupported state|auth|malformed/)
  })

  it('throws when the IV is wrong length', () => {
    const cipher = newCipher()
    const ct = cipher.encrypt('hello')
    const parts = ct.split('.')
    parts[0] = Buffer.from('short', 'utf8').toString('base64')
    expect(() => cipher.decrypt(parts.join('.'))).toThrow(/malformed ciphertext/)
  })

  it('throws when the ciphertext is corrupted', () => {
    const cipher = newCipher()
    const ct = cipher.encrypt('hello')
    const parts = ct.split('.')
    const ctBuf = Buffer.from(parts[2]!, 'base64')
    ctBuf[0] = ctBuf[0]! ^ 0x10
    parts[2] = ctBuf.toString('base64')
    expect(() => cipher.decrypt(parts.join('.'))).toThrow()
  })

  it('throws when decrypted with the wrong key', () => {
    const a = createTokenCipher(randomBytes(32))
    const b = createTokenCipher(randomBytes(32))
    const ct = a.encrypt('hello')
    expect(() => b.decrypt(ct)).toThrow()
  })

  it('rejects decryption that was done on a non-string', () => {
    const cipher = newCipher()
    // Make sure the cipher is initialised; calling encrypt before
    // exercising the runtime guard on decrypt keeps the test from
    // being a "did we forget to construct the cipher?" false positive.
    cipher.encrypt('warm-up')
    // @ts-expect-error — exercising runtime guard.
    expect(() => cipher.decrypt(undefined)).toThrow(/malformed ciphertext/)
  })
})

// ─── createStateSigner ────────────────────────────────────────────────────

describe('createStateSigner — construction', () => {
  it('throws when the key is the wrong length', () => {
    expect(() => createStateSigner(Buffer.alloc(16))).toThrow(/32 bytes/)
  })

  it('throws when the key is not a Buffer', () => {
    // @ts-expect-error — exercising runtime guard.
    expect(() => createStateSigner(null)).toThrow(/Buffer/)
  })
})

describe('createStateSigner — sign / verify', () => {
  function newSigner() {
    return createStateSigner(randomBytes(32))
  }

  it('signs and verifies a nonce', () => {
    const signer = newSigner()
    const nonce = randomBytes(16).toString('base64url')
    const issuedAtMs = 1_700_000_000_000
    const state = signer.sign(nonce, issuedAtMs)
    // Pass an explicit nowMs so the TTL window is satisfied.
    const decoded = signer.verify(state, issuedAtMs)
    expect(decoded).toEqual({ nonce, issuedAtMs })
  })

  it('produces different states on every sign (the signature includes the timestamp)', () => {
    const signer = newSigner()
    const nonce = 'static-nonce'
    const t1 = 1_700_000_000_000
    const t2 = 1_700_000_001_000
    const s1 = signer.sign(nonce, t1)
    const s2 = signer.sign(nonce, t2)
    // Different timestamps → different signatures.
    expect(s1).not.toBe(s2)
    expect(signer.verify(s1, t1)).not.toBeNull()
    expect(signer.verify(s2, t2)).not.toBeNull()
  })

  it('rejects a tampered nonce', () => {
    const signer = newSigner()
    const state = signer.sign('original-nonce', 1_700_000_000_000)
    const parts = state.split('.')
    parts[0] = 'tampered-nonce'
    expect(signer.verify(parts.join('.'))).toBeNull()
  })

  it('rejects a tampered timestamp', () => {
    const signer = newSigner()
    const state = signer.sign('nonce', 1_700_000_000_000)
    const parts = state.split('.')
    parts[1] = '1700000001000' // shift by 1s
    expect(signer.verify(parts.join('.'))).toBeNull()
  })

  it('rejects a tampered signature', () => {
    const signer = newSigner()
    const state = signer.sign('nonce', 1_700_000_000_000)
    const parts = state.split('.')
    const sigBuf = Buffer.from(parts[2]!, 'base64url')
    sigBuf[0] = sigBuf[0]! ^ 0x01
    parts[2] = sigBuf.toString('base64url')
    expect(signer.verify(parts.join('.'))).toBeNull()
  })

  it('rejects a state signed by a different signer', () => {
    const a = createStateSigner(randomBytes(32))
    const b = createStateSigner(randomBytes(32))
    const state = a.sign('nonce', 1_700_000_000_000)
    expect(b.verify(state, 1_700_000_000_000)).toBeNull()
  })

  it('rejects input with the wrong number of parts', () => {
    const signer = newSigner()
    expect(signer.verify('only.two')).toBeNull()
    expect(signer.verify('just-one')).toBeNull()
    expect(signer.verify('one.two.three.four')).toBeNull()
  })

  it('rejects non-numeric timestamps', () => {
    const signer = newSigner()
    expect(signer.verify('nonce.NaN.sig')).toBeNull()
    expect(signer.verify('nonce..sig')).toBeNull()
  })
})

describe('createStateSigner — TTL enforcement', () => {
  function newSigner() {
    return createStateSigner(randomBytes(32))
  }

  it('rejects states older than the TTL (10 minutes)', () => {
    const signer = newSigner()
    const issuedAtMs = 1_700_000_000_000
    const state = signer.sign('nonce', issuedAtMs)
    // Just past 10 minutes → reject.
    expect(signer.verify(state, issuedAtMs + 10 * 60 * 1000 + 1)).toBeNull()
  })

  it('accepts states well within the TTL', () => {
    const signer = newSigner()
    const issuedAtMs = 1_700_000_000_000
    const state = signer.sign('nonce', issuedAtMs)
    expect(signer.verify(state, issuedAtMs + 60_000)).not.toBeNull()
    expect(signer.verify(state, issuedAtMs + 9 * 60 * 1000)).not.toBeNull()
  })

  it('rejects states that are far in the future (clock skew attack)', () => {
    const signer = newSigner()
    const issuedAtMs = 1_700_000_000_000
    const state = signer.sign('nonce', issuedAtMs)
    // > 60s in the future → reject.
    expect(signer.verify(state, issuedAtMs - 120_000)).toBeNull()
  })

  it('accepts states that are within the -60s clock-skew tolerance', () => {
    const signer = newSigner()
    const issuedAtMs = 1_700_000_000_000
    const state = signer.sign('nonce', issuedAtMs)
    // Future clock is 30s behind the issue time → still accept (within tolerance).
    expect(signer.verify(state, issuedAtMs - 30_000)).not.toBeNull()
  })

  it('defaults `nowMs` to Date.now when not specified', () => {
    const signer = newSigner()
    const issuedAtMs = Date.now() - 1000 // 1s ago — within TTL
    const state = signer.sign('nonce', issuedAtMs)
    expect(signer.verify(state)).not.toBeNull()
  })
})

// ─── Integration: cipher and state signer share the same key securely ────

describe('shared-key isolation', () => {
  it('decrypting state-shaped data as ciphertext throws (formats differ)', () => {
    // The cipher and signer share a key but operate on completely
    // different shapes. A state token (nonce.issuedAtMs.sig base64url)
    // is *not* a valid ciphertext (iv.tag.ct base64, three dot-segments
    // of base64 with a 12-byte iv). Defence-in-depth: even if someone
    // pasted a state into decrypt(), the format check rejects it.
    const key = randomBytes(32)
    const signer = createStateSigner(key)
    const cipher = createTokenCipher(key)
    const state = signer.sign('nonce', Date.now())
    expect(() => cipher.decrypt(state)).toThrow(/malformed ciphertext/)
  })

  it('encrypting ciphertext-shaped data does NOT yield a valid state', () => {
    const key = randomBytes(32)
    const signer = createStateSigner(key)
    const cipher = createTokenCipher(key)
    const ct = cipher.encrypt('hello')
    // State requires three dot-separated parts where the last is
    // a base64url HMAC, not base64 ciphertext. The verify path is the
    // honest move here — verifying arbitrary 3-part strings as if
    // they were states should never match without the right HMAC.
    expect(signer.verify(ct)).toBeNull()
  })
})
