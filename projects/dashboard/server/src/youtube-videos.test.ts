// youtube-videos.test.ts — issue YT-004
//
// Storage-layer tests for the `videos` table. Each AC in the model
// surface (`insertVideo`, `getVideoById`, `getVideoByVideoId`,
// `countVideos`, `listVideoIdsForChannel`,
// `updateVideoFolder`, `renameVideoTitle`,
// `touchVideoLastPolledAt`) gets at least one assertion.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import {
  countVideos,
  getVideoById,
  getVideoByVideoId,
  insertVideo,
  listVideoIdsForChannel,
  renameVideoTitle,
  touchVideoLastPolledAt,
  updateVideoFolder,
  type VideoInsertInput,
} from './youtube-videos.js'
import {
  upsertSubscription,
} from './youtube-subscriptions.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

interface TestEnv {
  db: Database
}

let env: TestEnv

beforeEach(async () => {
  const db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  // Seed one YouTube account + one channel; FKs require it.
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

function makeInput(overrides: Partial<VideoInsertInput> = {}): VideoInsertInput {
  // We don't use `??` for thumbnailUrl because overrides might
  // intentionally pass `null` to exercise the "no thumb" path.
  // Explicit ternary is fine here.
  return {
    videoId: overrides.videoId ?? 'dQw4w9WgXcQ',
    channelId: overrides.channelId ?? 'UCaaaaaaa000000000000aab',
    title: overrides.title ?? 'Never Gonna Give You Up',
    publishedAt: overrides.publishedAt ?? '2009-10-25T06:57:33.000Z',
    thumbnailUrl:
      overrides.thumbnailUrl !== undefined
        ? overrides.thumbnailUrl
        : 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    link: overrides.link ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  }
}

// ─── Reads ────────────────────────────────────────────────────────────────

describe('getVideoById', () => {
  it('returns null for an unknown id', () => {
    expect(getVideoById(env.db, 'no-such-id')).toBeNull()
  })

  it('returns the row when found', () => {
    insertVideo(env.db, makeInput())
    const found = getVideoByVideoId(env.db, 'dQw4w9WgXcQ')
    expect(found).not.toBeNull()
    const back = getVideoById(env.db, found!.id)
    expect(back).not.toBeNull()
    expect(back!.videoId).toBe('dQw4w9WgXcQ')
    expect(back!.title).toBe('Never Gonna Give You Up')
    expect(back!.folderId).toBeNull()
  })
})

describe('getVideoByVideoId', () => {
  it('returns null for an unknown videoId', () => {
    expect(getVideoByVideoId(env.db, 'no-such')).toBeNull()
  })

  it('returns the row when found', () => {
    insertVideo(env.db, makeInput())
    const v = getVideoByVideoId(env.db, 'dQw4w9WgXcQ')
    expect(v?.videoId).toBe('dQw4w9WgXcQ')
  })
})

describe('countVideos', () => {
  it('returns 0 when empty', () => {
    expect(countVideos(env.db)).toBe(0)
  })

  it('counts every row across channels', () => {
    insertVideo(env.db, makeInput({ videoId: 'aaaa' }))
    insertVideo(env.db, makeInput({ videoId: 'bbbb' }))
    insertVideo(env.db, makeInput({ videoId: 'cccc' }))
    expect(countVideos(env.db)).toBe(3)
  })
})

describe('listVideoIdsForChannel', () => {
  it('returns an empty array when the channel has no videos', () => {
    expect(listVideoIdsForChannel(env.db, 'UCaaaaaaa000000000000aab')).toEqual([])
  })

  it('returns only that channel\'s video_ids', () => {
    // Add another subscription + one of its videos.
    upsertSubscription(env.db, {
      googleAccountId: 'acct-1',
      channelId: 'UCbbbbbbb000000000000bab',
      channelTitle: 'Beta',
      channelThumbnailUrl: null,
      subscribedAt: '2024-01-01T00:00:00.000Z',
    })
    insertVideo(env.db, makeInput({ videoId: 'aaaa', channelId: 'UCaaaaaaa000000000000aab' }))
    insertVideo(env.db, makeInput({ videoId: 'bbbb', channelId: 'UCaaaaaaa000000000000aab' }))
    insertVideo(env.db, makeInput({ videoId: 'cccc', channelId: 'UCbbbbbbb000000000000bab' }))
    expect(listVideoIdsForChannel(env.db, 'UCaaaaaaa000000000000aab').sort()).toEqual(['aaaa', 'bbbb'])
    expect(listVideoIdsForChannel(env.db, 'UCbbbbbbb000000000000bab')).toEqual(['cccc'])
  })
})

// ─── Writes ───────────────────────────────────────────────────────────────

describe('insertVideo', () => {
  it('inserts a fresh row', () => {
    const { outcome, id } = insertVideo(env.db, makeInput())
    expect(outcome).toBe('inserted')
    const v = getVideoById(env.db, id)
    expect(v).not.toBeNull()
    expect(v!.videoId).toBe('dQw4w9WgXcQ')
  })

  it('marks a duplicate videoId as "duplicate" and does not overwrite', () => {
    insertVideo(env.db, makeInput())
    // Operator renames the title — YT-005 will use this path.
    const first = getVideoByVideoId(env.db, 'dQw4w9WgXcQ')!
    renameVideoTitle(env.db, first.id, 'Operator rename')
    expect(getVideoByVideoId(env.db, 'dQw4w9WgXcQ')!.title).toBe('Operator rename')
    // Re-insert the same videoId with a different title → no overwrite.
    const second = insertVideo(env.db, makeInput({ title: 'Fresh from RSS' }))
    expect(second.outcome).toBe('duplicate')
    expect(getVideoByVideoId(env.db, 'dQw4w9WgXcQ')!.title).toBe('Operator rename')
  })

  it('returns the existing row\'s id on duplicate', () => {
    const { id: idA } = insertVideo(env.db, makeInput())
    const { id: idB } = insertVideo(env.db, makeInput())
    expect(idA).toBe(idB) // same row — id is stable
  })

  it('records discovered_at from injected nowMs', () => {
    const nowFixed = 1_700_000_000_000
    insertVideo(env.db, makeInput(), () => nowFixed)
    const v = getVideoByVideoId(env.db, 'dQw4w9WgXcQ')!
    expect(v.discoveredAt).toBe(new Date(nowFixed).toISOString())
  })

  it('allows thumbnail_url to be null', () => {
    // Use a fresh videoId so the INSERT OR IGNORE doesn't return
    // a previously-inserted row that had a non-null thumbnail.
    insertVideo(env.db, makeInput({ videoId: 'fresh-no-thumb', thumbnailUrl: null }))
    expect(getVideoByVideoId(env.db, 'fresh-no-thumb')!.thumbnailUrl).toBeNull()
  })
})

describe('updateVideoFolder', () => {
  it('sets folder_id to the given value', () => {
    env.db.run(
      `INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`,
    )
    const { id } = insertVideo(env.db, makeInput())
    expect(updateVideoFolder(env.db, id, 'f-1')).toBe(true)
    expect(getVideoById(env.db, id)!.folderId).toBe('f-1')
  })

  it('unfolds when passed null', () => {
    env.db.run(
      `INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`,
    )
    const { id } = insertVideo(env.db, makeInput())
    updateVideoFolder(env.db, id, 'f-1')
    updateVideoFolder(env.db, id, null)
    expect(getVideoById(env.db, id)!.folderId).toBeNull()
  })

  it('returns false for an unknown id', () => {
    expect(updateVideoFolder(env.db, 'no-such', 'f-1')).toBe(false)
  })

  it('SET NULL on folder delete — videos stay but unfoldered', () => {
    // This is enforced at the DB level by migration 010's
    // ON DELETE SET NULL clause on the videos.folder_id FK.
    env.db.run(
      `INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`,
    )
    const { id } = insertVideo(env.db, makeInput())
    updateVideoFolder(env.db, id, 'f-1')
    env.db.run(`DELETE FROM folders WHERE id = 'f-1'`)
    expect(getVideoById(env.db, id)!.folderId).toBeNull()
  })
})

describe('renameVideoTitle', () => {
  it('renames the title', () => {
    const { id } = insertVideo(env.db, makeInput())
    renameVideoTitle(env.db, id, 'My favorite')
    expect(getVideoById(env.db, id)!.title).toBe('My favorite')
  })

  it('returns false for an unknown id', () => {
    expect(renameVideoTitle(env.db, 'no-such', 'Whatever')).toBe(false)
  })

  it('a re-inserted RSS entry does NOT overwrite a renamed title', () => {
    // The poller relies on this — operators can rename, and the
    // next poll must not undo their work.
    const { id } = insertVideo(env.db, makeInput())
    renameVideoTitle(env.db, id, 'Renamed by operator')
    insertVideo(env.db, makeInput({ title: 'New title from RSS' }))
    expect(getVideoById(env.db, id)!.title).toBe('Renamed by operator')
  })
})

describe('touchVideoLastPolledAt', () => {
  // Note: this writes to `subscriptions.last_polled_at`, not
  // videos. The naming mirrors the existing helper pattern
  // (touchSubscriptionLastPolledAt in YT-002).

  it('records the timestamp on the channel row', () => {
    const now = 1_700_000_000_000
    touchVideoLastPolledAt(env.db, 'UCaaaaaaa000000000000aab', () => now)
    const row = env.db.get<{ last_polled_at: string }>(
      `SELECT last_polled_at FROM subscriptions WHERE channel_id = 'UCaaaaaaa000000000000aab'`,
    )
    expect(row?.last_polled_at).toBe(new Date(now).toISOString())
  })

  it('writes updated_at in the same atomic tick', () => {
    const before = Date.now()
    touchVideoLastPolledAt(env.db, 'UCaaaaaaa000000000000aab', () => Date.now())
    const row = env.db.get<{ updated_at: string }>(
      `SELECT updated_at FROM subscriptions WHERE channel_id = 'UCaaaaaaa000000000000aab'`,
    )
    const ts = new Date(row!.updated_at).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
  })

  it('also touches when called on an unknown channel — UPDATE is a no-op', () => {
    // No exception, no row created. Defensive only.
    expect(() =>
      touchVideoLastPolledAt(env.db, 'UCpe0000000000000000aabc'),
    ).not.toThrow()
  })
})

// ─── FK enforcement ───────────────────────────────────────────────────────

describe('FK enforcement', () => {
  it('refuses to insert a video for an unknown channel', () => {
    // SQLite enforces FK at INSERT time when foreign_keys=ON (set
    // in the Database wrapper). Migration 010's ON DELETE
    // RESTRICT also blocks deleting subscriptions that have
    // videos — tested below.
    expect(() =>
      insertVideo(env.db, makeInput({ channelId: 'UCpe0000000000000000aabc' })),
    ).toThrow(/FOREIGN KEY constraint failed/)
  })

  it('refuses to delete a subscription that still has videos', () => {
    // ON DELETE RESTRICT — the AC explicitly wants this for
    // operator-curated data preservation.
    insertVideo(env.db, makeInput())
    expect(() =>
      env.db.run(`DELETE FROM subscriptions WHERE channel_id = 'UCaaaaaaa000000000000aab'`),
    ).toThrow(/FOREIGN KEY constraint failed/)
  })
})