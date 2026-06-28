# 005 — FolderTreeBuilder + first sync E2E

**Labels**: `v1`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md)

## What to build

The `FolderTreeBuilder` deep module (pure function) that converts a flat list of folder paths + bookmark refs into a nested tree ready for DB insert. Full unit tests for all edge cases. The bulk sync endpoint from 004 now uses FolderTreeBuilder to actually write folders + bookmarks. The extension's first-run flow reads `chrome.bookmarks.getTree()`, POSTs to the server, and the dashboard's folder sidebar reflects the imported tree within 5 seconds.

## Acceptance criteria

- [ ] `FolderTreeBuilder` module implemented and exported
- [ ] Unit tests cover: empty input, single root, deep nesting, duplicates, re-parenting, reordering
- [ ] `POST /api/bookmarks/sync` uses FolderTreeBuilder; creates folders recursively; creates bookmarks linked to their folders
- [ ] Extension first-run reads `chrome.bookmarks.getTree()`, POSTs to server
- [ ] Dashboard sidebar renders the imported folder tree
- [ ] Manual smoke: extension syncs 100+ real bookmarks, sidebar shows the tree within 5s

## Blocked by

- 003 (schema + folder read)
- 004 (extension + sync API)