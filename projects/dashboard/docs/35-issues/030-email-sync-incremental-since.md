# 030 — Incremental sync: pick up where we left off (`since = lastSyncAt − 60s`)

**Labels**: `email`, `v4`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-002](../35-prds/PRD-002-email-mirror.md), [021](./021-email-sync-worker-differ-initial-sync.md)

## Bug

`EmailSyncWorker.sync` only passes `since` to `GmailClient.listMessages` on the **first** sync for an account:

```ts
const since: string | undefined = isFirstSync
  ? sinceForDays(req.historyDays ?? this.#defaultHistoryDays, this.#nowMs)
  : undefined
```

After the first sync completes, `state.lastPageToken` is `null` (cursor at the end), and `since` is unset. The scheduler's next tick calls `listMessages({pageToken: null})` — no `q` filter, no cursor — and Gmail returns the first page of **every message in the mailbox**. The worker paginates through the full inbox, re-fetching every message body via `getMessage`. The differ catches most as no-op matches, but Gmail API quota is burned on every scheduled tick.

## What to build

Subsequent syncs (`lastSyncAt IS NOT NULL`) use a `since` derived from `state.lastSyncAt` instead of starting from page 1. The 90-day window stays the **first-sync** default. The `pageToken` mechanism keeps its current role: resuming an interrupted sync within a single run, not bounding work across runs.

### Behaviour matrix

| State before this run | `since` | `pageToken` |
|---|---|---|
| First sync ever (`lastSyncAt IS NULL`, `lastPageToken IS NULL`) | `now − defaultHistoryDays` (90 by default) | `null` |
| Resume of interrupted first sync (`lastSyncAt IS NULL`, `lastPageToken IS NOT NULL`) | `now − defaultHistoryDays` (unchanged) | `state.lastPageToken` |
| Subsequent sync (`lastSyncAt IS NOT NULL`) | `state.lastSyncAt − 60s` safety margin | `null` (start fresh, `since` does the filtering) |

The safety margin (60s back from `lastSyncAt`) covers Gmail's `internalDate` indexing lag — a message that arrived in the second before the previous sync completed can have a timestamp slightly older than `lastSyncAt` and would otherwise be missed.

## Acceptance criteria

- [ ] `EmailSyncWorker.sync` resolves `since` per the matrix above
- [ ] Subsequent sync passes `since = state.lastSyncAt − 60s` and **does not** pass `pageToken` (verified by inspecting the GmailClient.listMessages args the worker constructs)
- [ ] Resume of an interrupted first sync still uses the 90-day `since` AND the persisted `pageToken` (regression test: seed `lastPageToken` with a value, leave `lastSyncAt` null, run sync, assert both args passed)
- [ ] First successful sync persists `last_sync_at`; second sync uses that timestamp as the new `since` lower bound (no overlap, no missed messages — verified via GmailClient mock asserting `q=after:<last_sync_at − 60s>` on the second call)
- [ ] **No** per-tick lookback cap introduced (out of scope for this slice — see "Not in scope")
- [ ] The `last_manual_trigger_at` debounce in the scheduler is unchanged
- [ ] **Tests:**
  - Subsequent sync uses `since = lastSyncAt − 60s` and no `pageToken` (GmailClient mock asserts exact args)
  - Safety margin: `lastSyncAt = T` → `since` arg passed to listMessages is `T − 60_000ms` as ISO
  - Two consecutive successful syncs: second call's `q=after:` arg equals `firstCall.lastSyncAt − 60s` (no manual offset)
  - Resume of an interrupted first sync: `lastPageToken = "abc"`, `lastSyncAt = null` → `listMessages` called with both `since = now − 90d` AND `pageToken = "abc"`
  - Subsequent sync + crash mid-run: `lastPageToken` is persisted (for in-run resume), and the **next** sync (after `lastSyncAt` is updated) uses `since` again — confirm by re-running with `lastSyncAt` set and a stale `lastPageToken` and asserting `pageToken` is `undefined`
  - Idempotent UPSERTs still hold: any overlap from the 60s safety margin is silently matched (zero writes in the differ)
  - Existing first-sync tests still pass (no regression)

## Blocked by

- [021](./021-email-sync-worker-differ-initial-sync.md), [026](./026-email-background-poll-sync-observability.md)

## Not in scope (deferred)

- Per-tick lookback cap (e.g. "max 7 days per scheduled tick") — punt until we see a real quota issue
- "Sync last N days" UI buttons — once the worker is incremental, the original need dissolves; revisit only if backfill-from-zero becomes a real workflow
- Changes to the `EMAIL_SYNC_HISTORY_DAYS` env var or its docs (still 90 by default; still applies to first sync only)
- Refactoring the scheduler / debounce logic