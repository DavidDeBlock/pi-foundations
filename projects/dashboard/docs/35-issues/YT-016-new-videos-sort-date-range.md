# YT-016 — New Videos sorting and published-date range

**Labels**: `youtube`, `v3.2`, `filters`, `ui`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-005](../35-prds/PRD-005-youtube-discovery-tags-and-focus-player.md)

## What to build

Add server-side sorting and an inclusive From/To publication-date range to New
Videos. The controls must compose with every existing canonical-library filter,
remain URL-addressable, and keep pagination stable.

The default New Videos view uses an inclusive Last 30 days range and sorts by
newest publication date. Operators can explicitly clear the date range to see
all time. A remembered Hide Shorts toggle removes canonical `/shorts/` entries
without changing playlist or watch-history defaults.

## Query contract

`GET /api/videos` gains:

- `sort=discovered_at|published_at|channel|title`
- `order=asc|desc`
- `published_from=YYYY-MM-DD`
- `published_to=YYYY-MM-DD`
- `exclude_shorts=true`

Defaults remain `sort=discovered_at&order=desc`. From and To refer to
`videos.published_at`, are individually optional, and include the complete named
UTC calendar day. To is implemented as an exclusive start-of-next-day boundary.

## Acceptance criteria

- [ ] the video query builder allow-lists sort fields/directions and never
  interpolates an unvalidated query value into SQL
- [ ] the API returns 400 with a useful error for unknown sort/order, impossible
  dates, non-`YYYY-MM-DD` input, or From later than To
- [ ] supported ordering is stable with video ID as the final tie-breaker and
  remains stable across pagination when primary values are equal
- [ ] publication bounds are applied server-side and compose with source,
  playlist, channel, folder, tag, watched, and unwatched filters
- [ ] an active date range excludes rows without a usable publication timestamp;
  no range preserves existing behavior
- [ ] `/videos` renders From and To native date controls, a Sort control with
  human-facing combined choices, and Apply/Clear actions
- [ ] sort choices are `Recently discovered`, `Oldest discovered`, `Newest
  published`, `Oldest published`, `Channel A–Z`, `Channel Z–A`, `Title A–Z`, and
  `Title Z–A`
- [ ] quick actions for Last 7 days and Last 30 days populate an inclusive range
  ending today; Clear dates removes only date constraints
- [ ] the bare New Videos view defaults to Last 30 days and Newest published;
  clearing dates remains stable across refresh and pagination
- [ ] `exclude_shorts=true` composes with all list filters, is available as a
  remembered Hide Shorts toggle, and is preserved through pagination
- [ ] invalid view parameters produce an accessible inline explanation rather
  than an empty-looking result
- [ ] form submission, pagination, filter changes, and reload preserve all active
  sort/date/filter query parameters; changing constraints resets to page 1
- [ ] the active date range is summarized near the result count and can be
  removed in one action
- [ ] filter controls wrap cleanly on narrow screens and labels remain visible
- [ ] API/data/UI tests cover defaults, every sort, equal-value tie-breakers,
  one-sided and two-sided ranges, leap day/month boundary, inclusive To,
  invalid/contradictory input, filter composition, empty results, auth, and XSS
- [ ] manual smoke: select a known one-week publication window, paginate it,
  reverse the order, refresh, and confirm the same constrained result set

## Blocked by

- [YT-005](./YT-005-videos-api-and-ui.md)
- [YT-013](./YT-013-watch-history-ui-watched-state.md)

## Coordination note

YT-015 also changes the video query and filter bar. Land YT-015 first or rebase
this issue after it to avoid duplicating query/hydration work.
