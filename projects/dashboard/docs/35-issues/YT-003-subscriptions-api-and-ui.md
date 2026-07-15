# YT-003 — Subscriptions API + SubscriptionsView UI

**Labels**: `youtube`, `v3.0`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-003](../35-prds/PRD-003-youtube-v3-subscriptions.md)

## What to build

David can see and manage his subscriptions from `/subscriptions`. The page shows a paginated list of channels with thumbnail, title, link to YouTube, and two inline toggles per row: `is_included` (drops music channels from the dashboard view without unsubscribing on YouTube) and `is_important` (reserved for the future LLM job; no behavior in v3.0). Filter chips (All / Included / Excluded), a search box, and a "Sync now" button round out the page. Toggles persist immediately via PATCH without a full page reload, matching v1's categorize UI patterns.

## Acceptance criteria

- [ ] `GET /api/subscriptions?filter=included|excluded|all&search=&page=&limit=` returns paginated `{ items: [...], total, page, limit }`; defaults `filter=all`, `limit=50`, sorted by `title ASC`
- [ ] Each item: `{ id, channel_id, title, thumbnail_url, subscribed_at, is_included, is_important, last_polled_at }`
- [ ] `PATCH /api/subscriptions/:id` accepts `{ is_included?, is_important? }` (both optional; only updates provided fields); returns updated row
- [ ] Toggling `is_included` updates DB and is visible in next GET within 1s; the change is consumed by the RSS poller (YT-004) within the next poll cycle
- [ ] Toggling `is_important` updates DB; **no behavior change in v3.0** (column is reserved for the future LLM job)
- [ ] `/subscriptions` page renders server-side HTML with the list, filter chips, search input, and "Sync now" button — reuses the existing card + sidebar patterns from v1
- [ ] Toggling `is_included` or `is_important` updates via PATCH using fetch + DOM patch (no full page reload), matching v1's categorize UI behavior
- [ ] Filter chips change the URL query (`?filter=included`) and re-render the list
- [ ] Search filters by channel title (case-insensitive substring)
- [ ] "Sync now" button posts to `/api/youtube/sync` and shows the result counts (`added / updated / removed / unchanged`) in an inline message
- [ ] Page shows total counts: included N, excluded M, all N+M
- [ ] Tests: API contract for list (filters, search, pagination) + PATCH (validates payload); UI smoke test for toggle persistence + filter chips + sync-now flow
- [ ] Manual smoke: load `/subscriptions`, toggle a channel off, reload page, see it under "Excluded"; click sync-now, see counts inline

## Blocked by

- [YT-002](./YT-002-subscriptions-schema-fetcher-sync.md) (needs `subscriptions` rows in DB)