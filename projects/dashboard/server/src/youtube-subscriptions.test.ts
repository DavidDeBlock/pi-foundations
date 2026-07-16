// youtube-subscriptions.test.ts — issue YT-002
//
// Unit tests for the model layer. Covers the round-trip from a
// `Subscription` payload through `upsertSubscription` to the
// DB row + the inverse read, plus the global remove pass and
// the user-toggles update path.
//
// Tests don't exercise HTTP or the YouTube Data API — those are
// the fetcher's and sync orchestrator's concern respectively.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  countSubscriptions,
  deleteSubscriptionsNotInChannelIds,
  getSubscriptionByChannelId,
  getSubscriptionById,
  listSubscriptions,
  touchSubscriptionLastPolledAt,
  updateSubscriptionToggles,
  upsertSubscription,
  type UpsertSubscriptionInput,
} from './youtube-subscriptions.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

let db: Database

/** Seed a bare `youtube_accounts` row so the FK on `subscriptions.google_account_id`
 *  is satisfied. We don't need real encrypted tokens for the model-layer tests
 *  — the FK only cares that the row exists. The cipher round-trip is
 *  exercised in youtube-accounts.test.ts. */
function seedAccount(id: string, email = `${id}@example.com`): void {
  db.run(
    `INSERT INTO youtube_accounts
       (id, provider, google_user_id, email_address,
        access_token_enc, refresh_token_enc, scopes)
     VALUES (?, 'youtube', ?, ?, 'x', 'y', 'youtube.readonly')`,
    [id, `google-${id}`, email],
  )
}

beforeEach(async () => {
  db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  seedAccount('acct-1')
})

afterEach(() => {
  db.close()
})

/** Build an UpsertSubscriptionInput with sensible defaults; override
 *  fields per test. */
function makeInput(overrides: Partial<UpsertSubscriptionInput> = {}): UpsertSubscriptionInput {
  return {
    googleAccountId: 'acct-1',
    channelId: 'UCabc',
    channelTitle: 'Some Channel',
    channelThumbnailUrl: 'https://example.com/thumb.jpg',
    subscribedAt: '2024-01-15T10:00:00.000Z',
    ...overrides,
  }
}

// ─── list / get / count ──────────────────────────────────────────────────

describe('listSubscriptions / getSubscriptionById / countSubscriptions', () => {
  it('returns an empty array on a fresh DB', () => {
    expect(listSubscriptions(db)).toEqual([])
    expect(countSubscriptions(db)).toBe(0)
  })

  it('returns inserted rows in title-sorted order', () => {
    upsertSubscription(db, makeInput({ channelId: 'UC1', channelTitle: 'Zeta' }))
    upsertSubscription(db, makeInput({ channelId: 'UC2', channelTitle: 'alpha' }))
    upsertSubscription(db, makeInput({ channelId: 'UC3', channelTitle: 'Mu' }))

    const titles = listSubscriptions(db).map((s) => s.channelTitle)
    // Case-insensitive sort: alpha, Mu, Zeta
    expect(titles).toEqual(['alpha', 'Mu', 'Zeta'])
  })

  it('filters by googleAccountId when provided', () => {
    seedAccount('acct-2')
    upsertSubscription(db, makeInput({ googleAccountId: 'acct-1', channelId: 'UC1' }))
    upsertSubscription(db, makeInput({ googleAccountId: 'acct-2', channelId: 'UC2' }))

    expect(listSubscriptions(db, 'acct-1')).toHaveLength(1)
    expect(listSubscriptions(db, 'acct-2')).toHaveLength(1)
    expect(listSubscriptions(db, 'unknown')).toHaveLength(0)
  })

  it('getSubscriptionById returns null when missing', () => {
    expect(getSubscriptionById(db, 'nope')).toBeNull()
  })

  it('getSubscriptionByChannelId returns null when missing', () => {
    expect(getSubscriptionByChannelId(db, 'UCmissing')).toBeNull()
  })

  it('round-trips nullable thumbnail', () => {
    upsertSubscription(
      db,
      makeInput({ channelThumbnailUrl: null, channelId: 'UCnull' }),
    )
    const row = getSubscriptionByChannelId(db, 'UCnull')
    expect(row?.channelThumbnailUrl).toBeNull()
  })
})

// ─── upsertSubscription ──────────────────────────────────────────────────

