# 004 — Extension skeleton + bulk sync API

**Labels**: `v1`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md)

## What to build

A Chrome extension (Manifest V3) that loads unpacked and has an options page for entering the API token + server URL. The server gets a new endpoint, `POST /api/bookmarks/sync`, that accepts a bulk payload (any shape, even empty) and returns 200. The endpoint is in place but does no real work yet — the next slice (005) wires up the FolderTreeBuilder and the extension's first-run `getTree()` call.

## Acceptance criteria

- [ ] Extension manifest v3 with `permissions: ["bookmarks", "storage"]` and a configurable `host_permissions` for the server URL
- [ ] Options page accepts API token + server URL in two fields
- [ ] Saving options validates the token against the server with a test call; invalid token shows a clear error
- [ ] Token + URL persist in `chrome.storage.local`
- [ ] `POST /api/bookmarks/sync` accepts a JSON payload and returns 200 (no DB writes yet)
- [ ] Tests cover: sync endpoint accepts valid payloads, rejects unauthenticated, rejects malformed

## Blocked by

- 003 (schema + folder read)