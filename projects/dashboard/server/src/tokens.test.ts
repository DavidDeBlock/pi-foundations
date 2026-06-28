import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import bcrypt from 'bcryptjs'
import { Hono } from 'hono'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { auth, type AuthVariables } from './auth.js'
import {
  InMemoryTokenStore,
  JsonTokenStore,
  type TokenStore,
} from './token-store.js'
import { tokenApi } from './api-tokens.js'
import { settingsView } from './settings-view.js'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'

// ─── Helpers ───────────────────────────────────────────────────────────────

const PASSWORD = 'correct horse battery staple'
const HASH = await bcrypt.hash(PASSWORD, 10)

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

function bearerHeader(token: string): string {
  return `Bearer ${token}`
}

/**
 * Build a Hono app with the given store. Mirrors the production wiring
 * (unified `auth` middleware) plus the token API and settings routes.
 */
async function buildApp(store: TokenStore): Promise<Hono<{ Variables: AuthVariables }>> {
  const app = new Hono<{ Variables: AuthVariables }>()
  const db = new Database(':memory:')
  // Migrations dir is `<project>/migrations` — vitest runs from the
  // server project root, so cwd-relative works.
  await runMigrations(db, { dir: resolve(process.cwd(), 'migrations') })
  app.use('*', auth({ passwordHash: HASH, tokenStore: store }))
  app.route('/api/tokens', tokenApi(store))
  const settings = settingsView(store)
  app.get('/settings', settings.list)
  app.post('/settings/tokens', settings.createToken)
  app.post('/settings/tokens/:id/revoke', settings.revokeFromUi)
  return app
}

// ─── InMemoryTokenStore ────────────────────────────────────────────────────

describe('InMemoryTokenStore', () => {
  it('create returns plaintext + record; list never contains plaintext', async () => {
    const store = new InMemoryTokenStore()
    const { record, plaintext } = await store.create('Chrome extension')

    expect(plaintext).toMatch(/^[A-Za-z0-9_-]{43}$/) // base64url, 32 bytes
    expect(record.label).toBe('Chrome extension')
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/) // UUID
    expect(record.lastUsedAt).toBeNull()

    const listed = await store.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).not.toHaveProperty('plaintext')
    expect(listed[0]).not.toHaveProperty('lookupHash')
    expect(listed[0]).not.toHaveProperty('verifyHash')
    expect(Object.keys(listed[0]).sort()).toEqual([
      'createdAt',
      'id',
      'label',
      'lastUsedAt',
    ])
  })

  it('roundtrip: create → findByPlaintext returns the same record', async () => {
    const store = new InMemoryTokenStore()
    const { plaintext } = await store.create('home desktop')
    const found = await store.findByPlaintext(plaintext)
    expect(found?.label).toBe('home desktop')
  })

  it('findByPlaintext returns null for an unknown token', async () => {
    const store = new InMemoryTokenStore()
    expect(await store.findByPlaintext('not-a-real-token')).toBeNull()
  })

  it('findByPlaintext returns null for a token with wrong plaintext', async () => {
    const store = new InMemoryTokenStore()
    const { plaintext } = await store.create('x')
    const tampered = plaintext.slice(0, -1) + (plaintext.endsWith('A') ? 'B' : 'A')
    expect(await store.findByPlaintext(tampered)).toBeNull()
  })

  it('findByPlaintext updates lastUsedAt on success', async () => {
    const store = new InMemoryTokenStore()
    const { record, plaintext } = await store.create('x')
    expect(record.lastUsedAt).toBeNull()

    const before = Date.now()
    const found = await store.findByPlaintext(plaintext)
    const after = Date.now()

    expect(found?.lastUsedAt).not.toBeNull()
    // Timestamp should fall between the calls surrounding findByPlaintext.
    const ts = new Date(found!.lastUsedAt!).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('revoke removes a token; findByPlaintext then returns null', async () => {
    const store = new InMemoryTokenStore()
    const { record, plaintext } = await store.create('x')

    expect(await store.revoke(record.id)).toBe(true)
    expect(await store.list()).toHaveLength(0)
    expect(await store.findByPlaintext(plaintext)).toBeNull()
  })

  it('revoke returns false for an unknown id', async () => {
    const store = new InMemoryTokenStore()
    expect(await store.revoke('does-not-exist')).toBe(false)
  })
})

