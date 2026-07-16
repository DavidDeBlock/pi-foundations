// youtube-subscriptions.ts — issue YT-002
//
// Storage helpers for the `subscriptions` table. Pure data layer:
// no HTTP, no YouTube API calls, no scheduler — just typed reads
// and writes against the row shape the schema defines.
//
// Identity is `channel_id` (UNIQUE in the schema). `id` is a
// dashboard-side UUID generated on insert. `google_account_id`
// is the foreign key into `youtube_accounts` so disconnecting
// the OAuth connection cascades through ON DELETE CASCADE.
//
// Mirrors youtube-accounts.ts: a flat namespace of functions
// that take `Database` first, `id`/`channel_id` second, and
// return either a typed row or `null`/`false` for the not-found
// case. No state, no singletons, no DI container — the caller
// passes the dependencies it already holds.

import { randomUUID } from 'node:crypto'
import type { Database } from './db.js'

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * Public view of one subscription. Title and thumbnail are the
 * fields the UI renders; `is_included` / `is_important` are the
 * user toggles; `subscribed_at` is YouTube's record of when the
 * user subscribed; `last_polled_at` is the RSS poller's
 * timestamp (NULL until YT-004 ships).
 */
export interface Subscription {
  readonly id: string
  readonly googleAccountId: string
  readonly channelId: string
  readonly channelTitle: string
  readonly channelThumbnailUrl: string | null
  readonly subscribedAt: string
  readonly isIncluded: boolean
  readonly isImportant: boolean
  readonly lastPolledAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** Raw row shape, as returned by `SELECT *`. Used only by the
 *  helpers below — production callers see the `Subscription` view. */
interface SubscriptionRow {
  id: string
  google_account_id: string
  channel_id: string
  channel_title: string
  channel_thumbnail_url: string | null
  subscribed_at: string
  is_included: number | bigint
  is_important: number | bigint
  last_polled_at: string | null
  created_at: string
  updated_at: string
}

// ─── Reads ────────────────────────────────────────────────────────────────

/**
 * List every subscription, ordered by title. The title sort is
 * deterministic across syncs (unlike `channel_id` which is opaque)
 * and what the /subscriptions UI shows by default.
 *
 * `googleAccountId` (optional) restricts the result to one account.
 * For v3.0 David has one account, so passing nothing returns the
 * full set.
 */
export function listSubscriptions(
  db: Database,
  googleAccountId?: string,
): Subscription[] {
  if (googleAccountId !== undefined) {
    const rows = db.all<SubscriptionRow>(
      `SELECT * FROM subscriptions
        WHERE google_account_id = ?
        ORDER BY channel_title COLLATE NOCASE ASC, id ASC`,
      [googleAccountId],
    )
    return rows.map(rowToSubscription)
  }
  const rows = db.all<SubscriptionRow>(
    `SELECT * FROM subscriptions
      ORDER BY channel_title COLLATE NOCASE ASC, id ASC`,
  )
  return rows.map(rowToSubscription)
}

/**
 * Fetch one subscription by its dashboard-side `id`. Returns
 * `null` when no row matches.
 */
export function getSubscriptionById(db: Database, id: string): Subscription | null {
  const row = db.get<SubscriptionRow>(`SELECT * FROM subscriptions WHERE id = ?`, [id])
  return row ? rowToSubscription(row) : null
}

/**
 * Fetch one subscription by `channel_id` (YouTube's id). Returns
 * `null` when no row matches.
 */
export function getSubscriptionByChannelId(
  db: Database,
  channelId: string,
): Subscription | null {
  const row = db.get<SubscriptionRow>(
    `SELECT * FROM subscriptions WHERE channel_id = ?`,
    [channelId],
  )
  return row ? rowToSubscription(row) : null
}

/** Count of subscriptions, optionally filtered by account. */
export function countSubscriptions(
  db: Database,
  googleAccountId?: string,
): number {
  if (googleAccountId !== undefined) {
    const row = db.get<{ n: number | bigint }>(
      `SELECT COUNT(*) AS n FROM subscriptions WHERE google_account_id = ?`,
      [googleAccountId],
    )
    return Number(row?.n ?? 0)
  }
  const row = db.get<{ n: number | bigint }>(
    `SELECT COUNT(*) AS n FROM subscriptions`,
  )
  return Number(row?.n ?? 0)
}

// ─── Writes ───────────────────────────────────────────────────────────────

export interface UpsertSubscriptionInput {
  readonly googleAccountId: string
  readonly channelId: string
  readonly channelTitle: string
  readonly channelThumbnailUrl: string | null
  readonly subscribedAt: string
}

/**
 * Insert-or-update one subscription row by `channel_id`. Returns
 * a tag describing what happened: `'inserted'` for a brand-new row,
 * `'unchanged'` when the incoming payload matches the existing row
 * byte-for-byte (the title / thumbnail / subscribedAt all match),
 * `'updated'` when a tracked column changed.
 *
 * This is the only write the sync orchestrator needs for the
 * per-channel loop; the global remove pass uses a separate
 * bulk DELETE (`deleteSubscriptionsNotInChannelIds`).
 *
 * Tracked columns (anything in this list can trigger an
 * `'updated'` return): `channel_title`, `channel_thumbnail_url`,
 * `subscribed_at`. The user toggles (`is_included`, `is_important`)
 * and the RSS poller's timestamp (`last_polled_at`) are NOT in
 * this list — re-syncing must NEVER overwrite a local edit or a
 * poller timestamp. The sync orchestrator relies on this invariant
 * to preserve user settings across daily syncs.
 *
 * Default values for the protected columns are written on insert:
 * `is_included = 1`, `is_important = 0` (per YT-002 AC).
 */
export type UpsertOutcome = 'inserted' | 'updated' | 'unchanged'

export function upsertSubscription(
  db: Database,
  input: UpsertSubscriptionInput,
  nowMs: () => number = () => Date.now(),
): { outcome: UpsertOutcome; id: string } {
  const existing = db.get<SubscriptionRow>(
    `SELECT * FROM subscriptions WHERE channel_id = ?`,
    [input.channelId],
  )
  if (existing) {
    const changed =
      existing.channel_title !== input.channelTitle ||
      (existing.channel_thumbnail_url ?? null) !==
        (input.channelThumbnailUrl ?? null) ||
      existing.subscribed_at !== input.subscribedAt
    if (!changed) {
      return { outcome: 'unchanged', id: existing.id }
    }
    db.run(
      `UPDATE subscriptions
         SET channel_title = ?,
             channel_thumbnail_url = ?,
             subscribed_at = ?,
             updated_at = ?
         WHERE id = ?`,
      [
        input.channelTitle,
        input.channelThumbnailUrl,
        input.subscribedAt,
        nowIso(nowMs),
        existing.id,
      ],
    )
    return { outcome: 'updated', id: existing.id }
  }
  const id = randomUUID()
  db.run(
    `INSERT INTO subscriptions
       (id, google_account_id, channel_id, channel_title,
        channel_thumbnail_url, subscribed_at,
        is_included, is_important, last_polled_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, NULL, ?)`,
    [
      id,
      input.googleAccountId,
      input.channelId,
      input.channelTitle,
      input.channelThumbnailUrl,
      input.subscribedAt,
      nowIso(nowMs),
    ],
  )
  return { outcome: 'inserted', id }
}

/**
 * Bulk DELETE every subscription for `googleAccountId` whose
 * `channel_id` is NOT in the provided set. Used by the sync
 * orchestrator's global remove pass: after INSERTing/UPDATEing
 * every channel Google returned, anything left over in the DB
 * was unsubscribed-from-on-YouTube (or moved to a different
 * Google account) and should disappear from the dashboard.
 *
 * The `OR channel_id IS NULL` guard means the FK CASCADE delete
 * doesn't silently swallow a "channel_id leaked into a row
 * with NULL" bug — instead we'd notice the count mismatch.
 * Actually scratch that: `channel_id` is NOT NULL UNIQUE in the
 * schema, so the guard is paranoia. Removed.
 */
export function deleteSubscriptionsNotInChannelIds(
  db: Database,
  googleAccountId: string,
  keepChannelIds: ReadonlySet<string>,
): number {
  // Snapshot existing rows first — we need their ids to count the
  // delete; running COUNT(*) before+after would race with concurrent
  // writes, which we don't expect today but the SELECT-then-DELETE
  // pattern is cheap and clear.
  const rows = db.all<{ id: string; channel_id: string }>(
    `SELECT id, channel_id FROM subscriptions WHERE google_account_id = ?`,
    [googleAccountId],
  )
  const toRemove: string[] = []
  for (const r of rows) {
    if (!keepChannelIds.has(r.channel_id)) toRemove.push(r.id)
  }
  if (toRemove.length === 0) return 0
  db.transaction(() => {
    for (const id of toRemove) {
      db.run(`DELETE FROM subscriptions WHERE id = ?`, [id])
    }
  })
  return toRemove.length
}

/**
 * Update the user toggles for one subscription. Only the
 * fields in `input` change — anything omitted is left alone.
 * Returns `false` if no row matched (id stale, or already
 * deleted by a concurrent sync).
 */
export interface UpdateSubscriptionTogglesInput {
  readonly isIncluded?: boolean
  readonly isImportant?: boolean
}

export function updateSubscriptionToggles(
  db: Database,
  id: string,
  input: UpdateSubscriptionTogglesInput,
  nowMs: () => number = () => Date.now(),
): boolean {
  // Build a dynamic SET clause. The two columns are independent
  // booleans; we let the caller patch either, both, or neither
  // (caller-side validation rejects "neither" before reaching
  // this helper). At least one field is guaranteed present.
  const sets: string[] = []
  const params: Array<string | number> = []
  if (input.isIncluded !== undefined) {
    sets.push('is_included = ?')
    params.push(input.isIncluded ? 1 : 0)
  }
  if (input.isImportant !== undefined) {
    sets.push('is_important = ?')
    params.push(input.isImportant ? 1 : 0)
  }
  sets.push('updated_at = ?')
  params.push(nowIso(nowMs))
  params.push(id)
  const result = db.run(
    `UPDATE subscriptions SET ${sets.join(', ')} WHERE id = ?`,
    params,
  )
  return result.changes > 0
}

/**
 * Stamp `last_polled_at` on one subscription row. Used by the
 * RSS poller (YT-004). `at` defaults to now. No-op on missing id.
 */
export function touchSubscriptionLastPolledAt(
  db: Database,
  id: string,
  at: string = nowIso(() => Date.now()),
): void {
  db.run(
    `UPDATE subscriptions SET last_polled_at = ? WHERE id = ?`,
    [at, id],
  )
}

// ─── Internal ────────────────────────────────────────────────────────────

function rowToSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    googleAccountId: row.google_account_id,
    channelId: row.channel_id,
    channelTitle: row.channel_title,
    channelThumbnailUrl: row.channel_thumbnail_url,
    subscribedAt: row.subscribed_at,
    isIncluded: !!row.is_included,
    isImportant: !!row.is_important,
    lastPolledAt: row.last_polled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function nowIso(nowMs: () => number): string {
  return new Date(nowMs()).toISOString()
}