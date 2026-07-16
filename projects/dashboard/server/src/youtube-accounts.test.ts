// youtube-accounts.test.ts — issue YT-001
//
// Storage layer for `youtube_accounts`. Verifies the encrypt-on-write /
// decrypt-on-read boundary: a row read straight out of SQLite should
// contain the ciphertext columns (not the plaintext), and the helpers
// always return decrypted data to callers.
//
// Mirrors email-accounts.test.ts (issue #020) — same shape, with
// YouTube-specific fields (google_user_id, scopes, last_refreshed_at)
// instead of (last_sync_at).

import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { createTokenCipher } from './token-encryption.js'
import {
  createYouTubeAccount,
  deleteYouTubeAccount,
  getMostRecentYouTubeAccountId,
  getYouTubeAccount,
  getYouTubeAccountByEmail,
  listYouTubeAccounts,
  updateYouTubeAccountLastRefreshedAt,
  updateYouTubeAccountTokens,
} from './youtube-accounts.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly'

function freshDb(): Database {
  return new Database(':memory:')
}

async function seededDb(): Promise<Database> {
  const db = freshDb()
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  return db
}

function newCipher() {
  return createTokenCipher(randomBytes(32))
}

afterEach(() => {})

describe('youtube_accounts schema', () => {
  it('creates the table with the expected columns', async () => {
    const db = await seededDb()
    const cols = db.all<{ name: string }>('PRAGMA table_info(youtube_accounts)')
    const names = cols.map((c) => c.name)
    expect(names).toEqual([
      'id',
      'provider',
      'google_user_id',
      'email_address',
      'access_token_enc',
      'refresh_token_enc',
      'token_expires_at',
      'scopes',
      'connected_at',
      'last_refreshed_at',
    ])
  })

  it('enforces CHECK provider IN (\'youtube\')', async () => {
    const db = await seededDb()
    expect(() =>
      db.run(
        'INSERT INTO youtube_accounts (id, provider, google_user_id, email_address, access_token_enc, refresh_token_enc, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['x', 'tiktok', 'gid', 'me@x.com', 'a', 'r', OAUTH_SCOPE],
      ),
    ).toThrow(/CHECK/)
  })

  it('enforces UNIQUE(provider, email_address)', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    createYouTubeAccount(db, cipher, {
      provider: 'youtube',
      googleUserId: 'gid-1',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
      scopes: OAUTH_SCOPE,
    })
    // Same email twice should throw on the UNIQUE index.
    expect(() =>
      createYouTubeAccount(db, cipher, {
        provider: 'youtube',
        googleUserId: 'gid-2',
        emailAddress: 'me@gmail.com',
        accessToken: 'a2',
        refreshToken: 'r2',
        scopes: OAUTH_SCOPE,
      }),
    ).toThrow(/UNIQUE/)
  })

  it('rejects rows missing scopes (NOT NULL)', async () => {
    const db = await seededDb()
    expect(() =>
      db.run(
        'INSERT INTO youtube_accounts (id, provider, google_user_id, email_address, access_token_enc, refresh_token_enc) VALUES (?, ?, ?, ?, ?, ?)',
        ['x', 'youtube', 'gid', 'me@x.com', 'a', 'r'],
      ),
    ).toThrow(/NOT NULL/)
  })
})

describe('encryption boundary', () => {
  it('tokens are stored as ciphertext, not plaintext', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    const access = 'ya29.plaintext-access-token-should-not-leak'
    const refresh = '1//plaintext-refresh-token-should-not-leak'

    createYouTubeAccount(db, cipher, {
      provider: 'youtube',
      googleUserId: 'gid',
      emailAddress: 'leak-test@gmail.com',
      accessToken: access,
      refreshToken: refresh,
      scopes: OAUTH_SCOPE,
    })

    const raw = db.get<{ access_token_enc: string; refresh_token_enc: string }>(
      'SELECT access_token_enc, refresh_token_enc FROM youtube_accounts',
    )
    expect(raw).toBeDefined()
    // Plaintext substrings must not appear in the encrypted columns.
    expect(raw!.access_token_enc).not.toContain(access)
    expect(raw!.refresh_token_enc).not.toContain(refresh)
    // The ciphertext format is iv.tag.ct — three dot-separated base64 segments.
    expect(raw!.access_token_enc.split('.')).toHaveLength(3)
    expect(raw!.refresh_token_enc.split('.')).toHaveLength(3)
  })

  it('listYouTubeAccounts returns decrypted tokens via the cipher', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    const account = createYouTubeAccount(db, cipher, {
      provider: 'youtube',
      googleUserId: 'gid',
      emailAddress: 'me@gmail.com',
      accessToken: 'plain-access',
      refreshToken: 'plain-refresh',
      scopes: OAUTH_SCOPE,
    })

    const accounts = listYouTubeAccounts(db, cipher)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.id).toBe(account.id)
    expect(accounts[0]!.accessToken).toBe('plain-access')
    expect(accounts[0]!.refreshToken).toBe('plain-refresh')

    const fetched = getYouTubeAccount(db, cipher, account.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.accessToken).toBe('plain-access')
  })

  it('rotation: a different cipher instance cannot decrypt tokens stored by another', async () => {
    const db = await seededDb()
    const writer = createTokenCipher(randomBytes(32))
    const account = createYouTubeAccount(db, writer, {
      provider: 'youtube',
      googleUserId: 'gid',
      emailAddress: 'me@gmail.com',
      accessToken: 'plain',
      refreshToken: 'plain',
      scopes: OAUTH_SCOPE,
    })
    const wrongReader = createTokenCipher(randomBytes(32))
    expect(() => listYouTubeAccounts(db, wrongReader)).toThrow()
    expect(() => getYouTubeAccount(db, wrongReader, account.id)).toThrow()
  })
})

