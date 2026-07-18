# YT-017 — Embedded and pop-out YouTube focus player

**Labels**: `youtube`, `v3.2`, `player`, `ui`, `privacy`, `needs-triage`
**Type**: AFK (manual browser smoke required)
**Parent**: [PRD-005](../35-prds/PRD-005-youtube-discovery-tags-and-focus-player.md)

## What to build

Embed a privacy-enhanced single-video YouTube player on video detail and add an
authenticated player-only route that opens in a resizable separate window. The
pop-out document contains no dashboard chrome, metadata, comments, or surrounding
recommendation feed.

## Platform boundary

Use `https://www.youtube-nocookie.com/embed/{videoId}` with supported player
parameters and native controls. `rel=0` may restrict end-screen related videos to
the same channel, but YouTube no longer permits embeds to disable those items
entirely. Native YouTube title/channel overlays also remain. Do not use deprecated
`modestbranding` or `showinfo` parameters.

## Acceptance criteria

- [ ] `/videos/:id` renders a responsive 16:9 privacy-enhanced iframe with an
  accessible title and native controls; the normal page does not autoplay
- [ ] the iframe allows the minimum browser capabilities needed for autoplay in
  the popup, encrypted media, picture-in-picture, and fullscreen
- [ ] the Content Security Policy permits frames from
  `https://www.youtube-nocookie.com` and does not broaden unrelated directives
- [ ] stored YouTube video IDs are validated/encoded before constructing an embed
  URL; video/channel metadata is escaped
- [ ] the detail page includes a clear **Pop out player** action and retains an
  explicit **Open on YouTube** fallback
- [ ] `GET /videos/:id/player` is authenticated and returns a minimal HTML
  document containing only a black full-viewport canvas and the player iframe
- [ ] the player-only route has no app header, sidebar, title block, metadata,
  comments, next-video queue, or dashboard recommendation UI
- [ ] the popup opens synchronously from the user's click at a sensible 16:9
  initial size (approximately 960×540), is resizable, and requests autoplay
- [ ] popup positioning is best-effort and does not assume a single monitor
- [ ] if `window.open` is blocked or returns null, the same player route opens in
  a normal new tab; the current detail page remains usable
- [ ] the iframe fills the popup viewport and continues to resize without
  distortion or scrollbars; native fullscreen works in supported browsers
- [ ] missing canonical videos return the existing authenticated 404 behavior
- [ ] embed-disabled, private, deleted, and age-restricted outcomes display a
  concise limitation/fallback path where YouTube exposes an error; no OAuth token
  or transcript/summary content is sent to the player
- [ ] opening the page alone does not create a watch event; actual IFrame Player
  playback is tracked locally per [ADR-011](../40-decisions/011-youtube-local-playback-and-search.md)
- [ ] server/UI tests cover auth, valid embed construction, CSP, escaping, 404,
  minimal player markup, absence of app chrome, popup-blocked fallback script,
  and responsive/accessibility attributes
- [ ] manual browser smoke in the deployed browser covers inline playback,
  pop-out resizing, browser popup blocking, fullscreen, picture-in-picture, an
  embed-disabled video, and mobile/narrow layout

## Blocked by

- [YT-005](./YT-005-videos-api-and-ui.md)

## References

- [YouTube embedded player parameters](https://developers.google.com/youtube/player_parameters)
- [YouTube privacy-enhanced embeds](https://support.google.com/youtube/answer/171780)
