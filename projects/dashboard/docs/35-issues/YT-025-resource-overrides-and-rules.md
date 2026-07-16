# YT-025 — Resource overrides and reusable channel/domain rules

**Labels**: `youtube`, `v3.4`, `ui`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-007](../35-prds/PRD-007-youtube-description-resources.md)

## What to build

Let David feature, hide, recategorize, or restore one resource and optionally
turn that correction into an explicit reusable domain or channel rule.

## Product rules

- Precedence is resource override, reusable user rule, deterministic rule,
  optional AI, then uncertain fallback.
- No single-resource action silently creates a global rule.
- Restore automatic removes the explicit override and immediately recomputes the
  effective result.
- Description refresh/re-extraction never overwrites user intent.

## Acceptance criteria

- [ ] persist lossless per-resource overrides and `video_resource_rules` for
  normalized domain/channel scope, nullable category/visibility, enable state,
  and audit timestamps
- [ ] validate categories, visibility, scope, normalized domains, ownership, and
  conflicting values at the API boundary
- [ ] expose authenticated create/list/update/disable/delete rule contracts and
  per-resource set/restore-automatic actions
- [ ] effective classification is resolved deterministically with the documented
  precedence and includes the winning source/reason
- [ ] the resources panel offers Feature, Hide, Recategorize, and Restore
  automatic actions with clear current state and optimistic-action recovery
- [ ] after a correction, offer separate “apply to this domain” and “apply to
  this channel” choices that preview the affected scope before saving
- [ ] conflicting domain/channel rules use a documented deterministic tie-break;
  explicit resource override always wins
- [ ] rules apply to existing and future extracted resources without rewriting
  their automatic classification history
- [ ] inactive/disappeared resources retain overrides and recover them if the
  same canonical resource reappears
- [ ] settings or a focused management surface lists rules, affected scope,
  enabled state, and edit/remove controls
- [ ] tests cover precedence, conflicts, refresh survival, future videos,
  restore-automatic, invalid scope/category, deleted videos, auth, concurrency,
  XSS, and transaction rollback
- [ ] manual smoke hides one sponsor domain, features one repository for a
  channel, refreshes the description, and confirms both intents survive

## Blocked by

- [YT-024](./YT-024-video-resources-panel.md)

