# YT-019 — AI & Research settings and Prompt Studio

**Labels**: `youtube`, `llm`, `v3.3`, `settings`, `ui`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-006](../35-prds/PRD-006-youtube-ai-summary-profiles-web-research.md)

## What to build

Add `Settings → AI & Research` for non-secret AI defaults, versioned summary
profile editing, and safe prompt testing. David can customize summary behavior
without editing server code, while the server retains control of safety,
evidence, citation, and structured-output rules.

## Product rules

- API keys remain environment-only and are never returned, rendered, or stored
  in dashboard settings.
- The effective prompt has a protected server base contract, an editable profile
  layer, and an optional per-video focus instruction.
- Saving a profile increments its revision. Old summary runs retain their
  existing snapshot.
- Built-in profiles may be customized and reset; duplicating creates a custom
  profile without a built-in identity.
- Default summary language supports English, Dutch, and Both. Search locale is a
  separate setting and may differ from output language.
- Prompt tests create explicitly labeled test runs and never replace the video's
  preferred summary automatically.

## Acceptance criteria

- [ ] add authenticated `/settings/ai` navigation and a cohesive AI & Research
  page with Provider, General defaults, Summary profiles, and Prompt Studio
  sections
- [ ] provider cards report MiniMax and Serper as configured/unconfigured using
  boolean server state only; responses and HTML contain no key or key fragment
- [ ] persist non-secret defaults for profile, output language, search country,
  search language, maximum search queries, input/output ceilings, and other
  bounded options chosen by PRD-006
- [ ] general defaults validate supported language values, locale formats,
  numeric ranges, and referenced profile IDs server-side
- [ ] `GET /api/ai/summary-profiles` lists built-in/custom profiles and current
  revisions without exposing the protected raw base prompt
- [ ] `POST /api/ai/summary-profiles` creates or duplicates a custom profile with
  normalized unique naming behavior
- [ ] `PATCH /api/ai/summary-profiles/:id` validates and saves a new revision
  rather than mutating revision history needed by existing runs
- [ ] `POST /api/ai/summary-profiles/:id/reset` restores the current server
  default for a built-in profile; custom profiles cannot masquerade as built-ins
- [ ] profile controls cover target depth/length, included sections, key-point
  limits, tone, default research state, default output language, and custom
  instructions without requiring raw JSON editing
- [ ] Prompt Studio supports only documented variables such as `video_title`,
  `channel_name`, `summary_mode`, `transcript`, `web_context`, and `current_date`;
  missing/unknown variables produce actionable validation errors
- [ ] assembled-prompt preview clearly distinguishes the protected contract from
  editable text, redacts secrets, and uses a bounded sample instead of embedding
  an entire transcript in the page
- [ ] prompt/profile/focus lengths are bounded and transcript/web delimiters
  cannot be escaped by user-provided text
- [ ] `POST /api/ai/summary-profiles/:id/test` requires a transcript-ready video,
  queues a labeled non-preferred test run, and returns its run ID/status
- [ ] unsaved drafts remain local to the browser until Save or Test; navigation
  warns about unsaved changes
- [ ] UI includes Duplicate, Reset to default, Save as new revision, and Test on
  video actions with accessible success/error states
- [ ] current revision, last edited time, and the number of runs using a profile
  are visible without showing full historical prompts by default
- [ ] settings/API/view tests cover auth, configuration booleans, secret
  non-disclosure, revision history, reset/duplicate, invalid variables, bounds,
  English/Dutch/Both defaults, prompt preview escaping, injection-shaped text,
  test-run isolation, and XSS
- [ ] manual smoke: edit and preview Standard, test it on a transcript, save a
  revision, verify an old run remains unchanged, duplicate the profile, reset the
  built-in, and verify no secret is visible in page source or network responses

## Blocked by

- [YT-018](./YT-018-versioned-ai-summary-profiles.md)

## Coordination note

YT-020 also reads search defaults but owns the Serper client, research pipeline,
and citations. Keep provider status/settings contracts small so both issues can
land without duplicating the research implementation.