describe('upsertSubscription', () => {
  it('inserts a new row with the documented defaults', () => {
    const { outcome, id } = upsertSubscription(db, makeInput({ channelId: 'UCnew' }))
    expect(outcome).toBe('inserted')
    expect(typeof id).toBe('string')

    const row = getSubscriptionById(db, id)
    expect(row).not.toBeNull()
    expect(row?.isIncluded).toBe(true)  // default per YT-002 AC
    expect(row?.isImportant).toBe(false) // default per YT-002 AC
    expect(row?.lastPolledAt).toBeNull() // RSS poller's column; sync doesn't write
    expect(row?.channelTitle).toBe('Some Channel')
  })

  it('returns unchanged when nothing about a row changed', () => {
    const first = upsertSubscription(db, makeInput({ channelId: 'UCsame' }))
    expect(first.outcome).toBe('inserted')
    const second = upsertSubscription(db, makeInput({ channelId: 'UCsame' }))
    expect(second.outcome).toBe('unchanged')
    expect(second.id).toBe(first.id) // same row, same id
  })

  it('returns updated when title changes', () => {
    const first = upsertSubscription(db, makeInput({ channelId: 'UCrename' }))
    const second = upsertSubscription(
      db,
      makeInput({ channelId: 'UCrename', channelTitle: 'New Title' }),
    )
    expect(second.outcome).toBe('updated')
    expect(second.id).toBe(first.id)
    expect(getSubscriptionById(db, first.id)?.channelTitle).toBe('New Title')
  })

  it('returns updated when thumbnail URL changes', () => {
    upsertSubscription(db, makeInput({ channelId: 'UCt', channelThumbnailUrl: 'a' }))
    const second = upsertSubscription(
      db,
      makeInput({ channelId: 'UCt', channelThumbnailUrl: 'b' }),
    )
    expect(second.outcome).toBe('updated')
  })

  it('returns updated when subscribed_at changes', () => {
    upsertSubscription(db, makeInput({ channelId: 'UCs', subscribedAt: '2024-01-01T00:00:00.000Z' }))
    const second = upsertSubscription(
      db,
      makeInput({ channelId: 'UCs', subscribedAt: '2024-02-01T00:00:00.000Z' }),
    )
    expect(second.outcome).toBe('updated')
  })

  it('does NOT overwrite user toggles (is_included / is_important) on a re-upsert', () => {
    // Insert then toggle off, then re-upsert with the SAME incoming
    // data. The toggles must survive — the sync orchestrator's
    // job is to mirror Google, not to clobber dashboard-side edits.
    const { id } = upsertSubscription(db, makeInput({ channelId: 'UCprotect' }))
    expect(updateSubscriptionToggles(db, id, { isIncluded: false, isImportant: true })).toBe(true)
    const afterToggle = getSubscriptionById(db, id)
    expect(afterToggle?.isIncluded).toBe(false)
    expect(afterToggle?.isImportant).toBe(true)

    // Re-upsert with unchanged incoming — outcome "unchanged", but
    // even on "updated" we should NOT clobber the toggles.
    const re = upsertSubscription(db, makeInput({ channelId: 'UCprotect' }))
    expect(re.outcome).toBe('unchanged')
    const afterRe = getSubscriptionById(db, id)
    expect(afterRe?.isIncluded).toBe(false)
    expect(afterRe?.isImportant).toBe(true)
  })

  it('does NOT overwrite last_polled_at on a re-upsert', () => {
    const { id } = upsertSubscription(db, makeInput({ channelId: 'UCpoll' }))
    touchSubscriptionLastPolledAt(db, id, '2024-03-01T12:00:00.000Z')
    expect(getSubscriptionById(db, id)?.lastPolledAt).toBe('2024-03-01T12:00:00.000Z')

    // Force an "updated" path by changing the title.
    upsertSubscription(db, makeInput({ channelId: 'UCpoll', channelTitle: 'Renamed' }))
    expect(getSubscriptionById(db, id)?.lastPolledAt).toBe('2024-03-01T12:00:00.000Z')
  })

  it('uses the injected clock for updated_at', () => {
    const fixedNow = () => 1_700_000_000_000 // fixed ms
    upsertSubscription(db, makeInput({ channelId: 'UCclock' }), fixedNow)
    const row = getSubscriptionByChannelId(db, 'UCclock')
    expect(row?.updatedAt).toBe(new Date(fixedNow()).toISOString())
  })
})

// ─── deleteSubscriptionsNotInChannelIds ──────────────────────────────────

