// youtube-subscriptions-sync.test.ts — issue YT-002
//
// Integration tests for the sync orchestrator. We exercise the
// full pipeline against an in-memory DB with a mocked fetcher
// and a fake clock — the only thing not mocked is the SQL layer
// and the diff logic, which is exactly what we want to verify.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { resolve } from 'node:path'
import { createTokenCipher } from './token-encryption.js'
import { YouTubeOAuthClient } from './youtube-oauth.js'
import {
  countSubscriptions,
  getSubscriptionByChannelId,
  listSubscriptions,
} from './youtube-subscriptions.js'
import {
  NoYouTubeAccountError,
  YouTubeSubscriptionsSync,
  type SubscriptionsSyncResult,
} from './youtube-subscriptions-sync.js'
import type { YouTubeSubscriptionsFetcher } from './youtube-subscriptions-fetcher.js'
import type { Subscription } from './youtube-subscriptions.js'
import { randomUUID } from 'node:crypto'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

interface TestEnv {
  db: Database
  cipher: ReturnType<typeof createTokenCipher>
  oauthClient: YouTubeOAuthClient
  fetcher: YouTubeSubscriptionsFetcher
  sync: YouTubeSubscriptionsSync
  fixedNow: number
  nowMs: () => number
}

let env: TestEnv

beforeEach(async () => {
  const db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  const cipher = createTokenCipher(Buffer.from('a'.repeat(64), 'hex'))
  const oauthClient = new YouTubeOAuthClient({
    db,
    cipher,
    oauthClientId: 'client',
    oauthClientSecret: 'secret',
    redirectUri: 'http://localhost/cb',
  })
  const fixedNow = 1_700_000_000_000
  const nowMs = (): number => fixedNow
  // We construct a real fetcher and override its #fetchFn by
  // wrapping it. Easier: build a test fetcher subclass that
  // returns canned data.
  const fetcher = makeFakeFetcher([])
  const sync = new YouTubeSubscriptionsSync({
    db,
    cipher,
    oauthClient,
    fetcher,
    nowMs,
  })
  env = { db, cipher, oauthClient, fetcher, sync, fixedNow, nowMs }
})

afterEach(() => {
  env.db.close()
})

/** Build a fetcher that returns the queue of incoming arrays in
 *  order, one per call. After the queue is exhausted, fetcher
 *  returns an empty array — useful for "first sync populates,
 *  second sync is a no-op" tests. */
function makeFakeFetcher(
  responses: ReadonlyArray<ReadonlyArray<Subscription>>,
): YouTubeSubscriptionsFetcher {
  const fake = {
    fetchAll: vi.fn(),
  } as unknown as YouTubeSubscriptionsFetcher
  let i = 0
  ;(fake as unknown as { fetchAll: (t: string) => Promise<readonly Subscription[]> }).fetchAll =
    async (_t: string) => {
      const r = responses[i] ?? []
      i++
      return r
    }
  return fake
}

/** Build a Subscription fixture with sensible defaults. */
function sub(
  channelId: string,
  overrides: Partial<Subscription> = {},
): Subscription {
  return {
    id: '',
    googleAccountId: '',
    channelId,
    channelTitle: `Channel ${channelId}`,
    channelThumbnailUrl: `https://example.com/${channelId}.jpg`,
    subscribedAt: '2024-01-01T00:00:00.000Z',
    isIncluded: true,
    isImportant: false,
    lastPolledAt: null,
    createdAt: '',
    updatedAt: '',
    ...overrides,
    autoFetchTranscripts: overrides.autoFetchTranscripts ?? false,
  }
}

/** Seed an OAuth-connected account with a long-lived access token.
 *  Returns the account id. */
function seedAccount(): string {
  const id = randomUUID()
  env.db.run(
    `INSERT INTO youtube_accounts
       (id, provider, google_user_id, email_address,
        access_token_enc, refresh_token_enc, token_expires_at, scopes)
     VALUES (?, 'youtube', 'g-1', 'd@example.com',
             ?, ?, ?, 'youtube.readonly openid userinfo.email')`,
    [
      id,
      env.cipher.encrypt('access-1'),
      env.cipher.encrypt('refresh-1'),
      // Far-future expiry so refreshIfNeeded is a no-op.
      '2099-01-01T00:00:00.000Z',
    ],
  )
  return id
}

// ─── Error cases ─────────────────────────────────────────────────────────

describe('YouTubeSubscriptionsSync.sync — error cases', () => {
  it('throws NoYouTubeAccountError when no account is connected', async () => {
    await expect(env.sync.sync()).rejects.toThrow(NoYouTubeAccountError)
  })

  it('throws when the given googleAccountId is unknown', async () => {
    await expect(env.sync.sync(randomUUID())).rejects.toThrow(
      NoYouTubeAccountError,
    )
  })
})

// ─── Happy paths ─────────────────────────────────────────────────────────

