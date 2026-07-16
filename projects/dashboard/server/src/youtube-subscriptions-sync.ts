// youtube-subscriptions-sync.ts — issue YT-002
//
// Orchestrates a YouTube subscriptions sync: token refresh → fetch
// all subscriptions via the Data API → diff against DB → INSERT /
// UPDATE / DELETE. Returns a count summary that the caller
// (manual POST endpoint, daily scheduler) can render or log.
//
// Two layers above it:
//   * YouTubeSubscriptionsScheduler (daily interval) — wraps
//     `sync()` in setInterval, isolates per-account failures,
//     logs results.
//   * `POST /api/youtube/sync` HTTP route — synchronous response
//     with the counts as JSON.
//
// Diff strategy: identity is `channel_id` (per the schema's UNIQUE
// constraint). Each incoming channel triggers a single `upsert` —
// the row's tracked columns (title / thumbnail / subscribed_at)
// are compared; if unchanged the row is not rewritten. After the
// per-channel loop, any local row whose `channel_id` was NOT in
// the incoming set is deleted in a single bulk operation.
//
// Idempotency: re-running `sync()` with no changes on Google's
// side produces `unchanged === incoming.length` and `added === 0`
// / `updated === 0` / `removed === 0` — the AC's manual-smoke
// check ("manual sync → counts match") is satisfied without any
// special-casing.

import type { Database } from './db.js'
import type { TokenCipher } from './token-encryption.js'
import {
  getYouTubeAccount,
  getMostRecentYouTubeAccountId,
} from './youtube-accounts.js'
import {
  deleteSubscriptionsNotInChannelIds,
  upsertSubscription,
} from './youtube-subscriptions.js'
import type { YouTubeOAuthClient } from './youtube-oauth.js'
import { YouTubeSubscriptionsFetcher } from './youtube-subscriptions-fetcher.js'

// ─── Errors ──────────────────────────────────────────────────────────────

/** No YouTube account is connected — the caller (manual endpoint
 *  or scheduler) should surface this as 404 / no-op respectively. */
export class NoYouTubeAccountError extends Error {
  constructor() {
    super('no YouTube account connected')
    this.name = 'NoYouTubeAccountError'
  }
}

// ─── Public types ────────────────────────────────────────────────────────

export interface SubscriptionsSyncResult {
  readonly added: number
  readonly updated: number
  readonly removed: number
  /** Number of incoming subscriptions that already existed AND had
   *  no tracked-column changes — i.e. zero DB writes. Distinct from
   *  `updated` (which means a column changed). */
  readonly unchanged: number
  /** Total incoming subscriptions considered this run. Always equals
   *  added + updated + unchanged; included for log clarity. */
  readonly total: number
  /** ISO 8601 timestamp at end-of-run. */
  readonly ranAt: string
}

export interface YouTubeSubscriptionsSyncDeps {
  readonly db: Database
  /** Cipher used to decrypt the account's tokens. Same cipher the
   *  OAuth client wrote with. */
  readonly cipher: TokenCipher
  /** The shared OAuth client (constructed in index.ts). Used for
   *  `refreshIfNeeded` — we don't talk to Google directly here. */
  readonly oauthClient: YouTubeOAuthClient
  /** Injectable fetcher for tests; default is the production one. */
  readonly fetcher?: YouTubeSubscriptionsFetcher
  /** Injected clock; default `Date.now`. */
  readonly nowMs?: () => number
  /** Optional persistent backfill queue (YT-009). Kept structural so the
   *  subscription sync remains independently testable. */
  readonly backfillService?: {
    queueAutomatic(subscriptionIds: readonly string[]): void
  }
}

// ─── Orchestrator ────────────────────────────────────────────────────────

export class YouTubeSubscriptionsSync {
  readonly #db: Database
  readonly #cipher: TokenCipher
  readonly #oauthClient: YouTubeOAuthClient
  readonly #fetcher: YouTubeSubscriptionsFetcher
  readonly #nowMs: () => number
  readonly #backfillService: YouTubeSubscriptionsSyncDeps['backfillService']

  constructor(deps: YouTubeSubscriptionsSyncDeps) {
    this.#db = deps.db
    this.#cipher = deps.cipher
    this.#oauthClient = deps.oauthClient
    this.#fetcher = deps.fetcher ?? new YouTubeSubscriptionsFetcher()
    this.#nowMs = deps.nowMs ?? (() => Date.now())
    this.#backfillService = deps.backfillService
  }

