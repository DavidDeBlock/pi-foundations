// gmail-client.test.ts — issue #020
//
// Unit tests for the deep `GmailClient` module. Coverage driven by the
// acceptance criteria:
//   * `listMessages` paginates via `nextPageToken`
//   * `getMessage` returns a fully-parsed `RawEmail`
//   * 401 → transparent refresh-token exchange → retry succeeds
//   * 429 → exponential backoff (sleep count + delays)
//   * Scope is exactly `gmail.readonly` (regression guard)
//
// We never hit the network: fetch + sleep are both injected via the
// `GmailClientDeps` constructor options. That keeps these tests fast
// and deterministic, and means they don't share infra with anyone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { createTokenCipher } from './token-encryption.js'
import { createEmailAccount } from './email-accounts.js'
import {
  GmailApiError,
  GmailClient,
  GMAIL_READONLY_SCOPE,
  RefreshFailedError,
} from './gmail-client.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

interface Client {
  readonly id: string
  readonly client: GmailClient
  readonly cipher: ReturnType<typeof createTokenCipher>
  readonly db: Database
}

async function makeClient(): Promise<Client> {
  const db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  const cipher = createTokenCipher(randomBytes(32))
  const account = createEmailAccount(db, cipher, {
    provider: 'gmail',
    emailAddress: 'me@gmail.com',
    accessToken: 'initial-access',
    refreshToken: 'initial-refresh',
    tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  })
  const client = new GmailClient({
    db,
    cipher,
    accountId: account.id,
    oauthClientId: 'test-client-id',
    oauthClientSecret: 'test-client-secret',
    // Real fetch disabled by default in tests — tests provide a `fetchFn`.
  })
  return { id: account.id, client, cipher, db }
}

interface RecordedCall {
  readonly url: string
  readonly init?: RequestInit
  readonly responseFactory: (callCount: number) => Response
}

/**
 * Build a fetch stub that walks through a queue of canned responses. Each
 * entry can either return a fixed Response immediately or invoke the
 * supplied counter-based factory. Holds onto call args so tests can
 * inspect the headers and body the GmailClient sent.
 */
function buildStub(calls: RecordedCall[]): {
  readonly fn: typeof fetch
  readonly calls: Array<{ url: string; init?: RequestInit }>
} {
  const recorded: Array<{ url: string; init?: RequestInit }> = []
  let callCount = 0

  const fn = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    recorded.push({ url, init })
    const next = calls[callCount]
    if (!next) {
      throw new Error(`unexpected fetch call #${callCount + 1} → ${url}`)
    }
    callCount++
    return next.responseFactory(callCount - 1)
  }) as unknown as typeof fetch

  return { fn, calls: recorded }
}

// ─── Scope regression guard ───────────────────────────────────────────────

describe('GmailClient scope', () => {
  it('exposes exactly gmail.readonly (no modify / send / compose)', () => {
    expect(GmailClient.getScope()).toBe('https://www.googleapis.com/auth/gmail.readonly')
    // Belt + braces: the constant matches the static helper.
    expect(GMAIL_READONLY_SCOPE).toBe(GmailClient.getScope())
    // Negative assertions on the four forbidden scopes.
    expect(GMAIL_READONLY_SCOPE).not.toContain('gmail.modify')
    expect(GMAIL_READONLY_SCOPE).not.toContain('gmail.send')
    expect(GMAIL_READONLY_SCOPE).not.toContain('gmail.compose')
  })
})

// ─── listMessages ─────────────────────────────────────────────────────────

