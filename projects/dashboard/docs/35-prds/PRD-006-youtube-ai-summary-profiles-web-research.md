# [PRD] Dashboard v3.3 — Configurable YouTube AI summaries and web research

**Labels**: `parent-prd`, `youtube`, `llm`, `v3.3`
**Date**: 2026-07-16
**Status**: Draft

## Problem statement

The dashboard can already fetch a timed YouTube transcript and turn it into one
cached MiniMax Insight Card. That first slice proves the workflow, but it is too
rigid for regular use:

- every video uses one hard-coded concise prompt;
- a video can retain only one summary, so regenerating destroys the previous
  result;
- there is no choice between a quick briefing and a thorough explanation;
- prompt behavior cannot be adjusted without editing server code;
- summaries are English-only and cannot also be read in Dutch;
- the model is restricted to the transcript and cannot research whether claims
  are current, supported, or disputed.

David wants summary depth and language to match the video. A short gaming video
may need no summary, a tutorial may need an actionable medium summary, and an
informative long-form video may deserve a detailed bilingual report enriched
with current web context.

## Product outcome

Dashboard v3.3 turns the existing Insight Card into a configurable AI research
workspace:

- Quick, Standard, and Detailed profiles provide useful defaults;
- output can be English, Dutch, or both;
- the same video can retain multiple versioned summary runs;
- profile prompts and output options can be edited in an AI & Research settings
  area without exposing provider secrets;
- an optional Serper-backed research pass adds current external context with
  explicit web citations;
- transcript timestamps and web sources remain visibly distinct;
- subscriptions can later opt into an automatic summary policy with usage
  limits.

The transcript remains the authoritative source for what the video says. Web
research is clearly labeled supporting context, not a silent replacement for
the speaker's claims.

## User stories

### Summary depth and versions

1. As David, I can choose Quick, Standard, or Detailed before generating a
   summary, so the result matches the amount of attention I want to spend.
2. As David, I can add a per-video focus instruction, such as “extract practical
   steps” or “concentrate on the architecture.”
3. As David, generating another profile does not overwrite an existing result.
4. As David, I can revisit previous summary runs and see which profile, model,
   prompt revision, language, and research mode produced each result.
5. As David, a long transcript is summarized reliably rather than silently
   truncated to fit one model request.

### English and Dutch output

6. As David, I can generate a summary in English, Dutch, or both languages.
7. As David, when both languages are present I can switch between them without
   creating or finding a second summary entry.
8. As David, English and Dutch variants use the same evidence, sections, and
   timestamp citations, so they do not make materially different claims.
9. As David, technical terms, proper names, code, product names, URLs, and source
   titles are preserved where translation would reduce accuracy.
10. As David, I can choose a default output language globally and override it
    for one summary or one subscription policy.

### Prompt and profile settings

11. As David, I can edit the purpose, tone, depth, section choices, and custom
    instructions for each summary profile from Settings.
12. As David, I can preview the assembled prompt and test a draft against an
    existing transcript before making it the active profile revision.
13. As David, I can restore a built-in profile or duplicate one into a custom
    profile.
14. As David, changing a profile creates a new revision and does not change the
    recorded configuration of old summaries.
15. As David, provider keys stay in the server environment and are never shown
    in prompt previews or returned to the browser.

### Web research

16. As David, I can independently turn web research on or off for any summary
    depth.
17. As David, Detailed defaults to research on when Serper is configured, while
    Quick and Standard default to transcript-only.
18. As David, I can see which search queries were used and which sources informed
    the result.
19. As David, the summary distinguishes “the video says” from external context,
    later developments, and contradictions.
20. As David, a search failure does not discard a valid transcript summary; the
    result clearly reports that research is incomplete and can be retried.

### Subscription automation

21. As David, an informative subscription can automatically generate a chosen
    profile after its transcript becomes ready.
22. As David, gaming or entertainment subscriptions can leave automatic
    transcripts and summaries disabled.
23. As David, automatic research is a separate explicit choice and is never
    inferred merely because automatic summarization is enabled.
24. As David, daily run and search-query limits prevent unexpected provider use.

## Product decisions

### Depth, research, and language are separate controls

