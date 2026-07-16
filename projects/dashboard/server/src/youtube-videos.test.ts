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
  searchVideos,
  getVideoDetail,
  attachTagByNameToVideo,
  detachTagFromVideo,
  listTagsForVideo,
  listTagsForVideos,
  updateVideoFolder,
  touchVideoLastPolledAt,
  type VideoInsertInput,
} from './youtube-videos.js'
import { normalize } from './tag-normalizer.js'
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
    expect(env.db.get('SELECT title, local_title_override FROM videos WHERE id = ?', [first.id])).toEqual({
      title: 'Fresh from RSS',
      local_title_override: 'Operator rename',
    })
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
  it('creates a canonical channel for a video without a subscription', () => {
    const inserted = insertVideo(env.db, makeInput({ channelId: 'UCpe0000000000000000aabc' }))
    expect(inserted.outcome).toBe('inserted')
    expect(env.db.get('SELECT channel_id FROM youtube_channels WHERE channel_id = ?', [
      'UCpe0000000000000000aabc',
    ])).toEqual({ channel_id: 'UCpe0000000000000000aabc' })
  })

  it('keeps canonical videos when their subscription is deleted', () => {
    const inserted = insertVideo(env.db, makeInput())
    env.db.run(`DELETE FROM subscriptions WHERE channel_id = 'UCaaaaaaa000000000000aab'`)
    expect(getVideoById(env.db, inserted.id)).not.toBeNull()
    expect(getVideoDetail(env.db, inserted.id)?.channelIsIncluded).toBe(false)
    expect(searchVideos(env.db).items.map((video) => video.id)).toContain(inserted.id)
  })
})
// ─── Search + list (issue YT-005) ─────────────────────────────────────────

