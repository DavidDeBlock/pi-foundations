# YT-009 — Subscription recent-video backfill

**Labels**: `youtube`, `v3.1`, `subscriptions`, `needs-triage`
**Type**: AFK (real-account smoke required)
**Parent**: [PRD-004](../35-prds/PRD-004-youtube-library-history-playlists-backfill.md)

## What to build

Import recent uploads when a subscription is first discovered and on explicit request. Use the channel's official uploads playlist, not `search.list`, and reuse the canonical video upsert from YT-008.

## Acceptance criteria

- [ ] `youtube_preferences` stores per-account `new_subscription_backfill_days` constrained to `0|7|30|90`, default `30`
- [ ] existing subscriptions present at migration time are marked initialized and are NOT automatically backfilled
- [ ] newly discovered included subscriptions queue the configured backfill; excluded subscriptions do not auto-queue
- [ ] batched `channels.list(part=contentDetails)` resolves uploads-playlist ids and paginated `playlistItems.list(maxResults=50)` fetches newest uploads
- [ ] fetch stops after crossing the requested cutoff or inspecting 500 items; missing/private/deleted items are skipped and counted
- [ ] `POST /api/subscriptions/:id/backfill` validates `{days:7|30|90}`, prevents concurrent duplicate jobs, and returns 202 job state
- [ ] `GET /api/subscriptions/:id/backfill` exposes pending/running/completed/failed, requested days, imported/skipped counts, timestamps, and safe error text
- [ ] GET/PATCH `/api/youtube/preferences` exposes the global default
- [ ] subscription UI includes the global selector and per-row **Import recent videos** action with live progress/result feedback
- [ ] repeated backfills create no duplicate videos or origins
- [ ] historical backfill does not automatically request transcripts or MiniMax summaries
- [ ] one channel failure does not fail other new-subscription backfills; quota/rate failures are retryable
- [ ] tests cover cutoff pagination, pre-existing-subscription safeguard, idempotency, excluded channels, concurrency, restart recovery, API, and UI

## Blocked by

- [YT-008](./YT-008-canonical-youtube-library-foundation.md)

