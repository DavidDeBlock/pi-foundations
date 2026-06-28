# 006 — BookmarkDiffer + ongoing sync (event listener)

**Labels**: `v1`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md)

## What to build

The `BookmarkDiffer` deep module (pure function) that compares an incoming Chrome bookmark tree against the current DB state and produces a minimal set of CRUD operations (create / update / delete / move). The bulk sync endpoint from 005 now applies the diff instead of blindly upserting. The extension's background script subscribes to `chrome.bookmarks.*` events and POSTs the delta to the server. The extension tags its own writes with a `synced_from: "extension"` marker so the listener ignores its own writes (no feedback loop).

## Acceptance criteria

- [ ] `BookmarkDiffer` module implemented and exported
- [ ] Unit tests cover: no-op (same tree), pure add, pure delete, pure move, mixed ops, conflict between `chrome_id` and URL
- [ ] `POST /api/bookmarks/sync` applies the diff via BookmarkDiffer
- [ ] Extension background script subscribes to `onCreated`, `onChanged`, `onRemoved`, `onMoved`
- [ ] On event, extension POSTs the delta to server
- [ ] Extension's own writes carry `synced_from: "extension"`; the listener ignores those events
- [ ] Manual smoke: create + rename + delete a bookmark in Chrome; changes appear in dashboard within 2s

## Blocked by

- 005 (FolderTreeBuilder + first sync E2E)