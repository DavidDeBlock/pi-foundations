# YT-026 — Optional AI resource classification and Insight Card integration

**Labels**: `youtube`, `llm`, `v3.4`, `needs-triage`
**Type**: AFK (MiniMax/manual smoke required)
**Parent**: [PRD-007](../35-prds/PRD-007-youtube-description-resources.md)

## What to build

Use MiniMax only for resources left ambiguous by rules, then make selected
creator-provided resources available to versioned Insight Cards as a distinct
Mentioned resources section.

## Product rules

- Deterministic and user rules run first; obvious resources consume no model
  request.
- AI receives bounded URL/label/domain/nearby text, not fetched target content.
- Invalid or low-confidence output falls back to `other`.
- Manual overrides and reusable rules always beat AI suggestions.
- Creator-provided resources are not transcript citations or Serper evidence.

## Acceptance criteria

- [ ] add a provider-neutral structured classifier contract with allow-listed
  category/visibility values, bounded confidence/reason, validation, timeout,
  retry ceiling, and typed failures
- [ ] classify only eligible ambiguous resources in bounded batches, snapshot
  model/prompt version, and avoid duplicate work for an unchanged description
  fingerprint and classifier revision
- [ ] delimit description context as untrusted input and prevent it from
  changing the system contract, requesting tools, or supplying arbitrary output
  fields
- [ ] expose global off/manual behavior plus an optional per-subscription
  automatic setting; existing subscriptions default off
- [ ] missing MiniMax configuration leaves deterministic resources fully usable
  and shows classification as unavailable rather than failed ingestion
- [ ] API/UI can explicitly classify ambiguous resources, show working/partial/
  failed state, and explain which results came from MiniMax
- [ ] user overrides created while a classification is pending remain
  authoritative when the model result arrives
- [ ] summary generation may snapshot selected visible resource IDs/URLs and
  render them under Mentioned resources with creator-provided labeling
- [ ] transcript timestamps, description resources, and Serper sources have
  separate output fields, headings, and visual citation treatments
- [ ] an old summary run keeps its snapshotted mentioned-resource links when the
  current description changes; ordinary reads trigger no provider request
- [ ] English/Dutch/Both summaries preserve resource titles/URLs while localizing
  only surrounding explanation where appropriate
- [ ] tests cover schema validation, batching/idempotency, low confidence,
  malformed/truncated output, timeout/retry, injection-shaped context, override
  races, missing provider, bilingual parity, source separation, XSS, and secrets
- [ ] manual smoke classifies ambiguous links from the example video and confirms
  the Insight Card never presents sponsor/affiliate links as external evidence

## Blocked by

- [YT-024](./YT-024-video-resources-panel.md)
- [YT-025](./YT-025-resource-overrides-and-rules.md)
- [YT-018](./YT-018-versioned-ai-summary-profiles.md)