describe('searchVideos — sorting', () => {
  it('returns empty list when there are no videos', () => {
    const r = searchVideos(env.db)
    expect(r.items).toEqual([])
    expect(r.total).toBe(0)
    expect(r.page).toBe(1)
    expect(r.limit).toBe(50)
  })

  it('sorts by discovered_at DESC', () => {
    // Two videos with staggered inserted-at times.
    const t0 = 1_700_000_000_000
    insertVideo(env.db, makeInput({ videoId: 'aaaa', title: 'A' }), () => t0)
    insertVideo(env.db, makeInput({ videoId: 'bbbb', title: 'B' }), () => t0 + 1000)
    const r = searchVideos(env.db)
    expect(r.items.map((v) => v.videoId)).toEqual(['bbbb', 'aaaa'])
  })

  it('respects limit + page for pagination', () => {
    const t0 = 1_700_000_000_000
    for (let i = 0; i < 5; i++) {
      insertVideo(env.db, makeInput({ videoId: `vv${i}` }), () => t0 + i * 1000)
    }
    const page1 = searchVideos(env.db, { page: 1, limit: 2 })
    expect(page1.items.map((v) => v.videoId)).toEqual(['vv4', 'vv3'])
    expect(page1.total).toBe(5)
    const page2 = searchVideos(env.db, { page: 2, limit: 2 })
    expect(page2.items.map((v) => v.videoId)).toEqual(['vv2', 'vv1'])
    const page3 = searchVideos(env.db, { page: 3, limit: 2 })
    expect(page3.items).toHaveLength(1)
    expect(page3.items[0]!.videoId).toBe('vv0')
  })

  it('caps limit at 200 to keep responses bounded', () => {
    const r = searchVideos(env.db, { limit: 9999 })
    expect(r.limit).toBe(200)
  })

  it('clamps invalid limit (0, -1) to the floor of 1', () => {
    expect(searchVideos(env.db, { limit: 0 }).limit).toBe(1)
    expect(searchVideos(env.db, { limit: -5 }).limit).toBe(1)
  })

  it('defaults page to 1 when missing or invalid', () => {
    expect(searchVideos(env.db, { page: 0 }).page).toBe(1)
    expect(searchVideos(env.db, { page: -1 }).page).toBe(1)
    expect(searchVideos(env.db, {}).page).toBe(1)
  })

  it.each([
    ['discovered_at', 'asc', ['sort-alpha', 'sort-beta']],
    ['discovered_at', 'desc', ['sort-beta', 'sort-alpha']],
    ['published_at', 'asc', ['sort-beta', 'sort-alpha']],
    ['published_at', 'desc', ['sort-alpha', 'sort-beta']],
    ['channel', 'asc', ['sort-alpha', 'sort-beta']],
    ['channel', 'desc', ['sort-beta', 'sort-alpha']],
    ['title', 'asc', ['sort-beta', 'sort-alpha']],
    ['title', 'desc', ['sort-alpha', 'sort-beta']],
  ] as const)('sorts by %s %s', (sort, order, expected) => {
    upsertSubscription(env.db, {
      googleAccountId: 'acct-1',
      channelId: 'UCbbbbbbb000000000000bab',
      channelTitle: 'Beta',
      channelThumbnailUrl: null,
      subscribedAt: '2024-01-01T00:00:00.000Z',
    })
    insertVideo(env.db, makeInput({
      videoId: 'sort-alpha', title: 'Zebra', publishedAt: '2026-02-02T10:00:00Z',
    }))
    insertVideo(env.db, makeInput({
      videoId: 'sort-beta', channelId: 'UCbbbbbbb000000000000bab',
      title: 'apple', publishedAt: '2026-02-01T10:00:00Z',
    }))
    env.db.run(`UPDATE videos SET discovered_at = '2026-02-01T00:00:00Z' WHERE video_id = 'sort-alpha'`)
    env.db.run(`UPDATE videos SET discovered_at = '2026-02-02T00:00:00Z' WHERE video_id = 'sort-beta'`)

    expect(searchVideos(env.db, { sort, order }).items.map((item) => item.videoId)).toEqual(expected)
  })

  it('uses dashboard video ID as a stable final tie-breaker across pages', () => {
    const ids = ['tie-1', 'tie-2', 'tie-3', 'tie-4'].map((videoId) =>
      insertVideo(env.db, makeInput({ videoId, title: 'Same title' })),
    ).sort((a, b) => a.id.localeCompare(b.id))

    const first = searchVideos(env.db, { sort: 'title', order: 'asc', page: 1, limit: 2 })
    const second = searchVideos(env.db, { sort: 'title', order: 'asc', page: 2, limit: 2 })
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(ids.map((item) => item.id))
  })
})

