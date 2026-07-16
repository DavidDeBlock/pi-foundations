import { Hono } from 'hono'
import type { AuthVariables } from './auth.js'
import type { Database } from './db.js'
import { getMostRecentYouTubeAccountId } from './youtube-accounts.js'
import {
  getYouTubePreferences,
  NEW_SUBSCRIPTION_BACKFILL_DAYS,
  updateYouTubePreferences,
} from './youtube-preferences.js'

export function youtubePreferencesApi(deps: {
  readonly db: Database
}): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  api.get('/', (c) => {
    const accountId = getMostRecentYouTubeAccountId(deps.db)
    if (!accountId) return c.json({ ok: false, error: 'no_account' }, 404)
    return c.json(toApi(getYouTubePreferences(deps.db, accountId)))
  })

  api.patch('/', async (c) => {
    const accountId = getMostRecentYouTubeAccountId(deps.db)
    if (!accountId) return c.json({ ok: false, error: 'no_account' }, 404)
    let body: { new_subscription_backfill_days?: unknown }
    try {
      body = await c.req.json() as typeof body
    } catch {
      return c.json({ ok: false, error: 'malformed_json' }, 400)
    }
    const days = body.new_subscription_backfill_days
    if (!NEW_SUBSCRIPTION_BACKFILL_DAYS.includes(days as never)) {
      return c.json({
        ok: false,
        error: 'invalid_days',
        message: 'new_subscription_backfill_days must be 0, 7, 30, or 90',
      }, 400)
    }
    return c.json(toApi(updateYouTubePreferences(deps.db, accountId, days as never)))
  })

  return api
}

function toApi(preferences: ReturnType<typeof getYouTubePreferences>): {
  new_subscription_backfill_days: number
  updated_at: string
} {
  return {
    new_subscription_backfill_days: preferences.newSubscriptionBackfillDays,
    updated_at: preferences.updatedAt,
  }
}
