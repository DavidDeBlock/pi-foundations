# ADR-003: YouTube data ingestion via Data API + Takeout

**Status**: Accepted
**Date**: 2026-06-28
**Authors**: David

## Context

The dashboard needs to ingest two types of YouTube data: saved videos (what the user wants to keep) and watch history (what the user has watched). The user wants both eventually, but with different priorities.

## Decision Drivers

- YouTube Data API v3 is the official, stable path for saves — `playlistItems.insert` and `videos.list` cover all metadata needs
- The Data API does NOT expose the user's watch history (no API endpoint for it)
- Watch history is least-valuable of the three datasets (bookmarks, history, watch history) — already visible on YouTube itself
- Personal scale: well under the 10,000 units/day quota
- Scraping YouTube's DOM is fragile — YouTube changes their markup regularly

## Decision

**Two paths, both official:**

1. **Saves** — YouTube Data API v3. Dashboard has OAuth credentials for the user's Google account. Saves use `playlistItems.insert` against a single private playlist ("Dashboard Saves"). Metadata fetched via `videos.list` on save.

2. **Watch history (v3, not v1)** — One-time Google Takeout export. User requests the export, downloads `watch-history.json`, uploads it to the dashboard. Dashboard parses and stores. Manual but reliable.

Watch history is deferred to v3 to ship v1 faster. Adds zero blocking complexity to the v1 build.

## Consequences

**Positive:**
- Saves path is well-documented, stable, free at personal scale
- No DOM scraping → no maintenance trap
- Watch history path is offline-capable (upload a file, no scheduled scraping)
- Quota headroom is huge for personal use

**Negative:**
- Watch history requires manual export step (v3)
- OAuth flow adds setup complexity (one-time, but real)
- YouTube playlist is rate-limited per minute — bulk saves need throttling (negligible at personal scale)