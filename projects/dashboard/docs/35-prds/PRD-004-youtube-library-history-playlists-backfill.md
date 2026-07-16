# [PRD] Dashboard v3.1 — YouTube library, playlists, history, and subscription backfill

**Labels**: `parent-prd`, `youtube`, `v3.1`
**Date**: 2026-07-16
**Status**: Draft

## Problem statement

The dashboard currently discovers only future uploads from subscribed channels. This leaves three gaps:

1. A newly added subscription looks empty until the creator publishes again.
2. Videos already saved into the user's YouTube playlists are absent.
3. The dashboard cannot distinguish watched from unwatched videos.

David wants the dashboard to become his YouTube library: one canonical video record regardless of whether it came from RSS, a recent-video backfill, a playlist, or Google Takeout history. Existing transcript and MiniMax Insight Card behavior must continue to work on those canonical videos.

## Goals

- Import a configurable recent window when a subscription is newly discovered.
- Allow an explicit recent-video backfill on any subscription.
- Read and locally mirror accessible playlists owned by the connected YouTube account.
- Import watch history from a Google Takeout `watch-history.json` export.
- Show provenance, playlist membership, and watched state without duplicating videos.
- Keep YouTube access read-only in this slice.
- Preserve existing folders, tags, transcripts, summaries, local title edits, and video IDs during migration.

## Non-goals

- Live Watch History API sync — YouTube does not expose it.
- Live Watch Later sync — YouTube blocks Watch Later through `playlistItems.list`.
- Mutating YouTube playlists, creating a Dashboard Saves mirror, or deleting YouTube data.
- Scraping YouTube pages.
- Continuous history capture through a browser extension.
- Automatic transcript or AI processing of every historical import.
- Recommendation ranking, cross-video AI chat, or morning briefings.

## Product principles

### One video, many contexts

A YouTube video has one dashboard row. Playlist memberships, subscription discoveries, and watch events point to it. Importing the same video from three sources must never create three cards.

### History is an event log

Watching is not a boolean in storage. Repeated views are retained as separate events; the UI derives `watched`, `last watched`, and `watch count`.

### Read-only first

Playlist sync mirrors YouTube into the dashboard. Local folders, tags, transcripts, and summaries remain dashboard-owned. Removing a video from a synced playlist removes only that membership, never the canonical video or its local enrichment.

### Historical imports are cost-controlled

Backfilled and playlist videos do not automatically trigger transcripts or MiniMax calls. The user can explicitly select videos for AI processing later.

## User experience

### YouTube library navigation

The YouTube compartment gains four clear views:

- **New videos** — subscription RSS and recent backfill inbox.
- **Playlists** — included YouTube playlists and their videos.
- **History** — imported watch events and watched-video statistics.
- **Subscriptions** — channel inclusion, AI preferences, and backfill actions.

The existing `/videos` route remains the canonical video library and gains source, playlist, and watched filters rather than creating separate copies of cards.

### New-subscription backfill

YouTube settings provide a global preference:

```text
When a new subscription is discovered
Future uploads only | Last 7 days | Last 30 days | Last 90 days
```

Default: **Last 30 days** for included subscriptions. The preference applies only to subscriptions first seen after the setting exists; it must not unexpectedly backfill every existing subscription after upgrade.

Every subscription row also has **Import recent videos** with 7/30/90-day choices. The row shows pending/running/completed/failed state, last backfill time, and imported count. Repeating the action is safe and imports only missing videos.

Backfill uses the channel's official uploads playlist. It fetches newest pages until all items are older than the cutoff, with a safety cap of 500 inspected items per run. Excluded subscriptions can be backfilled manually, but the resulting videos remain hidden from the New Videos view until the channel is included.

### Playlists

The first playlist sync imports metadata for accessible playlists owned by the authenticated account. New playlists default to excluded so a large YouTube account does not flood the dashboard. The user selects which playlists to include, then item sync runs immediately and periodically.

The playlist list shows title, thumbnail, privacy, YouTube item count, local item count, inclusion state, and last sync. A playlist detail view preserves YouTube order and supports watched/unwatched, transcript, summary, channel, folder, and tag filters.

Liked Videos may be represented as a special playlist when YouTube exposes its related playlist ID. Watch Later and Watch History must show a clear unsupported-live-sync explanation rather than silently returning empty lists.

### Watch-history import

`/settings/youtube` gains an **Import watch history** flow:

