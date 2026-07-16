# [PRD] Dashboard v3.2 — YouTube discovery controls and focus player

**Labels**: `parent-prd`, `youtube`, `v3.2`
**Date**: 2026-07-16
**Status**: Draft

## Problem statement

The dashboard now has a useful canonical YouTube library, but discovery still
requires repetitive organization and the actual viewing experience sends David
back into YouTube's distracting site chrome.

Three related gaps remain:

1. A channel's subject is not reusable. David must tag videos one at a time even
   when every video from a subscription belongs to the same topics.
2. New Videos is always ordered by discovery time and cannot be constrained to
   a publication window, which makes focused catch-up sessions awkward.
3. Opening a video on YouTube also opens comments, recommendations, and the rest
   of the YouTube interface. David wants a player-only experience inside the
   dashboard and in a resizable separate window.

## Product outcome

Dashboard v3.2 turns New Videos into a focused personal viewing queue:

- subscriptions can carry shared dashboard tags;
- those tags are inherited by all existing and future videos from the channel;
- subscription and video lists can be searched or filtered by those tags;
- New Videos supports useful sort modes and an inclusive published-date range;
- a privacy-enhanced YouTube embed plays a single video without dashboard chrome,
  comments, or a recommendation feed beside it;
- the same player can open in a resizable, fullscreen-capable separate window.

The dashboard remains read-only toward YouTube. Tags, filters, and player state
are local dashboard concerns.

## User stories

### Subscription tags

1. As David, I can add one or more tags to a subscription, so I describe the
   channel once instead of categorizing every upload.
2. As David, existing and newly discovered videos from that channel immediately
   show those inherited tags.
3. As David, I can still add a tag directly to one video without confusing it
   with a channel-level tag.
4. As David, removing a tag from a subscription removes only the inherited
   relationship and never removes the same tag when I also added it manually to
   a video.
5. As David, I can search subscriptions by channel title or tag name and filter
   both subscriptions and videos to a tag.
6. As David, inherited tags are visually distinguishable on a video detail page,
   so I know that they must be changed on the subscription.

### New Videos discovery controls

7. As David, I can sort New Videos by discovery time, publication time, channel,
   or title.
8. As David, I can choose ascending or descending order through clear, useful
   labels rather than database terminology.
9. As David, I can set a From and To publication date, so I can catch up on a
   specific period.
10. As David, I can quickly choose common windows such as the last 7 or 30 days
    and clear the range in one action.
11. As David, filtering, sorting, pagination, and browser refresh preserve the
    same URL-addressable view.

### Focus player

12. As David, I can play a video from its dashboard detail page without seeing
    YouTube comments or a right-hand recommendation feed.
13. As David, I can pop the player into a separate resizable window that contains
    only the video player.
14. As David, I can use the YouTube player's fullscreen and picture-in-picture
    controls when the browser supports them.
15. As David, an unavailable, age-restricted, private, or embed-disabled video
    fails clearly and still offers an explicit link to YouTube.

## Product decisions

### Tags are inherited, not copied

`subscription_tags` stores the channel-level choice. A video's **effective
tags** are the union of:

- its manual `video_tags`; and
- the tags of the current subscription for its channel.

The union is calculated when reading the canonical video. It is not copied into
every `video_tags` row. This makes subscription tag changes retroactive, avoids a
bulk rewrite for every edit, and prevents inherited-tag removal from deleting a
manual assignment. When the same tag comes from both sources it renders once and
reports both sources.

Inherited tags apply to the canonical video in every dashboard context,
including New Videos, playlists, and history. Subscription inclusion still
controls whether subscription-origin videos appear in New Videos; a tag does not
override that rule.

### Date range means YouTube publication date

From/To filters operate on `videos.published_at`, not `discovered_at`. This
matches the user's mental model of "videos from this week" even when a backfill
discovered an older upload today.

Both dates are inclusive calendar dates. The server implements To as an
exclusive boundary at the start of the following UTC day. Invalid dates and a
From date later than To are rejected by the API and explained inline by the UI.
Videos with no usable publication date are excluded only while a date range is
active.

Default ordering remains newest discovery first. Every order has a stable video
ID tie-breaker so pagination cannot shuffle equal values.

### The focus window is a dashboard route

`/videos/:id/player` is an authenticated HTML document containing a single
responsive YouTube iframe on a black canvas. It deliberately omits the dashboard
header, sidebar, metadata, comments, and related-video column. The normal detail
page embeds the same player in its content area and offers **Pop out player**.

The embed uses YouTube's privacy-enhanced `youtube-nocookie.com` host and native
controls. The popup opens from a direct click, requests a sensible 16:9 initial
size, is resizable, and falls back to a normal new tab when the browser blocks a
popup.

YouTube does not allow embeds to fully disable end-of-video recommendations or
hide all native title/channel overlays. `rel=0` restricts related items to the
same channel but does not eliminate them. The dashboard therefore promises no
surrounding feed or comments, not a modification of YouTube's native player UI.
Deprecated parameters such as `modestbranding` and `showinfo` are not used.

Opening or playing an embed does not create a local watch-history event in this
release. Reliable playback tracking would require a separate privacy and
semantics decision.

## Data model

### `subscription_tags`

| Column | Meaning |
|---|---|
| `subscription_id` | FK to `subscriptions(id)`, cascade on delete |
| `tag_id` | FK to the shared `tags(id)`, cascade on delete |

