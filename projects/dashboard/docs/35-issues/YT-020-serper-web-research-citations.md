# YT-020 — Serper web research and source citations

**Labels**: `youtube`, `llm`, `v3.3`, `research`, `api`, `needs-triage`
**Type**: AFK (external API smoke required)
**Parent**: [PRD-006](../35-prds/PRD-006-youtube-ai-summary-profiles-web-research.md)

## What to build

Add an optional, bounded Serper research stage to versioned video summaries.
Research identifies claims or knowledge gaps worth checking, persists the search
queries/results used, and renders current web context separately from what the
transcript says.

## Product rules

- `SERPER_API_KEY` is server-side only. Missing configuration disables research,
  not transcript-only generation.
- Research is independently selectable for any profile. Detailed may default it
  on when configured; Quick and Standard default it off.
- The service performs no more than the configured per-run query limit and does
  not expose an unrestricted autonomous search loop.
- Search-result snippets are web context, not conclusive verification.
- Transcript timestamps cite the video; web citations link to result URLs. The
  UI and data model never treat them as interchangeable.
- This slice does not fetch arbitrary source pages.
- A research failure preserves a useful transcript summary with a visible
  `partial` or `failed` research state.

## Research flow

1. Derive focused candidate queries from the transcript evidence plan.
2. Validate/deduplicate queries and apply the configured limit.
3. Search using configured country/language.
4. Normalize and persist selected organic result metadata.
5. Synthesize corroboration, contradiction, later developments, and unresolved
   questions with explicit source references.

## Acceptance criteria

- [ ] add a provider-isolated `SerperSearchClient` configured from
  `SERPER_API_KEY`, with bounded timeout, typed errors, response validation, and
  no browser-visible credential
- [ ] add `video_summary_sources` with cascading run ownership, stable position,
  query, title, URL, domain, snippet, optional published date, and retrieval time
- [ ] summary runs persist research status as `disabled`, `pending`, `ready`,
  `partial`, or `failed` and capture the effective country/language/query limit
- [ ] `POST /api/videos/:id/summaries` accepts an explicit research boolean,
  returns 503 or a typed unavailable result when research is requested without
  Serper, and remains usable with `research: false`
- [ ] query generation uses the transcript evidence plan rather than sending
  every transcript line as a search query; queries are length-bounded,
  deduplicated, and capped by settings
- [ ] the client sends only the minimum search request fields, uses configured
  locale values, and never logs authorization headers or raw API responses
- [ ] normalize only valid HTTP(S) results, canonicalize/deduplicate URLs, bound
  title/snippet lengths, and reject unsafe protocols before persistence/rendering
- [ ] rank/select results deterministically and retain the originating query so
  the result can explain why a source was consulted
- [ ] research context is delimited as untrusted data and cannot override the
  protected prompt or inject new tool calls
- [ ] generated output separates transcript claims, supporting context,
  contradictions/updates, and unresolved items; every web-derived item cites one
  or more persisted source IDs
- [ ] English/Dutch/Both renderings share identical source IDs; link titles stay
  in their source language while surrounding explanation follows output language
- [ ] the detail page offers a Web research toggle, shows expected query limit,
  and disables it with a link to AI settings when Serper is unconfigured
- [ ] results render a clear Research section and source list distinct from
  timestamp citations, including query/retrieval metadata behind progressive
  disclosure
- [ ] zero useful results produce a completed transcript summary with an
  explicit “No useful web context found” state
- [ ] timeout, quota/auth error, malformed response, or partial query failure
  preserves transcript output, records bounded operator detail, and offers retry
  as a new run without mutating the old result
- [ ] ordinary summary reads, page views, language switches, and cached history
  views make no Serper request
- [ ] client/service/API/view tests cover auth, missing configuration, locale,
  query caps, deduplication, unsafe URLs, zero results, partial/full failure,
  citations, bilingual source parity, injection-shaped snippets, XSS, secret
  non-disclosure, and restart recovery
- [ ] manual smoke with the real configured API covers a current topic, a niche
  topic with no useful results, English and Dutch output, a forced provider
  failure, source links, and confirmation that the configured query cap is obeyed

## Blocked by

- [YT-018](./YT-018-versioned-ai-summary-profiles.md)
- [YT-019](./YT-019-ai-research-settings-prompt-studio.md)

## References

- [Serper](https://serper.dev/) — configured search-result provider.
