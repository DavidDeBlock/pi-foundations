# YT-014 — YouTube library E2E, migration rehearsal, and docs

**Labels**: `youtube`, `v3.1`, `testing`, `documentation`, `needs-triage`
**Type**: AFK (manual smoke required)
**Parent**: [PRD-004](../35-prds/PRD-004-youtube-library-history-playlists-backfill.md)

## What to build

Verify PRD-004 as one system against upgraded and clean databases, a real read-only YouTube account, and a sanitized Google Takeout export. Finish operator documentation and recovery guidance.

## Acceptance criteria

- [ ] upgrade rehearsal starts from a populated migration-013 DB and proves video ids, folders, tags, transcripts, summaries, OAuth state, and subscription settings survive
- [ ] clean-install smoke covers new-subscription 30-day backfill and repeat-safe manual backfill
- [ ] real-account smoke imports playlist metadata, includes one playlist, syncs/reorders/removes membership, and preserves canonical videos
- [ ] one video arriving through RSS, backfill, two playlists, and history renders once with every context intact
- [ ] Takeout smoke previews, commits, then reimports the same file with zero new events
- [ ] New Videos unwatched filter and playlist/history navigation work after restart
- [ ] simulated partial pagination, 403 playlist, quota failure, malformed Takeout entry, and server restart preserve last good state
- [ ] README and deployment docs cover feature behavior, schedules, upload limits, storage, backups, privacy, and troubleshooting
- [ ] CONTEXT and PRD/issue indexes reflect the shipped v3.1 scope; historical ADRs remain intact
- [ ] backup/restore documentation explicitly includes staged imports, history, playlists, transcripts, and summaries
- [ ] full automated suite plus manual release checklist pass

## Blocked by

- [YT-009](./YT-009-subscription-recent-video-backfill.md)
- [YT-011](./YT-011-playlists-ui-library-integration.md)
- [YT-013](./YT-013-watch-history-ui-watched-state.md)

