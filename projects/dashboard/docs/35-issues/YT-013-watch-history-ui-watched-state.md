# YT-013 — Watch History UI and watched-state integration

**Labels**: `youtube`, `v3.1`, `history`, `ui`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-004](../35-prds/PRD-004-youtube-library-history-playlists-backfill.md)

## What to build

Expose Takeout import in settings, add the History view, and use derived watch state throughout the canonical YouTube library.

## Acceptance criteria

- [ ] `/settings/youtube` provides Takeout instructions, file picker, validation progress, dry-run preview, explicit confirm, and final counts
- [ ] preview highlights duplicates/malformed entries and never commits without confirmation
- [ ] `/history` lists reverse-chronological watch events with video/channel, watched time, repeated-watch count, and links to canonical detail
- [ ] `/videos` API/view supports `watched=true`, `unwatched=true`, and `source=history`; contradictory filters return 400
- [ ] New Videos offers a persistent `Unwatched only` filter
- [ ] video cards/detail show `Watched`, last watched, and watch count without implying playback position
- [ ] repeated events for one video appear as one canonical video where video cards are used and as separate events in History
- [ ] non-subscribed history videos remain visible and retain folders/tags/transcripts/summaries
- [ ] import audit list shows filename, hash abbreviation, committed time, counts, and date range with no delete/write-back action
- [ ] empty/no-import, importing, invalid file, expired preview, and partial-malformed states are accessible and actionable
- [ ] tests cover preview/confirm UI, filtering, repeat counts, date rendering, XSS escaping, non-subscribed channels, and auth

## Blocked by

- [YT-012](./YT-012-takeout-watch-history-import.md)

