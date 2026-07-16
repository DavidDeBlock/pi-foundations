# YT-012 — Google Takeout watch-history import

**Labels**: `youtube`, `v3.1`, `history`, `privacy`, `needs-triage`
**Type**: AFK (real Takeout fixture/manual smoke required)
**Parent**: [PRD-004](../35-prds/PRD-004-youtube-library-history-playlists-backfill.md)

## What to build

Import YouTube watch events from a Google Takeout `watch-history.json` or legacy `watch-history.html` file using a staged dry-run and transactional commit. Repeated and overlapping exports must be safe.

## Acceptance criteria

- [ ] migration creates `youtube_history_imports` and `youtube_watch_events` per PRD-004
- [ ] `TakeoutWatchHistoryParser` validates supported JSON, normalizes watch URLs/video IDs/timestamps/title/channel snapshots, and isolates malformed entries
- [ ] deterministic event fingerprints deduplicate repeated/overlapping imports while preserving legitimate watches at different timestamps
- [ ] parser supports bounded memory and a configured maximum upload size; oversized/unsupported files fail clearly
- [ ] POST `/api/youtube/history/preview` stores a private staged file and returns token, totals, new/duplicate/malformed counts, unique/new videos, and date range
- [ ] POST `/api/youtube/history/imports/:token/commit` is single-use, transactional, canonical-upserts videos/channels, and returns committed counts
- [ ] GET `/api/youtube/history/imports` exposes audit metadata but never file contents or server paths
- [ ] staged filenames cannot escape the import directory; files expire and are deleted after commit/expiry
- [ ] unknown/deleted/private videos retain the best available snapshot and do not abort valid events
- [ ] no history or Takeout contents are logged or sent to MiniMax
- [ ] tests include real-shape sanitized fixtures, malformed JSON, hostile filename, size limit, duplicate file, overlapping file, repeated watches, commit rollback, expiry, API auth, and restart
- [ ] HTML exports are parsed deterministically; non-watch activity cards are skipped without leaking titles
- [ ] preview enriches unique video IDs through authenticated `videos.list`, excludes videos with duration <= 180 seconds, and shows excluded event/video counts
- [ ] deleted/private/unavailable videos remain history-only snapshots and do not create playable library records
- [ ] duration classifications are persisted with the preview so commit/restart cannot change the reviewed filter result

## Blocked by

- [YT-008](./YT-008-canonical-youtube-library-foundation.md)
