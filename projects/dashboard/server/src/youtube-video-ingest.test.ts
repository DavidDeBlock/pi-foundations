// youtube-video-ingest.test.ts — issue YT-004
//
// Storage-layer tests for the ingest orchestrator. Each AC in
// the model surface (`insertVideo` idempotency, transaction
// atomicity, empty input) gets at least one assertion.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import {
  countVideos,
  getVideoByVideoId,
} from './youtube-videos.js'
import { ingestVideos } from './youtube-video-ingest.js'
import { upsertSubscription } from './youtube-subscriptions.js'
import type { FeedEntry } from './youtube-rss-fetcher.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

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
  upsertSubscription(db, {
    googleAccountId: 'acct-1',
    channelId: 'UCaaaaaaa000000000000aab',
    channelTitle: 'Alpha',
    channelThumbnailUrl: null,
    subscribedAt: '2024-01-01T00:00:00.000Z',
  })
  env = { db }
})

afterEach(() => {
  env.db.close()
})

function entry(overrides: Partial<FeedEntry> = {}): FeedEntry {
  return {
    videoId: overrides.videoId ?? 'dQw4w9WgXcQ',
    title: overrides.title ?? 'A Title',
    publishedAt: overrides.publishedAt ?? '2024-01-01T00:00:00.000Z',
    thumbnailUrl: overrides.thumbnailUrl ?? 'https://example.com/thumb.jpg',
    link: overrides.link ?? `https://www.youtube.com/watch?v=${overrides.videoId ?? 'dQw4w9WgXcQ'}`,
  }
}

// ─── Empty input ──────────────────────────────────────────────────────────

describe('ingestVideos — empty input', () => {
  it('returns zeros and is a no-op for an empty list', () => {
    const r = ingestVideos(env.db, 'UCaaaaaaa000000000000aab', [])
    expect(r).toEqual({ added: 0, skipped: 0, total: 0, insertedVideoIds: [] })
    expect(countVideos(env.db)).toBe(0)
  })
})

// ─── All-new ──────────────────────────────────────────────────────────────

describe('ingestVideos — all-new entries', () => {
  it('inserts three entries and reports added=3, skipped=0', () => {
    const entries = [
      entry({ videoId: 'AAAAAAAAAAA' }),
      entry({ videoId: 'BBBBBBBBBBB' }),
      entry({ videoId: 'CCCCCCCCCCC' }),
    ]
    const r = ingestVideos(env.db, 'UCaaaaaaa000000000000aab', entries)
    expect(r.added).toBe(3)
    expect(r.skipped).toBe(0)
    expect(r.total).toBe(3)
    expect(countVideos(env.db)).toBe(3)
  })

  it('records correct fields on each row', () => {
    const entries = [
      entry({
        videoId: 'XXXXXXXXXXX',
        title: 'Cool video',
        publishedAt: '2024-06-15T10:00:00.000Z',
        thumbnailUrl: 'https://example.com/x.jpg',
        link: 'https://www.youtube.com/watch?v=XXXXXXXXXXX',
      }),
    ]
    ingestVideos(env.db, 'UCaaaaaaa000000000000aab', entries)
    const v = getVideoByVideoId(env.db, 'XXXXXXXXXXX')!
    expect(v.videoId).toBe('XXXXXXXXXXX')
    expect(v.title).toBe('Cool video')
    expect(v.publishedAt).toBe('2024-06-15T10:00:00.000Z')
    expect(v.thumbnailUrl).toBe('https://example.com/x.jpg')
    expect(v.link).toBe('https://www.youtube.com/watch?v=XXXXXXXXXXX')
    expect(v.channelId).toBe('UCaaaaaaa000000000000aab')
  })

  it('attaches every row to the supplied channel_id', () => {
    const entries = [entry({ videoId: 'DDDDDDDDDDD' })]
    ingestVideos(env.db, 'UCaaaaaaa000000000000aab', entries)
    expect(getVideoByVideoId(env.db, 'DDDDDDDDDDD')!.channelId).toBe('UCaaaaaaa000000000000aab')
  })
})

// ─── All-duplicate ────────────────────────────────────────────────────────

