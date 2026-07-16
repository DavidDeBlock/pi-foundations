// email-sync-worker.ts — issue #021
//
// Orchestrates the Gmail mirror sync: paginated list → per-message
// fetch → differ → UPSERT → cursor persistence. Encapsulates the
// account lock, resume cursor, and the "protected-column UPSERT"
// boundary so the manual-refresh route and the future background poll
// (#026) share the same correctness guarantees.
//
// Contract:
//   * `sync({accountId})` blocks until completion (or throws on
//     failure mid-sync; the persisted cursor allows the next call
//     to resume from where this one stopped).
//   * Idempotent: re-running with unchanged Gmail state + unchanged
//     DB → zero writes (verified by the "re-sync is no-op" test).
//   * Resumes: if a run dies mid-page, the next call picks up from
//     the persisted `last_page_token`. Already-synced messages on
//     completed pages are not re-processed (the cursor advances only
//     AFTER the page's UPSERTs commit).
//   * Concurrent invocations on the same account: the second
//     caller sees SyncInProgressError.
//   * Removes (DB rows no longer in Gmail) are only emitted on the
//     FIRST sync for an account, where the entire 90-day window is
//     fetched. Ongoing syncs (cursor already present) don't run the
//     remove pass — they would otherwise delete messages that just
//     happen to fall outside the incremental lookback. A full
//     from-scratch reconcile is left to the user via disconnect /
//     reconnect.
//
// UPSERT integrity:
//   The UPSERT explicitly enumerates the columns that come from
//   Gmail. Local-state columns (`hidden_at`, dashboard tags in
//   #024/#025, etc.) are NOT in the list. Adding more local columns
//   later requires no changes here — they simply are not referenced.

import type { Database } from './db.js'
import type { TokenCipher } from './token-encryption.js'
import type { GmailClient, RawEmail } from './gmail-client.js'
import {
  getEmailAccount,
  updateEmailAccountLastSyncAt,
} from './email-accounts.js'
import { diff, readDbState } from './email-differ.js'

// ─── Errors ──────────────────────────────────────────────────────────────

/** A sync is already running for this account. Caller should poll
 *  status or back off. The previous sync's state may be stale (e.g.
 *  the process crashed mid-sync); future slices can add
 *  timeout-based auto-recovery. v1 surfaces this as the explicit
 *  error. */
export class SyncInProgressError extends Error {
  readonly accountId: string
  constructor(accountId: string) {
    super(`sync already in progress for account ${accountId}`)
    this.name = 'SyncInProgressError'
    this.accountId = accountId
  }
}

/** The requested `email_accounts` row doesn't exist. */
export class AccountNotFoundError extends Error {
  readonly accountId: string
  constructor(accountId: string) {
    super(`email_accounts row ${accountId} not found`)
    this.name = 'AccountNotFoundError'
    this.accountId = accountId
  }
}

/** A sync was attempted with no connected accounts. */
export class NoAccountsError extends Error {
  constructor() {
    super('no email accounts connected')
    this.name = 'NoAccountsError'
  }
}

// ─── Public types ────────────────────────────────────────────────────────

export interface SyncRequest {
  readonly accountId: string
  /** Initial lookback window in days, used only when there's no
   *  prior cursor (first sync for this account). Default 90 (the
   *  issue spec). Configurable via `EMAIL_SYNC_HISTORY_DAYS`. */
  readonly historyDays?: number
  /** Override the page size for testing. Default 100 (Gmail's max). */
  readonly pageSize?: number
}

export interface SyncResult {
  readonly accountId: string
  readonly added: number
  readonly updated: number
  readonly removed: number
  readonly matched: number
  readonly pages: number
  readonly cursor: string | null
  readonly completedAt: string
}

export interface SyncStatus {
  readonly inProgress: boolean
  readonly lastSyncAt: string | null
  readonly lastMessagesSynced: number
  readonly lastAdded: number
  readonly lastUpdated: number
  readonly lastRemoved: number
  readonly startedAt: string | null
}

// ─── Worker ──────────────────────────────────────────────────────────────

