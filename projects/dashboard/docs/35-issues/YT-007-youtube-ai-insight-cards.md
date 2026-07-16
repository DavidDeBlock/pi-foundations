# YT-007 — MiniMax YouTube AI Insight Cards

**Labels**: `youtube`, `llm`, `v3.x`
**Type**: AFK (after MiniMax env vars are configured)
**Parent**: [PRD-003](../35-prds/PRD-003-youtube-v3-subscriptions.md)

## What to build

Turn a stored YouTube transcript into a persisted, timestamp-cited Insight Card. The first slice is deliberately on-demand: a user opens a video whose transcript is ready, requests a summary, and can later read the cached result without another model call. MiniMax is configured through the dashboard's provider-neutral OpenAI-compatible LLM settings.

## Acceptance criteria

- [ ] `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` are server-side environment variables; the key is never returned to browser code
- [ ] the default MiniMax endpoint is `https://api.minimax.io/v1` and the default model is `MiniMax-M2.7`
- [ ] a migration stores one summary per video with pending/ready/failed state, model, prompt version, timestamps, and structured Insight Card fields
- [ ] `POST /api/videos/:id/summary` queues an on-demand summary only when a transcript is ready; missing videos return 404, missing transcripts return 409, and missing LLM configuration returns 503
- [ ] `GET /api/videos/:id/summary` returns the persisted state without calling MiniMax
- [ ] MiniMax receives the locally stored timed transcript and returns a TL;DR, key points, why-to-watch guidance, action items, and mentioned entities
- [ ] generated key points and action items cite valid transcript timestamps that link into the YouTube video
- [ ] the video detail page renders loading, retry, unconfigured, and completed Insight Card states
- [ ] completed summaries are cached; an ordinary page view never spends tokens
- [ ] pending jobs resume after a dashboard restart
- [ ] client, parser, service, API, migration, and view behavior have automated tests

## Deferred

- automatic subscription summaries
- bulk summarize from the video list
- morning briefing across videos
- ask-this-video chat
- cross-dashboard retrieval

## Blocked by

- [YT-005](./YT-005-videos-api-and-ui.md)