  /**
   * Run a full subscriptions sync for one Google account.
   *
   * Lifecycle:
   *   1. Resolve the account (default: most-recently connected).
   *   2. Ask the OAuth client for a non-expired access token
   *      (refreshes if within 5 min of expiry).
   *   3. Page through `subscriptions.list` and collect every
   *      channel David is subscribed to.
   *   4. UPSERT each channel by `channel_id`. Tracked columns
   *      (`channel_title`, `channel_thumbnail_url`,
   *      `subscribed_at`) drive INSERT / UPDATE / unchanged.
   *   5. DELETE every local row for the account whose `channel_id`
   *      was not in the incoming set (unsubscribed on YouTube
   *      since last sync).
   *   6. Return counts + a run timestamp.
   *
   * Throws:
   *   * `NoYouTubeAccountError` if no account is connected.
   *   * Whatever the OAuth client / fetcher throws on HTTP /
   *     decryption failures (propagated unchanged).
   */
  async sync(
    googleAccountId?: string,
  ): Promise<SubscriptionsSyncResult> {
    const accountId =
      googleAccountId ?? getMostRecentYouTubeAccountId(this.#db)
    if (accountId === null) throw new NoYouTubeAccountError()

    const account = getYouTubeAccount(this.#db, this.#cipher, accountId)
    if (!account) {
      // The id resolved by `getMostRecentYouTubeAccountId` was
      // deleted between calls — extremely rare (the OAuth callback
      // handler races), but treat it as "no account" so the
      // scheduler / manual endpoint get the same shape.
      throw new NoYouTubeAccountError()
    }

    // `refreshIfNeeded` returns the existing token if it's still
    // good (no refresh round-trip), or a freshly-refreshed token
    // if it's within 5 min of expiry. Either way, the returned
    // token is what we pass to the fetcher.
    const { accessToken } = await this.#oauthClient.refreshIfNeeded(account)
    const incoming = await this.#fetcher.fetchAll(accessToken)

    // Per-channel UPSERT inside one transaction. Either every
    // channel makes it to the DB or none do — partial diffs
    // would let the bulk-DELETE below misclassify rows as
    // "removed from YouTube" when really the sync crashed mid-
    // way. We also want a stable point-in-time snapshot for
    // the post-UPSERT remove pass.
    let added = 0
    let updated = 0
    let unchanged = 0
    const seenChannelIds = new Set<string>()
    const insertedSubscriptionIds: string[] = []
    this.#db.transaction(() => {
      for (const sub of incoming) {
        seenChannelIds.add(sub.channelId)
        const { outcome, id } = upsertSubscription(
          this.#db,
          {
            googleAccountId: account.id,
            channelId: sub.channelId,
            channelTitle: sub.channelTitle,
            channelThumbnailUrl: sub.channelThumbnailUrl,
            subscribedAt: sub.subscribedAt,
          },
          this.#nowMs,
        )
        if (outcome === 'inserted') {
          added++
          insertedSubscriptionIds.push(id)
        }
        else if (outcome === 'updated') updated++
        else unchanged++
      }
    })

    // Global remove pass: anything in the DB for this account
    // that wasn't in the incoming list is a channel David
    // unsubscribed from on YouTube (or that moved to another
    // account — but with one account, the only way to leave
    // the list is to unsubscribe). This is unconditional on
    // every sync; not gated on "first sync" because we have
    // full list pagination every run, not incremental cursors.
    // (Contrast with email-sync-worker's remove-pass logic,
    // which is gated on first sync because Gmail sync is
    // incremental; subscriptions.list isn't.)
    const removed = deleteSubscriptionsNotInChannelIds(
      this.#db,
      account.id,
      seenChannelIds,
    )

    // Queue only rows inserted by this sync. Migration 015 marks all
    // pre-existing rows initialized, preventing an upgrade-time flood.
    this.#backfillService?.queueAutomatic(insertedSubscriptionIds)

    return {
      added,
      updated,
      removed,
      unchanged,
      total: incoming.length,
      ranAt: new Date(this.#nowMs()).toISOString(),
    }
  }
}
