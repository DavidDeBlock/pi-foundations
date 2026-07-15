# YT-006 — Tracer-bullet E2E + smoke test + docs

**Labels**: `youtube`, `v3.0`, `needs-triage`
**Type**: AFK (with manual smoke)
**Parent**: [PRD-003](../35-prds/PRD-003-youtube-v3-subscriptions.md)

## What to build

End-to-end smoke that exercises the full v3.0 flow on a real install, plus the documentation that lets David (or a future builder) reproduce the setup. This slice is primarily verification + docs; it touches all earlier slices but adds no new behavior.

## Acceptance criteria

- [ ] E2E smoke script (`server/scripts/smoke-youtube.sh` or similar, mirroring v1's `smoke.sh`): boots a clean server with YouTube credentials → OAuth → first sync imports subs → "Poll now" inserts at least one video → categorize (folder + tag) → reload → categorization persists → toggle `is_included` off → "Poll now" excludes that channel → toggle back on → resumes
- [ ] Logs reviewed: OAuth grant event, daily sync counts, RSS poll results per channel, manual poll results — all present and useful for debugging
- [ ] Per-channel failure isolation verified: a fake `channel_id` that 404s does not break the rest of the poll loop; the failing channel's `last_polled_at` is still updated
- [ ] Restart test: kill server → restart → poller resumes on its own → no double-inserts (idempotency holds)
- [ ] README updated: v3.0 section with "what it does", "Google Cloud Console setup", env vars, manual smoke recipe
- [ ] `docs/CONTEXT.md` verified accurate (no drift after the ADR-009 + CONTEXT.md updates)
- [ ] `docs/deployment.md` updated if any new env vars (`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_TOKEN_ENCRYPTION_KEY`, `YOUTUBE_OAUTH_REDIRECT_URI`) need to be in the production runbook; systemd considerations for the 15-min poller verified (it should just work, but verify)
- [ ] All 7 PRD-003 acceptance criteria pass when walked through end-to-end

## Blocked by

- [YT-003](./YT-003-subscriptions-api-and-ui.md) (needs the subscriptions UI to be interactive)
- [YT-005](./YT-005-videos-api-and-ui.md) (needs the videos UI to be interactive)