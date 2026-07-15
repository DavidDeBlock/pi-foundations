# [PRD] Dashboard v3.0 — YouTube subscriptions + new-video detection

**Labels**: `parent-prd`, `v3.0`
**Date**: 2026-07-15
**Status**: Draft

## Problem Statement

David has ~100 YouTube subscriptions, but most of the value comes from ~20 of them. The rest are music channels he watches on YouTube itself. He wants a daily dashboard view that:

- Shows him new uploads from the channels he cares about, organized using the same folders/tags model as his bookmarks
- Lets him drop the music channels from this view without unsubscribing on YouTube
- Eventually (deferred to v3.x) summarizes each new video via LLM so he can skim instead of watch

He wants this without losing the freedom to manage subscriptions on YouTube.com itself — the dashboard reads YouTube, it doesn't own the subscription list.

## Solution

**Dashboard v3.0** adds:

- **OAuth with YouTube** — one-time grant, `youtube.readonly` scope (plus `youtube.force-ssl` if `subscriptions.list` requires it)
- **Subscriptions import** — pulls all of David's subscriptions into a dashboard table, refreshed daily
- **Subscription filter UX** — a Subscriptions page where David toggles each subscription's `is_included` (drop music) and `is_important` (reserve for future LLM)
- **RSS-based new-video detection** — every 15 minutes, the server polls the public RSS feed for each included subscription, inserts new video entries into a `videos` table
- **Categorization for new videos** — reuses the existing folders/tags model; no auto-categorization
- **View new videos** — a Videos page (paginated, filterable); per-video detail with categorize controls

The dashboard reads YouTube; it does not write back to it. Saves, mirror, watch history, transcripts, and LLM summarization are deferred to v3.1 / v3.x.

## User Stories

### OAuth & connection

1. As David, I visit the dashboard's YouTube settings page and click "Connect YouTube", so I can grant the dashboard read access to my subscriptions.
2. As David, I am redirected to Google's OAuth consent screen, see the dashboard is requesting read-only access to my YouTube data, and click Allow.
3. As David, after granting access I land back on the dashboard with a green "Connected" badge, so I know the integration is live.
4. As David, I can see when I last connected YouTube and when my access token was last refreshed, so I know the integration's freshness.
5. As David, I can disconnect YouTube from the dashboard, which revokes my token and stops all polling, so I can opt out cleanly.
6. As David, I can reconnect YouTube if my token expires or is revoked, so transient auth failures don't lock me out.

### Subscriptions import

7. As David, on first connection the dashboard imports all my YouTube subscriptions within ~30 seconds, so the Subscriptions page is populated immediately.
8. As David, every subscription shows up in the Subscriptions page with its channel name, thumbnail, and a link to the YouTube channel, so I can recognize them.
9. As David, the dashboard refreshes my subscriptions daily, so newly-subscribed or unsubscribed channels appear without manual action.
10. As David, if I unsubscribe from a channel on YouTube, the next daily refresh removes it from my dashboard subscriptions list.
11. As David, if I subscribe to a new channel on YouTube, the next daily refresh adds it to my dashboard subscriptions list with `is_included=true` by default.
12. As David, a manual "Sync now" button on the Subscriptions page triggers an immediate refresh, so I don't have to wait for the daily job after making changes on YouTube.

### Subscription filter

13. As David, every subscription has an `is_included` toggle (default on), so I can drop music channels from the dashboard view without unsubscribing on YouTube.
14. As David, every subscription has an `is_important` toggle (default off), so I can flag the channels I care most about for the future LLM-summary job.
15. As David, toggling `is_included` off stops that channel's RSS polling immediately, so excluded channels produce no new video entries.
16. As David, toggling `is_included` back on resumes polling for that channel, so I can re-enable a channel without losing history.
17. As David, the Subscriptions page filters by `is_included` (All / Included / Excluded), so I can focus on the list I care about.
18. As David, the Subscriptions page shows a count of included vs excluded channels, so I know how many I've filtered out.
19. As David, my `is_included` and `is_important` choices persist across dashboard restarts and token refreshes.

### New-video detection (RSS)

20. As David, the dashboard polls the RSS feed of every `is_included=true` subscription every 15 minutes, so new uploads appear in my dashboard within ~15 min of being published.
21. As David, when a channel publishes a new video, a new row appears in the `videos` table with title, channel, thumbnail, publish time, and link to YouTube.
22. As David, the same new video never gets inserted twice (idempotent by `video_id`), so re-polling doesn't duplicate.
23. As David, if a channel's RSS feed returns an error (404, network blip), only that channel's polling is skipped that round — other channels continue, so one broken channel doesn't break the dashboard.
24. As David, the dashboard records `last_polled_at` per subscription, so I can see in the Subscriptions page when each channel was last checked.
25. As David, if a channel hasn't published in months, its `last_polled_at` is still recent (15 min ago), so I can distinguish "stale because we stopped polling" from "stale because nothing's new."
26. As David, the RSS poller caps concurrent requests to a sane number (e.g. 5), so a sudden poll burst doesn't overwhelm YouTube or the server.