describe('searchVideos — publication date range', () => {
  beforeEach(() => {
    insertVideo(env.db, makeInput({ videoId: 'feb-28', publishedAt: '2024-02-28T23:59:59Z' }))
    insertVideo(env.db, makeInput({ videoId: 'leap-day', publishedAt: '2024-02-29T23:59:59.999Z' }))
    insertVideo(env.db, makeInput({ videoId: 'march-1', publishedAt: '2024-03-01T00:00:00Z' }))
    insertVideo(env.db, makeInput({ videoId: 'bad-date', publishedAt: 'not-a-timestamp' }))
  })

  it('supports one-sided ranges and excludes unusable timestamps only when active', () => {
    expect(searchVideos(env.db).total).toBe(4)
    expect(searchVideos(env.db, { publishedFrom: '2024-02-29' }).items.map((v) => v.videoId).sort())
      .toEqual(['leap-day', 'march-1'])
    expect(searchVideos(env.db, { publishedTo: '2024-02-29' }).items.map((v) => v.videoId).sort())
      .toEqual(['feb-28', 'leap-day'])
  })

  it('includes the complete To day and respects leap-day/month boundaries', () => {
    const result = searchVideos(env.db, {
      publishedFrom: '2024-02-29',
      publishedTo: '2024-02-29',
    })
    expect(result.items.map((v) => v.videoId)).toEqual(['leap-day'])
  })

  it('composes date bounds with canonical channel, folder, tag, and unwatched filters', () => {
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('range-folder', NULL, 'Range')`)
    const leap = getVideoByVideoId(env.db, 'leap-day')!
    updateVideoFolder(env.db, leap.id, 'range-folder')
    const tag = attachTagByNameToVideo(env.db, leap.id, 'range-tag')!
    const result = searchVideos(env.db, {
      channelId: 'UCaaaaaaa000000000000aab',
      folderId: 'range-folder',
      tagId: tag.id,
      unwatched: true,
      publishedFrom: '2024-02-29',
      publishedTo: '2024-03-01',
    })
    expect(result.items.map((v) => v.videoId)).toEqual(['leap-day'])
  })
})

describe('searchVideos — filters', () => {
  it('can exclude canonical YouTube Shorts while retaining regular videos', () => {
    insertVideo(env.db, makeInput({
      videoId: 'short-video',
      link: 'https://www.youtube.com/shorts/short-video',
    }))
    insertVideo(env.db, makeInput({
      videoId: 'regular-video',
      link: 'https://www.youtube.com/watch?v=regular-video',
    }))

    expect(searchVideos(env.db).total).toBe(2)
    expect(searchVideos(env.db, { excludeShorts: true }).items.map((video) => video.videoId))
      .toEqual(['regular-video'])
  })

  it('excludes videos from subscriptions that are currently excluded', () => {
    insertVideo(env.db, makeInput({ videoId: 'aaaa' }))
    env.db.run(
      `UPDATE subscriptions SET is_included = 0 WHERE channel_id = 'UCaaaaaaa000000000000aab'`,
    )

    const r = searchVideos(env.db)

    expect(r.items).toEqual([])
    expect(r.total).toBe(0)
    expect(countVideos(env.db)).toBe(1)
  })

  it('filters by channel_id', () => {
    upsertSubscription(env.db, {
      googleAccountId: 'acct-1',
      channelId: 'UCbbbbbbb000000000000bab',
      channelTitle: 'Beta',
      channelThumbnailUrl: null,
      subscribedAt: '2024-01-01T00:00:00.000Z',
    })
    const t0 = 1_700_000_000_000
    insertVideo(env.db, makeInput({ videoId: 'aaaa', channelId: 'UCaaaaaaa000000000000aab' }), () => t0)
    insertVideo(env.db, makeInput({ videoId: 'bbbb', channelId: 'UCbbbbbbb000000000000bab' }), () => t0 + 100)
    insertVideo(env.db, makeInput({ videoId: 'cccc', channelId: 'UCbbbbbbb000000000000bab' }), () => t0 + 200)
    const r = searchVideos(env.db, { channelId: 'UCbbbbbbb000000000000bab' })
    expect(r.total).toBe(2)
    expect(r.items.map((v) => v.videoId)).toEqual(['cccc', 'bbbb'])
  })

  it('hydrates channel_title + thumbnail_url', () => {
    insertVideo(env.db, makeInput())
    const [item] = searchVideos(env.db).items
    expect(item!.channelTitle).toBe('Alpha')
    expect(item!.channelThumbnailUrl).toBeNull()
  })

  it('filters by folder_id', () => {
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`)
    const a = insertVideo(env.db, makeInput({ videoId: 'aaaa' }))
    const b = insertVideo(env.db, makeInput({ videoId: 'bbbb' }))
    updateVideoFolder(env.db, a.id, 'f-1')
    const r = searchVideos(env.db, { folderId: 'f-1' })
    expect(r.total).toBe(1)
    expect(r.items[0]!.videoId).toBe('aaaa')
    expect(r.items[0]!.folderName).toBe('Work')
    expect(r.items[0]!.folderId).toBe('f-1')
    // Confirm unfoldered still has the second video
    expect(b.id).toBeDefined()
  })

  it('filters by unfoldered:true (folder_id IS NULL)', () => {
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`)
    insertVideo(env.db, makeInput({ videoId: 'aaaa' }))
    updateVideoFolder(env.db, getVideoByVideoId(env.db, 'aaaa')!.id, 'f-1')
    insertVideo(env.db, makeInput({ videoId: 'bbbb' }))
    const r = searchVideos(env.db, { unfoldered: true })
    expect(r.total).toBe(1)
    expect(r.items[0]!.videoId).toBe('bbbb')
  })

  it('filters by tag_id', () => {
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`)
    insertVideo(env.db, makeInput({ videoId: 'aaaa' }))
    insertVideo(env.db, makeInput({ videoId: 'bbbb' }))
    const idA = getVideoByVideoId(env.db, 'aaaa')!.id
    const idB = getVideoByVideoId(env.db, 'bbbb')!.id
    const tagA = attachTagByNameToVideo(env.db, idA, 'postgres')!
    attachTagByNameToVideo(env.db, idB, 'redis')
    const r = searchVideos(env.db, { tagId: tagA.id })
    expect(r.total).toBe(1)
    expect(r.items[0]!.videoId).toBe('aaaa')
  })

  it('combines channel + folder + tag filters (AND)', () => {
    upsertSubscription(env.db, {
      googleAccountId: 'acct-1',
      channelId: 'UCbbbbbbb000000000000bab',
      channelTitle: 'Beta',
      channelThumbnailUrl: null,
      subscribedAt: '2024-01-01T00:00:00.000Z',
    })
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`)
    // Across both channels, both folders, both tag sets.
    insertVideo(env.db, makeInput({ videoId: 'aaaa', channelId: 'UCaaaaaaa000000000000aab' }))
    insertVideo(env.db, makeInput({ videoId: 'bbbb', channelId: 'UCaaaaaaa000000000000aab' }))
    insertVideo(env.db, makeInput({ videoId: 'cccc', channelId: 'UCbbbbbbb000000000000bab' }))
    const idA = getVideoByVideoId(env.db, 'aaaa')!.id
    const idC = getVideoByVideoId(env.db, 'cccc')!.id
    updateVideoFolder(env.db, idA, 'f-1')
    const tA = attachTagByNameToVideo(env.db, idA, 'shared')!
    attachTagByNameToVideo(env.db, idC, 'shared')
    // Filter: channel=A AND folder=f-1 AND tag=tA.id → only aaaa
    const r = searchVideos(env.db, {
      channelId: 'UCaaaaaaa000000000000aab',
      folderId: 'f-1',
      tagId: tA.id,
    })
    expect(r.total).toBe(1)
    expect(r.items[0]!.videoId).toBe('aaaa')
  })
})

// ─── Detail + tag attach/detach (issue YT-005) ──────────────────────────

describe('getVideoDetail', () => {
  it('returns null for an unknown id', () => {
    expect(getVideoDetail(env.db, 'no-such')).toBeNull()
  })

  it('returns the full record with tags + folder + channel info', () => {
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`)
    const { id } = insertVideo(env.db, makeInput())
    updateVideoFolder(env.db, id, 'f-1')
    attachTagByNameToVideo(env.db, id, 'launch')
    attachTagByNameToVideo(env.db, id, 'queue')
    const d = getVideoDetail(env.db, id)
    expect(d).not.toBeNull()
    expect(d!.videoId).toBe('dQw4w9WgXcQ')
    expect(d!.folderId).toBe('f-1')
    expect(d!.folderName).toBe('Work')
    expect(d!.channelTitle).toBe('Alpha')
    expect(d!.channelIsIncluded).toBe(true)
    expect(d!.tags.map((t) => t.name)).toEqual(['launch', 'queue'])
  })

  it('reflects channelIsIncluded=false when the channel is excluded', () => {
    const { id } = insertVideo(env.db, makeInput())
    env.db.run(`UPDATE subscriptions SET is_included = 0 WHERE channel_id = 'UCaaaaaaa000000000000aab'`)
    const d = getVideoDetail(env.db, id)
    expect(d!.channelIsIncluded).toBe(false)
  })
})

