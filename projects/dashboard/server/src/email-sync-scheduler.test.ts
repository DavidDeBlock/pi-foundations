// email-sync-scheduler.test.ts — issue #026
//
// End-to-end tests for the background poll scheduler. Each AC item
// gets at least one test:
//
//   * Fires at the configured interval (timer-based test plus a
//     direct `runOnce()` for the per-tick behavior).
//   * Per-account mutex: a manual trigger running mid-tick is
//     respected (caught `SyncInProgressError` → skip + log).
//   * Manual-trigger debounce: a recent user click skips the next
//     scheduled run (no Gmail API call).
//   * No-op when no accounts are connected.
//   * `intervalMin === 0` disables the scheduler (no timer armed).
//   * Lifecycle: start() idempotent, stop() cleans up.
//   * Per-account errors don't poison other accounts.
//
// We use a deterministic `IntervalScheduler` test double instead of
// `vi.useFakeTimers()` because the production code awaits
// `worker.sync()` inside the tick — `setTimeout` aliases in fake
// mode have surfaced flake in past projects. The double lets each
// test advance "ticks" by calling the captured callback, asserting
// observable side effects, and awaiting any in-flight work.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { createTokenCipher } from './token-encryption.js'
import {
  EmailSyncWorker,
  markManualTrigger,
} from './email-sync-worker.js'
import {
  DEFAULT_MANUAL_DEBOUNCE_MS,
  EmailSyncScheduler,
  type IntervalScheduler,
} from './email-sync-scheduler.js'
import type { GmailClient, RawEmail } from './gmail-client.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

// ─── Test helpers ────────────────────────────────────────────────────────

interface StubGmail {
  client: GmailClient
  /** Incremented each time the worker calls this client's
   *  listMessages (== once per `sync()` call from the worker's
   *  perspective, modulo upsert idempotency). */
  syncCalls: number
  listMessages: ReturnType<typeof vi.fn>
  getMessage: ReturnType<typeof vi.fn>
}

function buildStubGmail(): StubGmail {
  // Build the stub object first WITHOUT `client`, then add it at
  // the end so the closure inside listMessages can read it before
  // its declared on the object. Circular reference is intentional.
  const stub: StubGmail = {
    syncCalls: 0,
    client: undefined as unknown as GmailClient,
    listMessages: vi.fn(async () => {
      stub.syncCalls++
      return {
        messages: [{ id: 'msg-1', threadId: 't-1' }],
        nextPageToken: null,
      }
    }),
    getMessage: vi.fn(async (id: string): Promise<RawEmail> => ({
      id,
      threadId: 't-1',
      internalDate: '2024-06-01T10:00:00.000Z',
      snippet: 'snippet',
      subject: 'Subject',
      from: { name: 'Alice', email: 'alice@example.com' },
      to: [{ name: 'Bob', email: 'bob@example.com' }],
      cc: [],
      bodyPlain: 'body',
      labels: ['INBOX'],
      isUnread: true,
    })),
  }
  stub.client = {
    listMessages: stub.listMessages,
    getMessage: stub.getMessage,
  } as unknown as GmailClient
  return stub
}

interface TestEnv {
  db: Database
  cipher: ReturnType<typeof createTokenCipher>
  accountId: string
  accountAddress: string
  nowMsFn: () => number
  stub: StubGmail
  worker: EmailSyncWorker
  recorder: RecordingIntervalScheduler
}

async function buildTestEnv(accountOpts: {
  emailAddress?: string
} = {}): Promise<TestEnv> {
  const db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  const cipher = createTokenCipher(randomBytes(32))
  const id = randomUUID()
  db.run(
    `INSERT INTO email_accounts
       (id, provider, email_address, access_token_enc, refresh_token_enc, token_expires_at)
     VALUES (?, 'gmail', ?, ?, ?, ?)`,
    [
      id,
      accountOpts.emailAddress ?? 'me@gmail.com',
      cipher.encrypt('access'),
      cipher.encrypt('refresh'),
      new Date(Date.now() + 3600_000).toISOString(),
    ],
  )

  // Deterministic "now" so the 90-day lookback is testable.
  const nowMs = Date.parse('2024-06-01T12:00:00.000Z')
  const nowMsFn = (): number => nowMs
  const stub = buildStubGmail()
  const worker = new EmailSyncWorker({
    db,
    cipher,
    buildGmailClient: () => stub.client,
    nowMs: nowMsFn,
    historyDays: 90,
  })
  // Wrap the worker's buildGmailClient so each call increments a
  // single counter — `syncCalls` is the primary observability
  // signal across the tests. The worker's promise chain to list +
  // get messages happens after this, but the counter still matches
  // "how many times the scheduler invoked sync()".
  const recorder = makeRecordingIntervalScheduler()
  const recorderMarker = Symbol.for('recorder')
  ;(worker as unknown as { [recorderMarker]: typeof recorder })[recorderMarker] =
    recorder
  return {
    db,
    cipher,
    accountId: id,
    accountAddress: accountOpts.emailAddress ?? 'me@gmail.com',
    nowMsFn,
    stub,
    worker,
    recorder,
  }
}

