# 021 — EmailSyncWorker + EmailDiffer + manual refresh + 90-day initial sync

**Labels**: `email`, `v4`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-002](../35-prds/PRD-002-email-mirror.md)

## What to build

With Gmail connected, the user can trigger an initial sync that pulls the last 90 days of mail into the dashboard's SQLite. Sync runs in pages, persists its cursor to `sync_state` after each successful page, and UPSERTs new/updated messages into the `emails` table. The UPSERT explicitly excludes the `hidden_at` column (added in 024) so local soft-deletes survive re-syncs. On failure mid-sync, the next attempt resumes from the last successful page — no re-processing of already-synced messages. The user triggers sync via a "Refresh" button on `/settings/email`; progress and counts (added/updated/removed) are visible after the run.

## Acceptance criteria

- [ ] Migration adds `emails` mirror table (one row per Gmail message, PK = Gmail's stable `id`) + `sync_state` table (cursor + last-sync timestamp per account)
- [ ] `EmailDiffer.diff(incoming, dbState) → {upserts, removes}` produces minimal CRUD ops
- [ ] `EmailSyncWorker.sync({accountId}) → {added, updated, removed, cursor}` runs pagination, UPSERTs messages, persists cursor after each page, returns counts
- [ ] `POST /api/email/sync` (optional `?account_id=`) triggers sync; returns the counts
- [ ] Sync runs idempotently — re-running against unchanged Gmail state produces zero writes
- [ ] Sync resumes from last cursor on failure (verify by killing mid-sync, restarting, confirming already-synced messages are not re-processed)
- [ ] Initial sync window defaults to last 90 days, configurable via `EMAIL_SYNC_HISTORY_DAYS` env var
- [ ] Rate-limit handling: 429 response from Gmail triggers exponential backoff + retry (not a hard failure)
- [ ] `GET /api/email/accounts/:id/status` returns `{lastSyncAt, inProgress, messagesSynced}` for observability
- [ ] "Refresh" button on `/settings/email` shows progress (in-progress indicator) + counts after sync completes
- [ ] Sync stores the plain-text body (extracted from Gmail's `text/plain` part); HTML body is skipped in v1; attachments are skipped (their existence is recorded but content is not downloaded)
- [ ] Tests: empty inbox, partial state with mixed new/updated/removed, failure mid-sync resumes from cursor, UPSERT preserves protected columns (seed `hidden_at`, re-sync, assert unchanged — even though `hidden_at` column doesn't exist yet, write the test such that the column exclusion is verified when 024 lands), 429 backoff retry

## Blocked by

- [020](./020-email-schema-oauth-gmail-client.md)


Dashboard listening on http://0.0.0.0:8080
^C ELIFECYCLE  Command failed.

❯ DASHBOARD_PASSWORD=secret pnpm start

> dashboard-server@0.1.0 start /home/david/projects/pi-foundations/projects/dashboard/server
> tsx src/index.ts

Failed to start dashboard server: EMAIL_TOKEN_ENCRYPTION_KEY is not set. Generate a 32-byte hex key (e.g. `openssl rand -hex 32`) and set it before starting the server. See /settings/email for details.
 ELIFECYCLE  Command failed with exit code 1.