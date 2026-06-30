// email-sync.ts — issue #021
//
// HTTP routes that drive the email sync worker:
//
//   POST /sync                              — manual refresh trigger
//                                             (optional ?account_id=)
//                                             kicks off the worker in
//                                             the background; returns
//                                             202 with the target
//                                             accountId. The page
//                                             polls /status until
//                                             done (see below).
//   GET  /accounts/:id/status               — observability: the
//                                             shape promised by the AC
//                                             ({lastSyncAt,
//                                             inProgress,
//                                             messagesSynced}) plus
//                                             the breakdown the UI
//                                             shows after a run
//                                             (added/updated/removed
//                                             from the latest run).
//
// Why kick off + poll (vs block-on-sync):
//   The initial 90-day sync can take several minutes for a large
//   inbox — far longer than any sane HTTP timeout. The kick + poll
//   pattern lets the browser render a "syncing…" indicator (via the
//   vanilla-JS block in email-settings.ts) while the server does the
//   work.
//
// Why 202 Accepted:
//   Matches the kick-off semantics. A 200 would imply the sync
//   already completed; 202 says "the request has been accepted for
//   processing".

import { Hono } from 'hono'
import type { Database } from './db.js'
import type { AuthVariables } from './auth.js'
import type { TokenCipher } from './token-encryption.js'
import type {
  EmailSyncWorker,
} from './email-sync-worker.js'
import {
  AccountNotFoundError,
  NoAccountsError,
  SyncInProgressError,
  defaultAccountId,
} from './email-sync-worker.js'

// ─── Hono sub-app ─────────────────────────────────────────────────────────

export interface EmailSyncDeps {
  readonly db: Database
  readonly cipher: TokenCipher
  readonly worker: EmailSyncWorker
  /** Injected for tests; default `Date.now`. */
  readonly nowMs?: () => number
}

export function emailSyncApi(
  deps: EmailSyncDeps,
): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()
  const nowMs = deps.nowMs ?? (() => Date.now())

  // ─── POST /sync ─────────────────────────────────────────────────────
  // Manual refresh trigger. The `?account_id=` query param is
  // optional; if absent we pick the most-recently-connected account.
  // Sync runs in the background — we return 202 immediately. Errors
  // during the sync are NOT surfaced via this response (the sync is
  // already in flight); the poller observes `inProgress` flipping to
  // false and `lastSyncAt` either updating or staying old.
  api.post('/sync', (c) => {
    let accountId = c.req.query('account_id') ?? ''
    try {
      if (accountId === '') accountId = defaultAccountId(deps.db)
    } catch (err: unknown) {
      if (err instanceof NoAccountsError) {
        return c.json({ ok: false, error: 'no_accounts' }, 400)
      }
      throw err
    }

    // Pre-flight: surface common failures synchronously so the UI
    // can show a clean error rather than spinning forever on a
    // status that won't change.
    const statusBefore = deps.worker.status(accountId)
    if (statusBefore.inProgress) {
      // Idempotent: just tell the caller it's already running, and
      // let the existing poll loop pick up the result.
      return c.json(
        {
          ok: true,
          started: false,
          reason: 'already_in_progress',
          accountId,
        },
        202,
      )
    }

    // Fire-and-forget. The worker handles its own locking +
    // cursor persistence + error cleanup. We log a failure but
    // deliberately don't throw — the caller's already left.
    void deps.worker
      .sync({ accountId })
      .then((result) => {
        // eslint-disable-next-line no-console
        console.log(
          `[email-sync] account ${accountId}: +${result.added} ~${result.updated} -${result.removed} (${result.pages} page(s))`,
        )
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(
          `[email-sync] account ${accountId} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      })

    return c.json(
      {
        ok: true,
        started: true,
        accountId,
        startedAt: new Date(nowMs()).toISOString(),
      },
      202,
    )
  })

  // ─── GET /accounts/:id/status ──────────────────────────────────────
  // Observability + the polling endpoint the UI uses. Shape matches
  // the AC (`{lastSyncAt, inProgress, messagesSynced}`); we add
  // `lastAdded/Updated/Removed` (count breakdown from the most
  // recent run) so the UI can render the post-sync summary without
  // an extra request.
  api.get('/accounts/:id/status', (c) => {
    const id = c.req.param('id')
    const status = deps.worker.status(id)
    return c.json({
      accountId: id,
      lastSyncAt: status.lastSyncAt,
      inProgress: status.inProgress,
      messagesSynced: status.lastMessagesSynced,
      lastAdded: status.lastAdded,
      lastUpdated: status.lastUpdated,
      lastRemoved: status.lastRemoved,
      startedAt: status.startedAt,
    })
  })

  return api
}

// Re-export error classes so the test file can `instanceof`-check
// them without chasing the import path.
export {
  AccountNotFoundError,
  NoAccountsError,
  SyncInProgressError,
}