describe('createYouTubeAccount / get / list', () => {
  it('round-trips through create → get', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    const created = createYouTubeAccount(db, cipher, {
      provider: 'youtube',
      googleUserId: 'gid-123',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
      scopes: OAUTH_SCOPE,
      tokenExpiresAt: '2026-01-01T00:00:00.000Z',
    })

    const fetched = getYouTubeAccount(db, cipher, created.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.id).toBe(created.id)
    expect(fetched!.provider).toBe('youtube')
    expect(fetched!.googleUserId).toBe('gid-123')
    expect(fetched!.emailAddress).toBe('me@gmail.com')
    expect(fetched!.accessToken).toBe('a')
    expect(fetched!.refreshToken).toBe('r')
    expect(fetched!.scopes).toBe(OAUTH_SCOPE)
    expect(fetched!.tokenExpiresAt).toBe('2026-01-01T00:00:00.000Z')
    expect(fetched!.connectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(fetched!.lastRefreshedAt).toBeNull()
  })

  it('returns null for an unknown id', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    expect(getYouTubeAccount(db, cipher, 'does-not-exist')).toBeNull()
  })

  it('getYouTubeAccountByEmail finds an existing account', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    createYouTubeAccount(db, cipher, {
      provider: 'youtube',
      googleUserId: 'gid',
      emailAddress: 'specific@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
      scopes: OAUTH_SCOPE,
    })
    const found = getYouTubeAccountByEmail(db, cipher, 'youtube', 'specific@gmail.com')
    expect(found).not.toBeNull()
    expect(found!.emailAddress).toBe('specific@gmail.com')
  })

  it('listYouTubeAccounts orders most-recently-connected first', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    // Force timestamps so the order is deterministic regardless of
    // millisecond-timing races. Insert raw rows with valid encrypted
    // ciphertext values (the helper would also work, but we want to
    // pin `connected_at` explicitly).
    const stubCt = cipher.encrypt('x')
    db.run(
      `INSERT INTO youtube_accounts
         (id, provider, google_user_id, email_address,
          access_token_enc, refresh_token_enc, scopes, connected_at)
       VALUES (?, 'youtube', 'g1', 'old@gmail.com', ?, ?, ?, '2024-01-01T00:00:00.000Z')`,
      ['id-old', stubCt, stubCt, OAUTH_SCOPE],
    )
    db.run(
      `INSERT INTO youtube_accounts
         (id, provider, google_user_id, email_address,
          access_token_enc, refresh_token_enc, scopes, connected_at)
       VALUES (?, 'youtube', 'g2', 'newer@gmail.com', ?, ?, ?, '2025-01-01T00:00:00.000Z')`,
      ['id-newer', stubCt, stubCt, OAUTH_SCOPE],
    )

    const accounts = listYouTubeAccounts(db, cipher)
    expect(accounts.map((a) => a.emailAddress)).toEqual([
      'newer@gmail.com',
      'old@gmail.com',
    ])
  })
})

