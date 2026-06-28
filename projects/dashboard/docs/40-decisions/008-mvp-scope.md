# ADR-008: v1 = read-only Chrome bookmarks + categorize + search

**Status**: Accepted
**Date**: 2026-06-28
**Authors**: David

## Context

The full feature set is large: bookmarks (read + write + organize), Chrome history (bulk import + ongoing), YouTube saves, YouTube history, plus all the supporting infrastructure (extension, auth, mirror job). Shipping it all in one pass risks a 6-month project that never finishes.

The architecture decisions are largely settled (ADRs 001–007). v1 should exercise the hardest parts of the system end-to-end, then layer on the rest.

## Decision Drivers

- Ship something usable in ~2 weeks, not 6 months
- v1 should validate the extension pipeline, the folder/tag schema, the search, and the UI
- Write-back to Chrome is its own beast (feedback loops, race conditions) — better landed in v2 after the data shape is understood
- YouTube is fully independent (separate OAuth, separate data type) — can land in v3 without blocking anything

## Decision

**Three vertical slices, each shippable on its own:**

### v1 — Chrome bookmarks, read-only
- Extension reads `chrome.bookmarks`, pushes to dashboard
- Dashboard lets user **view**, **categorize** (folders + tags), **search**, **edit titles**
- No write-back to Chrome yet
- No history, no YouTube

### v2 — Chrome write-back + history
- Extension writes changes back to Chrome (the ADR-006 feedback-loop fix)
- One-time bulk history import (close Chrome, read SQLite over SMB)
- Extension pushes ongoing visits
- Dashboard surfaces history alongside bookmarks

### v3 — YouTube
- Save videos via YouTube Data API
- Categorize (using the same folders + tags tree)
- Mirror to YouTube playlist
- Google Takeout import for watch history

## Consequences

**Positive:**
- v1 is the smallest slice that proves the architecture works
- Each slice is independently demoable — usable as soon as it ships
- Lower risk: each slice delivers value before the next starts
- Reduces temptation to over-engineer v1 in anticipation of v2/v3

**Negative:**
- v1 doesn't deliver the full original ask — user must wait for v2/v3 for write-back, history, YouTube
- Some early decisions (e.g. folder/tag schema) are made before they're validated against write-back or YouTube data — small risk of rework
- Three releases instead of one — more deployment cycles (but each is small)