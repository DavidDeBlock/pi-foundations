import type { Database } from './db.js'

export type NewSubscriptionBackfillDays = 0 | 7 | 30 | 90
export type ManualBackfillDays = 7 | 30 | 90

export const NEW_SUBSCRIPTION_BACKFILL_DAYS = [0, 7, 30, 90] as const
export const MANUAL_BACKFILL_DAYS = [7, 30, 90] as const

export interface YouTubePreferences {
  readonly googleAccountId: string
  readonly newSubscriptionBackfillDays: NewSubscriptionBackfillDays
  readonly updatedAt: string
}

interface PreferencesRow {
  google_account_id: string
  new_subscription_backfill_days: number
  updated_at: string
}

export function getYouTubePreferences(
  db: Database,
  googleAccountId: string,
): YouTubePreferences {
  db.run(
    `INSERT OR IGNORE INTO youtube_preferences (google_account_id)
     VALUES (?)`,
    [googleAccountId],
  )
  const row = db.get<PreferencesRow>(
    `SELECT google_account_id, new_subscription_backfill_days, updated_at
       FROM youtube_preferences WHERE google_account_id = ?`,
    [googleAccountId],
  )
  if (!row) throw new Error('YouTube preferences could not be created')
  return rowToPreferences(row)
}

export function updateYouTubePreferences(
  db: Database,
  googleAccountId: string,
  days: NewSubscriptionBackfillDays,
  nowMs: () => number = () => Date.now(),
): YouTubePreferences {
  const now = new Date(nowMs()).toISOString()
  db.run(
    `INSERT INTO youtube_preferences
       (google_account_id, new_subscription_backfill_days, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(google_account_id) DO UPDATE SET
       new_subscription_backfill_days = excluded.new_subscription_backfill_days,
       updated_at = excluded.updated_at`,
    [googleAccountId, days, now],
  )
  return getYouTubePreferences(db, googleAccountId)
}

function rowToPreferences(row: PreferencesRow): YouTubePreferences {
  return {
    googleAccountId: row.google_account_id,
    newSubscriptionBackfillDays:
      row.new_subscription_backfill_days as NewSubscriptionBackfillDays,
    updatedAt: row.updated_at,
  }
}
