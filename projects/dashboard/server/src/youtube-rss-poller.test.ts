// youtube-rss-poller.test.ts — issue YT-004
//
// Orchestrator tests. Each AC in the poller's surface gets at
// least one assertion:
//   * Lists `is_included=1` subscriptions only (is_included=0
//     is filtered out).
//   * Per-channel failure isolation: one bad channel doesn't
//     kill the loop.
//   * Concurrency cap respected (we count in-flight fetches).
//   * `last_polled_at` updated on both success and failure paths.
//   * Counts returned.
//   * Empty input throws `NoIncludedSubscriptionsError`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import {
  NoIncludedSubscriptionsError,
  YouTubeRssPoller,
} from './youtube-rss-poller.js'
import { YouTubeRssFeedFetcher, type Fetcher } from './youtube-rss-fetcher.js'
import {
  upsertSubscription,
} from './youtube-subscriptions.js'
import { getVideoByVideoId } from './youtube-videos.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

// ─── Test fixture: 24-char UC-prefixed channel IDs ────────────────────────
// The RssFeedFetcher validates channel_id format (UC + 22 chars,
// exactly 24 total). These constants are used everywhere these
// tests need a YouTube channel; using one consistent set across
// the file keeps the "looks up feed by channelId" logic working.
const CH_A = 'UCaaaaaaaaaaaaaaaaaaaaaa'
const CH_B = 'UCbbbbbbbbbbbbbbbbbbbbbb'
const CH_C = 'UCcccccccccccccccccccccc'
const CH_D = 'UCdddddddddddddddddddddd'
const CH_E = 'UCeeeeeeeeeeeeeeeeeeeeee'
const CH_F = 'UCffffffffffffffffffffff'
const CH_X = 'UCxxxxxxxxxxxxxxxxxxxxxx'
const CH_Y = 'UCyyyyyyyyyyyyyyyyyyyyyy'

interface TestEnv {
  db: Database
}

let env: TestEnv

beforeEach(async () => {
  const db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  db.run(
    `INSERT INTO youtube_accounts
       (id, provider, google_user_id, email_address,
        access_token_enc, refresh_token_enc, scopes)
     VALUES (?, 'youtube', 'g-1', 'd@example.com', 'x', 'y', 'youtube.readonly')`,
    ['acct-1'],
  )
  env = { db }
})

afterEach(() => {
  env.db.close()
})

function seedChannel(channelId: string, included: boolean): void {
  upsertSubscription(env.db, {
    googleAccountId: 'acct-1',
    channelId,
    channelTitle: channelId,
    channelThumbnailUrl: null,
    subscribedAt: '2024-01-01T00:00:00.000Z',
  })
  if (!included) {
    env.db.run(
      `UPDATE subscriptions SET is_included = 0 WHERE channel_id = ?`,
      [channelId],
    )
  }
}

/** Build a stubbed fetcher with a per-channel feed body map.
 *  Channels not in the map throw a 404-shaped `RssFeedFetchError`. */
function makeFetcher(
  feeds: Record<string, string>,
): {
  fetcher: YouTubeRssFeedFetcher
  calls: Record<string, number>
  inflight: { current: number; max: number }
} {
  const calls: Record<string, number> = {}
  const inflight = { current: 0, max: 0 }
  const httpFetcher: Fetcher = async (url, _init) => {
    const u = new URL(url)
    const channelId = u.searchParams.get('channel_id') ?? ''
    calls[channelId] = (calls[channelId] ?? 0) + 1
    inflight.current++
    if (inflight.current > inflight.max) inflight.max = inflight.current
    await new Promise((r) => setTimeout(r, 1))
    inflight.current--
    const body = feeds[channelId]
    if (!body) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => 'not found',
      } as unknown as Response
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => body,
    } as unknown as Response
  }
  return {
    fetcher: new YouTubeRssFeedFetcher({ fetcher: httpFetcher }),
    calls,
    inflight,
  }
}

