# YT-021 — Subscription automatic summary policies and usage limits

**Labels**: `youtube`, `llm`, `v3.3`, `automation`, `subscriptions`, `needs-triage`
**Type**: AFK (scheduler and provider smoke required)
**Parent**: [PRD-006](../35-prds/PRD-006-youtube-ai-summary-profiles-web-research.md)

## What to build

Let each subscription optionally queue a configured AI summary after its
automatic transcript becomes ready. Add explicit language/research choices and
global usage limits so informative channels can be automated without spending
provider capacity on gaming or entertainment channels.

## Product rules

- Automatic summary is off for every existing and newly synced subscription
  until David explicitly enables it.
- Auto summary requires `auto_fetch_transcripts`; enabling summary may offer to
  enable transcripts, but the server must reject an impossible policy state.
- Profile, output language, and research are explicit policy values. Automatic
  research is never inferred from the chosen profile's interactive default.
- A video gets at most one automatic run for the same policy revision and
  transcript fingerprint. Manual runs remain unrestricted by that idempotency.
- Daily generation and Serper-query limits are server-enforced. Reaching a limit
  defers work rather than losing it or repeatedly failing it.
- Excluded subscriptions do not enqueue new automatic work. Existing summaries
  remain readable.

## Acceptance criteria

- [ ] persist per-subscription `auto_summarize`, `summary_profile_id`,
  `summary_output_language`, `summary_web_research`, and a policy revision with
  safe foreign keys/defaults
- [ ] migration leaves all existing subscriptions with automatic summary off and
  preserves `auto_fetch_transcripts`, inclusion, tags, and sync metadata
- [ ] subscription read/PATCH contracts expose and validate the policy without
  ever exposing provider keys
- [ ] enabling auto summary without auto transcripts returns a useful validation
  response or performs one explicit, confirmed combined update; it is never
  silently stuck
- [ ] subscription UI groups Auto transcript and Auto summary controls, reveals
  profile/language/research choices only when relevant, and explains expected
  provider use
- [ ] language choices are English, Dutch, Both, and optionally “Use global
  default”; the resolved value is snapshotted into each run
- [ ] automatic web research has a separate opt-in control and is unavailable
  when Serper is unconfigured
- [ ] when a canonical video's transcript transitions to ready, the scheduler
  queues exactly one run for the effective policy revision and transcript
  fingerprint
- [ ] repeated polling, transcript retries, scheduler ticks, and restarts cannot
  create duplicate automatic runs
- [ ] excluded subscriptions and videos no longer eligible under the current
  subscription relationship do not enqueue; already queued work is handled by a
  documented cancel-or-finish rule and never becomes an infinite retry
- [ ] global settings enforce maximum automatic summaries per UTC day, maximum
  automatic Serper queries per UTC day, and bounded concurrency
- [ ] hitting a limit records a deferred reason and next eligible time; work
  resumes after the window resets in deterministic oldest-first order
- [ ] missing MiniMax configuration, missing Serper for a research policy,
  deleted profile, transcript loss, and provider failures produce observable
  bounded states without blocking other subscriptions
- [ ] manual generation remains available when automatic daily limits are
  reached, with clear disclosure that it is a manual provider action
- [ ] subscription list/filtering can identify Auto summaries on/off and shows
  the effective profile/language in a compact, scannable form
- [ ] operational status reports queued, running, deferred, completed, and failed
  automatic counts without logging prompts, transcripts, or secrets
- [ ] migration/service/scheduler/API/UI tests cover defaults, policy validation,
  idempotency, exclusion, revisions, transcript transitions, all language modes,
  explicit research, daily boundaries, restart recovery, profile deletion,
  provider failures, auth, and XSS
- [ ] manual smoke: enable Standard Dutch transcript-only for one informative
  channel and Detailed Both + research for another, ingest a new video for each,
  confirm one run per video, hit a low test limit, restart, and confirm deferred
  work resumes without duplication

## Blocked by

- [YT-018](./YT-018-versioned-ai-summary-profiles.md)
- [YT-019](./YT-019-ai-research-settings-prompt-studio.md)
- [YT-020](./YT-020-serper-web-research-citations.md)