describe('deleteSubscriptionsNotInChannelIds', () => {
  it('removes rows whose channel_id is NOT in the keep set', () => {
    seedAccount('acct-2')
    upsertSubscription(db, makeInput({ googleAccountId: 'acct-1', channelId: 'UCkeep1' }))
    upsertSubscription(db, makeInput({ googleAccountId: 'acct-1', channelId: 'UCkeep2' }))
    upsertSubscription(db, makeInput({ googleAccountId: 'acct-1', channelId: 'UCdrop1' }))
    upsertSubscription(db, makeInput({ googleAccountId: 'acct-1', channelId: 'UCdrop2' }))
    upsertSubscription(db, makeInput({ googleAccountId: 'acct-2', channelId: 'UCdrop3' }))

    const removed = deleteSubscriptionsNotInChannelIds(
      db,
      'acct-1',
      new Set(['UCkeep1', 'UCkeep2']),
    )
    expect(removed).toBe(2)
    const remaining = listSubscriptions(db).map((s) => s.channelId).sort()
    expect(remaining).toEqual(['UCdrop3', 'UCkeep1', 'UCkeep2'])
  })

  it('returns 0 when the keep set covers every row', () => {
    upsertSubscription(db, makeInput({ channelId: 'UCa' }))
    upsertSubscription(db, makeInput({ channelId: 'UCb' }))
    const removed = deleteSubscriptionsNotInChannelIds(
      db,
      'acct-1',
      new Set(['UCa', 'UCb']),
    )
    expect(removed).toBe(0)
    expect(countSubscriptions(db)).toBe(2)
  })

  it('scopes the delete to the given google_account_id', () => {
    seedAccount('acct-2')
    upsertSubscription(db, makeInput({ googleAccountId: 'acct-1', channelId: 'UCx' }))
    upsertSubscription(db, makeInput({ googleAccountId: 'acct-2', channelId: 'UCy' }))

    // Asking acct-1 to keep "UCx" but the keep-set is empty for acct-2
    // → UCx stays, UCy is removed (per its own account).
    const removed = deleteSubscriptionsNotInChannelIds(db, 'acct-2', new Set())
    expect(removed).toBe(1)
    expect(getSubscriptionByChannelId(db, 'UCx')).not.toBeNull()
    expect(getSubscriptionByChannelId(db, 'UCy')).toBeNull()
  })
})

// ─── updateSubscriptionToggles ──────────────────────────────────────────

describe('updateSubscriptionToggles', () => {
  it('updates is_included without touching is_important', () => {
    const { id } = upsertSubscription(db, makeInput({ channelId: 'UCa' }))
    expect(updateSubscriptionToggles(db, id, { isIncluded: false })).toBe(true)
    const row = getSubscriptionById(db, id)
    expect(row?.isIncluded).toBe(false)
    expect(row?.isImportant).toBe(false) // untouched
  })

  it('updates is_important without touching is_included', () => {
    const { id } = upsertSubscription(db, makeInput({ channelId: 'UCb' }))
    expect(updateSubscriptionToggles(db, id, { isImportant: true })).toBe(true)
    const row = getSubscriptionById(db, id)
    expect(row?.isIncluded).toBe(true) // untouched
    expect(row?.isImportant).toBe(true)
  })

  it('updates both toggles in one call', () => {
    const { id } = upsertSubscription(db, makeInput({ channelId: 'UCc' }))
    expect(
      updateSubscriptionToggles(db, id, { isIncluded: false, isImportant: true }),
    ).toBe(true)
    const row = getSubscriptionById(db, id)
    expect(row?.isIncluded).toBe(false)
    expect(row?.isImportant).toBe(true)
  })

  it('returns false when the id is unknown', () => {
    expect(
      updateSubscriptionToggles(db, randomUUID(), { isIncluded: true }),
    ).toBe(false)
  })
})

// ─── touchSubscriptionLastPolledAt ───────────────────────────────────────

describe('touchSubscriptionLastPolledAt', () => {
  it('sets last_polled_at to the provided timestamp', () => {
    const { id } = upsertSubscription(db, makeInput({ channelId: 'UCp' }))
    touchSubscriptionLastPolledAt(db, id, '2024-04-01T00:00:00.000Z')
    expect(getSubscriptionById(db, id)?.lastPolledAt).toBe('2024-04-01T00:00:00.000Z')
  })

  it('is a silent no-op when the id is unknown', () => {
    // Should not throw.
    touchSubscriptionLastPolledAt(db, randomUUID(), '2024-04-01T00:00:00.000Z')
  })
})