import type { Database } from './db.js'
import type { TokenCipher } from './token-encryption.js'
import { getYouTubeAccount } from './youtube-accounts.js'
import type { YouTubeOAuthClient } from './youtube-oauth.js'
import {
  YouTubeBackfillFetcher,
  YouTubeApiError,
  type BackfillFetchResult,
} from './youtube-backfill-fetcher.js'
import {
  getYouTubePreferences,
  type ManualBackfillDays,
} from './youtube-preferences.js'
import { upsertYouTubeVideo } from './youtube-video-upsert.js'

export type BackfillStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface SubscriptionBackfillState {
  readonly subscriptionId: string
  readonly status: BackfillStatus | null
  readonly requestedDays: ManualBackfillDays | null
  readonly importedCount: number
  readonly skippedCount: number
  readonly requestedAt: string | null
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly lastBackfilledAt: string | null
  readonly error: string | null
  readonly retryable: boolean
}

interface BackfillRow {
  id: string
  google_account_id: string
  channel_id: string
  channel_title: string
  channel_thumbnail_url: string | null
  is_included: number | bigint
  backfill_status: BackfillStatus | null
  last_backfill_days: number | null
  last_backfill_count: number | bigint
  last_backfill_skipped_count: number | bigint
  last_backfilled_at: string | null
  backfill_requested_at: string | null
  backfill_started_at: string | null
  backfill_completed_at: string | null
  backfill_error: string | null
  backfill_retryable: number | bigint
}

export interface BackfillFetcher {
  resolveUploadsPlaylistIds(
    accessToken: string,
    channelIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>
  fetchRecentUploads(
    accessToken: string,
    uploadsPlaylistId: string,
    cutoffIso: string,
  ): Promise<BackfillFetchResult>
}

export interface YouTubeSubscriptionBackfillServiceDeps {
  readonly db: Database
  readonly cipher: TokenCipher
  readonly oauthClient: YouTubeOAuthClient
  readonly fetcher?: BackfillFetcher
  readonly nowMs?: () => number
}

export class YouTubeSubscriptionBackfillService {
  readonly #db: Database
  readonly #cipher: TokenCipher
  readonly #oauthClient: YouTubeOAuthClient
  readonly #fetcher: BackfillFetcher
  readonly #nowMs: () => number
  #drainPromise: Promise<void> | null = null

  constructor(deps: YouTubeSubscriptionBackfillServiceDeps) {
    this.#db = deps.db
    this.#cipher = deps.cipher
    this.#oauthClient = deps.oauthClient
    this.#fetcher = deps.fetcher ?? new YouTubeBackfillFetcher()
    this.#nowMs = deps.nowMs ?? (() => Date.now())
  }

  /** Reset interrupted work and resume it after the process restarts. */
  resumePending(): void {
    this.#db.run(
      `UPDATE subscriptions
          SET backfill_status = 'pending', backfill_started_at = NULL
        WHERE backfill_status = 'running'`,
    )
    this.#scheduleDrain()
  }

  /** Apply the account default once to subscriptions first seen after YT-009. */
  queueAutomatic(subscriptionIds: readonly string[]): void {
    for (const id of subscriptionIds) {
      const row = this.#getRow(id)
      if (!row) continue
      const preferences = getYouTubePreferences(this.#db, row.google_account_id)
      this.#db.run(
        'UPDATE subscriptions SET backfill_initialized = 1 WHERE id = ?',
        [id],
      )
      if (!row.is_included || preferences.newSubscriptionBackfillDays === 0) continue
      this.#queueRow(id, preferences.newSubscriptionBackfillDays)
    }
    this.#scheduleDrain()
  }

