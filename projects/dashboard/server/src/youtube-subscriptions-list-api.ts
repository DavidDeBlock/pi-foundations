// youtube-subscriptions-list-api.ts — issue YT-003
//
// JSON API for reading + patching subscriptions. Two routes:
//
//   GET  /api/subscriptions?filter=included|excluded|all&search=&page=&limit=
//        Paginated, filtered, searched. Returns
//        `{ items, total, page, limit }`. Defaults `filter=all`,
//        `limit=50`. Sort is title ASC (deterministic across
//        pages — the page-N row is the same on every reload).
//
//   PATCH /api/subscriptions/:id
//        Body `{ is_included?: boolean, is_important?: boolean,
//                auto_fetch_transcripts?: boolean }`.
//        Both fields optional; only the provided fields change.
//        Empty body → 400. Missing id → 404. Returns the
//        updated subscription row in the same shape as the list
//        items.
//
// Why this file is separate from `youtube-subscriptions-api.ts`
// (which owns `POST /api/youtube/sync`):
//   * Different mount paths. `/api/youtube/sync` is the YouTube
//     resource (mirrors `/api/email/sync`). `/api/subscriptions/*`
//     is its own resource — separate API surface, separate
//     router, easier to swap, easier to grep.
//   * Different deps. `/sync` needs the sync orchestrator; the
//     list / patch endpoints need only the DB. Splitting keeps
//     each file's DI surface narrow.

import { Hono } from 'hono'
import type { AuthVariables } from './auth.js'
import type { Database } from './db.js'
import {
  getSubscriptionById,
  searchSubscriptions,
  SUBSCRIPTION_FILTERS,
  updateSubscriptionToggles,
  type Subscription,
} from './youtube-subscriptions.js'

export interface SubscriptionsApiDeps {
  readonly db: Database
}

/**
 * Mounted at `/api/subscriptions`. Adds:
 *   * `GET /` — paginated filtered list (described above).
 *   * `PATCH /:id` — toggle update (described above).
 *
 * The OAuth + sync routes on `/api/youtube` are owned by the
 * `youtubeApi` / `youtubeSyncApi` factories; Hono dispatches by
 * exact path match so the three co-exist.
 */