const FEED_TWO = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <entry>
    <videoId>AAAAAAAAAAA</videoId>
    <title>One</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=AAAAAAAAAAA"/>
    <published>2024-01-01T00:00:00.000Z</published>
  </entry>
  <entry>
    <videoId>BBBBBBBBBBB</videoId>
    <title>Two</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=BBBBBBBBBBB"/>
    <published>2024-01-02T00:00:00.000Z</published>
  </entry>
</feed>`

const FEED_EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<feed></feed>`

/**
 * Build a feed with two entries whose videoIds are prefixed by
 * the channel id. Used by tests that need distinct videos across
 * multiple channels (so the same video isn't counted twice as a
 * duplicate from two different feeds).
 *
 * The prefix must be ≤ 1 char to leave room for exactly 11-char
 * videoIds (the looksLikeVideoId regex requires length 11). The
 * test that calls this uses a 1-char prefix per channel.
 */
function feedTwoFor(prefix: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <entry>
    <videoId>${prefix}AAAAAAAAAA</videoId>
    <title>One</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=${prefix}AAAAAAAAAA"/>
    <published>2024-01-01T00:00:00.000Z</published>
  </entry>
  <entry>
    <videoId>${prefix}BBBBBBBBBB</videoId>
    <title>Two</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=${prefix}BBBBBBBBBB"/>
    <published>2024-01-02T00:00:00.000Z</published>
  </entry>
</feed>`
}

// ─── Empty input ──────────────────────────────────────────────────────────

describe('pollAll — empty input', () => {
  it('throws NoIncludedSubscriptionsError when no channels are included', async () => {
    seedChannel(CH_A, false) // is_included = 0
    const poller = new YouTubeRssPoller({ db: env.db })
    await expect(poller.pollAll()).rejects.toThrow(
      NoIncludedSubscriptionsError,
    )
  })

  it('throws when there are zero subscriptions entirely', async () => {
    const poller = new YouTubeRssPoller({ db: env.db })
    await expect(poller.pollAll()).rejects.toThrow(
      NoIncludedSubscriptionsError,
    )
  })
})

// ─── Happy path ───────────────────────────────────────────────────────────

describe('pollAll — happy path', () => {
  it('polls only the included channels', async () => {
    seedChannel(CH_A, true)
    seedChannel(CH_B, false)
    seedChannel(CH_C, true)
    const { fetcher } = makeFetcher({
      [CH_A]: FEED_TWO,
      [CH_C]: FEED_EMPTY,
    })
    const poller = new YouTubeRssPoller({ db: env.db, fetcher })
    const r = await poller.pollAll()
    expect(r.totalChannels).toBe(2)
    expect(r.succeeded).toBe(2)
    expect(r.failed).toBe(0)
    expect(r.added).toBe(2) // two entries on CH_A, none on CH_C
  })

  it('ingests the new entries', async () => {
    seedChannel(CH_A, true)
    const { fetcher } = makeFetcher({ [CH_A]: FEED_TWO })
    const poller = new YouTubeRssPoller({ db: env.db, fetcher })
    await poller.pollAll()
    expect(getVideoByVideoId(env.db, 'AAAAAAAAAAA')?.videoId).toBe('AAAAAAAAAAA')
    expect(getVideoByVideoId(env.db, 'BBBBBBBBBBB')?.videoId).toBe('BBBBBBBBBBB')
  })

  it('marks duplicates as skipped on re-poll', async () => {
    seedChannel(CH_A, true)
    const { fetcher } = makeFetcher({ [CH_A]: FEED_TWO })
    const poller = new YouTubeRssPoller({ db: env.db, fetcher })
    const first = await poller.pollAll()
    const second = await poller.pollAll()
    expect(first.added).toBe(2)
    expect(second.added).toBe(0)
    expect(second.skipped).toBe(2)
  })

  it('returns per-channel results in the channels array', async () => {
    seedChannel(CH_A, true)
    seedChannel(CH_B, true)
    const { fetcher } = makeFetcher({
      [CH_A]: FEED_TWO,
      [CH_B]: FEED_EMPTY,
    })
    const poller = new YouTubeRssPoller({ db: env.db, fetcher })
    const r = await poller.pollAll()
    expect(r.channels).toHaveLength(2)
    const ids = r.channels.map((c) => c.channelId).sort()
    expect(ids).toEqual([CH_A, CH_B].sort())
  })
})

// ─── Per-channel failure isolation ────────────────────────────────────────

describe('pollAll — per-channel failure isolation', () => {
  it("one channel's 404 does not kill the loop", async () => {
    seedChannel(CH_D, true) // bad: not in makeFetcher's feeds map → 404
    seedChannel(CH_E, true) // good
    const { fetcher } = makeFetcher({
      [CH_E]: FEED_TWO,
    })
    const poller = new YouTubeRssPoller({ db: env.db, fetcher })
    const r = await poller.pollAll()
    expect(r.succeeded).toBe(1)
    expect(r.failed).toBe(1)
    const failed = r.channels.find((c) => c.channelId === CH_D)!
    expect(failed.status).toBe('error')
    expect(failed.error).toMatch(/HTTP 404/)
    const good = r.channels.find((c) => c.channelId === CH_E)!
    expect(good.status).toBe('ok')
    expect(good.added).toBe(2)
  })

  it('records last_polled_at on FAILED channels too', async () => {
    seedChannel(CH_D, true)
    seedChannel(CH_E, true)
    const { fetcher } = makeFetcher({ [CH_E]: FEED_TWO })
    const poller = new YouTubeRssPoller({ db: env.db, fetcher })
    await poller.pollAll()
    for (const cid of [CH_D, CH_E]) {
      const row = env.db.get<{ last_polled_at: string }>(
        'SELECT last_polled_at FROM subscriptions WHERE channel_id = ?',
        [cid],
      )
      expect(row?.last_polled_at).not.toBeNull()
    }
  })

  it('records last_polled_at on OK channels', async () => {
    seedChannel(CH_E, true)
    const { fetcher } = makeFetcher({ [CH_E]: FEED_TWO })
    const poller = new YouTubeRssPoller({ db: env.db, fetcher })
    await poller.pollAll()
    const row = env.db.get<{ last_polled_at: string }>(
      'SELECT last_polled_at FROM subscriptions WHERE channel_id = ?',
      [CH_E],
    )
    expect(row?.last_polled_at).not.toBeNull()
  })

  it('reports the count summary correctly when one channel fails', async () => {
    seedChannel(CH_D, true)
    seedChannel(CH_E, true)
    seedChannel(CH_F, true)
    // Use distinct videoIds per channel (prefixed with the
    // channelId) so the second channel's inserts aren't
    // counted as duplicates against the first.
    const { fetcher } = makeFetcher({
      [CH_E]: feedTwoFor('E'),
      [CH_F]: feedTwoFor('F'),
    })
    const poller = new YouTubeRssPoller({ db: env.db, fetcher })
    const r = await poller.pollAll()
    expect(r.succeeded).toBe(2)
    expect(r.failed).toBe(1)
    expect(r.added).toBe(4) // 2 from each good channel
    expect(r.totalChannels).toBe(3)
  })

  it('keeps the loop going when a malformed feed follows a good one', async () => {
    const FEED_BAD = '<<<<not valid xml>>>>'
    seedChannel(CH_A, true)
    seedChannel(CH_B, true)
    const { fetcher } = makeFetcher({
      [CH_A]: FEED_TWO,
      [CH_B]: FEED_BAD,
    })
    const poller = new YouTubeRssPoller({ db: env.db, fetcher })
    const r = await poller.pollAll()
    expect(r.succeeded).toBe(1)
    expect(r.failed).toBe(1)
    expect(r.added).toBe(2)
  })
})

// ─── Concurrency cap ──────────────────────────────────────────────────────

describe('pollAll — concurrency cap', () => {
  it('does not exceed the configured concurrency', async () => {
    // Seed 10 channels, cap at 3, observe peak in-flight ≤ 3.
    const ids = [CH_A, CH_B, CH_C, CH_D, CH_E, CH_F, CH_X, CH_Y,
      // Two extras constructed inline:
      'UChhhhhhhhhhhhhhhhhhhhh',
      'UCiiiiiiiiiiiiiiiiiiiiii',
    ]
    ids.forEach((c) => seedChannel(c, true))
    const feeds: Record<string, string> = {}
    ids.forEach((c) => (feeds[c] = FEED_TWO))
    const { fetcher, inflight } = makeFetcher(feeds)
    const poller = new YouTubeRssPoller({
      db: env.db,
      fetcher,
      concurrency: 3,
    })
    await poller.pollAll()
    expect(inflight.max).toBeLessThanOrEqual(3)
  })

  it('cap=1 runs strictly sequentially', async () => {
    seedChannel(CH_A, true)
    seedChannel(CH_B, true)
    seedChannel(CH_C, true)
    const { fetcher, inflight } = makeFetcher({
      [CH_A]: FEED_TWO,
      [CH_B]: FEED_TWO,
      [CH_C]: FEED_TWO,
    })
    const poller = new YouTubeRssPoller({
      db: env.db,
      fetcher,
      concurrency: 1,
    })
    await poller.pollAll()
    expect(inflight.max).toBe(1)
  })
})

// ─── Timing ───────────────────────────────────────────────────────────────

describe('pollAll — ranAt timestamp', () => {
  it('reflects nowMs (deterministic for tests)', async () => {
    seedChannel(CH_A, true)
    const fixed = 1_700_000_000_000
    const { fetcher } = makeFetcher({ [CH_A]: FEED_TWO })
    const poller = new YouTubeRssPoller({
      db: env.db,
      fetcher,
      nowMs: () => fixed,
    })
    const r = await poller.pollAll()
    expect(r.ranAt).toBe(new Date(fixed).toISOString())
  })
})

// ─── Unexpected runtime errors ────────────────────────────────────────────

describe('pollAll — unexpected runtime errors', () => {
  it("a programming-style error from a fetcher surfaces as 'error' in the channels array", async () => {
    seedChannel(CH_A, true)
    // A non-RssFeedFetchError thrown from the underlying fetcher
    // must be caught and reported as a per-channel error, NOT
    // bubble up and break the loop.
    const fetcher = new YouTubeRssFeedFetcher({
      fetcher: async () => {
        throw new Error('disk full')
      },
    })
    const poller = new YouTubeRssPoller({ db: env.db, fetcher })
    const r = await poller.pollAll()
    expect(r.failed).toBe(1)
    expect(r.channels[0]!.status).toBe('error')
    // The error message is wrapped by the fetcher's catch block
    // (e.g. "YouTube RSS request failed for channel_id=...: disk
    // full"). Assert the underlying cause is preserved.
    expect(r.channels[0]!.error).toContain('disk full')
  })
})

// ─── Mock verification ────────────────────────────────────────────────────

describe('pollAll — fetcher invocation', () => {
  it('only calls the fetcher once per channel per poll', async () => {
    seedChannel(CH_A, true)
    const stub = makeFetcher({ [CH_A]: FEED_TWO })
    const poller = new YouTubeRssPoller({ db: env.db, fetcher: stub.fetcher })
    await poller.pollAll()
    expect(stub.calls[CH_A]).toBe(1)
  })

  // vi import kept for lint suppression; the suite uses vi for
  // mock helpers elsewhere and we want this file to share the
  // vitest runtime without dead-arg warnings.
  it.skip('vi is available', () => {
    expect(vi).toBeDefined()
  })
})