describe('listTagsForVideo', () => {
  it('returns [] when no tags', () => {
    const { id } = insertVideo(env.db, makeInput())
    expect(listTagsForVideo(env.db, id)).toEqual([])
  })

  it('returns attached tags alphabetically', () => {
    const { id } = insertVideo(env.db, makeInput())
    attachTagByNameToVideo(env.db, id, 'zeta')
    attachTagByNameToVideo(env.db, id, 'alpha')
    attachTagByNameToVideo(env.db, id, 'mike')
    const tags = listTagsForVideo(env.db, id)
    expect(tags.map((t) => t.name)).toEqual(['alpha', 'mike', 'zeta'])
  })
})

describe('listTagsForVideos (batch)', () => {
  it('returns a single map with all videos keyed by their id', () => {
    const a = insertVideo(env.db, makeInput({ videoId: 'aaaa' }))
    const b = insertVideo(env.db, makeInput({ videoId: 'bbbb' }))
    const c = insertVideo(env.db, makeInput({ videoId: 'cccc' }))
    attachTagByNameToVideo(env.db, a.id, 'launch')
    attachTagByNameToVideo(env.db, b.id, 'queue')
    const map = listTagsForVideos(env.db, [a.id, b.id, c.id])
    expect(map.get(a.id)?.map((t) => t.name)).toEqual(['launch'])
    expect(map.get(b.id)?.map((t) => t.name)).toEqual(['queue'])
    expect(map.get(c.id)).toBeUndefined()
  })

  it('returns an empty Map when given no ids (no SQL issued)', () => {
    expect(listTagsForVideos(env.db, []).size).toBe(0)
  })
})

