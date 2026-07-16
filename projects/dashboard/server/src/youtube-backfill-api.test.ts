import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
import { auth, type AuthVariables } from './auth.js'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { InMemoryTokenStore } from './token-store.js'
import { createTokenCipher } from './token-encryption.js'
import { YouTubeOAuthClient } from './youtube-oauth.js'
import { upsertSubscription } from './youtube-subscriptions.js'
import { YouTubeSubscriptionBackfillService } from './youtube-subscription-backfill.js'
import { subscriptionsApi } from './youtube-subscriptions-list-api.js'
import { youtubePreferencesApi } from './youtube-preferences-api.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')
const PASSWORD = 'secret'

describe('YT-009 APIs', () => {
  let db: Database
  let app: Hono<{ Variables: AuthVariables }>
  let service: YouTubeSubscriptionBackfillService
  let subscriptionId: string

  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    const cipher = createTokenCipher(Buffer.from('c'.repeat(64), 'hex'))
    const accountId = randomUUID()
    db.run(
      `INSERT INTO youtube_accounts
         (id, provider, google_user_id, email_address, access_token_enc,
          refresh_token_enc, token_expires_at, scopes)
       VALUES (?, 'youtube', 'g', 'd@example.com', ?, ?,
               '2099-01-01T00:00:00.000Z', 'youtube.readonly')`,
      [accountId, cipher.encrypt('access'), cipher.encrypt('refresh')],
    )
    subscriptionId = upsertSubscription(db, {
      googleAccountId: accountId,
      channelId: 'UC1',
      channelTitle: 'Channel',
      channelThumbnailUrl: null,
      subscribedAt: '2026-07-01T00:00:00.000Z',
    }).id
    const oauthClient = new YouTubeOAuthClient({
      db, cipher, oauthClientId: 'id', oauthClientSecret: 'secret',
      redirectUri: 'http://localhost/callback',
    })
    service = new YouTubeSubscriptionBackfillService({
      db,
      cipher,
      oauthClient,
      fetcher: {
        resolveUploadsPlaylistIds: async () => new Map([['UC1', 'UU1']]),
        fetchRecentUploads: async () => ({ videos: [], inspected: 0, skipped: 0 }),
      },
    })
    app = new Hono<{ Variables: AuthVariables }>()
    app.use('*', auth({
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      tokenStore: new InMemoryTokenStore(),
    }))
    app.route('/api/subscriptions', subscriptionsApi({ db, backfillService: service }))
    app.route('/api/youtube/preferences', youtubePreferencesApi({ db }))
  })

  afterEach(() => db.close())

  const headers = (): Record<string, string> => ({
    authorization: `Basic ${Buffer.from(`david:${PASSWORD}`).toString('base64')}`,
    'content-type': 'application/json',
  })

  it('reads and patches the new-subscription default', async () => {
    const initial = await app.request('/api/youtube/preferences', { headers: headers() })
    expect(await initial.json()).toMatchObject({ new_subscription_backfill_days: 30 })
    const patched = await app.request('/api/youtube/preferences', {
      method: 'PATCH', headers: headers(),
      body: JSON.stringify({ new_subscription_backfill_days: 0 }),
    })
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({ new_subscription_backfill_days: 0 })
  })

  it('rejects invalid preference and manual windows', async () => {
    const preference = await app.request('/api/youtube/preferences', {
      method: 'PATCH', headers: headers(),
      body: JSON.stringify({ new_subscription_backfill_days: 14 }),
    })
    expect(preference.status).toBe(400)
    const manual = await app.request(`/api/subscriptions/${subscriptionId}/backfill`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ days: 0 }),
    })
    expect(manual.status).toBe(400)
  })

  it('queues with 202 and exposes terminal state via GET', async () => {
    const queued = await app.request(`/api/subscriptions/${subscriptionId}/backfill`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ days: 30 }),
    })
    expect(queued.status).toBe(202)
    expect(await queued.json()).toMatchObject({
      ok: true,
      backfill: { requested_days: 30 },
    })
    await service.runPending()
    const status = await app.request(`/api/subscriptions/${subscriptionId}/backfill`, {
      headers: headers(),
    })
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({
      backfill: { status: 'completed', imported_count: 0, skipped_count: 0 },
    })
  })
})
