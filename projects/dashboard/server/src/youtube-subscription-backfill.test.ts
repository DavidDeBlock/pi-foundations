import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { createTokenCipher } from './token-encryption.js'
import { YouTubeOAuthClient } from './youtube-oauth.js'
import { upsertSubscription, updateSubscriptionToggles } from './youtube-subscriptions.js'
import {
  getSubscriptionBackfillState,
  YouTubeSubscriptionBackfillService,
  type BackfillFetcher,
} from './youtube-subscription-backfill.js'
import { updateYouTubePreferences } from './youtube-preferences.js'
import { YouTubeApiError } from './youtube-backfill-fetcher.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')
const NOW = Date.parse('2026-07-16T12:00:00.000Z')

describe('YouTubeSubscriptionBackfillService', () => {
  let db: Database
  let cipher: ReturnType<typeof createTokenCipher>
  let accountId: string
  let oauthClient: YouTubeOAuthClient

  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    cipher = createTokenCipher(Buffer.from('b'.repeat(64), 'hex'))
    accountId = randomUUID()
    db.run(
      `INSERT INTO youtube_accounts
         (id, provider, google_user_id, email_address, access_token_enc,
          refresh_token_enc, token_expires_at, scopes)
       VALUES (?, 'youtube', 'g', 'd@example.com', ?, ?,
               '2099-01-01T00:00:00.000Z', 'youtube.readonly')`,
      [accountId, cipher.encrypt('access'), cipher.encrypt('refresh')],
    )
    oauthClient = new YouTubeOAuthClient({
      db,
      cipher,
      oauthClientId: 'client',
      oauthClientSecret: 'secret',
      redirectUri: 'http://localhost/callback',
      nowMs: () => NOW,
    })
  })

  afterEach(() => db.close())

  function seedSubscription(channelId = 'UC1', included = true): string {
    const result = upsertSubscription(db, {
      googleAccountId: accountId,
      channelId,
      channelTitle: `Channel ${channelId}`,
      channelThumbnailUrl: null,
      subscribedAt: '2026-07-01T00:00:00.000Z',
    }, () => NOW)
    if (!included) updateSubscriptionToggles(db, result.id, { isIncluded: false })
    return result.id
  }

  function fetcher(overrides: Partial<BackfillFetcher> = {}): BackfillFetcher {
    return {
      resolveUploadsPlaylistIds: async (_token, ids) =>
        new Map(ids.map((id) => [id, `UU-${id}`])),
      fetchRecentUploads: async (_token, playlistId) => ({
        inspected: 1,
        skipped: 0,
        videos: [{
          videoId: `video-${playlistId}`,
          channelId: playlistId.replace('UU-', ''),
          channelTitle: 'Channel',
          title: 'Recent video',
          publishedAt: '2026-07-15T00:00:00.000Z',
          thumbnailUrl: null,
          link: `https://youtube.com/watch?v=video-${playlistId}`,
        }],
      }),
      ...overrides,
    }
  }

  function service(customFetcher = fetcher()): YouTubeSubscriptionBackfillService {
    return new YouTubeSubscriptionBackfillService({
      db,
      cipher,
      oauthClient,
      fetcher: customFetcher,
      nowMs: () => NOW,
    })
  }

  it('imports through the canonical upsert and is repeat-safe', async () => {
    const subscriptionId = seedSubscription()
    const worker = service()
    expect(worker.queueManual(subscriptionId, 30)?.status).toBe('pending')
    // A duplicate request while active returns the same job.
    expect(worker.queueManual(subscriptionId, 90)?.requestedDays).toBe(30)
    await worker.runPending()

    expect(getSubscriptionBackfillState(db, subscriptionId)).toMatchObject({
      status: 'completed', importedCount: 1, skippedCount: 0,
    })
    expect(db.get('SELECT origin_type, source_id FROM video_origins')).toEqual({
      origin_type: 'subscription_backfill', source_id: subscriptionId,
    })
    expect(db.get('SELECT * FROM video_transcripts')).toBeUndefined()
    expect(db.get('SELECT * FROM video_summaries')).toBeUndefined()

    worker.queueManual(subscriptionId, 30)
    await worker.runPending()
    expect(getSubscriptionBackfillState(db, subscriptionId)).toMatchObject({
      status: 'completed', importedCount: 0, skippedCount: 1,
    })
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM videos')?.count).toBe(1)
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM video_origins')?.count).toBe(1)
  })

  it('queues the configured default only for newly discovered included channels', async () => {
    const included = seedSubscription('UC-included')
    const excluded = seedSubscription('UC-excluded', false)
    updateYouTubePreferences(db, accountId, 7, () => NOW)
    const customFetcher = fetcher()
    const resolveSpy = vi.spyOn(customFetcher, 'resolveUploadsPlaylistIds')
    const worker = service(customFetcher)
    worker.queueAutomatic([included, excluded])
    await worker.runPending()
    expect(resolveSpy).toHaveBeenCalledWith('access', ['UC-included'])
    expect(getSubscriptionBackfillState(db, included)?.requestedDays).toBe(7)
    expect(getSubscriptionBackfillState(db, excluded)?.status).toBeNull()
  })

  it('isolates one channel failure and records quota failures as retryable', async () => {
    const good = seedSubscription('UC-good')
    const bad = seedSubscription('UC-bad')
    const worker = service(fetcher({
      fetchRecentUploads: async (_token, playlistId) => {
        if (playlistId === 'UU-UC-bad') throw new YouTubeApiError('playlistItems.list', 429)
        return fetcher().fetchRecentUploads(_token, playlistId, '')
      },
    }))
    worker.queueManual(good, 30)
    worker.queueManual(bad, 30)
    await worker.runPending()
    expect(getSubscriptionBackfillState(db, good)?.status).toBe('completed')
    expect(getSubscriptionBackfillState(db, bad)).toMatchObject({
      status: 'failed', retryable: true,
      error: 'YouTube API request failed (HTTP 429). Try again later.',
    })
  })

  it('recovers running jobs after restart', async () => {
    const id = seedSubscription()
    db.run(
      `UPDATE subscriptions SET backfill_status = 'running',
       last_backfill_days = 30, backfill_requested_at = ? WHERE id = ?`,
      [new Date(NOW).toISOString(), id],
    )
    const worker = service()
    worker.resumePending()
    await worker.runPending()
    expect(getSubscriptionBackfillState(db, id)?.status).toBe('completed')
  })
})
