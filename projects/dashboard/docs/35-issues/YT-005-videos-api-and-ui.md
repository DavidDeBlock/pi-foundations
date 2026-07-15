# YT-005 — Videos API + NewVideosView + VideoDetailView

**Labels**: `youtube`, `v3.0`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-003](../35-prds/PRD-003-youtube-v3-subscriptions.md)

## What to build

David can browse new videos at `/videos` (reverse-chronological by `discovered_at`) with filters by channel, folder, and tag, plus pagination. Clicking a video opens `/videos/:id` with full details and categorize controls: inline title edit, folder picker, tag input with autocomplete + create-on-the-fly, and tag removal. All categorize actions use fetch + DOM patch (no full reload), reusing the existing v1 `TagNormalizer`, folder picker, and tag-autocomplete patterns to keep behavior consistent across the dashboard.

## Acceptance criteria

- [ ] `GET /api/videos?channel_id=&folder_id=&tag_id=&page=&limit=` returns paginated `{ items: [...], total, page, limit }`; default `limit=50`, sorted by `discovered_at DESC`
- [ ] Each item: `{ id, video_id, channel_id, channel_title, channel_thumbnail_url, title, published_at, thumbnail_url, link, discovered_at, folder_id, folder_name, tags: [{ id, name }] }`
- [ ] `GET /api/videos/:id` returns one video with full tag list + folder info
- [ ] `PATCH /api/videos/:id` accepts `{ folder_id?, title? }`; updates DB; returns updated row
- [ ] `POST /api/videos/:id/tags` body `{ name }` adds a tag via existing `TagNormalizer` (lowercase, trim, dedupe, slugify); creates tag row if new; returns the tag
- [ ] `DELETE /api/videos/:id/tags/:tagId` removes the tag link
- [ ] `/videos` page renders server-side HTML, paginated, with filter controls (channel select, folder select, tag select) matching v1's categorize page patterns
- [ ] `/videos/:id` page renders server-side HTML with title (inline edit), thumbnail, channel info + link to channel, link to YouTube, folder picker, tag chips + input
- [ ] Inline title edit + folder move + tag add/remove all use fetch + DOM patch (no full reload), matching v1's UX
- [ ] Reuses `TagNormalizer` and existing `tag` + `folder` JS modules from v1 (no duplicate normalization or autocomplete code)
- [ ] Tests: API contract for list (filters, pagination) + get + patch + tag add/remove; UI smoke for the categorize flows
- [ ] Manual smoke: poll inserts a video (via YT-004) → categorize via folder + tag → reload → categorization persists; tag autocomplete suggests existing tags + allows create-on-the-fly

## Blocked by

- [YT-004](./YT-004-videos-schema-rss-poller.md) (needs `videos` rows in DB)