export function subscriptionsApi(
  deps: SubscriptionsApiDeps,
): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  // ─── GET / ──────────────────────────────────────────────────────────
  // Paginated, filtered, searched. The validation here mirrors the
  // model's clamps (1..200 limit, page >= 1) — we trust the model
  // for both, so the API only needs to refuse an invalid `filter`
  // value (a typo on the URL shouldn't silently fall back to `all`).
  api.get('/', (c) => {
    const filter = c.req.query('filter') ?? 'all'
    if (!SUBSCRIPTION_FILTERS.includes(filter as never)) {
      return c.json(
        {
          ok: false,
          error: 'invalid_filter',
          message: `filter must be one of: ${SUBSCRIPTION_FILTERS.join(', ')}`,
        },
        400,
      )
    }
    const search = c.req.query('search') ?? ''
    const page = parsePositiveInt(c.req.query('page'))
    const limit = parsePositiveInt(c.req.query('limit'))

    const result = searchSubscriptions(deps.db, {
      filter: filter as never,
      search,
      page,
      limit,
    })
    return c.json({
      items: result.items.map(toApiItem),
      total: result.total,
      page: result.page,
      limit: result.limit,
    })
  })

  // ─── PATCH /:id ─────────────────────────────────────────────────────
  // Update the three independent subscription preferences. Every field is
  // optional but at least one must be present — an empty body is
  // almost always a client bug, so we 400 instead of silently
  // no-op'ing.
  api.patch('/:id', async (c) => {
    const id = c.req.param('id')
    let body: {
      is_included?: unknown
      is_important?: unknown
      auto_fetch_transcripts?: unknown
    }
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json(
        { ok: false, error: 'malformed_json' },
        400,
      )
    }

    // Validate field presence + types. Both are booleans (no
    // truthy-string shortcuts — toggle UIs already deal in real
    // booleans and accepting '1' / 'true' / 1 / 0 would muddy
    // the contract).
    const patch: {
      isIncluded?: boolean
      isImportant?: boolean
      autoFetchTranscripts?: boolean
    } = {}
    let hasIncluded: boolean | null = null
    let hasImportant: boolean | null = null
    let hasAutoTranscripts: boolean | null = null
    if (body.is_included !== undefined) {
      if (typeof body.is_included !== 'boolean') {
        return c.json(
          {
            ok: false,
            error: 'invalid_field',
            message: 'is_included must be a boolean',
          },
          400,
        )
      }
      hasIncluded = body.is_included
      patch.isIncluded = body.is_included
    }
    if (body.is_important !== undefined) {
      if (typeof body.is_important !== 'boolean') {
        return c.json(
          {
            ok: false,
            error: 'invalid_field',
            message: 'is_important must be a boolean',
          },
          400,
        )
      }
      hasImportant = body.is_important
      patch.isImportant = body.is_important
    }
    if (body.auto_fetch_transcripts !== undefined) {
      if (typeof body.auto_fetch_transcripts !== 'boolean') {
        return c.json(
          {
            ok: false,
            error: 'invalid_field',
            message: 'auto_fetch_transcripts must be a boolean',
          },
          400,
        )
      }
      hasAutoTranscripts = body.auto_fetch_transcripts
      patch.autoFetchTranscripts = body.auto_fetch_transcripts
    }
    if (hasIncluded === null && hasImportant === null && hasAutoTranscripts === null) {
      return c.json(
        {
          ok: false,
          error: 'empty_patch',
          message: 'must include is_included, is_important, and/or auto_fetch_transcripts',
        },
        400,
      )
    }

    const updated = updateSubscriptionToggles(deps.db, id, patch)
    if (!updated) {
      return c.json({ ok: false, error: 'not_found' }, 404)
    }
    const fresh = getSubscriptionById(deps.db, id)
    if (fresh === null) {
      // Race: row was deleted between the UPDATE and the SELECT.
      // Shouldn't happen in v3.0 (the only writer is the toggle
      // + sync, both serial), but surface a 404 rather than
      // returning a phantom payload.
      return c.json({ ok: false, error: 'not_found' }, 404)
    }
    return c.json({ ok: true, subscription: toApiItem(fresh) })
  })

  return api
}

// ─── Wire → API shape ─────────────────────────────────────────────────────

/** Public API shape for one subscription:
 *   `{ id, channel_id, title, thumbnail_url, subscribed_at,
 *      is_included, is_important, auto_fetch_transcripts,
 *      last_polled_at }`. The
 *  `google_account_id` is intentionally omitted — the
 *  v3.0 UI is single-account and doesn't need to render
 *  which account owns which subscription; the row's id is
 *  enough for the PATCH endpoint to act on. */
interface ApiSubscriptionItem {
  readonly id: string
  readonly channel_id: string
  readonly title: string
  readonly thumbnail_url: string | null
  readonly subscribed_at: string
  readonly is_included: boolean
  readonly is_important: boolean
  readonly auto_fetch_transcripts: boolean
  readonly last_polled_at: string | null
}

function toApiItem(s: Subscription): ApiSubscriptionItem {
  return {
    id: s.id,
    channel_id: s.channelId,
    title: s.channelTitle,
    thumbnail_url: s.channelThumbnailUrl,
    subscribed_at: s.subscribedAt,
    is_included: s.isIncluded,
    is_important: s.isImportant,
    auto_fetch_transcripts: s.autoFetchTranscripts,
    last_polled_at: s.lastPolledAt,
  }
}

/** Parse a query-param string into a positive int (or undefined).
 *  `?page=abc` and `?page=` and `?page=0` and `?page=-3` all
 *  return undefined — the model layer applies its own clamps. */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  return Math.floor(n)
}
