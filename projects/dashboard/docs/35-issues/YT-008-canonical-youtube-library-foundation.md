# YT-008 — Canonical YouTube library foundation

**Labels**: `youtube`, `v3.1`, `database`, `needs-triage`
**Type**: AFK (migration rehearsal required)
**Parent**: [PRD-004](../35-prds/PRD-004-youtube-library-history-playlists-backfill.md)

## What to build

Decouple canonical YouTube videos from subscriptions so videos from playlists and history can exist even when their channels are not subscribed. This is a behavior-preserving foundation: current RSS, video list/detail, categorization, transcripts, and MiniMax summaries must work exactly as before after migration.

## Acceptance criteria

- [ ] migration creates `youtube_channels` and seeds it from every current subscription/video channel without losing metadata
- [ ] `subscriptions.channel_id` and rebuilt `videos.channel_id` reference `youtube_channels.channel_id`; videos no longer require a subscription row
- [ ] existing dashboard-side video ids remain unchanged, preserving `video_tags`, folders, `video_transcripts`, segments, and `video_summaries`
- [ ] migration creates `video_origins` with validated types (`subscription_rss`, `subscription_backfill`, `manual`) and seeds current videos as `subscription_rss`
- [ ] one `YouTubeVideoUpsert` module becomes the only ingestion write path; it upserts channel/video metadata and provenance idempotently
- [ ] local title edits are explicitly preserved (local override column or equivalent); remote refresh cannot silently replace them
- [ ] video queries left-join subscription state so non-subscribed videos are visible in general library/detail views
- [ ] New Videos still excludes videos whose subscription is excluded, while direct detail and non-subscription source views remain available
- [ ] deleting/unsubscribing a subscription does not delete or block deletion of its canonical channel/videos
- [ ] RSS poller and tests use the canonical upsert without behavior regression
- [ ] migration test starts from a populated migration-013 database and verifies ids/enrichment before and after upgrade
- [ ] typecheck and full applicable test suite pass

## Blocked by

- [YT-005](./YT-005-videos-api-and-ui.md)

