# YT-004 — videos + video_tags schema + RssFeedFetcher + VideoIngest + RssPoller (15-min job)

**Labels**: `youtube`, `v3.0`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-003](../35-prds/PRD-003-youtube-v3-subscriptions.md)

## What to build

Every 15 minutes, the server polls the public RSS feed (`https://www.youtube.com/feeds/videos.xml?channel_id=...`) for every subscription where `is_included = true`. New entries are inserted into a `videos` table keyed by `video_id` (idempotent). A `RssFeedFetcher` deep module handles HTTP fetch + Atom XML parsing; `VideoIngest` handles the diff-and-insert; `RssPoller` orchestrates the per-channel loop with concurrency cap and per-channel failure isolation. `last_polled_at` is recorded for every attempted channel so debugging can distinguish "stale because nothing's new" from "stale because polling stopped". The job starts on server boot and also exposes a manual "Poll now" endpoint.

## Acceptance criteria

- [ ] Migration adds `videos` table per PRD-003 schema: `id, video_id (UNIQUE), channel_id (FK→subscriptions.channel_id, ON DELETE RESTRICT), title, published_at, thumbnail_url, link, discovered_at, folder_id (nullable FK→folders), created_at, updated_at`
- [ ] Migration adds `video_tags` table: `video_id, tag_id` composite PK, mirroring `bookmark_tags` pattern
- [ ] `RssFeedFetcher` deep module exposes `fetch(channelId) → FeedEntry[]`; fetches `https://www.youtube.com/feeds/videos.xml?channel_id=<id>`; parses Atom XML; returns `[{ video_id, title, published_at, thumbnail_url, link }]`
- [ ] Malformed XML → typed error (does not crash)
- [ ] HTTP 404 / network error → typed error per channel (does not crash)
- [ ] Empty feed → returns `[]`
- [ ] `VideoIngest` deep module exposes `ingest(channelId, entries) → { added, skipped }`; INSERTs new entries by `video_id`; skips duplicates (idempotent on re-poll)
- [ ] `RssPoller` deep module exposes `pollAll() → { succeeded, failed, results: [{ channel_id, status: 'ok'|'error', added, error? }] }`; iterates `is_included=true` subscriptions; caps concurrency to 5 (configurable via env)
- [ ] Per-channel try/catch: one channel's failure does not break the loop; failure is logged with `channel_id` + error message
- [ ] `last_polled_at` updated for **every** attempted channel (success AND failure)
- [ ] 15-min cron interval registered on server boot; first poll runs ~15s after boot to surface issues early
- [ ] Manual "Poll now": `POST /api/youtube/poll` triggers immediate poll, returns the same shape as `pollAll()`
- [ ] Tests: `RssFeedFetcher` against sample Atom XML (single entry, multiple entries, empty feed, malformed XML, 404); `VideoIngest` for new / dup / mixed scenarios; `RssPoller` for per-channel failure isolation (one mock 404 doesn't kill others), concurrency cap respected, `last_polled_at` updated on both success and failure paths
- [ ] Manual smoke: pick a real channel known to publish frequently, click "Poll now", see new video in DB; toggle channel off, "Poll now" excludes it; toggle on, polling resumes

## Blocked by

- [YT-002](./YT-002-subscriptions-schema-fetcher-sync.md) (needs `subscriptions` rows in DB to know which channels to poll)