export interface EmailSyncWorkerDeps {
  readonly db: Database
  /** Cipher used to decrypt tokens when the worker needs to construct
   *  a GmailClient for the account. We don't store decrypted tokens;
   *  the factory below is the bridge. */
  readonly cipher: TokenCipher
  /** Factory used to obtain a GmailClient for the account under
   *  sync. The worker creates a fresh client per sync so token
   *  refreshes inside this run are scoped to it. */
  readonly buildGmailClient: (accountId: string) => GmailClient
  /** Injected for tests; default `Date.now`. */
  readonly nowMs?: () => number
  /** First-run lookback window, in days. Default 90. */
  readonly historyDays?: number
}

export class EmailSyncWorker {
  readonly #db: Database
  readonly #cipher: TokenCipher
  readonly #buildGmailClient: (accountId: string) => GmailClient
  readonly #nowMs: () => number
  readonly #defaultHistoryDays: number

  constructor(deps: EmailSyncWorkerDeps) {
    this.#db = deps.db
    this.#cipher = deps.cipher
    this.#buildGmailClient = deps.buildGmailClient
    this.#nowMs = deps.nowMs ?? (() => Date.now())
    this.#defaultHistoryDays = deps.historyDays ?? 90
  }

  /**
   * Run a full sync for one account. Blocks until the cursor returns
   * `null` (Gmail's "no more pages") or throws.
   *
   * Lifecycle:
   *   1. Validate the account exists + no concurrent sync.
   *   2. Mark `in_progress = 1` (account lock).
   *   3. Page through `GmailClient.listMessages`, fetch each full
   *      message via `getMessage`, accumulate in memory.
   *   4. After each page, persist the cursor so a crash mid-run
   *      resumes on the NEXT page (not the current one). The
   *      page's UPSERTs commit before the cursor advances.
   *   5. After the loop, run a single global diff pass:
   *      - UPSERT upserts (writes only fields that the worker
   *        tracks; local-state columns preserved).
   *      - DELETE removes (only on first sync, where the whole
   *        90-day window was fetched).
   *   6. Finalize: clear `in_progress`, write `last_sync_at`,
   *      totals, and update `email_accounts.last_sync_at`.
   *
   * Throws `AccountNotFoundError` if the account row doesn't exist,
   * `SyncInProgressError` if a sync is already running on this
   * account, or any `GmailApiError` / network error from the
   * underlying client.
   *
   * On throw the in_progress flag is cleared in the DB so the next
   * call can retry. The cursor is preserved at whatever was last
   * persisted — the resume logic above picks up correctly.
   */
  async sync(req: SyncRequest): Promise<SyncResult> {
    const account = getEmailAccount(this.#db, this.#cipher, req.accountId)
    if (!account) throw new AccountNotFoundError(req.accountId)

    const state = readSyncState(this.#db, req.accountId)
    if (state.inProgress) throw new SyncInProgressError(req.accountId)

    const isFirstSync = state.lastSyncAt === null
    // Whether THIS run is eligible to run the global remove pass.
    // Requires:
    //   1. First sync (lastSyncAt IS NULL) — we've never
    //      completed a sync; the 90-day window is what we
    //      currently have.
    //   2. No leftover cursor (lastPageToken IS NULL) — this run
    //      starts from scratch. A persisted cursor means a prior
    //      run was interrupted; its preSyncIds set covers rows
    //      fetched on pages we won't re-see, so the diff would
    //      mistakenly flag them as removed.
    //
    // After this run completes successfully with `since` set
    // and `nextPageToken` reaching null, we'll mark
    // `lookback_completed_at`. Future syncs will have
    // `lastSyncAt` set, so `isFirstSync` is false and the
    // remove pass stays off (the user's only path to detect
    // further deletes is via disconnect/reconnect).
    const isEligibleForRemovePass = isFirstSync && state.lastPageToken === null
    const startedAt = nowIso(this.#nowMs)

    // Mark in_progress before any external call so a concurrent
    // sync attempt on this account gets SyncInProgressError.
    markInProgress(this.#db, req.accountId, startedAt)

    // Snapshot pre-sync ids so we can distinguish added vs updated
    // when applying upserts (an upsert against an id that was in
    // the DB before this run is an "updated" row, not an "added"
    // one). For a first sync this set is empty by definition.
    const preSyncIds = new Set(
      this.#db
        .all<{ id: string }>(
          'SELECT id FROM emails WHERE account_id = ?',
          [req.accountId],
        )
        .map((r) => r.id),
    )

    const client = this.#buildGmailClient(req.accountId)
    // Resolve `since` and the starting `pageToken` for this run.
    // The matrix (issue #030) is:
    //
    //   1. First sync ever (lastSyncAt IS NULL, lastPageToken IS NULL):
    //      since = now - defaultHistoryDays (90), pageToken = null.
    //   2. Resume of interrupted first sync (lastSyncAt IS NULL,
    //      lastPageToken IS NOT NULL): same `since` as (1), plus we
    //      keep the saved pageToken so we resume pagination where we
    //      left off. The 90-day filter still applies; only the
    //      position inside that result set is restored.
    //   3. Subsequent sync (lastSyncAt IS NOT NULL): `since` is
    //      derived from the last successful run (with a safety
    //      margin — see INCREMENTAL_SINCE_SAFETY_MS), and we
    //      deliberately DROP any persisted pageToken. The cursor
    //      was tied to the original 90-day result set and is
    //      meaningless once we re-filter by `since`; `since` does
    //      the work, starting a fresh result set.
    //
    // Case (3) is the fix from issue #030: before, subsequent syncs
    // walked the full mailbox from page 1 on every tick, burning
    // Gmail API quota. Now they only ask Gmail for messages newer
    // than the last successful sync.
    let pageToken: string | null
    let since: string | undefined
    if (isFirstSync) {
      pageToken = state.lastPageToken
      since = sinceForDays(
        req.historyDays ?? this.#defaultHistoryDays,
        this.#nowMs,
      )
    } else {
      // Subsequent sync. Drop the stale cursor; `since` does the
      // filtering. The safety margin prevents missing messages
      // whose internalDate indexed a moment after lastSyncAt was
      // stamped — a known Gmail quirk (see the comment on
      // INCREMENTAL_SINCE_SAFETY_MS).
      pageToken = null
      const lastSyncMs = Date.parse(state.lastSyncAt ?? '')
      // Defensive fallback: if lastSyncAt is somehow unparseable
      // (corrupt row), fall back to the full history window so the
      // sync still produces correct data — at the cost of the
      // pre-#030 behaviour for that one run.
      since = Number.isFinite(lastSyncMs)
        ? new Date(lastSyncMs - INCREMENTAL_SINCE_SAFETY_MS).toISOString()
        : sinceForDays(this.#defaultHistoryDays, this.#nowMs)
    }
    let pages = 0
    let pagesAdded = 0
    let pagesUpdated = 0
    let pagesMatched = 0
    // Accumulator across all pages of this run. Used by the
    // first-sync remove pass to distinguish "DB row no longer in
    // Gmail" (legit delete) from "DB row outside the incremental
    // window" (ongoing sync — no action).
    const seenThisRun = new Set<string>()

    try {

      do {
        pages++
        const listed = await client.listMessages({
          ...(since !== undefined ? { since } : {}),
          ...(pageToken !== null ? { pageToken } : {}),
          ...(req.pageSize !== undefined ? { maxResults: req.pageSize } : {}),
        })

        // Fetch full messages in parallel. Each getMessage already
        // handles 429 backoff and 401 refresh internally.
        const fetched = await Promise.all(
          listed.messages.map((m) => client.getMessage(m.id)),
        )

        // Apply UPSERTs only on this page. We don't run the
        // differ's remove pass per-page because that would
        // prematurely delete DB rows not yet fetched (the full
        // run spans multiple pages). Local-state columns are
        // preserved by the UPSERT's explicit column list — see
        // `upsertEmail` below.
        let pageAdded = 0
        let pageUpdated = 0
        let pageMatched = 0
        this.#db.transaction(() => {
          for (const email of fetched) {
            seenThisRun.add(email.id)
            const wasInDb = preSyncIds.has(email.id)
            // Idempotent UPSERT: covered by `upsertEmail` even for
            // unchanged rows, but the differ's matchedIds path
            // skips the write entirely. We do that here to satisfy
            // the AC's "zero writes on no-op re-sync".
            const dbState = readDbState(this.#db)
            const d = diff([email], dbState)
            if (d.upserts.length > 0) {
              upsertEmail(this.#db, email, account.id)
              if (wasInDb) pageUpdated++
              else pageAdded++
            } else {
              pageMatched++
            }
          }
        })
        pagesAdded += pageAdded
        pagesUpdated += pageUpdated
        pagesMatched += pageMatched

        // Cursor advance AFTER the page's UPSERTs commit. A crash
        // here leaves the persisted cursor at "next page" — the
        // next sync skips already-applied pages entirely.
        pageToken = listed.nextPageToken
        persistCursor(this.#db, req.accountId, pageToken)

        if (!listed.nextPageToken) break
      } while (pageToken)

      // Global remove pass. Only on the first sync: the entire
      // 90-day window was fetched, so any pre-existing DB id not
      // seen across ALL pages of this run is a confirmed
      // deletion in Gmail. For ongoing syncs, a missing DB row
      // could just be an old Gmail message outside the
      // incremental lookback, so we conservatively skip the
      // pass.
      let removed = 0
      let ranFirstScan = false
      if (isEligibleForRemovePass) {
        // Fresh first-window scan reaching the end. The diff
        // `preSyncIds \ seenThisRun` is correctly the set of DB
        // rows no longer in Gmail within the 90-day window.
        //
        // Note: resumes of interrupted first scans are blocked
        // by the `state.lastPageToken === null` gate above —
        // their preSyncIds cover rows from pages we won't re-see
        // this run, so the set diff would falsely delete them.
        // The trade-off: a deleted-in-Gmail message that arrived
        // during an interrupted first scan stays in the mirror
        // until the user disconnect/reconnects, but no data is
        // ever lost.
        ranFirstScan = true
        const idsToRemove: string[] = []
        for (const id of preSyncIds) {
          if (!seenThisRun.has(id)) idsToRemove.push(id)
        }
        if (idsToRemove.length > 0) {
          this.#db.transaction(() => {
            for (const id of idsToRemove) {
              this.#db.run(
                'DELETE FROM emails WHERE id = ? AND account_id = ?',
                [id, req.accountId],
              )
            }
          })
        }
        removed = idsToRemove.length
      }

      const completedAt = nowIso(this.#nowMs)
      const totalAdded = pagesAdded
      const totalUpdated = pagesUpdated
      const totalMatched = pagesMatched
      const messagesSynced = totalAdded + totalUpdated + totalMatched

      finalizeSync(this.#db, req.accountId, completedAt, {
        added: totalAdded,
        updated: totalUpdated,
        removed,
        matched: totalMatched,
        messagesSynced,
        markLookbackCompleted: ranFirstScan,
      })
      updateEmailAccountLastSyncAt(this.#db, req.accountId, completedAt)

      return {
        accountId: req.accountId,
        added: totalAdded,
        updated: totalUpdated,
        removed,
        matched: totalMatched,
        pages,
        cursor: state.lastPageToken,
        completedAt,
      }
    } catch (err) {
      // Clear in_progress so the next call can retry. Cursor is
      // preserved at whatever was last persisted — the resume
      // logic above picks up correctly. We do NOT swallow the
      // error: callers (the HTTP route, the test) need to see
      // it so they can surface "sync failed".
      clearInProgress(this.#db, req.accountId)
      throw err
    }
  }

  /**
   * Read-only observability snapshot for the `GET /api/email/accounts/:id/status`
   * route. Cheap (single-row read).
   */
  status(accountId: string): SyncStatus {
    const row = this.#db.get<{
      last_sync_at: string | null
      last_messages_synced: number | bigint | null
      last_added: number | bigint | null
      last_updated: number | bigint | null
      last_removed: number | bigint | null
      in_progress: number | bigint | null
      started_at: string | null
    }>(
      `SELECT last_sync_at, last_messages_synced,
              last_added, last_updated, last_removed,
              in_progress, started_at
         FROM sync_state WHERE account_id = ?`,
      [accountId],
    )
    if (!row) {
      return {
        inProgress: false,
        lastSyncAt: null,
        lastMessagesSynced: 0,
        lastAdded: 0,
        lastUpdated: 0,
        lastRemoved: 0,
        startedAt: null,
      }
    }
    return {
      inProgress: !!row.in_progress,
      lastSyncAt: row.last_sync_at,
      lastMessagesSynced: Number(row.last_messages_synced ?? 0),
      lastAdded: Number(row.last_added ?? 0),
      lastUpdated: Number(row.last_updated ?? 0),
      lastRemoved: Number(row.last_removed ?? 0),
      startedAt: row.started_at,
    }
  }
}

// ─── Module-level helpers (public for tests + sync() defaults) ───────────

/** Read sync_state for an account. Returns a default-empty shape if
 *  the row doesn't exist (first sync for this account). */
export function readSyncState(
  db: Database,
  accountId: string,
): {
  lastPageToken: string | null
  inProgress: boolean
  lastSyncAt: string | null
} {
  const row = db.get<{
    last_page_token: string | null
    in_progress: number | bigint | null
    last_sync_at: string | null
  }>(
    `SELECT last_page_token, in_progress, last_sync_at
       FROM sync_state WHERE account_id = ?`,
    [accountId],
  )
  return {
    lastPageToken: row?.last_page_token ?? null,
    inProgress: !!row?.in_progress,
    lastSyncAt: row?.last_sync_at ?? null,
  }
}

/**
 * Resolve an account id when the caller didn't pass one. Picks the
 * most-recently connected account. Throws `NoAccountsError` if none.
 *
 * Exported so the HTTP route can default `?account_id=` to "whichever
 * is connected" without owning the SQL.
 *
 * Reads the bare id straight from `email_accounts` rather than going
 * through `listEmailAccounts` — that helper decrypts tokens, which
 * we don't need (and don't want — the worker is not the right place
 * to handle ciphertext in the default-account path).
 */
export function defaultAccountId(db: Database): string {
  const row = db.get<{ id: string }>(
    `SELECT id FROM email_accounts ORDER BY connected_at DESC, id ASC LIMIT 1`,
  )
  if (!row) throw new NoAccountsError()
  return row.id
}

/**
 * Compute `removed` for a first sync. Identifies DB rows that
 * existed before this run but were never seen by the worker — those
 * are the "deleted in Gmail since the last sync" rows.
 *
 * Implementation: after a complete first sync, every DB row was
 * either there pre-sync and got fetched (so preSyncIds.include(id)
 * AND visible in the new pages) OR was just inserted by the worker
 * (so NOT in preSyncIds). The ids in preSyncIds that are no longer
 * in DB after the run are the "removed" set.
 *
 * We approximate "still in DB" by checking post-sync membership:
 * the differ removes only DB ids not seen, so a "removed" id is one
 * that was in preSyncIds but is now absent. The cleanest read is:
 *
 *   removed = preSyncIds \ seenThisRun
 *
 * `seenThisRun` is the set of Gmail ids fetched across all pages.
 * The worker doesn't store it explicitly (no column for it), so we
 * derive it from the final DB state + the worker's UPSERT pattern.
 *
 * Observation: after a complete first-sync run, the DB contains
 *   - ids that were pre-existing AND fetched this run → still in DB
 *   - ids that were pre-existing AND NOT fetched this run → DELETED
 *     in Gmail, removed from DB by the differ's remove pass
 *   - ids that the worker just inserted → in DB
 *
 * The differ already removes the DELETED ones from the DB. So after
// ─── DB writes ───────────────────────────────────────────────────────────

/** Mark `sync_state.in_progress = 1`. UPSERTs the row so first-time
 *  syncs create it. */
function markInProgress(
  db: Database,
  accountId: string,
  startedAt: string,
): void {
  db.run(
    `INSERT INTO sync_state (account_id, provider, in_progress, started_at)
     VALUES (?, 'gmail', 1, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       in_progress = 1,
       started_at = excluded.started_at`,
    [accountId, startedAt],
  )
}

/** Persist the latest `nextPageToken` (NULL when no more pages). */
function persistCursor(
  db: Database,
  accountId: string,
  pageToken: string | null,
): void {
  db.run(
    `UPDATE sync_state
       SET last_page_token = ?
       WHERE account_id = ?`,
    [pageToken, accountId],
  )
}

/** Clear the `in_progress` lock on failure so the next call can retry. */
function clearInProgress(db: Database, accountId: string): void {
  db.run(
    `UPDATE sync_state
       SET in_progress = 0
       WHERE account_id = ?`,
    [accountId],
  )
}

/** Finalize a successful sync: clear in_progress, write totals + timestamp.
 *  Conditionally sets `lookback_completed_at` when the caller signals that
 *  this run was a clean first-window scan — the flag then prevents the
 *  global remove pass from re-running on future syncs (which would
 *  otherwise be unsafe for resume sequences — see the comments in
 *  `EmailSyncWorker.sync()`). */
function finalizeSync(
  db: Database,
  accountId: string,
  completedAt: string,
  counts: {
    readonly added: number
    readonly updated: number
    readonly removed: number
    readonly matched: number
    readonly messagesSynced: number
    /** True if this run completed a clean first-window scan. */
    readonly markLookbackCompleted: boolean
  },
): void {
  db.run(
    `UPDATE sync_state
       SET in_progress = 0,
           last_sync_at = ?,
           last_messages_synced = ?,
           last_added = ?,
           last_updated = ?,
           last_removed = ?,
           lookback_completed_at = CASE
             WHEN ? = 1 AND lookback_completed_at IS NULL THEN ?
             ELSE lookback_completed_at
           END
       WHERE account_id = ?`,
    [
      completedAt,
      counts.messagesSynced,
      counts.added,
      counts.updated,
      counts.removed,
      counts.markLookbackCompleted ? 1 : 0,
      completedAt,
      accountId,
    ],
  )
}

/**
 * Apply a single email UPSERT. The column list here IS the boundary
 * between "Gmail-owned" and "local-state" data. Local-state columns
 * (`hidden_at` arriving in #024, dashboard tags in #025 via a
 * separate table, etc.) MUST NOT be referenced in either the
 * INSERT column list or the ON CONFLICT UPDATE SET clause — if they
 * aren't named here, they can't be overwritten by a re-sync.
 *
 * The "UPSERT preserves protected columns" test exercises this: it
 * runs an ALTER TABLE to add `hidden_at`, sets a value, runs the
 * sync, asserts the value survived. Works both pre-#024 (via the
 * test's ALTER TABLE) and post-#024 (the column already exists, the
 * ALTER is a no-op).
 */
function upsertEmail(
  db: Database,
  email: RawEmail,
  accountId: string,
): void {
  const toAddrs = JSON.stringify(email.to.map((a) => a.email))
  const ccAddrs = JSON.stringify(email.cc.map((a) => a.email))
  const labelsJson = JSON.stringify(email.labels)
  const sender = email.from
    ? email.from.name
      ? `${email.from.name} <${email.from.email}>`
      : email.from.email
    : ''
  const senderEmail = email.from?.email ?? ''
  const syncedAt = nowIso(Date.now)

  db.run(
    `INSERT INTO emails (
        id, account_id, thread_id, subject, sender, sender_email,
        to_addrs, cc_addrs, received_at, snippet, body_plain, body_html,
        is_unread, labels, synced_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        account_id    = excluded.account_id,
        thread_id     = excluded.thread_id,
        subject       = excluded.subject,
        sender        = excluded.sender,
        sender_email  = excluded.sender_email,
        to_addrs      = excluded.to_addrs,
        cc_addrs      = excluded.cc_addrs,
        received_at   = excluded.received_at,
        snippet       = excluded.snippet,
        body_plain    = excluded.body_plain,
        body_html     = excluded.body_html,
        is_unread     = excluded.is_unread,
        labels        = excluded.labels,
        synced_at     = excluded.synced_at
    `,
    [
      email.id,
      accountId,
      email.threadId,
      email.subject,
      sender,
      senderEmail,
      toAddrs,
      ccAddrs,
      email.internalDate,
      email.snippet,
      email.bodyPlain,
      email.bodyHtml ?? null,
      email.isUnread ? 1 : 0,
      labelsJson,
      syncedAt,
    ],
  )
}

/** ISO-8601 timestamp at "now", using the worker's injected `nowMs`. */
function nowIso(nowMsOrFn: number | (() => number)): string {
  const ms =
    typeof nowMsOrFn === 'function' ? nowMsOrFn() : nowMsOrFn
  return new Date(ms).toISOString()
}

/** ISO-8601 lower bound for the lookback window. */
function sinceForDays(days: number, nowMs: () => number): string {
  const ms = days * 24 * 60 * 60 * 1000
  return new Date(nowMs() - ms).toISOString()
}

/**
 * Safety margin (in ms) applied when computing the `since` lower
 * bound for an INCREMENTAL sync (i.e. when `state.lastSyncAt` is set).
 *
 * Why a margin at all: Gmail's `internalDate` indexing can lag the
 * REST API by a few seconds. If the previous sync stamped
 * `last_sync_at` at T0 and a message landed at T0 + 1s with an
 * internalDate of T0 - 1s, using `since = T0` exactly would miss it.
 * Subtracting a small window guarantees overlap; the differ's
 * no-op UPSERT path handles duplicates silently.
 *
 * 60s matches the manual-trigger debounce (issue #026) — same order
 * of magnitude, same purpose (don't race the API's clock). Bigger
 * values waste quota on re-fetches; smaller values risk misses.
 *
 * Issue #030: introduced alongside the incremental `since` change.
 */
const INCREMENTAL_SINCE_SAFETY_MS = 60_000

// ─── Manual-trigger debounce (#026) ─────────────────────────────────────
//
// The background scheduler reads `last_manual_trigger_at` before
// firing each run and short-circuits if the user clicked Refresh
// within the last 60 seconds. The HTTP manual-refresh route calls
// `markManualTrigger` after deciding to fire (or even if it
// observed `already_in_progress` — the user still clicked, so
// the next scheduled run should give them space).

/**
 * Set `sync_state.last_manual_trigger_at` to a millisecond
 * timestamp. Idempotent — an UPSERT ensures the row exists for
 * accounts that haven't synced yet (no `sync_state` row yet).
 *
 * `nowMs` is the injected clock so tests can pin time. Pass
 * `Date.now` in production.
 */
export function markManualTrigger(
  db: Database,
  accountId: string,
  nowMs: number | (() => number) = Date.now,
): void {
  const ms = typeof nowMs === 'function' ? nowMs() : nowMs
  db.run(
    `INSERT INTO sync_state (account_id, provider, last_manual_trigger_at)
     VALUES (?, 'gmail', ?)
     ON CONFLICT(account_id) DO UPDATE SET
       last_manual_trigger_at = excluded.last_manual_trigger_at`,
    [accountId, String(ms)],
  )
}

/**
 * Return `true` if the user manually triggered a sync within the
 * last `windowMs` milliseconds (per the `last_manual_trigger_at`
 * column populated by `markManualTrigger`). Used by the
 * background scheduler to short-circuit a scheduled run after a
 * recent user action.
 *
 * If the column is `NULL` (account never manually triggered, or
 * the row doesn't exist yet), the predicate returns `false` so
 * a fresh setup still gets a background sync on schedule.
 */
export function wasManualTriggerWithinMs(
  db: Database,
  accountId: string,
  windowMs: number,
  nowMs: number | (() => number) = Date.now,
): boolean {
  const now = typeof nowMs === 'function' ? nowMs() : nowMs
  const row = db.get<{ last_manual_trigger_at: string | null }>(
    `SELECT last_manual_trigger_at FROM sync_state WHERE account_id = ?`,
    [accountId],
  )
  if (!row?.last_manual_trigger_at) return false
  const last = Number.parseInt(row.last_manual_trigger_at, 10)
  if (!Number.isFinite(last)) return false
  return now - last < windowMs
}

/**
 * List every `email_accounts` row regardless of whether it has a
 * `sync_state` row yet. The scheduler needs the full set so a
 * brand-new account (no sync_state row) still gets polled.
 *
 * Decryption isn't needed — the scheduler only needs the id (and
 * a human-readable emailAddress for log lines).
 */
export interface AccountSummary {
  readonly id: string
  readonly emailAddress: string
}

export function listConnectableAccounts(db: Database): AccountSummary[] {
  return db.all<AccountSummary>(
    `SELECT id, email_address AS emailAddress FROM email_accounts ORDER BY connected_at DESC, id ASC`,
  )
}