Quick, Standard, and Detailed are built-in profiles, not three independent code
paths. A profile provides defaults for length, sections, research, and output
shape. The generation request may override output language, research mode, and a
single per-video focus instruction without mutating the profile.

Built-in defaults are:

| Profile | Target | Default content | Research default |
|---|---|---|---|
| Quick | 150–250 words | TL;DR, 3–5 takeaways, worth-watching guidance | Off |
| Standard | 500–900 words | Overview, 6–10 cited points, examples, actions, limitations | Off |
| Detailed | 1,200–2,500 words | Executive summary, chapter walkthrough, arguments, examples, actions, limitations, open questions | On when configured |

These are targets rather than hard truncation points. A short transcript should
not be padded to satisfy a word count, and a model response must remain within
the configured server-side output-token ceiling.

### Bilingual output shares one evidence plan

Output language is `en`, `nl`, or `en_nl`. When `en_nl` is selected, one summary
run stores both localized renderings. The summarization pipeline first creates a
language-neutral structured evidence plan containing section identities,
claims, transcript segment references, entities, actions, and source references.
English and Dutch renderings are produced from that same plan and validated for
section and citation parity.

The dashboard does not translate or replace the stored transcript. Source titles
remain in their original language. The Dutch rendering should be natural Dutch,
not word-for-word translation, while preserving factual meaning and technical
terminology.

### Prompts have protected and editable layers

An effective prompt is assembled from:

1. a server-owned base contract for safety, evidence boundaries, timestamp
   validity, structured output, and prompt-injection resistance;
2. a versioned editable profile prompt for tone, depth, sections, and analysis
   priorities;
3. an optional per-video focus instruction;
4. server-provided transcript chunks and, when enabled, bounded research
   context.

The browser may edit profile instructions but cannot remove the base contract or
change the response schema. Supported template variables are allow-listed; an
unknown variable is rejected before saving. Transcript and web content are
always delimited as untrusted source material.

### Summary runs are immutable history

Generating or regenerating creates a new `video_summary_runs` row. Completed
results are never overwritten in place. A video may point to one preferred run
for default display, while the UI exposes its history.

Each run captures an immutable snapshot of its profile, prompt revision, output
language, focus instruction, model, transcript fingerprint, research options,
and generated output. This makes old results understandable and prevents profile
edits from retroactively changing their meaning.

Existing `video_summaries` rows migrate to English Quick runs without losing
ready, pending, or failed state. Compatibility reads may expose the preferred
run through the existing singular summary endpoint during migration.

### Long transcripts use hierarchical summarization

The service estimates input size before generation. Transcripts that do not fit
the safe model budget are divided on timed segment boundaries:

```text
timed transcript -> chunk evidence -> shared evidence plan -> localized output
                                             ^
                                             +-- optional web research
```

Chunk results retain original segment start times. The final synthesis may cite
only validated segment starts present in the stored transcript. Repeated points
are deduplicated before localization.

### Web research is explicit and bounded

Research is an optional enrichment stage:

1. MiniMax extracts important factual claims, named entities, products, dates,
   and possible knowledge gaps from the transcript evidence plan.
2. The service creates at most the configured number of focused queries.
3. Serper returns current search results using configured country and language.
4. Results are normalized, deduplicated, ranked, and stored with the run.
5. The final synthesis labels corroboration, contradiction, later developments,
   and unresolved claims.

The first release uses result titles, URLs, domains, dates when present, and
snippets. It does not fetch arbitrary result pages. Snippets are called “web
context,” not conclusive verification. Every external assertion links to the
underlying result URL, and the Serper response itself is not presented as a
source.

Output language and search locale are independent. A Dutch summary may use
English-language sources when they are more authoritative; search country and
language remain configurable.

### Partial research failure preserves transcript value

A transcript-only result can reach `ready` even when requested research fails.
The run records research as `failed` or `partial`, displays a warning, and offers
a research retry. Retrying research creates a new run or revision derived from
the same transcript evidence; it does not silently mutate a completed report.

## Data model

### `summary_profiles`