/** Per-test fake timer double. Records the callback so tests can
 *  fire ticks manually without fake timers. */
interface RecordingIntervalScheduler extends IntervalScheduler {
  fire(): Promise<void>
  readonly intervalMsValues: number[]
  readonly armCount: number
}

function makeRecordingIntervalScheduler(): RecordingIntervalScheduler {
  const callbacks: Array<() => void | Promise<void>> = []
  const intervalMsValues: number[] = []
  let arms = 0
  const scheduler: IntervalScheduler = {
    schedule(cb, intervalMs) {
      arms++
      callbacks.push(cb)
      intervalMsValues.push(intervalMs)
      return () => {
        const idx = callbacks.indexOf(cb)
        if (idx !== -1) callbacks.splice(idx, 1)
      }
    },
  }
  const fire = async (): Promise<void> => {
    // Snapshot the list so callbacks that arm NEW timers in flight
    // don't fire recursively in the same tick. Await each callback's
    // returned promise so async work (worker.sync etc.) has time
    // to land before assertions run.
    const snapshot = callbacks.slice()
    for (const cb of snapshot) {
      await cb()
    }
  }
  const full = Object.assign(scheduler, {
    callbacks,
    intervalMsValues,
    fire,
  })
  Object.defineProperty(full, 'armCount', {
    get: () => arms,
    enumerable: true,
  })
  return full as unknown as RecordingIntervalScheduler
}

interface SchedulerHandle {
  readonly scheduler: EmailSyncScheduler
  readonly recorder: RecordingIntervalScheduler
  readonly worker: EmailSyncWorker
}

function makeScheduler(
  env: TestEnv,
  overrides: Partial<{
    intervalMin: number
    manualDebounceMs: number
    buildGmailClient: (id: string) => GmailClient
  }> = {},
): SchedulerHandle {
  const scheduler = new EmailSyncScheduler({
    db: env.db,
    worker: env.worker,
    intervalMin: overrides.intervalMin ?? 10,
    nowMs: env.nowMsFn,
    ...(overrides.manualDebounceMs !== undefined
      ? { manualDebounceMs: overrides.manualDebounceMs }
      : {}),
    intervalScheduler: env.recorder,
  })
  return { scheduler, recorder: env.recorder, worker: env.worker }
}

/** Add a second account to the test DB; the global stub GmailClient
 *  answers for any caller. */
function addSecondAccount(env: TestEnv, emailAddress: string): string {
  const id = randomUUID()
  env.db.run(
    `INSERT INTO email_accounts
       (id, provider, email_address, access_token_enc, refresh_token_enc, token_expires_at)
     VALUES (?, 'gmail', ?, ?, ?, ?)`,
    [
      id,
      emailAddress,
      env.cipher.encrypt('a'),
      env.cipher.encrypt('r'),
      new Date(Date.now() + 3600_000).toISOString(),
    ],
  )
  return id
}

// ─── Console spies ───────────────────────────────────────────────────────

let consoleLogSpy: ReturnType<typeof vi.spyOn>
let consoleErrorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  // Allow any in-flight promises (worker.sync call) to settle.
  await new Promise((r) => setTimeout(r, 1))
})

// ─── Tests ────────────────────────────────────────────────────────────────