The composite primary key is `(subscription_id, tag_id)`. An index on `tag_id`
supports tag filtering. Existing `video_tags` remains the source of manual
per-video assignments.

No sort or date preferences need storage: the URL is the source of truth, with
the existing Unwatched-only local preference remaining independent.

## API contracts

All routes use existing dashboard authentication.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/subscriptions/:id/tags` | Normalize/create and attach `{ name }` |
| DELETE | `/api/subscriptions/:id/tags/:tagId` | Remove one inherited tag source |
| GET | `/api/subscriptions` | Existing list gains `tag_id`; search also matches tag names; items gain `tags` |
| GET | `/api/videos` | Existing list gains `sort`, `order`, `published_from`, and `published_to` |
| GET | `/api/videos` and detail | Effective tags include source metadata while retaining existing `id` and `name` |

Supported sort fields are `discovered_at`, `published_at`, `channel`, and
`title`; supported orders are `asc` and `desc`. Unknown values return 400 rather
than silently changing the requested view.

The existing single `tag_id` contract remains backward-compatible. It matches
either a manual or inherited effective tag.

## UX requirements

- Subscription rows use the existing shared tag autocomplete and
  create-on-the-fly normalization behavior.
- Tag chips remain compact. A small channel/inheritance indicator and tooltip
  distinguish inherited tags without introducing a second tag color system.
- The subscription toolbar offers an autocomplete-backed tag filter and a clear
  all-filters action.
- New Videos groups Channel, Tag, From, To, and Sort into a scannable filter bar
  that wraps cleanly on narrow screens.
- Active constraints remain visible and removable without opening a menu.
- Sort labels are human-facing: `Recently discovered`, `Oldest discovered`,
  `Newest published`, `Oldest published`, `Channel A–Z`, `Channel Z–A`,
  `Title A–Z`, and `Title Z–A`.
- The embedded player uses a responsive 16:9 container and meets YouTube's
  minimum player size.
- The player iframe has an accessible title, permits fullscreen, and does not
  autoplay on the normal detail page. The popup may request autoplay because it
  is opened by an explicit user action, subject to browser policy.
- Content Security Policy allows frames only from the chosen YouTube embed host;
  external video IDs and text are always escaped/validated.

## Resilience, privacy, and security

- Tag mutations are transactional and idempotent.
- Effective-tag queries remain paginated and avoid per-row tag lookups.
- Date and sort values are allow-listed before SQL construction.
- Only valid stored YouTube video IDs may form an embed URL.
- `youtube-nocookie.com` privacy-enhanced mode is used. No OAuth token is sent to
  the iframe.
- Videos that require YouTube login or disallow embedding may not play in the
  dashboard; this is surfaced as a platform limitation, not retried as a sync
  failure.

## Delivery slices

1. **YT-015** — subscription tags and effective video-tag filtering.
2. **YT-016** — New Videos sort and published-date controls.
3. **YT-017** — embedded and pop-out focus player.

All three slices can be implemented independently against the existing v3.1
canonical library. YT-015 and YT-016 both touch the video list query/view and
should be landed sequentially to minimize merge friction.

## Release acceptance criteria

- Adding a tag to a subscription makes it visible and filterable on both an
  existing video and a newly ingested video from that channel.
- Removing an inherited tag does not delete an identical manual video tag.
- Subscription search finds a channel by tag name; tag filtering combines with
  included/excluded and text search.
- New Videos sort/date controls compose with source, playlist, channel, folder,
  tag, and watched-state filters and survive pagination.
- Date boundaries include the complete From and To UTC calendar days.
- Detail and pop-out routes play an embeddable video without dashboard chrome,
  comments, or a surrounding recommendation feed.
- The pop-out is resizable and exposes native fullscreen; popup blocking has a
  working new-tab fallback.
- Invalid query values, XSS-shaped metadata, missing videos, and embed-disabled
  videos have automated coverage and accessible failure states.
- The full applicable automated suite and a real-browser manual smoke pass.

## Non-goals

- Writing tags or playback state back to YouTube.
- Tag rules based on playlist, title keywords, or AI classification.
- Arbitrary multi-column sorting or saved named filter views.
- Replacing or skinning YouTube's native player controls.
- Removing native end-screen suggestions that YouTube does not permit embeds to
  disable.
- Automatic local watched-state tracking from player events.

## Follow-up opportunities

- Multi-tag filters with explicit Match any / Match all behavior.
- Saved views such as `AI + unwatched + last 30 days`.
- A compact queue that advances through the current filtered result set.
- Opt-in player-event tracking with a clear watched threshold.
- Keyboard shortcuts for play/pause, next item, and pop-out.

## References

- [ADR-004](../40-decisions/004-categorization-folders-tags.md) — shared folders
  and tags across dashboard content.
- [PRD-003](./PRD-003-youtube-v3-subscriptions.md) — subscription and New Videos
  foundation.
- [PRD-004](./PRD-004-youtube-library-history-playlists-backfill.md) — canonical
  library, playlists, and watched state.
- [YouTube embedded player parameters](https://developers.google.com/youtube/player_parameters)
  — supported parameters, minimum dimensions, deprecated controls, and `rel=0`
  behavior.
- [YouTube privacy-enhanced embeds](https://support.google.com/youtube/answer/171780)
  — `youtube-nocookie.com` behavior and embed limitations.