describe('GmailClient.listMessages', () => {
  let env: Awaited<ReturnType<typeof makeClient>>
  beforeEach(async () => {
    env = await makeClient()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a parsed {messages, nextPageToken} shape', async () => {
    const { fn } = buildStub([
      {
        url: 'irrelevant',
        responseFactory: () => new Response(
          JSON.stringify({
            messages: [
              { id: 'm1', threadId: 't1' },
              { id: 'm2', threadId: 't1' },
              { id: 'm3', threadId: 't2' },
            ],
            nextPageToken: 'p2',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      },
    ])
    const c = new GmailClient({
      ...clientDeps(env),
      fetchFn: fn,
    })
    const out = await c.listMessages()
    expect(out.messages).toEqual([
      { id: 'm1', threadId: 't1' },
      { id: 'm2', threadId: 't1' },
      { id: 'm3', threadId: 't2' },
    ])
    expect(out.nextPageToken).toBe('p2')
  })

  it('sends the pageToken query param on the second call', async () => {
    const stub = buildStub([
      {
        url: 'first',
        responseFactory: () => new Response(
          JSON.stringify({
            messages: [{ id: 'm1', threadId: 't1' }],
            nextPageToken: 'p2',
          }),
          { status: 200 },
        ),
      },
      {
        url: 'second',
        responseFactory: () => new Response(
          JSON.stringify({
            messages: [{ id: 'm2', threadId: 't1' }],
          }),
          { status: 200 },
        ),
      },
    ])
    const c = new GmailClient({ ...clientDeps(env), fetchFn: stub.fn })
    const page1 = await c.listMessages()
    expect(page1.nextPageToken).toBe('p2')

    const page2 = await c.listMessages({ pageToken: page1.nextPageToken ?? undefined })
    expect(page2.messages).toEqual([{ id: 'm2', threadId: 't1' }])
    expect(page2.nextPageToken).toBeNull()

    // The second URL must carry pageToken=p2.
    expect(stub.calls[1]!.url).toContain('pageToken=p2')
  })

  it('translates `since` to a `q=after:<epoch-seconds>` filter', async () => {
    const { fn, calls } = buildStub([
      {
        url: 'irrelevant',
        responseFactory: () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      },
    ])
    const c = new GmailClient({ ...clientDeps(env), fetchFn: fn })

    // 2024-06-15T12:00:00Z = 1718452800 seconds since epoch.
    await c.listMessages({ since: '2024-06-15T12:00:00.000Z' })
    expect(calls[0]!.url).toContain('q=after%3A1718452800')
  })

  it('omits optional query params when not provided', async () => {
    const { fn, calls } = buildStub([
      {
        url: 'irrelevant',
        responseFactory: () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      },
    ])
    const c = new GmailClient({ ...clientDeps(env), fetchFn: fn })
    await c.listMessages()
    expect(calls[0]!.url).not.toContain('pageToken')
    expect(calls[0]!.url).not.toContain('maxResults')
    expect(calls[0]!.url).not.toContain('q=')
  })

  it('attaches a Bearer access token (decrypted from storage)', async () => {
    const { fn, calls } = buildStub([
      {
        url: 'irrelevant',
        responseFactory: () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      },
    ])
    const c = new GmailClient({ ...clientDeps(env), fetchFn: fn })
    await c.listMessages()
    expect(calls[0]!.init?.headers).toMatchObject({
      authorization: 'Bearer initial-access',
    })
  })
})

function clientDeps(env: Awaited<ReturnType<typeof makeClient>>) {
  // Helper so each test can spread { ...clientDeps(env), fetchFn } to
  // construct a GmailClient without repeating every dependency.
  return {
    db: env.db,
    cipher: env.cipher,
    accountId: env.id,
    oauthClientId: 'test-client-id',
    oauthClientSecret: 'test-client-secret',
  } as const
}

// ─── getMessage ───────────────────────────────────────────────────────────

describe('GmailClient.getMessage', () => {
  let env: Awaited<ReturnType<typeof makeClient>>
  beforeEach(async () => {
    env = await makeClient()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a fully-parsed RawEmail', async () => {
    // Build a Gmail `messages.get` response with multipart/alternative
    // (text/plain + text/html). Verify we extract the plain version.
    const plain = Buffer.from('Hello body', 'utf8').toString('base64url')
    const html = Buffer.from('<p>Hello body</p>', 'utf8').toString('base64url')

    const gmailRes = {
      id: 'm1',
      threadId: 't1',
      internalDate: '1700000000000',
      snippet: 'Hello snippet',
      labelIds: ['INBOX', 'UNREAD'],
      payload: {
        headers: [
          { name: 'Subject', value: 'A subject' },
          { name: 'From', value: '"Alice" <alice@example.com>' },
          { name: 'To', value: 'me@gmail.com' },
          { name: 'Cc', value: '"Bob" <bob@example.com>, carol@example.com' },
        ],
        parts: [
          { mimeType: 'text/plain', body: { data: plain } },
          { mimeType: 'text/html', body: { data: html } },
        ],
      },
    }

    const { fn, calls } = buildStub([
      {
        url: 'irrelevant',
        responseFactory: () => new Response(JSON.stringify(gmailRes), { status: 200 }),
      },
    ])
    const c = new GmailClient({ ...clientDeps(env), fetchFn: fn })
    const msg = await c.getMessage('m1')

    expect(msg.id).toBe('m1')
    expect(msg.threadId).toBe('t1')
    expect(msg.snippet).toBe('Hello snippet')
    expect(msg.internalDate).toBe('2023-11-14T22:13:20.000Z')
    expect(msg.subject).toBe('A subject')
    expect(msg.bodyPlain).toBe('Hello body')
    expect(msg.isUnread).toBe(true)
    expect(msg.labels).toEqual(['INBOX', 'UNREAD'])
    expect(msg.from).toEqual({ name: 'Alice', email: 'alice@example.com' })
    expect(msg.to).toEqual([{ name: null, email: 'me@gmail.com' }])
    expect(msg.cc).toEqual([
      { name: 'Bob', email: 'bob@example.com' },
      { name: null, email: 'carol@example.com' },
    ])
    expect(calls[0]!.url).toContain('/messages/m1')
    expect(calls[0]!.url).toContain('format=full')
  })

  it('handles a non-multipart message (body sits at payload.body)', async () => {
    const data = Buffer.from('Simple body', 'utf8').toString('base64url')
    const gmailRes = {
      id: 'm2',
      threadId: 't2',
      payload: {
        headers: [{ name: 'Subject', value: 's' }],
        body: { data },
      },
    }
    const { fn } = buildStub([
      {
        url: 'irrelevant',
        responseFactory: () => new Response(JSON.stringify(gmailRes), { status: 200 }),
      },
    ])
    const c = new GmailClient({ ...clientDeps(env), fetchFn: fn })
    const msg = await c.getMessage('m2')
    expect(msg.bodyPlain).toBe('Simple body')
    expect(msg.subject).toBe('s')
    expect(msg.isUnread).toBe(false)
  })

  it('converts a non-multipart HTML-only message to readable plain text', async () => {
    const data = Buffer.from(
      '<html><head><style>.hidden{display:none}</style></head><body><h1>Weekly&nbsp;update</h1><p>Hello <strong>David</strong>,</p><ul><li>First item</li><li>Second &amp; final</li></ul><script>alert(1)</script></body></html>',
      'utf8',
    ).toString('base64url')
    const gmailRes = {
      id: 'm-html-simple',
      threadId: 't-html-simple',
      payload: {
        mimeType: 'text/html',
        headers: [{ name: 'Subject', value: 'HTML only' }],
        body: { data },
      },
    }
    const { fn } = buildStub([
      {
        url: 'irrelevant',
        responseFactory: () => new Response(JSON.stringify(gmailRes), { status: 200 }),
      },
    ])

    const msg = await new GmailClient({ ...clientDeps(env), fetchFn: fn }).getMessage('m-html-simple')

    expect(msg.bodyPlain).toContain('Weekly update')
    expect(msg.bodyPlain).toContain('Hello David,')
    expect(msg.bodyPlain).toContain('- First item')
    expect(msg.bodyPlain).toContain('- Second & final')
    expect(msg.bodyPlain).not.toMatch(/<[^>]+>|alert\(1\)|display:none/)
    expect(msg.bodyHtml).toContain('<h1>Weekly&nbsp;update</h1>')
  })

  it('converts an HTML-only multipart message instead of exposing markup', async () => {
    const html = Buffer.from('<div>Welcome<br>back, &#68;avid.</div>', 'utf8').toString('base64url')
    const gmailRes = {
      id: 'm-html-part',
      threadId: 't-html-part',
      payload: {
        headers: [{ name: 'Subject', value: 'HTML part' }],
        parts: [{ mimeType: 'text/html', body: { data: html } }],
      },
    }
    const { fn } = buildStub([
      {
        url: 'irrelevant',
        responseFactory: () => new Response(JSON.stringify(gmailRes), { status: 200 }),
      },
    ])

    const msg = await new GmailClient({ ...clientDeps(env), fetchFn: fn }).getMessage('m-html-part')

    expect(msg.bodyPlain).toBe('Welcome\nback, David.')
    expect(msg.bodyHtml).toBe('<div>Welcome<br>back, &#68;avid.</div>')
  })

  it('recurses into nested multipart bodies', async () => {
    const inner = Buffer.from('Deep body', 'utf8').toString('base64url')
    const gmailRes = {
      id: 'm3',
      threadId: 't3',
      payload: {
        headers: [{ name: 'Subject', value: 'nested' }],
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              { mimeType: 'text/plain', body: { data: inner } },
              {
                mimeType: 'multipart/related',
                parts: [
                  { mimeType: 'text/html', body: { data: 'aGk=' /* "hi" */ } },
                ],
              },
            ],
          },
        ],
      },
    }
    const { fn } = buildStub([
      {
        url: 'irrelevant',
        responseFactory: () => new Response(JSON.stringify(gmailRes), { status: 200 }),
      },
    ])
    const c = new GmailClient({ ...clientDeps(env), fetchFn: fn })
    const msg = await c.getMessage('m3')
    expect(msg.bodyPlain).toBe('Deep body') // prefers text/plain over deeper HTML
    expect(msg.bodyHtml).toBe('hi')
  })

  it('rejects an empty id', async () => {
    const c = new GmailClient({ ...clientDeps(env) })
    await expect(c.getMessage('')).rejects.toThrow(/id is required/)
  })
})