### Viewing new videos

27. As David, the Videos page shows new videos reverse-chronological by `discovered_at`, so I see what just dropped.
28. As David, I can filter the Videos view by channel, folder, and tag, so I can narrow to one channel or category.
29. As David, I can paginate through the Videos view (default 50 per page), so the page stays fast with many videos.
30. As David, each video card shows title, channel name + thumbnail, publish date, discovered date, and current folder/tags, so I can see everything at a glance.
31. As David, I can click any video card to open its detail page with full info (title, link to YouTube, channel, folder, tags, when discovered, when published).

### Categorizing videos

32. As David, I can move a video into a folder using the existing folder picker, so I can organize new videos the same way as bookmarks.
33. As David, I can add tags to a video using the existing tag autocomplete + create-on-the-fly, so multi-axis organization works the same as bookmarks.
34. As David, I can remove a tag from a video, so tags can be cleaned up.
35. As David, I can rename a video's title inline (e.g. to fix typos or annotate), so the dashboard is more useful than YouTube's title alone.
36. As David, video categorization changes are reflected immediately in the Videos view, so the UI feels live.
37. As David, when I categorize a video, that decision persists and is visible across page reloads and dashboard restarts.

### Authorization & data

38. As David, only I can view my subscriptions and videos (HTTP Basic auth), so my watchlist is private.
39. As David, the YouTube OAuth token is stored server-side only (never in the browser or extension), so a compromised browser can't leak it.
40. As David, the YouTube access token is refreshed automatically before expiry, so polling doesn't break due to expired tokens.
41. As David, I can audit the server logs to see OAuth grant events, daily sync results, and RSS poll results per channel, so I can troubleshoot if something looks off.

### Operational

42. As David, the dashboard server starts the RSS poller as a background job on boot, so I don't have to start it manually.
43. As David, if the server is down for a few hours, the next boot catches up on RSS polling for all included subscriptions, so I don't permanently miss new uploads.
44. As David, RSS polling failures are logged with channel ID and error message, so I can diagnose which channel is misbehaving.
45. As David, I can run a manual "Poll now" from a settings/debug page to force a poll cycle, so I don't have to wait for the 15-min cron during testing.

## Implementation Decisions

### Modules

**Deep modules (unit-tested in isolation):**

| Module | Purpose |
|---|---|
| `YouTubeOAuthClient` | Wraps Google OAuth flow with `youtube.readonly` scope; manages token storage + refresh |
| `SubscriptionsFetcher` | Calls Data API `subscriptions.list` (paginated); normalizes response to typed `Subscription[]` |
| `SubscriptionsSync` | Diffs incoming subscriptions against DB state by `channel_id`; produces minimal CRUD ops; idempotent |
| `RssFeedFetcher` | Fetches `youtube.com/feeds/videos.xml?channel_id=...`; parses Atom XML → `FeedEntry[]` |
| `VideoIngest` | Diffs incoming feed entries against `videos` table by `video_id`; inserts new rows; idempotent |
| `RssPoller` | Per-channel loop over `is_included=true` subs; orchestrates `RssFeedFetcher` + `VideoIngest`; isolates per-channel failures; records `last_polled_at`; caps concurrency |

**Thin orchestrators (integration-tested):**

- `YouTubeSyncScheduler` — daily trigger of `SubscriptionsSync`
- `YouTubeRssJob` — every-15-min trigger of `RssPoller`
- `YouTubeConnectionService` — manages OAuth lifecycle (start, callback, status, disconnect)

**External-facing modules (HTTP boundaries, API-tested):**

- `YouTubeAuthAPI` — `/api/youtube/oauth/*` (start, callback, status, disconnect)
- `SubscriptionsAPI` — `GET /api/subscriptions`, `PATCH /api/subscriptions/:id`, `POST /api/youtube/sync`
- `VideosAPI` — `GET /api/videos`, `GET /api/videos/:id`, `PATCH /api/videos/:id`, `POST /api/videos/:id/tags`, `DELETE /api/videos/:id/tags/:tagId`

**UI modules (server-rendered HTML; E2E / smoke-tested):**

- `YouTubeConnectionView` — connect / disconnect / status page
- `SubscriptionsView` — list with `is_included` + `is_important` toggles, filter chips, "Sync now" button
- `NewVideosView` — paginated Videos feed with filters (channel, folder, tag)
- `VideoDetailView` — single video with categorize controls (folder picker, tag input, inline title edit)

**Storage additions:**

