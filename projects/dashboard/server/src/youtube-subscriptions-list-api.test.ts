// youtube-subscriptions-list-api.test.ts — issue YT-003
//
// API boundary tests for `GET /api/subscriptions` and
// `PATCH /api/subscriptions/:id`. Two layers:
//   1. Auth — every endpoint requires Basic/Bearer.
//   2. Behaviour — filter, search, pagination, validation,
//      toggle updates, 404 on missing id.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { resolve } from 'node:path'
import { auth, type AuthVariables } from './auth.js'
import { InMemoryTokenStore } from './token-store.js'
import { subscriptionsApi } from './youtube-subscriptions-list-api.js'
import {
  upsertSubscription,
  updateSubscriptionToggles,
} from './youtube-subscriptions.js'
import { randomUUID } from 'node:crypto'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

const PASSWORD = 'secret'

interface TestEnv {
  db: Database
  app: Hono<{ Variables: AuthVariables }>
}

let env: TestEnv

beforeEach(async () => {
  const db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  const passwordHash = await bcrypt(PASSWORD)
  const tokenStore = new InMemoryTokenStore()
  const api = subscriptionsApi({ db })
  const app = new Hono<{ Variables: AuthVariables }>()
  app.use('*', auth({ passwordHash, tokenStore }))
  app.route('/api/subscriptions', api)
  env = { db, app }
})

afterEach(() => {
  env.db.close()
})

async function bcrypt(p: string): Promise<string> {
  return (await import('bcryptjs')).default.hash(p, 4)
}

function basic(pass: string): string {
  return `Basic ${Buffer.from(`david:${pass}`).toString('base64')}`
}

/** Seed an account + a fixed set of subscriptions for the GET tests. */
function seedFixture(): void {
  const acctId = randomUUID()
  env.db.run(
    `INSERT INTO youtube_accounts
       (id, provider, google_user_id, email_address,
        access_token_enc, refresh_token_enc, scopes)
     VALUES (?, 'youtube', 'g-1', 'a@example.com', 'x', 'y', 'youtube.readonly')`,
    [acctId],
  )
  const rows: ReadonlyArray<{ id: string; title: string; included: boolean }> = [
    { id: 'UCa', title: 'Alpha', included: true },
    { id: 'UCb', title: 'Beta', included: false },
    { id: 'UCc', title: 'Gamma', included: true },
    { id: 'UCd', title: 'CoolChannel', included: true },
    { id: 'UCe', title: 'CoolerMusic', included: false },
  ]
  for (const r of rows) {
    upsertSubscription(env.db, {
      googleAccountId: acctId,
      channelId: r.id,
      channelTitle: r.title,
      channelThumbnailUrl: null,
      subscribedAt: '2024-01-01T00:00:00.000Z',
    })
    if (!r.included) {
      updateSubscriptionToggles(env.db, /* id not yet known */ 'PLACEHOLDER', {
        isIncluded: false,
      })
      // The above won't work because we don't have the id — do a
      // direct UPDATE instead.
      env.db.run(`UPDATE subscriptions SET is_included = 0 WHERE channel_id = ?`, [r.id])
    }
  }
}

// ─── GET / ─────────────────────────────────────────────────────────────────