| Column | Meaning |
|---|---|
| `id` | Stable profile ID |
| `built_in_key` | Nullable `quick`, `standard`, or `detailed` identity |
| `name`, `description` | User-facing metadata |
| `instructions` | Editable profile prompt layer |
| `options_json` | Length, section, citation, and default-research options |
| `default_language` | `en`, `nl`, or `en_nl` |
| `revision` | Incremented for every saved change |
| `created_at`, `updated_at` | Audit timestamps |

Built-in profiles can be customized but retain a resettable server default.
Custom profiles have no `built_in_key`.

### `video_summary_runs`

| Column | Meaning |
|---|---|
| `id` | Summary-run ID |
| `video_id` | Canonical video FK |
| `status` | `pending`, `ready`, or `failed` |
| `profile_id` | Nullable source profile FK |
| `profile_snapshot_json` | Immutable effective options and profile text |
| `prompt_revision` | Revision used for this run |
| `focus_instruction` | Nullable per-video instruction |
| `output_language` | `en`, `nl`, or `en_nl` |
| `transcript_fingerprint` | Detects summaries based on older transcript text |
| `model` | Provider model used |
| `research_status` | `disabled`, `pending`, `ready`, `partial`, or `failed` |
| `evidence_json` | Structured evidence plan with transcript references |
| `outputs_json` | English and/or Dutch structured renderings |
| `requested_at`, `generated_at`, `updated_at` | Lifecycle timestamps |
| `error_message` | Bounded operational failure detail |

The preferred run may be represented by `videos.preferred_summary_run_id` or a
separate relation, chosen during implementation to avoid a circular migration.

### `video_summary_sources`

| Column | Meaning |
|---|---|
| `summary_run_id` | Owning run FK, cascade on delete |
| `position` | Stable display order |
| `query` | Search query that found the result |
| `title`, `url`, `domain`, `snippet` | Persisted result context |
| `published_at` | Nullable source date supplied by search |
| `retrieved_at` | Search timestamp |

Provider API keys are not stored in these tables.

## API contracts

