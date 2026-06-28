# ADR-005: Dashboard DB is source of truth for YouTube saves

**Status**: Accepted
**Date**: 2026-06-28
**Authors**: David

## Context

YouTube Data API treats "save a video" as "add it to a playlist." If categories map to playlists, then:
- A video can only live in one playlist (one category)
- Reorganizing means 3 API calls per move (list + delete + insert) and burns API quota
- Move operations destroy position in the destination playlist
- Phone YouTube app sees the playlist as the source of truth, but the dashboard may want different organization

## Decision Drivers

- User wants multi-category tagging (ADR-004) — single-playlist model is too restrictive
- Personal scale: quota (10k units/day) burns fast on reorganization under pure-playlist model
- Phone app should still see saves — but doesn't need to see all internal organization
- Dashboard is the user's "home base" for organization

## Decision

**Dashboard DB is source of truth. YouTube playlist is a thin mirror.**

- Dashboard DB owns: title, URL, channel, folder, tags, notes, saved_at, etc.
- One YouTube playlist ("Dashboard Saves") exists as a side effect for phone-app visibility
- A nightly (or on-save) sync job pushes dashboard saves to the playlist as a mirror
- If the mirror drifts (user reorganizes in YouTube UI), the next sync corrects it
- Tags and folders don't sync — only video IDs

Reorganizing in the dashboard is just SQL: `UPDATE saved_videos SET folder_id = ? WHERE id = ?`. Zero API calls, zero quota, instant.

## Consequences

**Positive:**
- Free, instant reorganization
- Multi-tag works without API gymnastics
- Custom metadata (notes, saved_at, tags) lives in the dashboard DB
- Phone app sees saves (via mirror)

**Negative:**
- Brief lag between dashboard edit and phone-app reflection (until next sync)
- If the user reorganizes in YouTube UI directly, that change is silently overwritten on next sync
- Mirror job is a new moving part (small, but real)