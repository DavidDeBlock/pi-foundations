# YT-011 — Playlists UI and library integration

**Labels**: `youtube`, `v3.1`, `playlists`, `ui`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-004](../35-prds/PRD-004-youtube-library-history-playlists-backfill.md)

## What to build

Make playlist data useful in the dashboard through a clean Playlists navigation surface, playlist selection, detail pages, and canonical-library filters.

## Acceptance criteria

- [ ] YouTube contextual navigation clearly exposes New videos, Playlists, History, and Subscriptions without expanding the global sidebar
- [ ] `/playlists` lists playlist thumbnail/title/privacy, remote/local counts, inclusion, last sync, and safe error/unsupported state
- [ ] inclusion toggles persist through PATCH and show initial-sync progress without a full page reload
- [ ] manual **Sync playlists** reports added/updated/removed/failed counts
- [ ] `/playlists/:id` preserves YouTube position and paginates canonical video cards
- [ ] detail filters include watched state (when available), channel, folder, tag, transcript, and summary
- [ ] playlist badges appear on video cards/detail without duplicating cards
- [ ] `/videos` API/view supports `source=playlist` and `playlist_id` while preserving old query behavior
- [ ] a video from a non-subscribed channel renders with canonical channel metadata and can be categorized, transcribed, and summarized
- [ ] empty, loading, unsupported Watch Later, disconnected, and failed-sync states explain the next action
- [ ] responsive behavior and keyboard/focus states match the current dashboard design system
- [ ] view/API tests cover XSS escaping, filters, order, toggles, non-subscribed channels, empty states, and auth

## Blocked by

- [YT-010](./YT-010-youtube-playlists-ingestion-sync-api.md)