describe('EmailSyncScheduler — start / stop lifecycle', () => {
  it('is inert when intervalMin === 0 (manual-only mode)', async () => {
    const env = await buildTestEnv()
    const { scheduler, recorder } = makeScheduler(env, { intervalMin: 0 })
    scheduler.start()
    expect(scheduler.isEnabled()).toBe(false)
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('disabled (intervalMin=0)'),
    )
    expect(recorder.armCount).toBe(0)
    // Idempotent stop.
    scheduler.stop()
  })

  it('start() arms exactly one timer with the right interval', async () => {
    const env = await buildTestEnv()
    const { scheduler, recorder } = makeScheduler(env)
    scheduler.start()
    expect(recorder.armCount).toBe(1)
    expect(recorder.intervalMsValues[0]).toBe(10 * 60 * 1000)
    scheduler.stop()
  })

  it('start() is idempotent — calling twice does not arm a second timer', async () => {
    const env = await buildTestEnv()
    const { scheduler, recorder } = makeScheduler(env)
    scheduler.start()
    scheduler.start()
    scheduler.start()
    expect(recorder.armCount).toBe(1)
    scheduler.stop()
  })

  it('stop() cancels the active timer; subsequent ticks do not fire', async () => {
    const env = await buildTestEnv()
    const { scheduler, recorder } = makeScheduler(env)
    scheduler.start()
    await recorder.fire()
    scheduler.stop()
    // After stop(), the captured callback list is empty —
    // fire() therefore runs nothing.
    await recorder.fire()
    expect(env.stub.syncCalls).toBe(1)
    // start() can rearm.
    scheduler.start()
    await recorder.fire()
    expect(env.stub.syncCalls).toBe(2)
    scheduler.stop()
  })
})

describe('EmailSyncScheduler — runOnce()', () => {
  it('runs the worker per connected account', async () => {
    const env = await buildTestEnv()
    const { scheduler } = makeScheduler(env)
    await scheduler.runOnce()
    expect(env.stub.syncCalls).toBe(1)
    env.db.close()
  })

  it('runs the worker once per account when multiple accounts are connected', async () => {
    const env = await buildTestEnv()
    addSecondAccount(env, 'other@gmail.com')
    const { scheduler } = makeScheduler(env)
    await scheduler.runOnce()
    expect(env.stub.syncCalls).toBe(2)
    env.db.close()
  })

  it('is a no-op (logged) when no accounts are connected', async () => {
    const env = await buildTestEnv()
    const db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    const cipher = createTokenCipher(randomBytes(32))
    // Plain worker — no accounts in this DB.
    const stub = buildStubGmail()
    const worker = new EmailSyncWorker({
      db,
      cipher,
      buildGmailClient: () => stub.client,
    })
    const recorder = makeRecordingIntervalScheduler()
    const scheduler = new EmailSyncScheduler({
      db,
      worker,
      intervalMin: 10,
      intervalScheduler: recorder,
    })
    await scheduler.runOnce()
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('no accounts connected'),
    )
    expect(stub.syncCalls).toBe(0)
    db.close()
    env.db.close()
  })

  it('per-account failure does not poison other accounts', async () => {
    const env = await buildTestEnv()
    const badId = addSecondAccount(env, 'bad@gmail.com')
    // Reconstruct the worker with a selective factory that throws
    // for the bad account. We can't override
    // `worker.buildGmailClient` post-construction because the worker
    // snapshots the factory at construction time.
    const stub = buildStubGmail()
    const worker = new EmailSyncWorker({
      db: env.db,
      cipher: env.cipher,
      buildGmailClient: (id) => {
        if (id === badId) {
          throw new Error('synthetic factory failure')
        }
        return stub.client
      },
      nowMs: env.nowMsFn,
      historyDays: 90,
    })
    const scheduler = new EmailSyncScheduler({
      db: env.db,
      worker,
      intervalMin: 10,
      nowMs: env.nowMsFn,
      intervalScheduler: env.recorder,
    })
    await scheduler.runOnce()
    // The healthy account still synced.
    expect(stub.syncCalls).toBe(1)
    // The error was logged.
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('synthetic factory failure'),
    )
    env.db.close()
  })
})