describe('GET /api/subscriptions', () => {
  it('returns 401 unauthenticated', async () => {
    const res = await env.app.request('/api/subscriptions')
    expect(res.status).toBe(401)
  })

  it('returns an empty envelope when there are no subscriptions', async () => {
    const res = await env.app.request('/api/subscriptions', {
      headers: { authorization: basic(PASSWORD) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: unknown[]
      total: number
      page: number
      limit: number
    }
    expect(body.items).toEqual([])
    expect(body.total).toBe(0)
    expect(body.page).toBe(1)
    expect(body.limit).toBe(50)
  })

  it('returns the full list when filter is omitted', async () => {
    seedFixture()
    const res = await env.app.request('/api/subscriptions', {
      headers: { authorization: basic(PASSWORD) },
    })
    const body = (await res.json()) as {
      items: Array<{ title: string; channel_id: string }>
      total: number
    }
    expect(body.total).toBe(5)
    expect(body.items.map((i) => i.title)).toEqual([
      'Alpha',
      'Beta',
      'CoolChannel',
      'CoolerMusic',
      'Gamma',
    ])
  })

  it('item shape includes the documented fields', async () => {
    seedFixture()
    const res = await env.app.request('/api/subscriptions?filter=included', {
      headers: { authorization: basic(PASSWORD) },
    })
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>
    }
    const item = body.items[0]!
    expect(Object.keys(item).sort()).toEqual([
      'auto_fetch_transcripts',
      'backfill_error',
      'backfill_retryable',
      'backfill_status',
      'channel_id',
      'id',
      'is_important',
      'is_included',
      'last_backfill_count',
      'last_backfill_days',
      'last_backfill_skipped_count',
      'last_backfilled_at',
      'last_polled_at',
      'subscribed_at',
      'thumbnail_url',
      'title',
    ])
  })

  it('filters by ?filter=included', async () => {
    seedFixture()
    const res = await env.app.request('/api/subscriptions?filter=included', {
      headers: { authorization: basic(PASSWORD) },
    })
    const body = (await res.json()) as {
      items: Array<{ title: string }>
      total: number
    }
    expect(body.total).toBe(3)
    expect(body.items.map((i) => i.title)).toEqual([
      'Alpha',
      'CoolChannel',
      'Gamma',
    ])
  })

  it('filters by ?filter=excluded', async () => {
    seedFixture()
    const res = await env.app.request('/api/subscriptions?filter=excluded', {
      headers: { authorization: basic(PASSWORD) },
    })
    const body = (await res.json()) as {
      items: Array<{ title: string }>
      total: number
    }
    expect(body.total).toBe(2)
    expect(body.items.map((i) => i.title)).toEqual(['Beta', 'CoolerMusic'])
  })

  it('rejects an unknown filter with 400', async () => {
    const res = await env.app.request('/api/subscriptions?filter=bogus', {
      headers: { authorization: basic(PASSWORD) },
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_filter')
  })

  it('searches by title substring (case-insensitive)', async () => {
    seedFixture()
    const res = await env.app.request('/api/subscriptions?search=cool', {
      headers: { authorization: basic(PASSWORD) },
    })
    const body = (await res.json()) as {
      items: Array<{ title: string }>
      total: number
    }
    expect(body.total).toBe(2)
    expect(body.items.map((i) => i.title)).toEqual(['CoolChannel', 'CoolerMusic'])
  })

  it('paginates with ?page= and ?limit=', async () => {
    seedFixture()
    const res = await env.app.request(
      '/api/subscriptions?page=2&limit=2',
      { headers: { authorization: basic(PASSWORD) } },
    )
    const body = (await res.json()) as {
      items: Array<{ title: string }>
      total: number
      page: number
      limit: number
    }
    expect(body.total).toBe(5)
    expect(body.page).toBe(2)
    expect(body.limit).toBe(2)
    expect(body.items.map((i) => i.title)).toEqual(['CoolChannel', 'CoolerMusic'])
  })

  it('combines filter + search', async () => {
    seedFixture()
    const res = await env.app.request(
      '/api/subscriptions?filter=included&search=cool',
      { headers: { authorization: basic(PASSWORD) } },
    )
    const body = (await res.json()) as { items: Array<{ title: string }>; total: number }
    expect(body.total).toBe(1)
    expect(body.items.map((i) => i.title)).toEqual(['CoolChannel'])
  })
})

// ─── PATCH /:id ───────────────────────────────────────────────────────────

describe('PATCH /api/subscriptions/:id', () => {
  it('returns 401 unauthenticated', async () => {
    const res = await env.app.request(
      `/api/subscriptions/${randomUUID()}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ is_included: false }),
      },
    )
    expect(res.status).toBe(401)
  })

  it('toggles is_included and returns the updated row', async () => {
    seedFixture()
    // Grab the id for UCa (Alpha).
    const row = env.db.get<{ id: string }>(
      `SELECT id FROM subscriptions WHERE channel_id = 'UCa'`,
    )!
    const res = await env.app.request(
      `/api/subscriptions/${row.id}`,
      {
        method: 'PATCH',
        headers: {
          authorization: basic(PASSWORD),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ is_included: false }),
      },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      subscription: { id: string; is_included: boolean }
    }
    expect(body.ok).toBe(true)
    expect(body.subscription.id).toBe(row.id)
    expect(body.subscription.is_included).toBe(false)
    // DB check: next GET shows Alpha under "excluded".
    const list = await env.app.request(
      '/api/subscriptions?filter=excluded',
      { headers: { authorization: basic(PASSWORD) } },
    )
    const listBody = (await list.json()) as { items: Array<{ title: string }> }
    expect(listBody.items.map((i) => i.title)).toContain('Alpha')
  })

  it('toggles is_important without touching is_included', async () => {
    seedFixture()
    const row = env.db.get<{ id: string }>(
      `SELECT id FROM subscriptions WHERE channel_id = 'UCa'`,
    )!
    const res = await env.app.request(
      `/api/subscriptions/${row.id}`,
      {
        method: 'PATCH',
        headers: {
          authorization: basic(PASSWORD),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ is_important: true }),
      },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      subscription: { is_important: boolean; is_included: boolean }
    }
    expect(body.subscription.is_important).toBe(true)
    expect(body.subscription.is_included).toBe(true) // untouched
  })

  it('toggles automatic transcript fetching independently', async () => {
    seedFixture()
    const row = env.db.get<{ id: string }>(
      `SELECT id FROM subscriptions WHERE channel_id = 'UCa'`,
    )!
    const res = await env.app.request(`/api/subscriptions/${row.id}`, {
      method: 'PATCH',
      headers: {
        authorization: basic(PASSWORD),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ auto_fetch_transcripts: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      subscription: {
        auto_fetch_transcripts: boolean
        is_included: boolean
        is_important: boolean
      }
    }
    expect(body.subscription.auto_fetch_transcripts).toBe(true)
    expect(body.subscription.is_included).toBe(true)
    expect(body.subscription.is_important).toBe(false)
  })

  it('updates both fields when both are present', async () => {
    seedFixture()
    const row = env.db.get<{ id: string }>(
      `SELECT id FROM subscriptions WHERE channel_id = 'UCa'`,
    )!
    const res = await env.app.request(
      `/api/subscriptions/${row.id}`,
      {
        method: 'PATCH',
        headers: {
          authorization: basic(PASSWORD),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ is_included: false, is_important: true }),
      },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      subscription: { is_included: boolean; is_important: boolean }
    }
    expect(body.subscription.is_included).toBe(false)
    expect(body.subscription.is_important).toBe(true)
  })

  it('returns 404 when the id does not exist', async () => {
    const res = await env.app.request(
      `/api/subscriptions/${randomUUID()}`,
      {
        method: 'PATCH',
        headers: {
          authorization: basic(PASSWORD),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ is_included: true }),
      },
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('not_found')
  })

  it('returns 400 when the body is empty', async () => {
    const res = await env.app.request(
      `/api/subscriptions/${randomUUID()}`,
      {
        method: 'PATCH',
        headers: {
          authorization: basic(PASSWORD),
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('empty_patch')
  })

  it('returns 400 when a field is not a boolean', async () => {
    const res = await env.app.request(
      `/api/subscriptions/${randomUUID()}`,
      {
        method: 'PATCH',
        headers: {
          authorization: basic(PASSWORD),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ is_included: 'yes' }),
      },
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_field')
  })

  it('returns 400 on malformed JSON', async () => {
    const res = await env.app.request(
      `/api/subscriptions/${randomUUID()}`,
      {
        method: 'PATCH',
        headers: {
          authorization: basic(PASSWORD),
          'content-type': 'application/json',
        },
        body: 'not json',
      },
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('malformed_json')
  })
})
