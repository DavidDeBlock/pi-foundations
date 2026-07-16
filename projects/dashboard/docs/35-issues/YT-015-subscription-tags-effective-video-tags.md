# YT-015 — Subscription tags and effective video-tag filtering

**Labels**: `youtube`, `v3.2`, `tags`, `ui`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-005](../35-prds/PRD-005-youtube-discovery-tags-and-focus-player.md)

## What to build

Let a subscription carry shared dashboard tags and expose those tags as inherited
effective tags on every canonical video from its channel. Add subscription and
video filtering that recognizes inherited tags while keeping manual per-video
tag assignments independent.

## Product rules

- `subscription_tags` is the stored channel-level relationship.
- A video's effective tags are the distinct union of its `video_tags` and its
  current subscription's `subscription_tags`.
- Effective tags are derived at read time; do not bulk-copy them into
  `video_tags`.
- If a tag is both manual and inherited, render it once and report both sources.
- Removing a subscription tag never removes a manual `video_tags` row.
- Inherited tags apply in New Videos, playlists, history-backed canonical cards,
  and video detail. They do not make an excluded subscription visible in New
  Videos.

## Acceptance criteria

- [ ] add a migration for `subscription_tags(subscription_id, tag_id)` with a
  composite primary key, cascading foreign keys, and a `tag_id` index
- [ ] migration upgrade and clean-install tests prove existing tags and YouTube
  enrichment remain unchanged
- [ ] subscription tag create uses the shared `TagNormalizer`; duplicate and
  normalization-equivalent additions are idempotent
- [ ] `POST /api/subscriptions/:id/tags` accepts `{ name }`, returns the normalized
  tag, and returns 404 for an unknown subscription
- [ ] `DELETE /api/subscriptions/:id/tags/:tagId` removes only that subscription
  relationship and is idempotent for a missing relationship
- [ ] `GET /api/subscriptions` items include `tags: [{ id, name }]`, accepts
  `tag_id`, and combines it with existing included/excluded, search, and paging
- [ ] subscription text search matches channel titles and tag names
  case-insensitively without duplicate subscription rows
- [ ] `/subscriptions` supports tag autocomplete/create/remove per row and an
  autocomplete-backed tag filter without a full page reload for mutations
- [ ] subscription rows expose pending, success, and recoverable error states for
  tag mutations and remain keyboard accessible
- [ ] canonical video list/detail queries return each effective tag once with
  source metadata (`manual`, `subscription`, or both) while retaining `id` and
  `name` for compatibility
- [ ] existing `GET /api/videos?tag_id=` matches both manual and inherited tags
  in combination with all existing source/folder/channel/watch filters
- [ ] video cards and detail show inherited tags with a subtle channel indicator
  and tooltip; editing an inherited tag directs the user to the subscription
- [ ] adding/removing a subscription tag is immediately reflected on already
  stored videos and future ingestion requires no special tag-copy step
- [ ] query hydration is batched; listing 50 videos or subscriptions does not
  issue one tag query per row
- [ ] API and UI tests cover normalization, duplicates, tag search/filter
  composition, manual+inherited collision, removal safety, excluded channels,
  canonical videos in playlists/history, auth, and XSS escaping
- [ ] manual smoke: tag one subscription, verify an old and newly synced video,
  filter by that tag, add the same tag manually to one video, remove it from the
  subscription, and confirm only the manual tag remains

## Blocked by

- [YT-003](./YT-003-subscriptions-api-and-ui.md)
- [YT-005](./YT-005-videos-api-and-ui.md)
- [YT-008](./YT-008-canonical-youtube-library-foundation.md)