describe('EmailSyncScheduler — manual-trigger debounce', () => {
  it('skips a run if the user manually triggered within DEFAULT_MANUAL_DEBOUNCE_MS', async () => {
    const env = await buildTestEnv()
    markManualTrigger(env.db, env.accountId, env.nowMsFn())
    const { scheduler } = makeScheduler(env)
    await scheduler.runOnce()
    expect(env.stub.syncCalls).toBe(0)
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('user clicked Refresh'),
    )
    env.db.close()
  })

  it('runs normally after the debounce window has elapsed', async () => {
    const env = await buildTestEnv()
    markManualTrigger(
      env.db,
      env.accountId,
      env.nowMsFn() - (DEFAULT_MANUAL_DEBOUNCE_MS + 1),
    )
    const { scheduler } = makeScheduler(env)
    await scheduler.runOnce()
    expect(env.stub.syncCalls).toBe(1)
    env.db.close()
  })

  it('skips only the debounced account; other accounts still sync', async () => {
    const env = await buildTestEnv()
    const otherId = addSecondAccount(env, 'other@gmail.com')
    // Mark ONLY the seed account as recently triggered.
    markManualTrigger(env.db, env.accountId, env.nowMsFn())
    const { scheduler } = makeScheduler(env)
    await scheduler.runOnce()
    // Only the second account ran.
    expect(env.stub.syncCalls).toBe(1)
    // The other account's sync_state was populated by worker.sync()
    // (last_sync_at set, in_progress cleared).
    const otherState = env.db.get<{ in_progress: number; last_sync_at: string | null }>(
      `SELECT in_progress, last_sync_at FROM sync_state WHERE account_id = ?`,
      [otherId],
    )
    expect(otherState).toBeDefined()
    expect(otherState?.in_progress ?? 0).toBe(0)
    expect(otherState?.last_sync_at).not.toBeNull()
    // The seed account's sync_state row exists (from
    // markManualTrigger) but last_sync_at stayed NULL because the
    // scheduler skipped it. last_messages_synced remains 0.
    const seedState = env.db.get<{ in_progress: number; last_sync_at: string | null; last_messages_synced: number }>(
      `SELECT in_progress, last_sync_at, last_messages_synced FROM sync_state WHERE account_id = ?`,
      [env.accountId],
    )
    expect(seedState).toBeDefined()
    expect(seedState?.last_sync_at).toBeNull()
    expect(seedState?.last_messages_synced ?? 0).toBe(0)
    env.db.close()
  })

  it('honors a custom debounce window', async () => {
    const env = await buildTestEnv()
    // Custom 5s window.
    markManualTrigger(env.db, env.accountId, env.nowMsFn() - 10_000)
    const { scheduler } = makeScheduler(env, { manualDebounceMs: 5000 })
    await scheduler.runOnce()
    expect(env.stub.syncCalls).toBe(1) // ran (outside 5s window)
    // Now within the window: skipped.
    markManualTrigger(env.db, env.accountId, env.nowMsFn() - 1_000)
    await scheduler.runOnce()
    expect(env.stub.syncCalls).toBe(1) // still 1, no new run
    env.db.close()
  })
})

describe('EmailSyncScheduler — per-account mutex', () => {
  it('a manual sync in flight is respected: scheduler logs + skips that account', async () => {
    const env = await buildTestEnv()
    // Mark the account as already in_progress. The worker's
    // sync() throws SyncInProgressError when it sees
    // state.inProgress=true at the readSyncState() check.
    env.db.run(
      `INSERT INTO sync_state (account_id, provider, in_progress, started_at)
       VALUES (?, 'gmail', 1, ?)`,
      [env.accountId, new Date(env.nowMsFn()).toISOString()],
    )
    const { scheduler } = makeScheduler(env)
    await scheduler.runOnce()
    // The worker threw before reaching GmailClient, so syncCalls
    // is unchanged.
    expect(env.stub.syncCalls).toBe(0)
    // The skip was logged.
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('sync already in progress'),
    )
    env.db.close()
  })
})

describe('EmailSyncScheduler — interval firing', () => {
  it('a fired tick runs every connected account', async () => {
    const env = await buildTestEnv()
    addSecondAccount(env, 'other@gmail.com')
    const { scheduler, recorder } = makeScheduler(env)
    scheduler.start()
    const before = env.stub.syncCalls
    await recorder.fire()
    expect(env.stub.syncCalls).toBe(before + 2)
    scheduler.stop()
    env.db.close()
  })

  it('multiple ticks fire each time (idempotent re-syncs)', async () => {
    const env = await buildTestEnv()
    const { scheduler, recorder } = makeScheduler(env)
    scheduler.start()
    await recorder.fire()
    await recorder.fire()
    await recorder.fire()
    expect(env.stub.syncCalls).toBe(3)
    scheduler.stop()
    env.db.close()
  })

  it('a tick after a manual trigger is skipped; runs again after the debounce', async () => {
    const env = await buildTestEnv()
    const { scheduler, recorder } = makeScheduler(env)
    scheduler.start()
    await recorder.fire()
    expect(env.stub.syncCalls).toBe(1)
    // User clicks Refresh \u2192 mark the manual trigger.
    markManualTrigger(env.db, env.accountId, env.nowMsFn())
    // Next tick should skip.
    await recorder.fire()
    expect(env.stub.syncCalls).toBe(1)
    // Back-dating the manual trigger to > debounce-freshness
    // simulates the debounce window passing.
    markManualTrigger(
      env.db,
      env.accountId,
      env.nowMsFn() - (DEFAULT_MANUAL_DEBOUNCE_MS + 1000),
    )
    await recorder.fire()
    expect(env.stub.syncCalls).toBe(2)
    scheduler.stop()
    env.db.close()
  })
})