All routes use existing dashboard authentication.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/ai/summary-profiles` | List built-in and custom profiles |
| POST | `/api/ai/summary-profiles` | Duplicate/create a custom profile |
| PATCH | `/api/ai/summary-profiles/:id` | Save a new profile revision |
| POST | `/api/ai/summary-profiles/:id/reset` | Restore a built-in profile |
| POST | `/api/ai/summary-profiles/:id/test` | Queue a non-active test against a selected transcript |
| GET | `/api/videos/:id/summaries` | List summary-run metadata/history |
| POST | `/api/videos/:id/summaries` | Queue `{ profile_id, output_language, research, focus_instruction }` |
| GET | `/api/videos/:id/summaries/:runId` | Read one persisted run and its sources |
| POST | `/api/videos/:id/summaries/:runId/prefer` | Select default display run |
| GET | `/api/ai/research/status` | Return configured/available state, never the key |

The existing `GET/POST /api/videos/:id/summary` remains temporarily compatible
with the preferred/default profile and is deprecated only after all dashboard
consumers move to the plural contract.

## UX requirements

### Video detail

- Place a Quick/Standard/Detailed selector, language selector, Web research
  toggle, optional focus field, and Generate action above the Insight Card.
- Disable generation with a clear explanation until the transcript is ready.
- When `Both` is selected, show English and Dutch tabs; remember the active tab
  locally without changing the stored preferred run.
- Render transcript citations as timestamp links and web citations as source
  links with visually different treatments.
- Detailed output uses collapsible or well-spaced sections instead of one large
  text block.
- Show generation state, profile, language, model, research state, source count,
  and generation time without overwhelming the primary content.
- Expose previous runs and a “Set as preferred” action. Regenerate always creates
  a new run.

### Settings → AI & Research

- Provider status reports MiniMax and Serper as configured/unconfigured without
  displaying secret values.
- General defaults include summary profile, output language, search country,
  search language, maximum queries per run, and output-token ceilings.
- Profile cards expose section toggles and concise controls before the advanced
  prompt editor.
- Prompt Studio supports allow-listed variables, assembled-prompt preview, test
  generation, save-as-new-revision, duplicate, and reset.
- Prompt previews redact secrets and use a bounded transcript sample rather than
  placing an entire long transcript into the settings page HTML.
- Built-in safety/evidence instructions are visible as a summarized protected
  contract, not editable raw text.

## Configuration

Secrets remain server-side environment variables:

- `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` for MiniMax or another
  OpenAI-compatible provider;
- `SERPER_API_KEY` for web search.

Non-secret defaults belong in dashboard settings stored in the database. An API
key opts its provider into availability; missing Serper configuration disables
research controls but does not disable transcript-only summaries.

## Resilience, privacy, and security

- Transcript, title, focus text, prompts, search queries, snippets, and model
  output are treated as untrusted data and escaped at render boundaries.
- The protected base prompt tells the model never to follow instructions found
  inside transcript or research content.
- Focus instructions and editable profile prompts have length limits.
- Template variables are allow-listed and expanded server-side.
- URLs are restricted to HTTP(S), normalized, and rendered with safe external
  link attributes. The first release does not fetch arbitrary result URLs.
- Provider timeouts, bounded retries, queue recovery, and per-run query limits
  prevent a single job from blocking later summaries.
- Logs include run IDs, provider, model, durations, query counts, and status but
  never API keys, full prompts, full transcripts, or complete provider payloads.
- Ordinary page views never call MiniMax or Serper.
- Cached summary reads and language switching spend no provider tokens.

## Delivery slices

1. **YT-018** — versioned runs plus Quick/Standard/Detailed and
   English/Dutch/Both output.
2. **YT-019** — AI & Research settings, profile management, and Prompt Studio.
3. **YT-020** — bounded Serper research, persisted sources, and web citations.
4. **YT-021** — per-subscription automatic summary policies and usage limits.

YT-018 is the data and generation foundation. YT-019 and YT-020 can be developed
after it with limited overlap: YT-019 owns settings/profile UI and YT-020 owns
the research client/pipeline. YT-021 integrates all earlier controls into
subscription automation and lands last.

## Release acceptance criteria

- A transcript-ready video can retain Quick, Standard, and Detailed runs without
  overwriting another run.
- English, Dutch, and bilingual generation render correctly; bilingual variants
  have matching section identities and transcript/source references.
- Long transcripts are chunked on timed segment boundaries and final citations
  resolve to stored transcript starts.
- Profile edits create revisions, old runs preserve snapshots, and built-in
  profiles can be restored.
- A custom focus instruction affects only the requested run.
- Research mode uses bounded Serper queries, persists sources, distinguishes web
  citations from timestamps, and clearly reports partial failure.
- Missing MiniMax disables generation; missing Serper disables only research.
- Automatic subscription policies run only when explicitly enabled and respect
  daily generation/search limits.
- Restart recovery, authentication, validation, XSS-shaped content, prompt
  injection attempts, provider failures, and compatibility migration have
  automated coverage.
- Manual smoke covers all three depths, all language modes, a long transcript,
  research success/failure, prompt testing, and one automatic subscription.

## Non-goals

- Translating or replacing the stored transcript itself.
- Treating search snippets as conclusive fact-checking.
- Fetching, scraping, or indexing arbitrary web result pages in the first
  research release.
- Unrestricted autonomous browsing or model-selected tool loops.
- Editing the protected safety and structured-output base contract.
- Sharing prompts or summaries between users; the dashboard remains single-user.
- Automatic summaries for every included subscription by default.
- Ask-this-video chat, cross-video retrieval, or morning briefings.
- AI-generated tags or automatic categorization.

## Follow-up opportunities

- Fetch and extract an explicitly selected source page with SSRF protections and
  per-domain controls.
- Ask-this-video chat grounded in transcript segments and saved sources.
- Compare multiple videos or summarize a playlist.
- Daily or weekly bilingual briefing across selected subscriptions.
- Export a summary to Markdown, email, or a project note.
- Quality feedback per profile to help tune prompts.

## References

- [YT-007](../35-issues/YT-007-youtube-ai-insight-cards.md) — current on-demand
  MiniMax Insight Card foundation.
- [PRD-003](./PRD-003-youtube-v3-subscriptions.md) — subscriptions and New Videos
  foundation.
- [PRD-004](./PRD-004-youtube-library-history-playlists-backfill.md) — canonical
  library and transcript-capable video foundation.
- [Serper](https://serper.dev/) — Google search result API used for bounded web
  context.