// ─── getThread ────────────────────────────────────────────────────────────

describe('GmailClient.getThread', () => {
  let env: Awaited<ReturnType<typeof makeClient>>
  beforeEach(async () => {
    env = await makeClient()
  })

  it('returns every message in the thread, parsed', async () => {
    const buildMsg = (id: string, threadId: string) => ({
      id,
      threadId,
      payload: {
        headers: [{ name: 'Subject', value: `subj ${id}` }],
        body: { data: Buffer.from(`body ${id}`, 'utf8').toString('base64url') },
      },
    })
    const { fn } = buildStub([
      {
        url: 'irrelevant',
        responseFactory: () => new Response(
          JSON.stringify({ messages: [buildMsg('a', 'tA'), buildMsg('b', 'tA')] }),
          { status: 200 },
        ),
      },
    ])
    const c = new GmailClient({ ...clientDeps(env), fetchFn: fn })
    const thread = await c.getThread('tA')
    expect(thread).toHaveLength(2)
    expect(thread.map((m) => m.id)).toEqual(['a', 'b'])
    expect(thread.map((m) => m.bodyPlain)).toEqual(['body a', 'body b'])
  })

  it('returns [] for a thread with no messages', async () => {
    const { fn } = buildStub([
      {
        url: 'irrelevant',
        responseFactory: () => new Response(JSON.stringify({}), { status: 200 }),
      },
    ])
    const c = new GmailClient({ ...clientDeps(env), fetchFn: fn })
    const thread = await c.getThread('empty')
    expect(thread).toEqual([])
  })
})