  queueManual(
    subscriptionId: string,
    days: ManualBackfillDays,
  ): SubscriptionBackfillState | null {
    const row = this.#getRow(subscriptionId)
    if (!row) return null
    if (row.backfill_status !== 'pending' && row.backfill_status !== 'running') {
      this.#queueRow(subscriptionId, days)
      this.#scheduleDrain()
    }
    return getSubscriptionBackfillState(this.#db, subscriptionId)
  }

  /** Public deterministic drain for tests and operational callers. */
  runPending(): Promise<void> {
    if (this.#drainPromise) return this.#drainPromise
    this.#drainPromise = this.#drain().finally(() => {
      this.#drainPromise = null
      const waiting = this.#db.get<{ count: number | bigint }>(
        `SELECT COUNT(*) AS count FROM subscriptions WHERE backfill_status = 'pending'`,
      )
      if (Number(waiting?.count ?? 0) > 0) this.#scheduleDrain()
    })
    return this.#drainPromise
  }

  #scheduleDrain(): void {
    queueMicrotask(() => {
      void this.runPending().catch((error: unknown) => {
        // Individual jobs are isolated below. This guard catches only an
        // unexpected drain-level fault without exposing OAuth/API payloads.
        // eslint-disable-next-line no-console
        console.error(`[youtube-backfill] drain failed: ${safeError(error).message}`)
      })
    })
  }

  async #drain(): Promise<void> {
    const pending = this.#db.all<BackfillRow>(
      `${BACKFILL_SELECT}
        WHERE backfill_status = 'pending'
        ORDER BY backfill_requested_at ASC, id ASC`,
    )
    if (pending.length === 0) return

    const claimed: BackfillRow[] = []
    const startedAt = this.#nowIso()
    this.#db.transaction(() => {
      for (const row of pending) {
        const result = this.#db.run(
          `UPDATE subscriptions
              SET backfill_status = 'running', backfill_started_at = ?,
                  backfill_error = NULL, backfill_retryable = 0
            WHERE id = ? AND backfill_status = 'pending'`,
          [startedAt, row.id],
        )
        if (result.changes > 0) claimed.push(row)
      }
    })

    const byAccount = new Map<string, BackfillRow[]>()
    for (const row of claimed) {
      const rows = byAccount.get(row.google_account_id) ?? []
      rows.push(row)
      byAccount.set(row.google_account_id, rows)
    }

    for (const [accountId, rows] of byAccount) {
      let accessToken: string
      try {
        const account = getYouTubeAccount(this.#db, this.#cipher, accountId)
        if (!account) throw new Error('YouTube account is no longer connected')
        accessToken = (await this.#oauthClient.refreshIfNeeded(account)).accessToken
      } catch (error: unknown) {
        for (const row of rows) this.#fail(row.id, error)
        continue
      }

      let playlistIds: ReadonlyMap<string, string>
      try {
        playlistIds = await this.#fetcher.resolveUploadsPlaylistIds(
          accessToken,
          rows.map((row) => row.channel_id),
        )
      } catch (error: unknown) {
        for (const row of rows) this.#fail(row.id, error)
        continue
      }

      for (const row of rows) {
        try {
          const playlistId = playlistIds.get(row.channel_id)
          if (!playlistId) throw new Error('Uploads playlist is unavailable')
          const days = row.last_backfill_days as ManualBackfillDays
          const cutoff = new Date(
            this.#nowMs() - days * 24 * 60 * 60 * 1000,
          ).toISOString()
          const result = await this.#fetcher.fetchRecentUploads(
            accessToken,
            playlistId,
            cutoff,
          )
          let imported = 0
          let skipped = result.skipped
          for (const video of result.videos) {
            const upserted = upsertYouTubeVideo(this.#db, {
              ...video,
              channelThumbnailUrl: row.channel_thumbnail_url,
              origin: { type: 'subscription_backfill', sourceId: row.id },
            }, this.#nowMs)
            if (upserted.outcome === 'inserted') imported++
            else skipped++
          }
          this.#complete(row.id, imported, skipped)
        } catch (error: unknown) {
          this.#fail(row.id, error)
        }
      }
    }
  }

  #queueRow(id: string, days: ManualBackfillDays): void {
    const now = this.#nowIso()
    this.#db.run(
      `UPDATE subscriptions
          SET backfill_initialized = 1, backfill_status = 'pending',
              last_backfill_days = ?, last_backfill_count = 0,
              last_backfill_skipped_count = 0, backfill_requested_at = ?,
              backfill_started_at = NULL, backfill_completed_at = NULL,
              backfill_error = NULL, backfill_retryable = 0
        WHERE id = ?`,
      [days, now, id],
    )
  }

  #complete(id: string, imported: number, skipped: number): void {
    const now = this.#nowIso()
    this.#db.run(
      `UPDATE subscriptions
          SET backfill_status = 'completed', last_backfill_count = ?,
              last_backfill_skipped_count = ?, last_backfilled_at = ?,
              backfill_completed_at = ?, backfill_error = NULL,
              backfill_retryable = 0
        WHERE id = ?`,
      [imported, skipped, now, now, id],
    )
  }

  #fail(id: string, error: unknown): void {
    const safe = safeError(error)
    this.#db.run(
      `UPDATE subscriptions
          SET backfill_status = 'failed', backfill_completed_at = ?,
              backfill_error = ?, backfill_retryable = ?
        WHERE id = ?`,
      [this.#nowIso(), safe.message, safe.retryable ? 1 : 0, id],
    )
  }

  #getRow(id: string): BackfillRow | null {
    return this.#db.get<BackfillRow>(`${BACKFILL_SELECT} WHERE id = ?`, [id]) ?? null
  }

  #nowIso(): string {
    return new Date(this.#nowMs()).toISOString()
  }
}

const BACKFILL_SELECT = `SELECT id, google_account_id, channel_id,
  channel_title, channel_thumbnail_url, is_included, backfill_status,
  last_backfill_days, last_backfill_count, last_backfill_skipped_count,
  last_backfilled_at, backfill_requested_at, backfill_started_at,
  backfill_completed_at, backfill_error, backfill_retryable
  FROM subscriptions`

export function getSubscriptionBackfillState(
  db: Database,
  subscriptionId: string,
): SubscriptionBackfillState | null {
  const row = db.get<BackfillRow>(`${BACKFILL_SELECT} WHERE id = ?`, [subscriptionId])
  if (!row) return null
  return {
    subscriptionId: row.id,
    status: row.backfill_status,
    requestedDays: row.last_backfill_days as ManualBackfillDays | null,
    importedCount: Number(row.last_backfill_count),
    skippedCount: Number(row.last_backfill_skipped_count),
    requestedAt: row.backfill_requested_at,
    startedAt: row.backfill_started_at,
    completedAt: row.backfill_completed_at,
    lastBackfilledAt: row.last_backfilled_at,
    error: row.backfill_error,
    retryable: !!row.backfill_retryable,
  }
}

function safeError(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof YouTubeApiError) {
    return {
      message: `YouTube API request failed (HTTP ${error.status}). Try again later.`,
      retryable: error.retryable,
    }
  }
  const message = error instanceof Error ? error.message : 'Backfill failed'
  const allowed = message === 'Uploads playlist is unavailable' ||
    message === 'YouTube account is no longer connected'
  return { message: allowed ? message : 'Recent videos could not be imported.', retryable: false }
}
