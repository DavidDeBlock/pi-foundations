// email-sync-scheduler.ts — issue #026
//
// Background poll scheduler. Runs `EmailSyncWorker.sync` for
// every connected account at a configurable interval. Designed
// for the v1 single-process server (Node's `setInterval`) —
// multi-worker deployment would need a Redis-style lock, not
// here.
//
// Invariants (each AC item):
//
//   1. **Per-account mutex** — the existing `EmailSyncWorker.sync`
//      throws `SyncInProgressError` if a sync is already running.
//      We catch it, log, and skip that account for this tick; we
//      never run two syncs for the same account in parallel.
//
//   2. **Manual-trigger debounce** — `wasManualTriggerWithinMs`
//      checks `sync_state.last_manual_trigger_at`. If the user
//      clicked Refresh within the last 60s, we skip this
//      account's run entirely (no Gmail API call, no
//      quota consumed). The skip is logged so operators can see
//      why the scheduler didn't run.
//
//   3. **Disabled when `intervalMin === 0`** — `start()` is a
//      no-op in that mode. The config still creates the
//      scheduler instance for symmetry, but no timer is
//      scheduled.
//
//   4. **No-op when no accounts are connected** — `runOnce`
//      iterates `listConnectableAccounts(db)`; an empty list is a
//      logged no-op (no Gmail API calls). The scheduler still
//      ticks at the interval, so newly connected accounts pick up
//      on the NEXT tick without manual restart.
//
//   5. **Lifecycle** — `start()` is called once after boot;
//      `stop()` is called on shutdown. Idempotent on either
//      side. The internal timer is `.unref()`-ed so a running
//      scheduler doesn't keep the Node process alive past
//      `serve()` shutdown.

import type { Database } from './db.js'
import {
  EmailSyncWorker,
  SyncInProgressError,
  listConnectableAccounts,
  type AccountSummary,
  wasManualTriggerWithinMs,
} from './email-sync-worker.js'

// ─── Configuration ───────────────────────────────────────────────────────

/** Manual-trigger debounce window, milliseconds. After a user
 *  clicks Refresh, the scheduler holds off for this many ms before
 *  firing the next scheduled run, saving Gmail API quota when the
 *  user's manual action is fresh in the UI. */
export const DEFAULT_MANUAL_DEBOUNCE_MS = 60_000

/**
 * Timer abstraction. The default implementation wraps
 * `setInterval` and `unref()`s the handle so the process can
 * exit cleanly. Tests inject a deterministic scheduler to avoid
 * relying on `vi.useFakeTimers` (which can race with real-async
 * work in this codebase).
 */
export interface IntervalScheduler {
  /**
   * Arm a recurring callback every `intervalMs`. Returns a
   * disposer the caller can call to cancel.
   */
  schedule(callback: () => void, intervalMs: number): () => void
}

export interface EmailSyncSchedulerDeps {
  readonly db: Database
  readonly worker: EmailSyncWorker
  /**
   * Polling interval, in minutes. `0` disables the scheduler
   * entirely (manual-only mode).
   */
  readonly intervalMin: number
  /** Injected clock; defaults to `Date.now`. */
  readonly nowMs?: () => number
  /** Manual-trigger debounce window in ms; default 60_000. */
  readonly manualDebounceMs?: number
  /** Timer abstraction; defaults to a `setInterval`-based
   *  implementation with `.unref()`. Tests inject a deterministic
   *  one. */
  readonly intervalScheduler?: IntervalScheduler
}

// ─── Default timer wrapper ──────────────────────────────────────────────

const defaultIntervalScheduler: IntervalScheduler = {
  schedule(callback, intervalMs) {
    const id = setInterval(callback, intervalMs)
    if (typeof id === 'object' && id !== null && 'unref' in id) {
      ;(id as { unref: () => void }).unref()
    }
    return () => clearInterval(id)
  },
}

// ─── Scheduler ──────────────────────────────────────────────────────────

export class EmailSyncScheduler {
  readonly #db: Database
  readonly #worker: EmailSyncWorker
  readonly #intervalMin: number
  readonly #nowMs: () => number
  readonly #manualDebounceMs: number
  readonly #intervalMs: number
  readonly #intervalScheduler: IntervalScheduler
  readonly #activeRuns: Set<string> = new Set()

