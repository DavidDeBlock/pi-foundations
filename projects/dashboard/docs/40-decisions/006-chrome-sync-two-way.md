# ADR-006: Two-way Chrome sync, dashboard wins

**Status**: Accepted
**Date**: 2026-06-28
**Authors**: David

## Context

The user wants to create bookmarks from the dashboard and have them appear in Chrome. They also want to see all their existing Chrome bookmarks in the dashboard. Both directions of sync are needed.

## Decision Drivers

- User wants to **create** bookmarks from the dashboard (write path is required)
- User wants to **view** all their Chrome bookmarks (read path is required)
- Single user, one machine effectively (Chrome Sync handles the second machine) — no collaboration conflicts
- The dashboard is the user's "home base" — they think in terms of the dashboard's organization
- Feedback loops (extension sees its own write) are solvable with a marker pattern

## Decision

**Two-way sync. Dashboard wins on conflict.**

- **Dashboard → Chrome**: When the user saves/edits/deletes a bookmark in the dashboard, the extension pushes the change to Chrome via `chrome.bookmarks` API. The change is tagged with `synced_from: "dashboard"` so the extension's listener ignores its own writes.
- **Chrome → Dashboard**: When Chrome changes a bookmark (user edits in Chrome UI), the extension's `chrome.bookmarks.onChanged`/`onCreated`/`onRemoved`/`onMoved` events fire and push the change to the dashboard.
- **Conflict**: Dashboard wins. If the user edits in both places within seconds, the dashboard's version overwrites Chrome on next dashboard save. (One person, one machine — this is unlikely.)

## Consequences

**Positive:**
- Dashboard is the canonical view — Chrome always reflects dashboard state
- User can edit in either place without losing data (last dashboard-saved wins)
- No complex merge logic needed
- Marker pattern prevents feedback loops cleanly

**Negative:**
- Chrome-only fields (date added exactness, folder colors) don't round-trip cleanly to dashboard
- Dashboard-only fields (custom tags, notes) are silently dropped on Chrome side (intentional, documented)
- Edge case: if user re-parents in Chrome and dashboard's parent differs, dashboard's parent overwrites on next dashboard edit
- Extension must declare `bookmarks` permission (broad — see ADR-007 for the security implications)