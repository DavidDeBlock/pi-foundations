// email-accounts.test.ts — issue #020
//
// Storage layer for `email_accounts`. Verifies the encrypt-on-write /
// decrypt-on-read boundary: a row read straight out of SQLite should
// contain the ciphertext columns (not the plaintext), and the helpers
// always return decrypted data to callers.
//
// Covers:
//   * `parseEncryptionKey` + `createTokenCipher` boundary (encryption
//     key rotation would break round-trips)
//   * list/get/getByAddress return decrypted tokens
//   * Raw rows (via `db.get<EmailAccountRow>`) contain ciphertext
//   * UNIQUE(provider, email_address) blocks accidental double-link
//   * updateTokens / updateLastSyncAt mutate only the relevant columns
//   * delete works and is idempotent

import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { createTokenCipher } from './token-encryption.js'
import {
  createEmailAccount,
  deleteEmailAccount,
  getEmailAccount,
  getEmailAccountByAddress,
  listEmailAccounts,
  updateEmailAccountLastSyncAt,
  updateEmailAccountTokens,
} from './email-accounts.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

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

describe('email_accounts schema', () => {
  it('creates the table with the expected columns', async () => {
    const db = await seededDb()
    const cols = db.all<{ name: string }>('PRAGMA table_info(email_accounts)')
    const names = cols.map((c) => c.name)
    expect(names).toEqual([
      'id',
      'provider',
      'email_address',
      'access_token_enc',
      'refresh_token_enc',
      'token_expires_at',
      'connected_at',
      'last_sync_at',
    ])
  })

  it('enforces CHECK provider IN (\'gmail\')', async () => {
    const db = await seededDb()
    expect(() =>
      db.run(
        'INSERT INTO email_accounts (id, provider, email_address, access_token_enc, refresh_token_enc) VALUES (?, ?, ?, ?, ?)',
        ['x', 'outlook', 'me@x.com', 'a', 'b'],
      ),
    ).toThrow(/CHECK/)
  })

  it('enforces UNIQUE(provider, email_address)', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    createEmailAccount(db, cipher, {
      provider: 'gmail',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
    })
    // Same email twice should throw on the UNIQUE index.
    expect(() =>
      createEmailAccount(db, cipher, {
        provider: 'gmail',
        emailAddress: 'me@gmail.com',
        accessToken: 'a2',
        refreshToken: 'r2',
      }),
    ).toThrow(/UNIQUE/)
  })
})

describe('encryption boundary', () => {
  it('tokens are stored as ciphertext, not plaintext', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    const access = 'ya29.plaintext-access-token-should-not-leak'
    const refresh = '1//plaintext-refresh-token-should-not-leak'

    createEmailAccount(db, cipher, {
      provider: 'gmail',
      emailAddress: 'leak-test@gmail.com',
      accessToken: access,
      refreshToken: refresh,
    })

    const raw = db.get<{ access_token_enc: string; refresh_token_enc: string }>(
      'SELECT access_token_enc, refresh_token_enc FROM email_accounts',
    )
    expect(raw).toBeDefined()
    // Plaintext substrings must not appear in the encrypted columns.
    expect(raw!.access_token_enc).not.toContain(access)
    expect(raw!.refresh_token_enc).not.toContain(refresh)
    // The ciphertext format is iv.tag.ct — three dot-separated base64 segments.
    expect(raw!.access_token_enc.split('.')).toHaveLength(3)
    expect(raw!.refresh_token_enc.split('.')).toHaveLength(3)
  })

  it('listEmailAccounts returns decrypted tokens via the cipher', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    const account = createEmailAccount(db, cipher, {
      provider: 'gmail',
      emailAddress: 'me@gmail.com',
      accessToken: 'plain-access',
      refreshToken: 'plain-refresh',
    })

    const accounts = listEmailAccounts(db, cipher)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.id).toBe(account.id)
    expect(accounts[0]!.accessToken).toBe('plain-access')
    expect(accounts[0]!.refreshToken).toBe('plain-refresh')

    const fetched = getEmailAccount(db, cipher, account.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.accessToken).toBe('plain-access')
  })

  it('rotation: a different cipher instance cannot decrypt tokens stored by another', async () => {
    const db = await seededDb()
    const writer = createTokenCipher(randomBytes(32))
    const account = createEmailAccount(db, writer, {
      provider: 'gmail',
      emailAddress: 'me@gmail.com',
      accessToken: 'plain',
      refreshToken: 'plain',
    })
    const wrongReader = createTokenCipher(randomBytes(32))
    expect(() => listEmailAccounts(db, wrongReader)).toThrow()
    expect(() => getEmailAccount(db, wrongReader, account.id)).toThrow()
  })
})

