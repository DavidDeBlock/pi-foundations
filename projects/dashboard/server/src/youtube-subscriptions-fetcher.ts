// youtube-subscriptions-fetcher.ts — issue YT-002
//
// Deep module wrapping the YouTube Data API `subscriptions.list`
// endpoint. One job: paginate through every subscription the
// authenticated user has and return a normalized `Subscription[]`
// for the sync orchestrator to diff against the DB.
//
// The fetcher is intentionally stateless: it doesn't touch the DB
// or read tokens from disk. The caller (sync orchestrator) resolves
// the access token (via `YouTubeOAuthClient.refreshIfNeeded` when
// needed) and passes it in. This keeps the fetcher pure-ish — easy
// to unit-test against canned API responses, no fixture crypto.
//
// API contract we depend on:
//   * `GET /youtube/v3/subscriptions?part=snippet&mine=true&maxResults=50`
//   * Pagination via `pageToken` (returned as `nextPageToken`)
//   * One page can hold up to 50 items (the API max).
//
// Errors propagate as plain `Error` so the orchestrator can log
// them and decide whether to retry, abort, or swallow. No
// exception types — the API doesn't have stable error codes worth
// distinguishing in v3.0 (David is a single user; the dashboard
// has no retry policy).

import type { Subscription } from './youtube-subscriptions.js'

// ─── Constants ────────────────────────────────────────────────────────────

const YOUTUBE_SUBSCRIPTIONS_URL =
  'https://www.googleapis.com/youtube/v3/subscriptions'

/** Max results per page — YouTube Data API v3 caps this at 50.
 *  Hardcoded rather than parameterised because going lower would
 *  multiply the number of round-trips for no benefit (David has
 *  ~100 subscriptions, fits in 2 pages). */
const MAX_RESULTS_PER_PAGE = 50

// ─── Wire types (internal — match Google's response shape) ────────────────

interface GoogleSubscriptionsListResponse {
  nextPageToken?: string
  items?: RawSubscription[]
}

interface RawSubscription {
  /** Google's subscription resource id (NOT the channel id — these are
   *  different! Subscription id = composite of user+channel). We use
   *  `snippet.resourceId.channelId` instead. */
  id?: string
  snippet?: {
    publishedAt?: string
    title?: string
    resourceId?: {
      channelId?: string
    }
    thumbnails?: ThumbnailsShape
  }
}

interface ThumbnailShape {
  url?: string
}

interface ThumbnailsShape {
  default?: ThumbnailShape
  medium?: ThumbnailShape
  high?: ThumbnailShape
}

// ─── Fetcher ──────────────────────────────────────────────────────────────

/**
 * Thin class over `fetch` so tests can inject a deterministic
 * response fixture. Defaults to global `fetch`. Held as a single
 * optional dependency so production callers don't have to wire it.
 */
export class YouTubeSubscriptionsFetcher {
  readonly #fetchFn: typeof fetch

  constructor(fetchFn?: typeof fetch) {
    this.#fetchFn = fetchFn ?? globalThis.fetch
  }

  /**
   * Fetch every subscription for the bearer of `accessToken`,
   * transparently following `nextPageToken` until the API reports
   * no more pages. Returns a normalised `Subscription[]` in the
   * shape the DB row expects (no decrypt/decrypt crypto, no DB I/O).
   *
   * Throws on:
   *   * Non-2xx HTTP response (with the status code + body in the
   *     message — the operator can read the cause from the log).
   *   * Network errors (propagated from `fetch`).
   *   * Malformed JSON (propagated from `response.json()`).
   *
   * An empty `items` array is NOT an error — a user with zero
   * subscriptions gets `[]`.
   */
  async fetchAll(accessToken: string): Promise<readonly Subscription[]> {
    const collected: Subscription[] = []
    let pageToken: string | undefined = undefined

    // Pagination loop. Google returns `nextPageToken` only when
    // there's another page — its absence means we're done. The
    // loop is bounded by the number of pages Google chooses to
    // return (no infinite loop risk: each call either advances
    // the token or terminates).
    do {
      const url = new URL(YOUTUBE_SUBSCRIPTIONS_URL)
      url.searchParams.set('part', 'snippet')
      url.searchParams.set('mine', 'true')
      url.searchParams.set('maxResults', String(MAX_RESULTS_PER_PAGE))
      if (pageToken !== undefined) {
        url.searchParams.set('pageToken', pageToken)
      }

      const res = await this.#fetchFn(url.toString(), {
        headers: { authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) {
        const body = await safeText(res)
        throw new Error(
          `subscriptions.list ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
        )
      }
      const body = (await res.json()) as GoogleSubscriptionsListResponse
      const items = body.items ?? []
      for (const raw of items) {
        const parsed = parseSubscription(raw)
        if (parsed !== null) collected.push(parsed)
      }
      pageToken = body.nextPageToken
    } while (pageToken)

    return collected
  }
}

// ─── Parsing ──────────────────────────────────────────────────────────────

/** Normalise a single Google `subscription` resource into our
 *  `Subscription` shape. Returns `null` when the resource is missing
 *  the fields we need (channel_id or title) — the fetcher skips
 *  those silently rather than failing the entire sync. A subscription
 *  without a title or channel_id is a Google schema violation; we'd
 *  rather log a single missing row than break the user's daily
 *  refresh. */
export function parseSubscription(raw: RawSubscription): Subscription | null {
  const snippet = raw.snippet
  if (!snippet) return null
  const channelId = snippet.resourceId?.channelId
  const title = snippet.title
  if (typeof channelId !== 'string' || channelId === '') return null
  if (typeof title !== 'string' || title === '') return null
  return {
    id: '', // assigned by the DB on insert (UUID); meaningless here
    googleAccountId: '', // caller fills in; this view doesn't carry it
    channelId,
    channelTitle: title,
    channelThumbnailUrl: pickThumbnail(snippet.thumbnails),
    subscribedAt: snippet.publishedAt ?? '',
    isIncluded: true,
    isImportant: false,
    autoFetchTranscripts: false,
    lastPolledAt: null,
    backfillStatus: null,
    lastBackfillDays: null,
    lastBackfillCount: 0,
    lastBackfillSkippedCount: 0,
    lastBackfilledAt: null,
    backfillError: null,
    backfillRetryable: false,
    createdAt: '',
    updatedAt: '',
    tags: [],
  }
}

function pickThumbnail(t: ThumbnailsShape | null | undefined): string | null {
  if (!t) return null
  // Prefer `medium` (240x240) — large enough to look crisp at the
  // dashboard's 32px avatar size without bloating the page. Fall
  // back to `default`, then `high`. Missing `url` → null.
  return t.medium?.url ?? t.default?.url ?? t.high?.url ?? null
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