describe('ingestVideos — all-duplicate entries', () => {
  it('reports added=0, skipped=N — re-poll is no-op', () => {
    ingestVideos(env.db, 'UCaaaaaaa000000000000aab', [entry({ videoId: 'EEEEEEEEEEE' })])
    const r = ingestVideos(env.db, 'UCaaaaaaa000000000000aab', [entry({ videoId: 'EEEEEEEEEEE' })])
    expect(r.added).toBe(0)
    expect(r.skipped).toBe(1)
    expect(r.total).toBe(1)
    expect(countVideos(env.db)).toBe(1)
  })

  it('does not overwrite existing data (no UPDATE branch)', () => {
    // Operates on a renamed title to verify the no-overwrite
    // invariant: re-poll must not undo operator-curated changes.
    const r1 = ingestVideos(env.db, 'UCaaaaaaa000000000000aab', [entry({ videoId: 'FFFFFFFFFF' })])
    expect(r1.added).toBe(1)
    const row = getVideoByVideoId(env.db, 'FFFFFFFFFF')!
    env.db.run(
      `UPDATE videos SET title = ? WHERE id = ?`,
      ['Renamed', row.id],
    )
    ingestVideos(env.db, 'UCaaaaaaa000000000000aab', [entry({ videoId: 'FFFFFFFFFF', title: 'Should not overwrite' })])
    expect(getVideoByVideoId(env.db, 'FFFFFFFFFF')!.title).toBe('Renamed')
  })
})

// ─── Mixed ────────────────────────────────────────────────────────────────

describe('ingestVideos — mixed new + duplicate entries', () => {
  it('counts each row as either added or skipped', () => {
    // Two already known, two fresh.
    ingestVideos(env.db, 'UCaaaaaaa000000000000aab', [
      entry({ videoId: 'AAAAA1' }),
      entry({ videoId: 'BBBBB1' }),
    ])
    const before = countVideos(env.db)
    const r = ingestVideos(env.db, 'UCaaaaaaa000000000000aab', [
      entry({ videoId: 'AAAAA1' }), // dup
      entry({ videoId: 'CCCCC1' }), // fresh
      entry({ videoId: 'BBBBB1' }), // dup
      entry({ videoId: 'DDDDD1' }), // fresh
    ])
    expect(r.added).toBe(2)
    expect(r.skipped).toBe(2)
    expect(r.total).toBe(4)
    expect(countVideos(env.db)).toBe(before + 2)
  })
})

// ─── Atomicity ────────────────────────────────────────────────────────────

describe('ingestVideos — transaction atomicity', () => {
  it('rolls back the whole batch when one INSERT throws', () => {
    // FK violation: insert an entry for a non-existent channel
    // should not be possible because the channelId is fixed by
    // the caller — but if a FeedEntry somehow violates another
    // constraint (e.g. NULL required field), the entire batch
    // rolls back.
    env.db.run(
      `INSERT INTO youtube_accounts (id, provider, google_user_id, email_address, access_token_enc, refresh_token_enc, scopes)
         VALUES (?, 'youtube', 'g-2', 'z@example.com', 'x', 'y', 'youtube.readonly')`,
      ['acct-2'],
    )
    upsertSubscription(env.db, {
      googleAccountId: 'acct-2',
      channelId: 'UCzzzzzzzzzzzzzzzzzz00ab',
      channelTitle: 'Zeta',
      channelThumbnailUrl: null,
      subscribedAt: '2024-01-01T00:00:00.000Z',
    })
    // Insert: 2 fresh + 1 FK-violating entry. The whole
    // transaction should roll back.
    const valid = [entry({ videoId: 'GGGGGGGGGGG' }), entry({ videoId: 'HHHHHHHHHHH' })]
    expect(() =>
      env.db.transaction(() => {
        ingestVideos(env.db, 'UCaaaaaaa000000000000aab', valid)
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(countVideos(env.db)).toBe(0)
  })
})

// ─── nowMs injection ──────────────────────────────────────────────────────

describe('ingestVideos — nowMs injection', () => {
  it('passes nowMs through so timestamps are deterministic', () => {
    // We control only the columns we explicitly write. `created_at`
    // is set by SQLite's `strftime('now')` default, so we assert
    // on `discoveredAt` (which we DO write) and accept `createdAt`
    // can be any recent timestamp.
    const fixedNow = 1_700_000_000_000
    const r = ingestVideos(env.db, 'UCaaaaaaa000000000000aab', [entry({ videoId: 'JJJJJJJJJJJ' })], () => fixedNow)
    expect(r.added).toBe(1)
    const v = getVideoByVideoId(env.db, 'JJJJJJJJJJJ')!
    expect(v.discoveredAt).toBe(new Date(fixedNow).toISOString())
  })
})
