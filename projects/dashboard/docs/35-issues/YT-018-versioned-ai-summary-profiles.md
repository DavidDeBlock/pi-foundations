# YT-018 — Versioned AI summary profiles and bilingual output

**Labels**: `youtube`, `llm`, `v3.3`, `ui`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-006](../35-prds/PRD-006-youtube-ai-summary-profiles-web-research.md)

## What to build

Replace the single overwritable YouTube Insight Card with immutable summary runs.
Add built-in Quick, Standard, and Detailed profiles, per-run focus instructions,
and English, Dutch, or bilingual output. This slice remains transcript-only;
Serper research and editable profile settings land separately.

## Product rules

- Summary depth, output language, and per-video focus are independent request
  values.
- Built-in defaults follow PRD-006: Quick 150–250 words, Standard 500–900 words,
  and Detailed 1,200–2,500 words without padding short source material.
- `en_nl` is one summary run containing English and Dutch renderings derived
  from the same structured evidence plan.
- Bilingual renderings must have matching section IDs and the same timestamp
  references; translation may not introduce new factual claims.
- Regenerate creates a new run. It never updates a completed run in place.
- Existing `video_summaries` records migrate to English Quick runs and remain
  readable.
- The transcript remains the only evidence source in this slice.

## API contract

- `GET /api/videos/:id/summaries` lists run metadata newest first.
- `POST /api/videos/:id/summaries` accepts `profile_id`, `output_language`,
  optional `focus_instruction`, and `research: false`.
- `GET /api/videos/:id/summaries/:runId` returns one persisted structured result.
- `POST /api/videos/:id/summaries/:runId/prefer` selects the default run.
- The singular `/api/videos/:id/summary` contract remains compatible by reading
  or generating the default built-in profile until dashboard consumers migrate.

## Acceptance criteria

- [ ] add migrations for `summary_profiles` and `video_summary_runs`, plus a safe
  preferred-run relation that does not create a circular migration dependency
- [ ] seed idempotent Quick, Standard, and Detailed profiles on clean install and
  upgrade; built-in IDs remain stable across restarts
- [ ] migrate existing ready, pending, and failed `video_summaries` rows into
  English Quick runs without losing output, model, prompt version, timestamps,
  or error state
- [ ] every new request snapshots effective profile options/instructions, prompt
  revision, focus instruction, language, model, and transcript fingerprint
- [ ] generating or retrying inserts a new run; completed run rows and their
  output snapshots are immutable
- [ ] validate `output_language` as `en`, `nl`, or `en_nl`; reject unknown profile
  IDs, overlong focus text, and research-enabled requests in this slice
- [ ] generation creates a structured language-neutral evidence plan before
  localized output and permits only stored transcript segment starts as
  timestamp citations
- [ ] English output is idiomatic English and Dutch output is natural Dutch while
  preserving names, code, URLs, product names, and technical terms where needed
- [ ] bilingual output has the same section identities, claim/evidence IDs,
  actions, and timestamp references in both languages; parity validation fails
  the run rather than persisting silently divergent variants
- [ ] input-size estimation chunks long transcripts on segment boundaries,
  persists/retains original timestamp references through synthesis, deduplicates
  repeated findings, and never silently truncates transcript text
- [ ] queue processing remains bounded, resumes pending runs after restart, and
  isolates one failed run from later jobs
- [ ] `/videos/:id` renders profile, language, focus, and Generate controls only
  when the transcript is ready; unavailable configuration has a useful state
- [ ] bilingual results use accessible English/Dutch tabs and changing tabs makes
  no API/provider call
- [ ] the detail view shows run history, status, profile, language, model,
  generation time, and a Set as preferred action without hiding the main result
- [ ] Quick, Standard, and Detailed produce visibly different section/length
  contracts while sharing timestamp-safe rendering
- [ ] API/view/service/migration tests cover auth, validation, all profiles, all
  languages, bilingual parity, long transcripts, old-summary migration,
  preferred selection, restart recovery, failures, XSS, and prompt injection in
  transcript/focus text
- [ ] manual smoke: generate all three depths for one video, generate Both for a
  long transcript, switch languages, select an older preferred run, restart, and
  confirm every run remains available

## Blocked by

- [YT-007](./YT-007-youtube-ai-insight-cards.md)

## Deferred to following slices

- Editable profile/prompt settings: [YT-019](./YT-019-ai-research-settings-prompt-studio.md)
- Serper web context: [YT-020](./YT-020-serper-web-research-citations.md)
- Subscription automation: [YT-021](./YT-021-subscription-auto-summary-policies.md)