1. Select a Google Takeout `watch-history.json` file.
2. Dashboard validates it and displays a dry-run preview.
3. Preview shows total events, new events, duplicates, unique videos, new canonical videos, oldest date, and newest date.
4. User confirms the staged import.
5. Import commits transactionally and reports counts.

The same or overlapping export can be imported repeatedly. Stable event fingerprints prevent duplicate watch events. Unknown, deleted, private, or malformed entries are reported separately; one bad entry does not abort an otherwise valid import.

The History view shows reverse-chronological events. Video cards throughout the dashboard can show `Watched`, last-watched time, and watch count. The New Videos view gains `Unwatched only`.

## Data model

### Canonical channel and video foundation

The current `videos.channel_id` foreign key points directly at `subscriptions.channel_id`, which cannot represent videos from non-subscribed channels. v3.1 introduces:

| Table/change | Purpose |
|---|---|
| `youtube_channels` | Canonical channel registry: `channel_id`, title, thumbnail, metadata timestamps. |
| `subscriptions` | Continues to represent the user's relationship to a channel; references `youtube_channels`. User preferences remain here. |
| `videos` rebuild | `channel_id` references `youtube_channels`, not `subscriptions`. Existing local IDs and enrichment are preserved. |
| `video_origins` | Records `subscription_rss`, `subscription_backfill`, or `manual` discovery with source id and first-seen time. Playlist memberships and watch events remain in their richer tables. |

Views that currently inner-join subscriptions must left-join channels/subscriptions so playlist and history videos remain visible. Subscription inclusion filters apply only to subscription-origin inbox views, not to playlist/history views.

### Backfill and preference state

| Table/change | Purpose |
|---|---|
| `youtube_preferences` | Per-account `new_subscription_backfill_days` (`0`, `7`, `30`, or `90`; default `30`). |
| `subscriptions` additions | `last_backfilled_at`, `last_backfill_days`, `last_backfill_count`, `backfill_status`, `backfill_error`. |

### Playlist state

| Table | Purpose |
|---|---|
| `youtube_playlists` | Playlist id, account id, title, description, thumbnail, privacy, remote count, inclusion flag, special type, last sync. |
| `youtube_playlist_items` | Playlist membership with YouTube playlist-item id, canonical video id, position, added-at, and synced-at. Unique by playlist + playlist-item id. |

Deleting a remote playlist or item removes local playlist metadata/membership only after a successful complete sync. Canonical videos and local enrichment remain.

### History state

| Table | Purpose |
|---|---|
| `youtube_history_imports` | File hash, filename, preview/commit status, event counts, date range, created/committed timestamps. |
| `youtube_watch_events` | Canonical video id, watched-at, normalized title/channel snapshot, and unique event fingerprint. |

Staged upload files live below the configured dashboard data directory, have a size limit, are never served publicly, and are deleted after commit or expiry.

## Ingestion and sync behavior

### Canonical upsert

Every ingestion path calls one `YouTubeVideoUpsert` module. It identifies by YouTube `video_id`, creates/updates the canonical channel, preserves dashboard-owned fields, and records the appropriate relationship. No fetcher writes directly to `videos`.

Remote metadata may update YouTube-owned title/thumbnail/publish time. Local title edits must not be silently overwritten; the foundation issue should add an explicit local-title override or equivalent preservation rule.

### Recent uploads

- Resolve upload-playlist IDs with `channels.list(part=contentDetails)` in batches.
- Page through `playlistItems.list(part=snippet,contentDetails,maxResults=50)`.
- Stop after the first page whose oldest usable video predates the cutoff, or at the safety cap.
- Hydrate video/channel metadata in batches where playlist data is incomplete.
- Queue at most one backfill per subscription; persist terminal state.

### Playlist sync

- `playlists.list(part=snippet,contentDetails,status,mine=true)` imports metadata.
- Only included playlists fetch all playlist items.
- A complete successful item sync performs add/update/remove diff transactionally.
- Partial or failed pagination never runs the remove pass.
- Scheduled metadata/item sync defaults to daily; manual sync is always available.

### History parser

- Streaming or bounded parsing; never load an unbounded archive into browser memory.
- Normalize YouTube watch URLs to video IDs.
- Fingerprint normalized video id + watched timestamp + relevant activity identity.
- Preserve repeated watches at different times.
- Reject unsupported files with a clear format error.