// ─── JsonTokenStore ────────────────────────────────────────────────────────

describe('JsonTokenStore', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'dashboard-tokens-'))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('persists across instances', async () => {
    const a = new JsonTokenStore({ dataDir: tmp })
    const { record, plaintext } = await a.create('home')
    expect(await a.list()).toHaveLength(1)

    const b = new JsonTokenStore({ dataDir: tmp })
    const listed = await b.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(record.id)

    // The plaintext must NOT be in the persisted file.
    const fs = await import('node:fs/promises')
    const raw = await fs.readFile(join(tmp, 'tokens.json'), 'utf8')
    expect(raw).not.toContain(plaintext)
  })

  it('creates the data dir if missing', async () => {
    const nested = join(tmp, 'nested', 'deeper')
    const store = new JsonTokenStore({ dataDir: nested })
    await store.create('x')
    const fs = await import('node:fs/promises')
    const stat = await fs.stat(join(nested, 'tokens.json'))
    expect(stat.isFile()).toBe(true)
  })

  it('survives concurrent creates without losing data', async () => {
    const store = new JsonTokenStore({ dataDir: tmp })
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.create(`tok-${i}`)),
    )
    expect(results).toHaveLength(10)
    expect(new Set(results.map((r) => r.record.id)).size).toBe(10)
    expect(await store.list()).toHaveLength(10)
  })
})

// ─── Bearer auth middleware ────────────────────────────────────────────────