describe('EmailSyncWorker — markManualTrigger / wasManualTriggerWithinMs', () => {
  it('markManualTrigger is idempotent and overwrites the previous timestamp', async () => {
    const env = await buildTestEnv()
    const t0 = env.nowMsFn() - 5000
    const t1 = env.nowMsFn()
    markManualTrigger(env.db, env.accountId, t0)
    markManualTrigger(env.db, env.accountId, t1)
    const row = env.db.get<{ last_manual_trigger_at: string }>(
      `SELECT last_manual_trigger_at FROM sync_state WHERE account_id = ?`,
      [env.accountId],
    )
    expect(row?.last_manual_trigger_at).toBe(String(t1))
    env.db.close()
  })

  it('wasManualTriggerWithinMs handles missing sync_state rows', async () => {
    const env = await buildTestEnv()
    // No sync_state row exists yet — the predicate should return
    // false (so background polling isn't blocked by a fresh setup
    // that has never been manually synced).
    const { wasManualTriggerWithinMs } = await import(
      './email-sync-worker.js'
    )
    expect(
      wasManualTriggerWithinMs(env.db, env.accountId, 60_000, env.nowMsFn),
    ).toBe(false)
    env.db.close()
  })

  it('wasManualTriggerWithinMs returns true within the window and false beyond it', async () => {
    const env = await buildTestEnv()
    const { wasManualTriggerWithinMs } = await import(
      './email-sync-worker.js'
    )
    markManualTrigger(env.db, env.accountId, env.nowMsFn() - 30_000)
    expect(
      wasManualTriggerWithinMs(env.db, env.accountId, 60_000, env.nowMsFn),
    ).toBe(true)
    markManualTrigger(
      env.db,
      env.accountId,
      env.nowMsFn() - (60_000 + 1),
    )
    expect(
      wasManualTriggerWithinMs(env.db, env.accountId, 60_000, env.nowMsFn),
    ).toBe(false)
    env.db.close()
  })

  it('listConnectableAccounts returns all connected accounts', async () => {
    const env = await buildTestEnv({ emailAddress: 'first@gmail.com' })
    const id1 = addSecondAccount(env, 'second@gmail.com')
    const { listConnectableAccounts } = await import(
      './email-sync-worker.js'
    )
    const accounts = listConnectableAccounts(env.db)
    const ids = accounts.map((a) => a.id).sort()
    expect(ids).toEqual([id1, env.accountId].sort())
    expect(accounts.every((a) => a.emailAddress.length > 0)).toBe(true)
    env.db.close()
  })
})

describe('sync — env var EMAIL_SYNC_INTERVAL_MIN parsing', () => {
  it('loadConfig sets emailSyncIntervalMin to the parsed value', async () => {
    process.env.EMAIL_SYNC_INTERVAL_MIN = '7'
    const { loadConfig } = await import('./env.js')
    const cfg = await loadConfig()
    expect(cfg.emailSyncIntervalMin).toBe(7)
    delete process.env.EMAIL_SYNC_INTERVAL_MIN
  })

  it('loadConfig accepts EMAIL_SYNC_INTERVAL_MIN=0 (manual-only mode)', async () => {
    process.env.EMAIL_SYNC_INTERVAL_MIN = '0'
    const { loadConfig } = await import('./env.js')
    const cfg = await loadConfig()
    expect(cfg.emailSyncIntervalMin).toBe(0)
    delete process.env.EMAIL_SYNC_INTERVAL_MIN
  })

  it('loadConfig falls back to 10 for negative / non-numeric / empty values', async () => {
    process.env.EMAIL_SYNC_INTERVAL_MIN = '-3'
    const { loadConfig } = await import('./env.js')
    const cfg = await loadConfig()
    expect(cfg.emailSyncIntervalMin).toBe(10)
    delete process.env.EMAIL_SYNC_INTERVAL_MIN

    process.env.EMAIL_SYNC_INTERVAL_MIN = 'banana'
    const cfg2 = await loadConfig()
    expect(cfg2.emailSyncIntervalMin).toBe(10)
    delete process.env.EMAIL_SYNC_INTERVAL_MIN

    process.env.EMAIL_SYNC_INTERVAL_MIN = ''
    const cfg3 = await loadConfig()
    expect(cfg3.emailSyncIntervalMin).toBe(10)
    delete process.env.EMAIL_SYNC_INTERVAL_MIN
  })
})