## API contracts

All routes use existing dashboard authentication.

| Method | Path | Purpose |
|---|---|---|
| GET/PATCH | `/api/youtube/preferences` | Read/update new-subscription backfill default. |
| POST | `/api/subscriptions/:id/backfill` | Queue `{days: 7|30|90}`; return job state. |
| GET | `/api/subscriptions/:id/backfill` | Read current/last backfill state. |
| POST | `/api/youtube/playlists/sync` | Sync playlist metadata, optionally one playlist's items. |
| GET | `/api/youtube/playlists` | List playlist metadata and inclusion state. |
| PATCH | `/api/youtube/playlists/:id` | Update local `is_included`. |
| GET | `/api/youtube/playlists/:id/videos` | Paginated playlist items with library filters. |
| POST | `/api/youtube/history/preview` | Stage and validate Takeout JSON; return preview + import token. |
| POST | `/api/youtube/history/imports/:token/commit` | Commit a valid staged import once. |
| GET | `/api/youtube/history/imports` | Import audit history. |
| GET | `/api/youtube/history` | Paginated watch events and filters. |

Existing `/api/videos` gains optional `source`, `playlist_id`, `watched`, and `unwatched` filters. Existing response fields remain backward-compatible.

## Resilience and observability

- Backfill, playlist sync, and history import are idempotent.
- Background work persists pending/running/failed/completed state and resumes safely after restart.
- YouTube 401 triggers existing token refresh; 403 inaccessible playlist is recorded without breaking other playlists.
- Quota/rate-limit failures retain the last complete local snapshot.
- Settings show last run, counts, errors, and next scheduled sync.
- Logs never contain OAuth tokens, Takeout contents, or video transcript text.

## Privacy and security

- `youtube.readonly` remains the only YouTube data scope required.
- Takeout files and history are sensitive local data and require normal dashboard authentication.
- Upload filename is never trusted as a filesystem path.
- Staged imports have size/type limits and expire automatically.
- History data is not sent to MiniMax. Only an explicit future AI action may send selected transcript text under the existing LLM privacy model.

## Delivery slices

1. **YT-008** — canonical channels/videos/source foundation.
2. **YT-009** — recent subscription backfill and global default.
3. **YT-010** — playlist schema, fetcher, sync, and API.
4. **YT-011** — playlist selection/detail UI and library integration.
5. **YT-012** — Takeout watch-history parser, staged preview, and import API.
6. **YT-013** — History UI and watched-state integration.
7. **YT-014** — cross-slice smoke, migration rehearsal, and operations docs.

YT-009, YT-010, and YT-012 can proceed independently after YT-008. YT-011 follows YT-010; YT-013 follows YT-012. YT-014 waits for all feature slices.

## Release acceptance criteria

- Existing RSS videos, folders, tags, transcripts, and Insight Cards survive the foundation migration unchanged.
- Newly discovered subscriptions follow the configured 0/7/30/90-day default without backfilling pre-existing subscriptions unexpectedly.
- Manual subscription backfill is repeat-safe and stops at its cutoff/safety cap.
- Accessible playlists sync completely and removals do not delete canonical videos.
- The same video from RSS, multiple playlists, and history has one canonical video card.
- Re-importing the same Takeout file adds zero duplicate watch events.
- New Videos can filter to unwatched videos; playlist and history views remain visible for non-subscribed channels.
- All ingestion paths remain read-only toward YouTube.
- Background failures are observable and do not destroy the last good local snapshot.
- Automated tests plus a real-account smoke cover migration, backfill, playlist sync, and repeated Takeout import.

## Follow-up opportunities

- Bulk transcript/summary actions from a playlist.
- Playlist-level MiniMax briefing.
- History-aware morning briefing that suppresses watched videos.
- Browser-extension capture for incremental future watch events.
- Read/write Dashboard Saves mirror from ADR-005.
- Takeout support for Watch Later if present in exported playlist files.

## References

- [ADR-003](../40-decisions/003-youtube-ingestion-data-api.md) — Data API for saves/playlists; Takeout for history.
- [ADR-005](../40-decisions/005-youtube-source-of-truth.md) — dashboard owns local organization.
- [ADR-009](../40-decisions/009-youtube-subscriptions-rss.md) — RSS new-video detection remains the future-upload path.
- [PRD-003](./PRD-003-youtube-v3-subscriptions.md) — current subscription and new-video surface.