describe('Bearer auth via app.request()', () => {
  let store: InMemoryTokenStore
  let app: Hono<{ Variables: AuthVariables }>

  beforeEach(async () => {
    store = new InMemoryTokenStore()
    app = await buildApp(store)
  })

  it('accepts a valid Bearer token', async () => {
    const { plaintext } = await store.create('home')
    const res = await app.request('/api/tokens', {
      headers: { authorization: bearerHeader(plaintext) },
    })
    expect(res.status).toBe(200)
  })

  it('rejects an unknown Bearer token with 401', async () => {
    const res = await app.request('/api/tokens', {
      headers: { authorization: bearerHeader('definitely-not-real') },
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="Dashboard"')
  })

  it('rejects a revoked Bearer token with 401', async () => {
    const { record, plaintext } = await store.create('home')
    await store.revoke(record.id)

    const res = await app.request('/api/tokens', {
      headers: { authorization: bearerHeader(plaintext) },
    })
    expect(res.status).toBe(401)
  })

  it('still accepts Basic auth (regression check)', async () => {
    const res = await app.request('/api/tokens', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
  })

  it('rejects Basic auth with the wrong password (regression check)', async () => {
    const res = await app.request('/api/tokens', {
      headers: { authorization: basicHeader('david', 'wrong') },
    })
    expect(res.status).toBe(401)
  })

  it('rejects when no Authorization header is sent', async () => {
    const res = await app.request('/api/tokens')
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="Dashboard"')
  })

  it('rejects when the Bearer token is malformed (no value)', async () => {
    const res = await app.request('/api/tokens', {
      headers: { authorization: 'Bearer ' },
    })
    expect(res.status).toBe(401)
  })

  it('records lastUsedAt after a successful Bearer request', async () => {
    const { plaintext, record } = await store.create('home')
    expect(record.lastUsedAt).toBeNull()

    await app.request('/api/tokens', {
      headers: { authorization: bearerHeader(plaintext) },
    })

    const found = await store.findByPlaintext(plaintext)
    expect(found?.lastUsedAt).not.toBeNull()
    // Allow a small skew — the middleware writes the timestamp, then we
    // read it back. ISO 8601 strings compare cleanly.
    expect(found!.lastUsedAt!).not.toEqual(record.lastUsedAt)
  })
})

// ─── /api/tokens JSON API ──────────────────────────────────────────────────

describe('/api/tokens JSON API', () => {
  let store: InMemoryTokenStore
  let app: Hono<{ Variables: AuthVariables }>

  beforeEach(async () => {
    store = new InMemoryTokenStore()
    app = await buildApp(store)
  })

  it('GET /api/tokens returns an empty list initially', async () => {
    const res = await app.request('/api/tokens', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tokens: [] })
  })

  it('POST /api/tokens returns 201 + plaintext-once', async () => {
    const res = await app.request('/api/tokens', {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ label: 'home desktop' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      id: string
      label: string
      plaintext: string
      createdAt: string
      lastUsedAt: string | null
    }
    expect(body.label).toBe('home desktop')
    expect(body.plaintext).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('POST /api/tokens falls back to "Untitled" for missing/empty labels', async () => {
    const res = await app.request('/api/tokens', {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ label: '   ' }),
    })
    const body = (await res.json()) as { label: string }
    expect(body.label).toBe('Untitled')
  })

  it('GET /api/tokens returns created tokens WITHOUT the plaintext', async () => {
    const created = await store.create('home')
    const res = await app.request('/api/tokens', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tokens: Array<Record<string, unknown>> }
    expect(body.tokens).toHaveLength(1)
    expect(body.tokens[0]).not.toHaveProperty('plaintext')
    expect(body.tokens[0]).not.toHaveProperty('lookupHash')
    expect(body.tokens[0]).not.toHaveProperty('verifyHash')
    expect(body.tokens[0]?.label).toBe('home')
    expect(body.tokens[0]?.id).toBe(created.record.id)
  })

  it('DELETE /api/tokens/:id returns 204 for a known id', async () => {
    const { record } = await store.create('home')
    const res = await app.request(`/api/tokens/${record.id}`, {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(204)
    expect(await store.list()).toHaveLength(0)
  })

  it('DELETE /api/tokens/:id returns 404 for an unknown id', async () => {
    const res = await app.request('/api/tokens/does-not-exist', {
      method: 'DELETE',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(404)
  })

  it('the newly-issued Bearer token can call /api/tokens immediately', async () => {
    const res = await app.request('/api/tokens', {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ label: 'ext' }),
    })
    const { plaintext } = (await res.json()) as { plaintext: string }

    const using = await app.request('/api/tokens', {
      headers: { authorization: bearerHeader(plaintext) },
    })
    expect(using.status).toBe(200)
  })
})

// ─── /settings HTML UI ─────────────────────────────────────────────────────

describe('/settings HTML UI', () => {
  let store: InMemoryTokenStore
  let app: Hono<{ Variables: AuthVariables }>

  beforeEach(async () => {
    store = new InMemoryTokenStore()
    app = await buildApp(store)
  })

  it('GET /settings renders the empty-state HTML when there are no tokens', async () => {
    const res = await app.request('/settings', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<h1>Settings</h1>')
    expect(html).toContain('No tokens yet')
  })

  it('POST /settings/tokens renders the plaintext once and links back', async () => {
    const form = new URLSearchParams({ label: 'home desktop' })
    const res = await app.request('/settings/tokens', {
      method: 'POST',
      headers: {
        authorization: basicHeader('david', PASSWORD),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Copy it now')
    expect(html).toMatch(/[A-Za-z0-9_-]{43}/) // the plaintext appears once
    expect(html).toContain('home desktop')
  })

  it('POST /settings/tokens/:id/revoke redirects back to /settings', async () => {
    const { record } = await store.create('home')
    const res = await app.request(`/settings/tokens/${record.id}/revoke`, {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings')
    expect(await store.list()).toHaveLength(0)
  })
})
