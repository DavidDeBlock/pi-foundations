# YT-024 — Video resources panel and full-description UX

**Labels**: `youtube`, `v3.4`, `ui`, `needs-triage`
**Type**: AFK (browser smoke required)
**Parent**: [PRD-007](../35-prds/PRD-007-youtube-description-resources.md)

## What to build

Add a scannable **Resources from this video** section directly below the focus
player and above Folder/Tags. Feature useful resources first while keeping other,
promotional, and raw-description content available through progressive
disclosure.

## Acceptance criteria

- [ ] render the section in the specified video-detail position without
  displacing or nesting Folder, Tags, Insight Card, or Transcript
- [ ] featured resources show category badge, useful creator label/fallback,
  domain, bounded context, and Open/Copy actions
- [ ] Other links and Promotional links hidden render as separate collapsed
  groups with counts; promotional links are not included in Featured by default
- [ ] Full description is collapsed independently and preserves readable line
  breaks while safely linkifying only validated stored resources
- [ ] show description fetched/refreshed time and explicit Refresh description
  action; page load itself remains side-effect free
- [ ] render useful empty states for not fetched, pending, no description, no
  links, stale-with-last-value, unavailable, and failed states
- [ ] refresh progress updates without full-page ambiguity and cannot create
  duplicate actions from repeated clicks
- [ ] long labels/domains/context wrap correctly and the section works with the
  current lighter dark theme on desktop, narrow, and touch layouts
- [ ] all external links open with safe rel attributes; Copy reports success or
  failure accessibly; controls are keyboard reachable with visible focus
- [ ] server-rendered remote content, query strings, labels, contexts, model
  reasons, and descriptions are escaped against XSS
- [ ] view/API tests cover grouping/order/counts/states/auth/XSS, and manual smoke
  covers the example video, a link-free description, mobile layout, and theme

## Blocked by

- [YT-023](./YT-023-description-resource-extraction-classification.md)
- [YT-017](./YT-017-youtube-focus-player.md)