describe('createEmailAccount / get / list', () => {
  it('round-trips through create → get', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    const created = createEmailAccount(db, cipher, {
      provider: 'gmail',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
      tokenExpiresAt: '2026-01-01T00:00:00.000Z',
    })

    const fetched = getEmailAccount(db, cipher, created.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.id).toBe(created.id)
    expect(fetched!.provider).toBe('gmail')
    expect(fetched!.emailAddress).toBe('me@gmail.com')
    expect(fetched!.accessToken).toBe('a')
    expect(fetched!.refreshToken).toBe('r')
    expect(fetched!.tokenExpiresAt).toBe('2026-01-01T00:00:00.000Z')
    expect(fetched!.connectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(fetched!.lastSyncAt).toBeNull()
  })

  it('returns null for an unknown id', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    expect(getEmailAccount(db, cipher, 'does-not-exist')).toBeNull()
  })

  it('getEmailAccountByAddress finds an existing account', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    createEmailAccount(db, cipher, {
      provider: 'gmail',
      emailAddress: 'specific@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
    })
    const found = getEmailAccountByAddress(db, cipher, 'gmail', 'specific@gmail.com')
    expect(found).not.toBeNull()
    expect(found!.emailAddress).toBe('specific@gmail.com')
  })

  it('listEmailAccounts orders most-recently-connected first', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    // Force timestamps so the order is deterministic regardless of
    // millisecond-timing races. Insert raw rows with valid encrypted
    // ciphertext values (the helper would also work, but we want to
    // pin `connected_at` explicitly).
    const stubCt = cipher.encrypt('x')
    db.run(
      `INSERT INTO email_accounts (id, provider, email_address, access_token_enc, refresh_token_enc, connected_at)
       VALUES (?, 'gmail', 'old@gmail.com', ?, ?, '2024-01-01T00:00:00.000Z')`,
      ['id-old', stubCt, stubCt],
    )
    db.run(
      `INSERT INTO email_accounts (id, provider, email_address, access_token_enc, refresh_token_enc, connected_at)
       VALUES (?, 'gmail', 'newer@gmail.com', ?, ?, '2025-01-01T00:00:00.000Z')`,
      ['id-newer', stubCt, stubCt],
    )

    const accounts = listEmailAccounts(db, cipher)
    expect(accounts.map((a) => a.emailAddress)).toEqual([
      'newer@gmail.com',
      'old@gmail.com',
    ])
  })
})

describe('updateEmailAccountTokens', () => {
  it('rotates the encrypted tokens', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    const acc = createEmailAccount(db, cipher, {
      provider: 'gmail',
      emailAddress: 'me@gmail.com',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
    })

    const ok = updateEmailAccountTokens(db, cipher, acc.id, {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      tokenExpiresAt: '2026-12-31T00:00:00.000Z',
    })
    expect(ok).toBe(true)

    const fetched = getEmailAccount(db, cipher, acc.id)
    expect(fetched!.accessToken).toBe('new-access')
    expect(fetched!.refreshToken).toBe('new-refresh')
    expect(fetched!.tokenExpiresAt).toBe('2026-12-31T00:00:00.000Z')
    // connected_at must NOT have changed (this helper only mutates token columns).
    expect(fetched!.connectedAt).toBe(acc.connectedAt)
  })

  it('returns false for an unknown id', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    expect(
      updateEmailAccountTokens(db, cipher, 'ghost', {
        accessToken: 'a',
        refreshToken: 'r',
        tokenExpiresAt: null,
      }),
    ).toBe(false)
  })
})

describe('updateEmailAccountLastSyncAt', () => {
  it('sets last_sync_at when called without a timestamp', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    const acc = createEmailAccount(db, cipher, {
      provider: 'gmail',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
    })
    expect(acc.lastSyncAt).toBeNull()

    updateEmailAccountLastSyncAt(db, acc.id)
    const fetched = getEmailAccount(db, cipher, acc.id)
    expect(fetched!.lastSyncAt).not.toBeNull()
    expect(fetched!.lastSyncAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('accepts an explicit ISO timestamp', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    const acc = createEmailAccount(db, cipher, {
      provider: 'gmail',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
    })
    updateEmailAccountLastSyncAt(db, acc.id, '2025-06-15T12:34:56.000Z')
    const fetched = getEmailAccount(db, cipher, acc.id)
    expect(fetched!.lastSyncAt).toBe('2025-06-15T12:34:56.000Z')
  })
})

describe('deleteEmailAccount', () => {
  it('removes the row and returns true', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    const acc = createEmailAccount(db, cipher, {
      provider: 'gmail',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
    })
    expect(deleteEmailAccount(db, acc.id)).toBe(true)
    expect(getEmailAccount(db, cipher, acc.id)).toBeNull()
  })

  it('is idempotent (returns false on a second delete)', async () => {
    const db = await seededDb()
    const cipher = newCipher()
    const acc = createEmailAccount(db, cipher, {
      provider: 'gmail',
      emailAddress: 'me@gmail.com',
      accessToken: 'a',
      refreshToken: 'r',
    })
    expect(deleteEmailAccount(db, acc.id)).toBe(true)
    expect(deleteEmailAccount(db, acc.id)).toBe(false)
  })

  it('returns false for an unknown id', async () => {
    const db = await seededDb()
    expect(deleteEmailAccount(db, 'ghost')).toBe(false)
  })
})
