# YT-027 — Guarded resource link metadata and freshness checks

**Labels**: `youtube`, `v3.4`, `security`, `needs-triage`
**Type**: AFK (network/security smoke required)
**Parent**: [PRD-007](../35-prds/PRD-007-youtube-description-resources.md)

## What to build

Add an explicit, bounded checker for selected description resources. It may
resolve redirects and retain small response metadata so the dashboard can flag
stale or moved links, without becoming a general-purpose server-side URL fetcher.

## Product rules

- Checking is separate from extraction/classification and is never required to
  show a resource.
- HTTP status is freshness information, not a malware or trust guarantee.
- Original and canonical creator URLs are preserved even when a final redirect
  destination is recorded.
- Ordinary video-detail reads make no target-site request.

## Acceptance criteria

- [ ] add check lifecycle/final URL/status/content type/bounded title/timestamp/
  error metadata without storing response bodies
- [ ] implement an allow-listed HTTP(S) client that resolves DNS and rejects
  loopback, private, link-local, multicast, reserved, and otherwise disallowed
  destinations before the initial request and every redirect
- [ ] defend against DNS rebinding and mixed-address answers according to a
  documented deny-by-default policy
- [ ] cap redirects, request duration, response bytes, concurrency, batch size,
  title length, error length, and retry behavior
- [ ] send no dashboard credentials, provider tokens, cookies, or user browser
  headers; execute no script and perform no authenticated challenge flow
- [ ] reject unsupported schemes, embedded credentials, malformed ports,
  overlong URLs, redirect loops, and redirects to disallowed addresses
- [ ] expose an explicit authenticated check action for selected visible
  resources plus observable pending/ready/failed/unchecked state
- [ ] UI shows last checked time, moved/broken indicators, and final domain when
  different, while keeping the original link available
- [ ] check failures never change resource category/visibility or erase prior
  useful metadata; repeated normal page loads do not retry
- [ ] tests use controlled local fixtures for redirects/limits/content types and
  cover IPv4/IPv6/private-address variants, rebinding abstraction, timeout,
  oversized response, TLS/network failure, auth, XSS titles, and restart state
- [ ] manual smoke checks known public repository/docs links and confirms a
  crafted LAN/loopback target is rejected before connection

## Blocked by

- [YT-024](./YT-024-video-resources-panel.md)

