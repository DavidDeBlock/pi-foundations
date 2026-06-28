# 007 — Activity feed landing + bookmark detail

**Labels**: `v1`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md)

## What to build

The dashboard's default landing page (`GET /`) renders a reverse-chronological activity feed of bookmarks. Each item shows title, URL, folder path, date added, and tags (chips). Clicking a bookmark opens `/bookmarks/:id` with the full detail. The view is server-rendered HTML with HTMX for any interactivity (e.g. lazy-loaded tag chips).

## Acceptance criteria

- [ ] `GET /` renders the activity feed sorted by `created_at DESC`
- [ ] Each item shows: title (linked to URL), folder path, date added, tags as chips
- [ ] Clicking a bookmark navigates to `/bookmarks/:id`
- [ ] `GET /bookmarks/:id` shows: title, URL, full folder path, tags, created_at, updated_at, last_seen_at
- [ ] Smoke check: page loads in <500ms with 1,000 seeded bookmarks
- [ ] Tests cover: feed query (correct order, pagination), detail query (404 for missing id)

## Blocked by

- 003 (schema + folder read)