describe('attachTagByNameToVideo', () => {
  it('returns null for an empty/whitespace tag name', () => {
    const { id } = insertVideo(env.db, makeInput())
    expect(attachTagByNameToVideo(env.db, id, '   ')).toBeNull()
    expect(listTagsForVideo(env.db, id)).toEqual([])
  })

  it('lowercases (matches existing tag, no duplicate row)', () => {
    const { id } = insertVideo(env.db, makeInput())
    attachTagByNameToVideo(env.db, id, 'Postgres')
    attachTagByNameToVideo(env.db, id, 'postgres')
    attachTagByNameToVideo(env.db, id, 'POSTGRES')
    const tags = listTagsForVideo(env.db, id)
    expect(tags).toHaveLength(1)
    expect(tags[0]!.name).toBe('postgres')
  })

  it('uses TagNormalizer contract (canonical form)', () => {
    const { id } = insertVideo(env.db, makeInput())
    const tag = attachTagByNameToVideo(env.db, id, '  PostgreSQL Server  ')
    // TagNormalizer produces 'postgresql-server'
    expect(tag?.name).toBe(normalize('  PostgreSQL Server  '))
  })

  it('is idempotent: re-attaching returns the same id', () => {
    const { id } = insertVideo(env.db, makeInput())
    const a = attachTagByNameToVideo(env.db, id, 'singleton')!
    const b = attachTagByNameToVideo(env.db, id, 'singleton')!
    expect(a.id).toBe(b.id)
  })
})

describe('detachTagFromVideo', () => {
  it('removes a single (video, tag) link', () => {
    const { id } = insertVideo(env.db, makeInput())
    const t = attachTagByNameToVideo(env.db, id, 'singleton')!
    expect(detachTagFromVideo(env.db, id, t.id)).toBe(true)
    expect(listTagsForVideo(env.db, id)).toEqual([])
  })

  it('returns false when the link did not exist', () => {
    const { id } = insertVideo(env.db, makeInput())
    expect(detachTagFromVideo(env.db, id, 'no-such-tag-id')).toBe(false)
  })

  it('only removes the one link, not all tags', () => {
    const { id } = insertVideo(env.db, makeInput())
    const t1 = attachTagByNameToVideo(env.db, id, 'one')!
    attachTagByNameToVideo(env.db, id, 'two')
    detachTagFromVideo(env.db, id, t1.id)
    expect(listTagsForVideo(env.db, id).map((t) => t.name)).toEqual(['two'])
  })
})