describe('YouTubeSubscriptionsSync.sync — happy paths', () => {
  it('inserts every channel on a fresh DB (added === total)', async () => {
    const accountId = seedAccount()
    env.fetcher = makeFakeFetcher([
      [sub('UCa', { channelTitle: 'Alpha' }), sub('UCb', { channelTitle: 'Beta' })],
    ])
    env.sync = new YouTubeSubscriptionsSync({
      db: env.db,
      cipher: env.cipher,
      oauthClient: env.oauthClient,
      fetcher: env.fetcher,
      nowMs: env.nowMs,
    })

    const result: SubscriptionsSyncResult = await env.sync.sync(accountId)
    expect(result).toEqual({
      added: 2,
      updated: 0,
      removed: 0,
      unchanged: 0,
      total: 2,
      ranAt: new Date(env.fixedNow).toISOString(),
    })
    expect(countSubscriptions(env.db)).toBe(2)
  })

  it('is a no-op on a re-run with unchanged Google state (idempotent)', async () => {
    const accountId = seedAccount()
    env.fetcher = makeFakeFetcher([
      [sub('UCa'), sub('UCb'), sub('UCc')],
      [sub('UCa'), sub('UCb'), sub('UCc')], // second call: identical
    ])
    env.sync = new YouTubeSubscriptionsSync({
      db: env.db,
      cipher: env.cipher,
      oauthClient: env.oauthClient,
      fetcher: env.fetcher,
      nowMs: env.nowMs,
    })

    const first = await env.sync.sync(accountId)
    expect(first.added).toBe(3)

    const second = await env.sync.sync(accountId)
    expect(second.added).toBe(0)
    expect(second.updated).toBe(0)
    expect(second.unchanged).toBe(3)
    expect(second.total).toBe(3)
    expect(countSubscriptions(env.db)).toBe(3)
  })

  it('detects added channels (new on YouTube)', async () => {
    const accountId = seedAccount()
    env.fetcher = makeFakeFetcher([
      [sub('UCa'), sub('UCb')],
      [sub('UCa'), sub('UCb'), sub('UCc')], // UCc is new
    ])
    env.sync = new YouTubeSubscriptionsSync({
      db: env.db,
      cipher: env.cipher,
      oauthClient: env.oauthClient,
      fetcher: env.fetcher,
      nowMs: env.nowMs,
    })
    await env.sync.sync(accountId)
    const second = await env.sync.sync(accountId)
    expect(second.added).toBe(1)
    expect(second.unchanged).toBe(2)
    expect(countSubscriptions(env.db)).toBe(3)
  })

  it('detects removed channels (unsubscribed on YouTube)', async () => {
    const accountId = seedAccount()
    env.fetcher = makeFakeFetcher([
      [sub('UCa'), sub('UCb'), sub('UCc')],
      [sub('UCa')], // UCb, UCc gone
    ])
    env.sync = new YouTubeSubscriptionsSync({
      db: env.db,
      cipher: env.cipher,
      oauthClient: env.oauthClient,
      fetcher: env.fetcher,
      nowMs: env.nowMs,
    })
    await env.sync.sync(accountId)
    const second = await env.sync.sync(accountId)
    expect(second.removed).toBe(2)
    expect(second.unchanged).toBe(1)
    expect(countSubscriptions(env.db)).toBe(1)
    expect(getSubscriptionByChannelId(env.db, 'UCa')).not.toBeNull()
  })

  it('detects updated channels (title changed on YouTube)', async () => {
    const accountId = seedAccount()
    env.fetcher = makeFakeFetcher([
      [sub('UCa', { channelTitle: 'Old Title' })],
      [sub('UCa', { channelTitle: 'New Title' })],
    ])
    env.sync = new YouTubeSubscriptionsSync({
      db: env.db,
      cipher: env.cipher,
      oauthClient: env.oauthClient,
      fetcher: env.fetcher,
      nowMs: env.nowMs,
    })
    await env.sync.sync(accountId)
    const second = await env.sync.sync(accountId)
    expect(second.updated).toBe(1)
    expect(second.added).toBe(0)
    expect(second.unchanged).toBe(0)
    expect(getSubscriptionByChannelId(env.db, 'UCa')?.channelTitle).toBe(
      'New Title',
    )
  })

  it('handles a mixed scenario: added + updated + removed in one sync', async () => {
    const accountId = seedAccount()
    env.fetcher = makeFakeFetcher([
      [sub('UCkeep'), sub('UCrename', { channelTitle: 'Old' }), sub('UCdrop')],
    ])
    env.sync = new YouTubeSubscriptionsSync({
      db: env.db,
      cipher: env.cipher,
      oauthClient: env.oauthClient,
      fetcher: env.fetcher,
      nowMs: env.nowMs,
    })
    const first = await env.sync.sync(accountId)
    expect(first.added).toBe(3)

    // Second run: UCkeep stays, UCrename gets a new title, UCdrop
    // is gone, UCnew is fresh.
    env.fetcher = makeFakeFetcher([
      [sub('UCkeep'), sub('UCrename', { channelTitle: 'New' }), sub('UCnew')],
    ])
    env.sync = new YouTubeSubscriptionsSync({
      db: env.db,
      cipher: env.cipher,
      oauthClient: env.oauthClient,
      fetcher: env.fetcher,
      nowMs: env.nowMs,
    })
    const second = await env.sync.sync(accountId)
    expect(second.added).toBe(1)
    expect(second.updated).toBe(1)
    expect(second.unchanged).toBe(1)
    expect(second.removed).toBe(1)

    const rows = listSubscriptions(env.db).map((s) => s.channelId).sort()
    expect(rows).toEqual(['UCkeep', 'UCnew', 'UCrename'])
  })

  it('handles a fully-empty incoming list (user unsubscribed from everything)', async () => {
    const accountId = seedAccount()
    env.fetcher = makeFakeFetcher([[sub('UCa'), sub('UCb')]])
    env.sync = new YouTubeSubscriptionsSync({
      db: env.db,
      cipher: env.cipher,
      oauthClient: env.oauthClient,
      fetcher: env.fetcher,
      nowMs: env.nowMs,
    })
    await env.sync.sync(accountId)
    expect(countSubscriptions(env.db)).toBe(2)

    env.fetcher = makeFakeFetcher([[]])
    env.sync = new YouTubeSubscriptionsSync({
      db: env.db,
      cipher: env.cipher,
      oauthClient: env.oauthClient,
      fetcher: env.fetcher,
      nowMs: env.nowMs,
    })
    const result = await env.sync.sync(accountId)
    expect(result.removed).toBe(2)
    expect(countSubscriptions(env.db)).toBe(0)
  })

  it('handles a brand-new account whose first sync returns zero rows', async () => {
    const accountId = seedAccount()
    env.fetcher = makeFakeFetcher([[]])
    env.sync = new YouTubeSubscriptionsSync({
      db: env.db,
      cipher: env.cipher,
      oauthClient: env.oauthClient,
      fetcher: env.fetcher,
      nowMs: env.nowMs,
    })
    const result = await env.sync.sync(accountId)
    expect(result).toEqual({
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      total: 0,
      ranAt: new Date(env.fixedNow).toISOString(),
    })
    expect(countSubscriptions(env.db)).toBe(0)
  })

  it('does NOT touch user toggles (is_included / is_important) during sync', async () => {
    const accountId = seedAccount()
    // First sync inserts UCa.
    env.fetcher = makeFakeFetcher([[sub('UCa')]])
    env.sync = new YouTubeSubscriptionsSync({
      db: env.db,
      cipher: env.cipher,
      oauthClient: env.oauthClient,
      fetcher: env.fetcher,
      nowMs: env.nowMs,
    })
    await env.sync.sync(accountId)
    // User toggles off included.
    env.db.run(
      `UPDATE subscriptions SET is_included = 0, is_important = 1 WHERE channel_id = 'UCa'`,
    )
    // Second sync — re-fetches UCa with same title. Should be 'unchanged'.
    env.fetcher = makeFakeFetcher([[sub('UCa')]])
    env.sync = new YouTubeSubscriptionsSync({
      db: env.db,
      cipher: env.cipher,
      oauthClient: env.oauthClient,
      fetcher: env.fetcher,
      nowMs: env.nowMs,
    })
    const second = await env.sync.sync(accountId)
    expect(second.added).toBe(0)
    expect(second.updated).toBe(0)
    expect(second.unchanged).toBe(1)
    // Toggles survived.
    const row = getSubscriptionByChannelId(env.db, 'UCa')
    expect(row?.isIncluded).toBe(false)
    expect(row?.isImportant).toBe(true)
  })
})

// ─── Default account resolution ─────────────────────────────────────────

describe('YouTubeSubscriptionsSync.sync — default account resolution', () => {
  it('targets the most-recently-connected account when no id is given', async () => {
    // Two accounts — the second one is more recent and should win.
    env.db.run(
      `INSERT INTO youtube_accounts
         (id, provider, google_user_id, email_address,
          access_token_enc, refresh_token_enc, scopes, connected_at)
       VALUES (?, 'youtube', 'g-1', 'old@example.com', 'x', 'y', 's', '2024-01-01T00:00:00.000Z')`,
      ['acct-old'],
    )
    const newId = seedAccount() // most recent by default (strftime NOW)
    env.fetcher = makeFakeFetcher([[sub('UCa')]])
    env.sync = new YouTubeSubscriptionsSync({
      db: env.db,
      cipher: env.cipher,
      oauthClient: env.oauthClient,
      fetcher: env.fetcher,
      nowMs: env.nowMs,
    })
    const result = await env.sync.sync()
    expect(result.added).toBe(1)
    // The new account owns the inserted row, not the old one.
    const row = getSubscriptionByChannelId(env.db, 'UCa')
    expect(row?.googleAccountId).toBe(newId)
  })
})
