# YT-010 — YouTube playlists ingestion, sync, and API

**Labels**: `youtube`, `v3.1`, `playlists`, `needs-triage`
**Type**: AFK (real-account smoke required)
**Parent**: [PRD-004](../35-prds/PRD-004-youtube-library-history-playlists-backfill.md)

## What to build

Create the read-only playlist mirror: fetch accessible playlist metadata owned by the connected account, let callers select playlists locally, and synchronize included playlist items into canonical videos.

## Acceptance criteria

- [ ] migration creates `youtube_playlists` and `youtube_playlist_items` per PRD-004 with account, inclusion, privacy, ordering, remote/local counts, and sync timestamps
- [ ] `YouTubePlaylistsFetcher` paginates `playlists.list(mine=true)` and normalizes public/private/unlisted plus Liked Videos when exposed
- [ ] new playlists default `is_included=false`; metadata refresh preserves the local inclusion choice
- [ ] included playlists page through every `playlistItems.list` result and canonical-upsert each usable video/channel
- [ ] complete sync transactionally diffs memberships, positions, and metadata; failed/partial pagination never performs removals
- [ ] removing a playlist item or playlist removes membership only, preserving canonical video enrichment and other sources
- [ ] inaccessible Watch Later/History responses are recorded as unsupported, not treated as empty successful playlists
- [ ] GET `/api/youtube/playlists`, PATCH `/api/youtube/playlists/:id`, POST `/api/youtube/playlists/sync`, and GET `/api/youtube/playlists/:id/videos` match PRD contracts
- [ ] enabling a playlist triggers initial item sync; disabling stops scheduled item sync without deleting cached membership
- [ ] daily scheduler plus manual sync expose counts, last run, and per-playlist failures
- [ ] existing `youtube.readonly` OAuth grant is sufficient; no write scope is added
- [ ] tests cover pagination, private playlists, removed items, reorder, duplicate videos across playlists/RSS, partial failure, scheduler, API validation, and auth

## Blocked by

- [YT-008](./YT-008-canonical-youtube-library-foundation.md)