// ─── 401 → refresh → retry ────────────────────────────────────────────────

describe('GmailClient — 401 refresh', () => {
  let env: Awaited<ReturnType<typeof makeClient>>
  beforeEach(async () => {
    env = await makeClient()
  })

  it('refreshes the access token on 401 and retries the original request', async () => {
    const { fn, calls } = buildStub([
      // 1st attempt: returns 401 for the Gmail call.
      {
        url: 'initial gmail call',
        responseFactory: () => new Response('unauthorized', { status: 401 }),
      },
      // 2nd fetch: the token endpoint exchange (URL identifies it).
      {
        url: 'refresh exchange',
        responseFactory: () => new Response(
          JSON.stringify({
            access_token: 'rotated-access',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      },
      // 3rd fetch: retry of the original Gmail call (must use new token).
      {
        url: 'retry gmail call',
        responseFactory: () => new Response(
          JSON.stringify({
            messages: [{ id: 'm', threadId: 't' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      },
    ])
    const c = new GmailClient({ ...clientDeps(env), fetchFn: fn })
    const out = await c.listMessages()
    expect(out.messages).toEqual([{ id: 'm', threadId: 't' }])
    expect(calls).toHaveLength(3)

    // 1st call: original Bearer token.
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: 'Bearer initial-access' })
    // 2nd call: POST to Google's token endpoint.
    expect(calls[1]!.url).toBe('https://oauth2.googleapis.com/token')
    expect(calls[1]!.init?.method).toBe('POST')
    expect(calls[1]!.init?.headers).toMatchObject({ 'content-type': 'application/x-www-form-urlencoded' })
    // Verify the refresh body shape.
    const body = calls[1]!.init?.body
    expect(typeof body).toBe('string')
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('refresh_token=initial-refresh')
    expect(body).toContain('client_id=test-client-id')
    // 3rd call: retry with the rotated token.
    expect(calls[2]!.init?.headers).toMatchObject({ authorization: 'Bearer rotated-access' })
  })

  it('persists the rotated tokens back to storage (encrypted)', async () => {
    const stub = buildStub([
      { url: 'gmail', responseFactory: () => new Response('no', { status: 401 }) },
      {
        url: 'token',
        responseFactory: () => new Response(
          JSON.stringify({
            access_token: 'rotated-access',
            refresh_token: 'rotated-refresh',
            expires_in: 7200,
          }),
          { status: 200 },
        ),
      },
      {
        url: 'gmail-retry',
        responseFactory: () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      },
    ])
    const c = new GmailClient({ ...clientDeps(env), fetchFn: stub.fn })
    await c.listMessages()

    // Re-read the row to confirm the rotated tokens round-trip.
    const rows = env.db.all<{
      access_token_enc: string
      refresh_token_enc: string
      token_expires_at: string | null
    }>('SELECT access_token_enc, refresh_token_enc, token_expires_at FROM email_accounts WHERE id = ?', [
      env.id,
    ])
    expect(rows).toHaveLength(1)
    const decoded = {
      access: env.cipher.decrypt(rows[0]!.access_token_enc),
      refresh: env.cipher.decrypt(rows[0]!.refresh_token_enc),
      expiresAt: rows[0]!.token_expires_at,
    }
    expect(decoded.access).toBe('rotated-access')
    expect(decoded.refresh).toBe('rotated-refresh')
    expect(typeof decoded.expiresAt).toBe('string')
    expect(decoded.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('keeps the existing refresh token when the response omits one', async () => {
    const stub = buildStub([
      { url: 'gmail', responseFactory: () => new Response('no', { status: 401 }) },
      {
        url: 'token',
        responseFactory: () => new Response(
          JSON.stringify({
            access_token: 'rotated-access',
            expires_in: 3600,
            // refresh_token: intentionally absent
          }),
          { status: 200 },
        ),
      },
      {
        url: 'gmail-retry',
        responseFactory: () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      },
    ])
    const c = new GmailClient({ ...clientDeps(env), fetchFn: stub.fn })
    await c.listMessages()

    const db = env.db
    const rows = db.all<{ refresh_token_enc: string }>(
      'SELECT refresh_token_enc FROM email_accounts WHERE id = ?',
      [env.id],
    )
    expect(env.cipher.decrypt(rows[0]!.refresh_token_enc)).toBe('initial-refresh')
  })

  it('throws RefreshFailedError when the refresh endpoint returns 400', async () => {
    const stub = buildStub([
      { url: 'gmail', responseFactory: () => new Response('no', { status: 401 }) },
      {
        url: 'token',
        responseFactory: () => new Response('invalid_grant', { status: 400 }),
      },
    ])
    const c = new GmailClient({ ...clientDeps(env), fetchFn: stub.fn })
    await expect(c.listMessages()).rejects.toBeInstanceOf(RefreshFailedError)
  })

  it('does NOT refresh twice on a second 401 (RefreshFailedError after one attempt)', async () => {
    const stub = buildStub([
      // Attempt 1: 401
      { url: 'gmail', responseFactory: () => new Response('no', { status: 401 }) },
      // Refresh attempt: succeeds
      {
        url: 'token',
        responseFactory: () => new Response(
          JSON.stringify({ access_token: 'rotated', expires_in: 3600 }),
          { status: 200 },
        ),
      },
      // Attempt 2 (retry): still 401 → propagates as GmailApiError
      { url: 'gmail-retry', responseFactory: () => new Response('still not authed', { status: 401 }) },
    ])
    const c = new GmailClient({ ...clientDeps(env), fetchFn: stub.fn })
    await expect(c.listMessages()).rejects.toBeInstanceOf(RefreshFailedError)
  })
})

// ─── 429 → backoff ────────────────────────────────────────────────────────

describe('GmailClient — 429 backoff', () => {
  let env: Awaited<ReturnType<typeof makeClient>>
  beforeEach(async () => {
    env = await makeClient()
  })

  it('retries after a backoff sleep on 429', async () => {
    const sleeps: number[] = []
    const stub = buildStub([
      { url: 'attempt 1', responseFactory: () => new Response('rate-limited', { status: 429 }) },
      {
        url: 'attempt 2',
        responseFactory: () => new Response(JSON.stringify({ messages: [{ id: 'm', threadId: 't' }] }), { status: 200 }),
      },
    ])
    const c = new GmailClient({
      ...clientDeps(env),
      fetchFn: stub.fn,
      sleepFn: async (ms: number) => {
        sleeps.push(ms)
      },
      baseBackoffMs: 50,
    })
    const out = await c.listMessages()
    expect(out.messages).toEqual([{ id: 'm', threadId: 't' }])
    expect(sleeps).toHaveLength(1)
    // Should be in the (0, 250ms) range: base 50 + up to 25% jitter.
    expect(sleeps[0]).toBeGreaterThan(0)
    expect(sleeps[0]).toBeLessThan(250)
  })

  it('honors Retry-After (in seconds) when provided', async () => {
    const sleeps: number[] = []
    const stub = buildStub([
      {
        url: 'attempt 1',
        responseFactory: () => new Response('too many', {
          status: 429,
          headers: { 'retry-after': '3' },
        }),
      },
      {
        url: 'attempt 2',
        responseFactory: () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      },
    ])
    const c = new GmailClient({
      ...clientDeps(env),
      fetchFn: stub.fn,
      sleepFn: async (ms: number) => {
        sleeps.push(ms)
      },
    })
    await c.listMessages()
    expect(sleeps).toHaveLength(1)
    // Retry-After of "3" seconds → 3000ms wait.
    expect(sleeps[0]).toBe(3000)
  })

  it('gives up after maxRetries and throws GmailApiError(429)', async () => {
    const sleeps: number[] = []
    const stub = buildStub([
      // Default maxRetries = 5; that's 1 initial + 5 retries = 6 total
      // attempted fetches. We provide 6 of them.
      { url: 'attempt 1', responseFactory: () => new Response('', { status: 429 }) },
      { url: 'attempt 2', responseFactory: () => new Response('', { status: 429 }) },
      { url: 'attempt 3', responseFactory: () => new Response('', { status: 429 }) },
      { url: 'attempt 4', responseFactory: () => new Response('', { status: 429 }) },
      { url: 'attempt 5', responseFactory: () => new Response('', { status: 429 }) },
      { url: 'attempt 6', responseFactory: () => new Response('', { status: 429 }) },
    ])
    const c = new GmailClient({
      ...clientDeps(env),
      fetchFn: stub.fn,
      sleepFn: async (ms: number) => {
        sleeps.push(ms)
      },
      baseBackoffMs: 1,
      maxRetries: 5,
    })
    await expect(c.listMessages()).rejects.toMatchObject({
      name: 'GmailApiError',
      status: 429,
    })
    // 5 sleeps (one before each retry), no 6th.
    expect(sleeps).toHaveLength(5)
  })

  it('exponential backoff roughly doubles each attempt (within jitter band)', async () => {
    const sleeps: number[] = []
    // 4 retries needed.
    const stub = buildStub([
      { url: 'a', responseFactory: () => new Response('', { status: 429 }) },
      { url: 'b', responseFactory: () => new Response('', { status: 429 }) },
      { url: 'c', responseFactory: () => new Response('', { status: 429 }) },
      { url: 'd', responseFactory: () => new Response('', { status: 429 }) },
      { url: 'e', responseFactory: () => new Response(JSON.stringify({ messages: [] }), { status: 200 }) },
    ])
    const c = new GmailClient({
      ...clientDeps(env),
      fetchFn: stub.fn,
      sleepFn: async (ms: number) => {
        sleeps.push(ms)
      },
      baseBackoffMs: 100,
      maxRetries: 5,
    })
    await c.listMessages()
    expect(sleeps).toHaveLength(4)
    // Check that the sleeps are bounded by the expected exponential bands.
    const expectedBounds = [
      [75, 125], // 100 ± 25%
      [150, 250], // 200 ± 25%
      [300, 500], // 400 ± 25%
      [600, 1000], // 800 ± 25%
    ]
    for (let i = 0; i < expectedBounds.length; i++) {
      const [lo, hi] = expectedBounds[i]!
      expect(sleeps[i]).toBeGreaterThanOrEqual(lo!)
      expect(sleeps[i]).toBeLessThanOrEqual(hi!)
    }
  })
})

// ─── Other non-2xx errors ─────────────────────────────────────────────────

describe('GmailClient — error mapping', () => {
  let env: Awaited<ReturnType<typeof makeClient>>
  beforeEach(async () => {
    env = await makeClient()
  })

  it('throws GmailApiError on 500-class', async () => {
    const stub = buildStub([
      { url: 'gmail', responseFactory: () => new Response('boom', { status: 500 }) },
    ])
    const c = new GmailClient({ ...clientDeps(env), fetchFn: stub.fn })
    let captured: unknown
    try {
      await c.listMessages()
    } catch (err) {
      captured = err
    }
    expect(captured).toBeInstanceOf(GmailApiError)
    expect((captured as GmailApiError).status).toBe(500)
  })

  it('throws GmailApiError on 400 (bad request, not retriable)', async () => {
    const stub = buildStub([
      { url: 'gmail', responseFactory: () => new Response('bad', { status: 400 }) },
    ])
    const c = new GmailClient({ ...clientDeps(env), fetchFn: stub.fn })
    let captured: unknown
    try {
      await c.listMessages()
    } catch (err) {
      captured = err
    }
    expect(captured).toBeInstanceOf(GmailApiError)
    expect((captured as GmailApiError).status).toBe(400)
  })
})
