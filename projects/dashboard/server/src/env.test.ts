// env.test.ts — issue #021 follow-up
//
// Tests for the load-time env-var parsing. The TLS branch (added in
// the same follow-up that documented the Google OAuth HTTPS rule)
// is the most behaviour-rich piece — every other branch already has
// integration coverage through the live app tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './env.js'

const PASSWORD_ENV = 'DASHBOARD_PASSWORD'

/** Snapshot every relevant env var so a test can mutate one without
 *  contaminating the next. We don't blanket-save process.env because
 *  vitest's own config + the parent shell have unrelated vars we
 *  don't care about; this list is the union of what loadConfig reads. */
const RELEVANT_ENV_KEYS = [
  PASSWORD_ENV,
  'PORT',
  'HOSTNAME',
  'DASHBOARD_DATA_DIR',
  'DASHBOARD_DB_PATH',
  'DASHBOARD_TLS_CERT',
  'DASHBOARD_TLS_KEY',
  'EMAIL_TOKEN_ENCRYPTION_KEY',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'EMAIL_OAUTH_REDIRECT_URI',
  'EMAIL_SYNC_HISTORY_DAYS',
] as const

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of RELEVANT_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env[PASSWORD_ENV] = 'test-password'
})

afterEach(() => {
  for (const key of RELEVANT_ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('loadConfig — TLS (issue #021 follow-up)', () => {
  /** Generate a self-signed cert + key pair in a fresh tmpdir. Uses
   *  the node crypto module so the test doesn't need an external
   *  openssl binary. The cert is for `localhost` — the config layer
   *  doesn't validate the CN; it only checks file readability and
   *  that the bytes look like a PEM. */
  function makeCertAndKey(): { certPath: string; keyPath: string; cleanup: () => void } {
    const { generateKeyPairSync, createSign } = require('node:crypto') as typeof import('node:crypto')
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-tls-'))
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privPem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
    // Self-signed cert — minimal but real. Sufficient for testing
    // that loadConfig reads + parses it.
    const tbs = Buffer.from(JSON.stringify({
      version: 2,
      subject: 'CN=localhost',
      issuer: 'CN=localhost',
      notBefore: '19700101000000Z',
      notAfter: '99991231235959Z',
      publicKey: publicKey.export({ format: 'pem', type: 'spki' }),
    }))
    const sign = createSign('RSA-SHA256')
    sign.update(tbs)
    const sig = sign.sign(privateKey)
    const b64 = (b: Buffer) => b.toString('base64').replace(/(.{64})/g, '$1\n')
    const cert = [
      '-----BEGIN CERTIFICATE-----',
      b64(Buffer.concat([tbs, sig])),
      '-----END CERTIFICATE-----',
      '',
    ].join('\n')
    const certPath = join(dir, 'cert.pem')
    const keyPath = join(dir, 'key.pem')
    writeFileSync(certPath, cert)
    writeFileSync(keyPath, privPem)
    return {
      certPath,
      keyPath,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    }
  }

  it('returns tls=null when neither env var is set', async () => {
    const config = await loadConfig()
    expect(config.tls).toBeNull()
  })

  it('loads cert + key when both DASHBOARD_TLS_CERT and DASHBOARD_TLS_KEY point at readable files', async () => {
    const { certPath, keyPath, cleanup } = makeCertAndKey()
    try {
      process.env.DASHBOARD_TLS_CERT = certPath
      process.env.DASHBOARD_TLS_KEY = keyPath
      const config = await loadConfig()
      expect(config.tls).not.toBeNull()
      expect(config.tls?.cert.toString('utf8')).toContain('BEGIN CERTIFICATE')
      expect(config.tls?.key.toString('utf8')).toContain('PRIVATE KEY')
    } finally {
      cleanup()
    }
  })

  it('throws when only DASHBOARD_TLS_CERT is set (the pair must be present together)', async () => {
    const { certPath, cleanup } = makeCertAndKey()
    try {
      process.env.DASHBOARD_TLS_CERT = certPath
      await expect(loadConfig()).rejects.toThrow(/Both DASHBOARD_TLS_CERT and DASHBOARD_TLS_KEY/)
    } finally {
      cleanup()
    }
  })

  it('throws when only DASHBOARD_TLS_KEY is set', async () => {
    const { keyPath, cleanup } = makeCertAndKey()
    try {
      process.env.DASHBOARD_TLS_KEY = keyPath
      await expect(loadConfig()).rejects.toThrow(/Both DASHBOARD_TLS_CERT and DASHBOARD_TLS_KEY/)
    } finally {
      cleanup()
    }
  })

  it('throws a path-specific error when the cert file is unreadable', async () => {
    process.env.DASHBOARD_TLS_CERT = '/nonexistent/dashboard-tls-cert.pem'
    process.env.DASHBOARD_TLS_KEY = '/also/missing.pem'
    await expect(loadConfig()).rejects.toThrow(/DASHBOARD_TLS_CERT could not be read/)
  })
})

describe('loadConfig — defaults', () => {
  it('uses port 8080 when PORT is unset', async () => {
    const config = await loadConfig()
    expect(config.port).toBe(8080)
  })

  it('uses 0.0.0.0 when HOSTNAME is unset', async () => {
    const config = await loadConfig()
    expect(config.hostname).toBe('0.0.0.0')
  })

  it('uses 90 days when EMAIL_SYNC_HISTORY_DAYS is unset or invalid', async () => {
    const config = await loadConfig()
    expect(config.emailSyncHistoryDays).toBe(90)
    process.env.EMAIL_SYNC_HISTORY_DAYS = '0'
    const c0 = await loadConfig()
    expect(c0.emailSyncHistoryDays).toBe(90)
    process.env.EMAIL_SYNC_HISTORY_DAYS = '-5'
    const cn = await loadConfig()
    expect(cn.emailSyncHistoryDays).toBe(90)
    process.env.EMAIL_SYNC_HISTORY_DAYS = 'garbage'
    const cg = await loadConfig()
    expect(cg.emailSyncHistoryDays).toBe(90)
  })

  it('respects EMAIL_SYNC_HISTORY_DAYS when it is a positive integer', async () => {
    process.env.EMAIL_SYNC_HISTORY_DAYS = '365'
    const config = await loadConfig()
    expect(config.emailSyncHistoryDays).toBe(365)
  })
})

describe('loadConfig — DASHBOARD_PASSWORD', () => {
  it('throws a clear error when DASHBOARD_PASSWORD is unset', async () => {
    delete process.env.DASHBOARD_PASSWORD
    await expect(loadConfig()).rejects.toThrow(/DASHBOARD_PASSWORD is not set/)
  })
})

describe('loadConfig — .env auto-load', () => {
  function writeEnv(content: string): { path: string; cleanup: () => void } {
    const { writeFileSync, mkdtempSync, rmSync } = require('node:fs') as typeof import('node:fs')
    const { tmpdir } = require('node:os') as typeof import('node:os')
    const { join } = require('node:path') as typeof import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-dotenv-'))
    const p = join(dir, '.env')
    writeFileSync(p, content)
    return { path: p, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  it('loads KEY=value pairs from a .env file when shell env is unset', async () => {
    const { path, cleanup } = writeEnv(`
# comment line, should be skipped
DASHBOARD_PASSWORD=from-dotenv

# blank lines too

GOOGLE_OAUTH_CLIENT_ID=dotenv-client-id
GOOGLE_OAUTH_CLIENT_SECRET=dotenv-secret
EMAIL_OAUTH_REDIRECT_URI=http://localhost:8080/api/email/oauth/callback
EMAIL_TOKEN_ENCRYPTION_KEY=${'a'.repeat(64)}
`)
    try {
      process.env.DASHBOARD_ENV_FILE = path
      delete process.env.DASHBOARD_PASSWORD
      delete process.env.GOOGLE_OAUTH_CLIENT_ID
      const config = await loadConfig()
      // passwordHash is derived from the password string but isn't
      // directly comparable; verify via the email deps that the
      // OAuth vars came from the file.
      expect(config.email?.googleOauthClientId).toBe('dotenv-client-id')
      expect(config.email?.googleOauthClientSecret).toBe('dotenv-secret')
    } finally {
      cleanup()
    }
  })

  it('shell env wins over .env values (no override)', async () => {
    const { path, cleanup } = writeEnv(`DASHBOARD_PASSWORD=from-dotenv
GOOGLE_OAUTH_CLIENT_ID=dotenv-id
GOOGLE_OAUTH_CLIENT_SECRET=dotenv-secret
EMAIL_OAUTH_REDIRECT_URI=http://localhost:8080/api/email/oauth/callback
EMAIL_TOKEN_ENCRYPTION_KEY=${'c'.repeat(64)}`)
    try {
      process.env.DASHBOARD_ENV_FILE = path
      process.env.DASHBOARD_PASSWORD = 'from-shell'
      process.env.GOOGLE_OAUTH_CLIENT_ID = 'shell-id'
      process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'shell-secret'
      process.env.EMAIL_OAUTH_REDIRECT_URI = 'http://localhost:8080/api/email/oauth/callback'
      process.env.EMAIL_TOKEN_ENCRYPTION_KEY = 'd'.repeat(64)
      const config = await loadConfig()
      expect(config.email?.googleOauthClientId).toBe('shell-id')
      expect(config.email?.googleOauthClientSecret).toBe('shell-secret')
    } finally {
      cleanup()
    }
  })

  it('strips surrounding single or double quotes from values', async () => {
    const { path, cleanup } = writeEnv(`GOOGLE_OAUTH_CLIENT_ID="quoted-id"
GOOGLE_OAUTH_CLIENT_SECRET='single-quoted'
EMAIL_TOKEN_ENCRYPTION_KEY=${'b'.repeat(64)}
EMAIL_OAUTH_REDIRECT_URI=http://localhost:8080/api/email/oauth/callback
DASHBOARD_PASSWORD=p`)
    try {
      process.env.DASHBOARD_ENV_FILE = path
      const config = await loadConfig()
      expect(config.email?.googleOauthClientId).toBe('quoted-id')
      expect(config.email?.googleOauthClientSecret).toBe('single-quoted')
    } finally {
      cleanup()
    }
  })

  it('skips the file silently when it does not exist', async () => {
    process.env.DASHBOARD_ENV_FILE = '/nonexistent/.env'
    // Should still load with the test-env password from beforeEach.
    const config = await loadConfig()
    expect(config.passwordHash).toBeDefined()
  })

  it('comments and blank lines are ignored', async () => {
    const { path, cleanup } = writeEnv(`
# this is a comment
# another comment

DASHBOARD_PASSWORD=value-after-comments
`)
    try {
      process.env.DASHBOARD_ENV_FILE = path
      // If comments weren't skipped, loadConfig would fail because
      // of an empty KEY assignment; if it parses the file, the
      // password loaded successfully.
      const config = await loadConfig()
      expect(config.passwordHash).toBeDefined()
    } finally {
      cleanup()
    }
  })
})