describe('updateYouTubeAccountTokens', () => {
  it('rotates the encrypted tokens', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    const acc = createYouTubeAccount(db, cipher, {
      provider: 'youtube',
      googleUserId: 'gid',
      emailAddress: 'me@gmail.com',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      scopes: OAUTH_SCOPE,
    })

    const ok = updateYouTubeAccountTokens(db, cipher, acc.id, {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      tokenExpiresAt: '2026-12-31T00:00:00.000Z',
    })
    expect(ok).toBe(true)

    const fetched = getYouTubeAccount(db, cipher, acc.id)
    expect(fetched!.accessToken).toBe('new-access')
    expect(fetched!.refreshToken).toBe('new-refresh')
    expect(fetched!.tokenExpiresAt).toBe('2026-12-31T00:00:00.000Z')
    // connected_at + scopes must NOT have changed (this helper only
    // mutates token columns).
    expect(fetched!.connectedAt).toBe(acc.connectedAt)
    expect(fetched!.scopes).toBe(OAUTH_SCOPE)
  })

  it('returns false for an unknown id', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    expect(
      updateYouTubeAccountTokens(db, cipher, 'ghost', {
        accessToken: 'a',
        refreshToken: 'r',
        tokenExpiresAt: null,
      }),
    ).toBe(false)
  })
})

describe('updateYouTubeAccountLastRefreshedAt', () => {
  it('sets last_refreshed_at when called without a timestamp', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    const acc = createYouTubeAccount(db, cipher, {
      provider: 'youtube',
      googleUserId: 'gid',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
      scopes: OAUTH_SCOPE,
    })
    expect(acc.lastRefreshedAt).toBeNull()

    updateYouTubeAccountLastRefreshedAt(db, acc.id)
    const fetched = getYouTubeAccount(db, cipher, acc.id)
    expect(fetched!.lastRefreshedAt).not.toBeNull()
    expect(fetched!.lastRefreshedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('accepts an explicit ISO timestamp', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    const acc = createYouTubeAccount(db, cipher, {
      provider: 'youtube',
      googleUserId: 'gid',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
      scopes: OAUTH_SCOPE,
    })
    updateYouTubeAccountLastRefreshedAt(db, acc.id, '2025-06-15T12:34:56.000Z')
    const fetched = getYouTubeAccount(db, cipher, acc.id)
    expect(fetched!.lastRefreshedAt).toBe('2025-06-15T12:34:56.000Z')
  })
})

describe('deleteYouTubeAccount', () => {
  it('removes the row and returns true', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    const acc = createYouTubeAccount(db, cipher, {
      provider: 'youtube',
      googleUserId: 'gid',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
      scopes: OAUTH_SCOPE,
    })
    expect(deleteYouTubeAccount(db, acc.id)).toBe(true)
    expect(getYouTubeAccount(db, cipher, acc.id)).toBeNull()
  })

  it('is idempotent (returns false on a second delete)', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    const acc = createYouTubeAccount(db, cipher, {
      provider: 'youtube',
      googleUserId: 'gid',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
      scopes: OAUTH_SCOPE,
    })
    expect(deleteYouTubeAccount(db, acc.id)).toBe(true)
    expect(deleteYouTubeAccount(db, acc.id)).toBe(false)
  })

  it('returns false for an unknown id', async () => {
    const db = await seededDb()
    expect(deleteYouTubeAccount(db, 'ghost')).toBe(false)
  })
})

describe('getMostRecentYouTubeAccountId', () => {
  it('returns null when no row exists', async () => {
    const db = await seededDb()
    expect(getMostRecentYouTubeAccountId(db)).toBeNull()
  })

  it('returns the id of the most-recently-connected row', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    const stubCt = cipher.encrypt('x')
    db.run(
      `INSERT INTO youtube_accounts
         (id, provider, google_user_id, email_address,
          access_token_enc, refresh_token_enc, scopes, connected_at)
       VALUES (?, 'youtube', 'g1', 'old@gmail.com', ?, ?, ?, '2024-01-01T00:00:00.000Z')`,
      ['id-old', stubCt, stubCt, OAUTH_SCOPE],
    )
    db.run(
      `INSERT INTO youtube_accounts
         (id, provider, google_user_id, email_address,
          access_token_enc, refresh_token_enc, scopes, connected_at)
       VALUES (?, 'youtube', 'g2', 'newer@gmail.com', ?, ?, ?, '2025-01-01T00:00:00.000Z')`,
      ['id-newer', stubCt, stubCt, OAUTH_SCOPE],
    )
    expect(getMostRecentYouTubeAccountId(db)).toBe('id-newer')
  })

  it('returns the id even when the ciphertext cannot be decrypted', async () => {
    const db = await seededDb()
    // Simulate key rotation by inserting garbage ciphertext.
    db.run(
      `INSERT INTO youtube_accounts
         (id, provider, google_user_id, email_address,
          access_token_enc, refresh_token_enc, scopes)
       VALUES (?, 'youtube', 'gid', 'corrupt@gmail.com', 'garbage', 'garbage', ?)`,
      ['id-corrupt', OAUTH_SCOPE],
    )
    // listYouTubeAccounts would throw here (decrypt fails), but the
    // helper just needs the id.
    expect(getMostRecentYouTubeAccountId(db)).toBe('id-corrupt')
  })
})