- New migrations: `migrations/NNN-youtube-subscriptions.sql`, `migrations/NNN-youtube-videos.sql`
- Reuses: `Database` wrapper, `TagNormalizer`, `folders` table, `tags` table, `bookmark_tags` pattern

### Schema

| Table | Purpose | Key fields | Notes |
|---|---|---|---|
| `subscriptions` | One row per YouTube subscription | `id, channel_id (unique), title, thumbnail_url, subscribed_at, is_included, is_important, last_polled_at, created_at, updated_at` | `is_included` default true; `is_important` default false (reserved for future LLM job, no behavior in v3.0) |
| `videos` | One row per discovered video | `id, video_id (unique), channel_id (FK→subscriptions.channel_id), title, published_at, thumbnail_url, link, discovered_at, folder_id (nullable FK→folders), created_at, updated_at` | Identity by `video_id`; FK to subscriptions |
| `video_tags` | Many-to-many | `video_id, tag_id (composite PK)` | Mirrors `bookmark_tags` pattern |

### API contracts

All `/api/youtube/*`, `/api/subscriptions/*`, and `/api/videos/*` routes require authentication (HTTP Basic for UI; the same Bearer-token model used by the existing extension endpoints, if extended).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/youtube/connection` | Status: connected? last refresh? |
| POST | `/api/youtube/oauth/start` | Begin OAuth; returns redirect URL |
| GET | `/api/youtube/oauth/callback` | OAuth redirect handler |
| DELETE | `/api/youtube/connection` | Disconnect; revoke token |
| POST | `/api/youtube/sync` | Manual subscriptions sync; returns counts (added/updated/removed) |
| GET | `/api/subscriptions` | List subscriptions; supports `?filter=included\|excluded\|all&search=&page=&limit=` |
| PATCH | `/api/subscriptions/:id` | Update `is_included` and/or `is_important` |
| GET | `/api/videos` | List videos; supports `?channel_id=&folder_id=&tag_id=&page=&limit=` |
| GET | `/api/videos/:id` | One video |
| PATCH | `/api/videos/:id` | Update `folder_id` and/or `title` |
| POST | `/api/videos/:id/tags` | Add tag (body: `{ name }`) |
| DELETE | `/api/videos/:id/tags/:tagId` | Remove tag |

### UI paths

| Path | View |
|---|---|
| `/settings/youtube` | YouTube connection status, connect/disconnect |
| `/subscriptions` | Subscriptions list with toggles, filters, sync-now |
| `/videos` | New videos feed (paginated, filterable) |
| `/videos/:id` | Video detail |

### Architectural decisions (already locked in ADRs)

- **v3.0 scope = subscriptions + RSS + categorization** (ADR-009)
- **New-video detection = RSS polling every 15 min** (ADR-009)
- **No mirror in v3.0** — dashboard reads YouTube, doesn't write (ADR-005 principle applied; mirror piece deferred to v3.1)
- **Categorization = existing folders/tags** (ADR-004)
- **Subscription filter UX = hybrid: import all, UI toggle, default included** (ADR-009)
- **`is_important` captured now, behavior deferred with LLM** (ADR-009)
- **Data API for subscriptions ingestion + RSS for new-video detection** (ADR-009)
- **OAuth scopes: `youtube.readonly` (and `youtube.force-ssl` if `subscriptions.list` requires it)** (ADR-009)

## Testing Decisions

### What makes a good test

A good test exercises **external behavior** — the inputs and outputs of a module as a consumer would use them. It does not test implementation details (which SQL query ran, which cron schedule is used). Tests on behavior survive refactors; tests on internals get rewritten.

### Unit tests (Vitest) — for the 6 deep modules

| Module | What to test |
|---|---|
| `YouTubeOAuthClient` | Token exchange success/failure; refresh-when-expired; scope validation |
| `SubscriptionsFetcher` | Sample API responses → normalized `Subscription[]`; pagination across multiple pages |
| `SubscriptionsSync` | Empty / all-new / all-same / mixed (add+update+remove) scenarios; idempotency on second run |
| `RssFeedFetcher` | Sample Atom XML fixtures → parsed `FeedEntry[]`; malformed XML → typed error; empty feed → empty array |
| `VideoIngest` | New entries inserted; duplicates by `video_id` skipped; batch with mixed new/dup handled |
| `RssPoller` | Per-channel failure isolation (one 404 doesn't kill loop); concurrency cap respected; `last_polled_at` recorded on success and failure |

### Integration tests (Vitest + Hono test client + in-memory SQLite)

- `SubscriptionsSync` end-to-end with DB (initial sync populates table; re-sync is no-op)
- `VideoIngest` end-to-end with DB (RSS poll populates videos; re-poll dedupes)
- `RssPoller` end-to-end with mock HTTP fetcher + in-memory DB (one failing channel doesn't break the rest)
- OAuth happy path with mocked Google endpoints
- API contract tests for each documented endpoint, asserting documented shape for documented inputs
- Auth middleware rejects unauthenticated calls to `/api/youtube/*`, `/api/subscriptions/*`, `/api/videos/*`

### Manual / smoke tests

- Real OAuth grant on dev server → status shows "Connected"
- Manual "Sync now" → subscription count matches YouTube's web UI
- RSS poll on a real channel with a known recent upload → new video appears in `/videos` within 15 min
- Toggle `is_included` off → polling stops for that channel within 15 min
- Toggle `is_included` back on → polling resumes
- Toggle `is_important` → no UI behavior change today; value persists across reload
- Categorize a video (folder + tags) → changes visible in feed and detail
- Server restart → RSS poller resumes on its own

### Prior art

- v1 uses Vitest for similar unit-test patterns on its small modules (`server/src/*.test.ts`)
- v1 integration tests against in-memory SQLite (existing API tests)
- `e2e/` in pi-foundations has Playwright + Page Object Model (deferred for v3.0 if UI surface stabilizes)

### What's NOT tested in v3.0

- LLM / transcript behaviors (deferred)
- PubSubHubbub (deferred)
- Performance benchmarks beyond smoke latency
- Visual regression
- Failure modes that don't exist yet (e.g. Data API quota-exceeded — unlikely at personal scale but undocumented)

## Out of Scope

The following are explicitly **not** part of v3.0 and will get their own PRDs / ADRs:

- **Save YouTube videos** (no `playlistItems.insert` to a "Dashboard Saves" playlist). v3.1. (ADR-003)
- **Mirror to YouTube playlist** (no nightly push of saves to a private playlist). v3.1. (ADR-005)
- **Watch history import** (no Google Takeout upload). v3.1. (ADR-003)
- **User playlists ingestion** (no read of user's own playlists). v3.1.
- **Transcript fetching** (no scrape of `youtube-transcript` or equivalent). v3.x with LLM.
- **LLM summarization job** (no cloud LLM client, no summary UI). v3.x. (ADR-009)
- **Real-time push via PubSubHubbub** (no webhook endpoint). Revisit if 15-min latency feels bad. (ADR-009)
- **AI auto-categorization** of new videos. Not planned.
- **YouTube write-back** (dashboard never mutates YouTube in v3.0). v3.1.
- **Multi-user** — only David, ever. (ADR-007)
- **Mobile-optimized UI** — works on mobile but desktop-first.
- **Dark mode** — not in v3.0.
- **Subscription notes / custom per-channel metadata** — no UI for it.

## Further Notes

### Acceptance Criteria (for "v3.0 is done")

These map directly to the issue tracker tickets that `to-issues` will create.

1. **YouTube OAuth works** — clicking Connect redirects to Google; granting access lands back on the dashboard with "Connected"; status persists across restart; disconnect revokes the token.
2. **Subscriptions import works** — first connection imports all subscriptions within ~30s; daily refresh picks up new subs / removes unsubscribed; manual "Sync now" returns counts.
3. **Subscription filter works** — `is_included` toggle stops/resumes RSS polling; `is_important` toggle persists but has no behavior today; filter chips and search work on the Subscriptions page.
4. **RSS polling detects new videos** — every 15 min, new uploads from `is_included=true` channels appear in the `videos` table with correct metadata; duplicates by `video_id` are not inserted; per-channel failures don't break the loop.
5. **Videos view shows new uploads** — `/videos` lists videos reverse-chronological by `discovered_at`; pagination works; filters by channel/folder/tag work; each card shows the documented fields.
6. **Video categorization works** — folder picker moves video into the chosen folder; tag autocomplete + create-on-the-fly works; tag removal works; title inline edit works; all changes persist and are reflected in the feed.
7. **Operational hygiene** — RSS poller runs on boot; logs include OAuth events, sync results, RSS poll results per channel; manual "Poll now" works; concurrency is capped.

### References

- [ADR-003](../40-decisions/003-youtube-ingestion-data-api.md) — YouTube saves + Takeout history (v3.1, not v3.0)
- [ADR-004](../40-decisions/004-categorization-folders-tags.md) — Folders + tags
- [ADR-005](../40-decisions/005-youtube-source-of-truth.md) — Dashboard DB is source of truth (principle applied; mirror deferred)
- [ADR-008](../40-decisions/008-mvp-scope.md) — MVP scope
- [ADR-009](../40-decisions/009-youtube-subscriptions-rss.md) — v3.0 subscriptions + RSS
- [PRD-001](./PRD-001-v1-chrome-bookmarks.md) — v1 (shipped) — prior art for module + test patterns
- [PRD-002](./PRD-002-email-mirror.md) — email mirror (deferred; future OAuth-pattern reuse)