  #cancelTimer: (() => void) | null = null

  constructor(deps: EmailSyncSchedulerDeps) {
    this.#db = deps.db
    this.#worker = deps.worker
    this.#intervalMin = deps.intervalMin
    this.#nowMs = deps.nowMs ?? (() => Date.now())
    this.#manualDebounceMs = deps.manualDebounceMs ?? DEFAULT_MANUAL_DEBOUNCE_MS
    this.#intervalMs = this.#intervalMin * 60_000
    this.#intervalScheduler = deps.intervalScheduler ?? defaultIntervalScheduler
  }

  /** Whether `start()` would actually arm a timer. When
   *  `intervalMin === 0` the scheduler is intentionally inert
   *  — manual-only mode. */
  isEnabled(): boolean {
    return this.#intervalMin > 0
  }

  /** Begin polling at the configured interval. Idempotent —
   *  calling twice is a no-op (the second call returns without
   *  re-arming the timer). */
  start(): void {
    if (this.#cancelTimer !== null) return
    if (!this.isEnabled()) {
      // eslint-disable-next-line no-console
      console.log(
        '[email-sync-scheduler] disabled (intervalMin=0). Manual triggers only.',
      )
      return
    }
    // eslint-disable-next-line no-console
    console.log(
      `[email-sync-scheduler] starting; interval=${this.#intervalMin}min, manualDebounce=${this.#manualDebounceMs}ms`,
    )
    this.#cancelTimer = this.#intervalScheduler.schedule(
      () => this.#runOnceSafe(),
      this.#intervalMs,
    )
  }

  /** Tear down the timer and refuse further ticks. Idempotent. */
  stop(): void {
    if (this.#cancelTimer === null) return
    this.#cancelTimer()
    this.#cancelTimer = null
  }

  /**
   * Execute one tick of the scheduler across every connected
   * account. Public so tests can drive it deterministically
   * without advancing fake timers.
   *
   * Errors are caught per-account and logged; one misbehaving
   * account doesn't poison the rest of the tick.
   */
  async runOnce(): Promise<void> {
    await this.#runOnceSafe()
  }

  async #runOnceSafe(): Promise<void> {
    const accounts = listConnectableAccounts(this.#db)
    if (accounts.length === 0) {
      // eslint-disable-next-line no-console
      console.log('[email-sync-scheduler] tick: no accounts connected')
      return
    }
    for (const account of accounts) {
      try {
        await this.#runForAccount(account)
      } catch (err: unknown) {
        // Defensive guard so one bad account doesn't break the iteration.
        // eslint-disable-next-line no-console
        console.error(
          `[email-sync-scheduler] account ${account.id} (${account.emailAddress}) crashed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
  }

  async #runForAccount(account: AccountSummary): Promise<void> {
    if (this.#activeRuns.has(account.id)) {
      // Should not happen — start() arms a single timer — but
      // defensively guard so an externally-injected runOnce()
      // running concurrently with a timer tick doesn't double-fire.
      // eslint-disable-next-line no-console
      console.log(
        `[email-sync-scheduler] account ${account.id} already running (internal lock); skipping this tick`,
      )
      return
    }
    if (
      wasManualTriggerWithinMs(
        this.#db,
        account.id,
        this.#manualDebounceMs,
        this.#nowMs,
      )
    ) {
      // eslint-disable-next-line no-console
      console.log(
        `[email-sync-scheduler] account ${account.id} (${account.emailAddress}) skipped: user clicked Refresh within ${this.#manualDebounceMs}ms`,
      )
      return
    }
    this.#activeRuns.add(account.id)
    const startedAt = this.#nowMs()
    try {
      const result = await this.#worker.sync({ accountId: account.id })
      const elapsedMs = this.#nowMs() - startedAt
      // eslint-disable-next-line no-console
      console.log(
        `[email-sync-scheduler] account ${account.id}: +${result.added} ~${result.updated} -${result.removed} (${result.pages} page(s), ${elapsedMs}ms)`,
      )
    } catch (err: unknown) {
      if (err instanceof SyncInProgressError) {
        // eslint-disable-next-line no-console
        console.log(
          `[email-sync-scheduler] account ${account.id}: skip — sync already in progress`,
        )
        return
      }
      throw err
    } finally {
      this.#activeRuns.delete(account.id)
    }
  }
}
