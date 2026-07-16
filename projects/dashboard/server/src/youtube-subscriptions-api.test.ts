// youtube-subscriptions-api.test.ts — issue YT-002
//
// API boundary tests for `POST /api/youtube/sync`. Two scopes:
//   1. Auth — unauthenticated calls get 401 (the global auth
//      middleware gates everything).
//   2. Behaviour — no account → 404, with account → 200 + counts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { resolve } from 'node:path'
import { createTokenCipher } from './token-encryption.js'
import { YouTubeOAuthClient } from './youtube-oauth.js'
import {
  YouTubeSubscriptionsSync,
  type SubscriptionsSyncResult,
} from './youtube-subscriptions-sync.js'
import { youtubeSyncApi } from './youtube-subscriptions-api.js'
import { auth, type AuthVariables } from './auth.js'
import { randomUUID } from 'node:crypto'
import { InMemoryTokenStore } from './token-store.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

const PASSWORD = 'secret'
let passwordHash = ''

let db: Database
let cipher: ReturnType<typeof createTokenCipher>
let oauthClient: YouTubeOAuthClient
let sync: YouTubeSubscriptionsSync
let app: Hono<{ Variables: AuthVariables }>

beforeEach(async () => {
  db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  cipher = createTokenCipher(Buffer.from('b'.repeat(64), 'hex'))
  oauthClient = new YouTubeOAuthClient({
    db,
    cipher,
    oauthClientId: 'cid',
    oauthClientSecret: 'csec',
    redirectUri: 'http://localhost/cb',
  })
  passwordHash = await hashPassword(PASSWORD)

  // InMemoryTokenStore covers the bearer-token path; these tests
  // only authenticate via Basic so the store stays empty.
  const tokenStore = new InMemoryTokenStore()

  sync = new YouTubeSubscriptionsSync({ db, cipher, oauthClient })
  app = new Hono<{ Variables: AuthVariables }>()
  app.use('*', auth({ passwordHash, tokenStore }))
  app.route('/api/youtube', youtubeSyncApi({ sync }))
})

afterEach(() => {
  db.close()
})

async function hashPassword(p: string): Promise<string> {
  // Auth middleware uses bcryptjs for password verification
  // (see auth.ts). We mirror that here so the test's `Basic`
  // header compares cleanly against this hash.
  const bcrypt = (await import('bcryptjs')).default
  return bcrypt.hash(p, 4)
}

function basicHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

describe('POST /api/youtube/sync', () => {
  it('returns 401 unauthenticated', async () => {
    const res = await app.request('/api/youtube/sync', {
      method: 'POST',
    })
    expect(res.status).toBe(401)
  })

  it('returns 404 with {ok:false,error:"no_account"} when no account is connected', async () => {
    const res = await app.request('/api/youtube/sync', {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body).toEqual({ ok: false, error: 'no_account' })
  })

  it('returns 200 with count summary when an account is connected', async () => {
    // Seed an account so sync() doesn't throw NoYouTubeAccountError.
    const id = randomUUID()
    db.run(
      `INSERT INTO youtube_accounts
         (id, provider, google_user_id, email_address,
          access_token_enc, refresh_token_enc, token_expires_at, scopes)
       VALUES (?, 'youtube', 'g-1', 'd@example.com',
               ?, ?, '2099-01-01T00:00:00.000Z', 'youtube.readonly')`,
      [id, cipher.encrypt('a'), cipher.encrypt('r')],
    )

    // Spy on the underlying orchestrator's sync method so we don't
    // have to fake the OAuth client + fetcher together.
    const spy = vi
      .spyOn(sync, 'sync')
      .mockResolvedValueOnce({
        added: 5,
        updated: 1,
        removed: 2,
        unchanged: 10,
        total: 18,
        ranAt: '2026-01-01T00:00:00.000Z',
      } satisfies SubscriptionsSyncResult)

    const res = await app.request('/api/youtube/sync', {
      method: 'POST',
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as SubscriptionsSyncResult
    expect(body.added).toBe(5)
    expect(body.updated).toBe(1)
    expect(body.removed).toBe(2)
    expect(body.unchanged).toBe(10)
    expect(body.total).toBe(18)
    expect(body.ranAt).toBe('2026-01-01T00:00:00.000Z')
    expect(spy).toHaveBeenCalledTimes(1)
  })
})