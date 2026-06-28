# 008 — TagNormalizer + categorize UI (folders + tags)

**Labels**: `v1`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md)

## What to build

The `TagNormalizer` deep module (pure function) that lowercases, trims, dedupes (case-insensitive), and slugifies tag names. The full categorize UI: inline title edit, folder move via picker, tag input with autocomplete + create-on-the-fly, tag remove via × on chip, folder create + rename from sidebar. All CRUD endpoints (`/api/folders`, `/api/bookmarks/:id`, `/api/bookmarks/:id/move`) implemented and tested.

## Acceptance criteria

- [ ] `TagNormalizer` module implemented and exported
- [ ] Unit tests cover: mixed case, whitespace, unicode, case-insensitive dedupe, slugify special chars
- [ ] Inline title edit on bookmark card; saves on blur
- [ ] Folder picker moves bookmark to a different folder
- [ ] Tag input with autocomplete from existing tags
- [ ] Creating a new tag by typing and pressing Enter
- [ ] Tag remove via × on chip
- [ ] Folder create + rename from sidebar
- [ ] `POST /api/folders`, `PATCH /api/folders/:id`, `DELETE /api/folders/:id` endpoints
- [ ] `POST /api/bookmarks/:id` (update), `POST /api/bookmarks/:id/move` endpoints
- [ ] Tests for all CRUD endpoints + UI handlers

## Blocked by

- 007 (activity feed UI — provides the bookmark card to edit)