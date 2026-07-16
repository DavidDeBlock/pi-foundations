# YT-002 — subscriptions schema + SubscriptionsFetcher + SubscriptionsSync + daily scheduler

**Labels**: `youtube`, `v3.0`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-003](../35-prds/PRD-003-youtube-v3-subscriptions.md)

## What to build

After OAuth is granted, the dashboard auto-imports all of David's subscriptions via the YouTube Data API `subscriptions.list` endpoint. A `SubscriptionsFetcher` deep module handles paginated API calls; a `SubscriptionsSync` deep module diffs incoming subscriptions against DB state by `channel_id` and produces minimal INSERT/UPDATE/DELETE. A daily scheduler triggers the sync. A manual sync endpoint is also available. Subscriptions are written with `is_included = true` and `is_important = false` by default.

## Acceptance criteria

- [x] Migration adds `subscriptions` table per PRD-003 schema: `id, channel_id (UNIQUE), title, thumbnail_url, subscribed_at, is_included (DEFAULT 1), is_important (DEFAULT 0), last_polled_at (nullable), created_at, updated_at`
- [x] `SubscriptionsFetcher` deep module exposes `fetchAll(accessToken) → Subscription[]`; paginates `subscriptions.list` with `part=snippet`, `mine=true`, `maxResults=50`; handles empty result
- [x] `SubscriptionsSync` deep module exposes `sync(incoming: Subscription[]) → { added, updated, removed, unchanged }`; identity is `channel_id`; INSERT new rows, UPDATE changed fields (`title`, `thumbnail_url`, `subscribed_at`), DELETE rows not in incoming; idempotent on second run (returns `unchanged === incoming.length`)
- [x] New rows default to `is_included = true`, `is_important = false`
- [x] Daily scheduler: registers a 24h interval that calls `SubscriptionsFetcher` (auto-refreshing token via `YouTubeOAuthClient`) then `SubscriptionsSync`; logs `{added, updated, removed, unchanged, ran_at}`
- [x] `POST /api/youtube/sync` triggers a manual sync; returns `{ added, updated, removed, unchanged, ran_at }`
- [x] Auto-triggered on first OAuth grant (so the dashboard is populated within ~30s of connecting)
- [x] Tests: `SubscriptionsFetcher` against sample Data API responses (single page, multiple pages, empty); `SubscriptionsSync` for empty / all-new / all-same / mixed (add+update+remove) / idempotency scenarios; manual sync endpoint returns correct counts; daily scheduler is registered on boot
- [ ] Manual smoke: connect YouTube → see subscriptions in DB; call sync again → `unchanged === total`

## Blocked by

- [YT-001](./YT-001-youtube-oauth-client-and-settings.md) (needs OAuth + `YouTubeOAuthClient`)