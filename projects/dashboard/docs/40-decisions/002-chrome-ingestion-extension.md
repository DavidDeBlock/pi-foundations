# ADR-002: Chrome data ingestion via extension

**Status**: Accepted
**Date**: 2026-06-28
**Authors**: David

## Context

Chrome data lives in two places: bookmarks (a JSON file) and history (a SQLite database) in the user profile directory. The dashboard needs to read this data, plus eventually write bookmarks back to Chrome.

The user has two Windows machines running Chrome (signed into the same Google account, so Chrome Sync keeps them aligned). The Ubuntu server hosting the dashboard cannot directly reach the Windows profile directories over SMB without setup.

## Decision Drivers

- History is needed beyond the 90-day ceiling of the `chrome.history` API
- The dashboard must write bookmarks back to Chrome (user wants to create bookmarks from the dashboard)
- The ingestion path must work on a remote server, not just the same machine as Chrome
- One-time setup cost is acceptable; ongoing maintenance should be near-zero

## Decision

**Chrome extension + one-time bulk history import.**

1. **Chrome extension** (lives in `projects/dashboard/extension/` or a sibling project) uses `chrome.bookmarks` and `chrome.history` APIs to push data to the dashboard server in real time. Handles both read and write paths.

2. **One-time bulk history import**: On first install, the dashboard reads the full `History` SQLite file directly from the Windows machine (via SMB share). Requires closing Chrome for ~30 seconds. Captures the long-tail history beyond 90 days. After this, the extension takes over for new visits.

3. The extension is the only ongoing data ingestion point. The bulk import is a one-shot bootstrap.

## Consequences

**Positive:**
- Works regardless of network topology — extension just needs to reach the server URL
- Write-back to Chrome is first-class (extension has the API)
- Real-time history updates after the bulk import
- No Windows-side scripts or scheduled tasks to maintain

**Negative:**
- Two artifacts to ship (extension + bulk import flow)
- Extension must be installed once per Chrome profile
- Bulk import requires user to close Chrome for ~30 seconds (one-time friction)
- Extension must be kept in sync with dashboard API contract

## Alternatives Considered

- **Direct SQLite read ongoing**: locked while Chrome runs; ruled out
- **Chrome DevTools Protocol**: fragile, debugging-port security concerns
- **Google Chrome Sync API**: doesn't expose history; mostly read-only bookmarks
- **Hybrid (direct + extension)**: more code, same outcome as chosen approach