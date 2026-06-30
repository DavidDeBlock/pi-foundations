# 026 — Background poll scheduler + sync state observability

**Labels**: `email`, `v4`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-002](../35-prds/PRD-002-email-mirror.md)

## What to build

Email stays fresh without the user clicking "Refresh." A background scheduler runs `EmailSyncWorker` every `EMAIL_SYNC_INTERVAL_MIN` minutes (default 10). The `/email` view shows "Last synced X ago" and a "Syncing now..." indicator during in-progress runs. Manual refresh within the last 60 seconds short-circuits the next scheduled run (saves Gmail API quota). Only one sync runs at a time — a second trigger waits or is skipped, never runs in parallel.

## Acceptance criteria

- [ ] Background scheduler runs `EmailSyncWorker.sync({accountId})` at `EMAIL_SYNC_INTERVAL_MIN` interval (default 10), iterating over all connected accounts
- [ ] Scheduler starts on server boot (after migrations + OAuth bootstrap)
- [ ] Mutex: only one sync runs at a time per account; concurrent triggers wait or skip
- [ ] Manual `POST /api/email/sync` within last 60 seconds short-circuits the next scheduled run (records the skip, doesn't consume API quota)
- [ ] Scheduler is a no-op if no accounts are connected (no API calls)
- [ ] `/email` view shows "Last synced X ago" indicator (relative time, refreshes every 30s on the page)
- [ ] `/email` view shows "Syncing now..." indicator with a spinner while `inProgress = true`
- [ ] `/settings/email` shows per-account last sync time + total message count + in-progress flag
- [ ] Scheduler can be disabled by setting `EMAIL_SYNC_INTERVAL_MIN=0` (manual-only mode)
- [ ] Server logs each scheduled run with duration + counts (so issues are diagnosable from `/var/log/dashboard.log` or wherever logs land)
- [ ] Tests: scheduler fires at correct interval (use fake timers), mutex blocks parallel runs, skip-on-recent-manual, no-op when no accounts, `EMAIL_SYNC_INTERVAL_MIN=0` disables scheduler

## Blocked by

- [022](./022-email-read-api-querybuilder-searcher-retriever.md)

(can run in parallel with [024](./024-email-soft-delete-hide-unhide-hidden-view.md) and [025](./025-email-dashboard-tags-crud-autocomplete-filter.md))