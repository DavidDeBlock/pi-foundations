# ADR-010: News & Weather ingestion + display (v5.0)

**Status**: Accepted
**Date**: 2026-07-16
**Authors**: David

## Context

The dashboard currently focuses on personal data the user owns and curates: Chrome bookmarks (v1), email (v2), YouTube subscriptions + RSS-based new-video detection (v3.0). The next slice — v4 — adds **ambient information**: Belgian news and weather the user wants to glance at without leaving the dashboard.

The user explicitly listed Belgian news and weather as the goal, with **no AI summaries, event clustering, relevance scoring, project linking, or advanced filtering** in this slice. The "first implementation" set is 5 sources (VRT NWS, De Tijd General, CCB News, CCB Advisories, Open-Meteo Ghent); the rest (HLN, De Standaard, BRUZZ, KMI warnings link) lands in a follow-up PRD.

The architectural decisions for this slice were made during a grilling session on 2026-07-16 and are captured here so future readers don't have to re-derive them.

## Decision Drivers

- The dashboard already runs an RSS polling loop for YouTube subscriptions (`youtube-rss-fetcher.ts` / `youtube-rss-poller.ts` / `youtube-rss-scheduler.ts` per ADR-009). The temptation is to extend that pipeline.
- News articles have **different dedupe keys** than YouTube videos (article-level `guid`/URL vs video ID), **different lifecycle** (accumulate forever vs disappear after categorization), and a **different failure-isolation requirement** ("continue updating other feeds when one feed fails").
- Weather is **fundamentally not RSS** — it's a JSON API with time-bounded forecasts.
- The "first implementation" is 5 sources; the eventual list is 9. Architecture must accommodate growth without rework.
- The user wants the source list and refresh intervals to be **configurable** without code changes, but explicitly does not want an admin UI yet.
- The dashboard is single-user, LAN-only, single-process (per ADR-001, ADR-007). Schedulers are in-process.

## Decision

**v5.0 = News & Weather ingestion + display. First implementation = 5 sources. No AI, no filtering, no clustering.**

1. **Parallel infrastructure (no reuse of YouTube RSS plumbing).** A new `NewsFetcher` dispatcher, `NewsScheduler`, and `news_*` DB tables live alongside the existing YouTube RSS modules. YouTube code is untouched. Reason: per-channel subscription polling and per-source news polling have different dedupe keys, different failure-isolation shapes, and different lifecycles.

2. **Source registry: DB-backed, type-discriminated.** A single `news_sources` table holds all sources (RSS, Atom, JSON API). `type` column discriminator (`rss | atom | json_api`). Per-source `refresh_interval_min` column. Per-source `enabled` flag (so De Standaard can be seeded with `enabled = 0` until the URL is verified). Sources are seeded via migration `025_news.sql`.

3. **Article dedupe key: feed-supplied `guid` (or Atom `<id>`), fallback to URL.** Stored in the `news_articles.id` column. `UNIQUE (source_id, id)` constraint is the dedupe mechanism. Insertion uses `INSERT OR IGNORE`. Per-item parse failures within a feed are **skipped**, not fail-whole-feed.

4. **Article retention: forever.** No prune job. Storage is cheap (~9MB/year at 500 chars/article); "what did the news say about X last week" is a real use case. The CCB Advisories feed in particular benefits from indefinite retention (advisories don't age out like news).

5. **Weather storage: one row per source, overwritten on each fetch.** A `weather_snapshots` table with `PRIMARY KEY (source_id)`. JSON blobs for `current`, `daily`, `hourly` arrays (not decomposed relationally in v1). The user-visible "fetched 12 min ago" timestamp comes from `news_sources.last_successful_fetch_at`.

6. **Concurrent fetch with `Promise.allSettled` and per-source timeout.** Scheduler ticks every 60s. For each enabled source where `last_fetched_at IS NULL OR (last_fetched_at + refresh_interval_min * 60s < now())`, fire a fetch with a 15s timeout. All due sources fetched in parallel. Failures update `last_error`; successes update `last_fetched_at` and `last_successful_fetch_at`. **Per-source in-flight tracking** prevents double-fetching if a fetch outlives a tick.

7. **Article description: plain text, ~500 chars, stripped at import.** HTML stripped via `rss-parser`'s default summary behavior or a dedicated sanitizer. Truncate at 500 chars. Render-safe by default — no XSS surface ever, no escape code needed.

8. **Page: `/news-weather`, server-rendered HTML, no client framework.** Weather block on top (current conditions + 7-day forecast). News articles grouped by category below (General, Economy, Local and Politics, Technology and Cybersecurity). Top 20 per category, newest first. Same HTTP Basic auth as the rest of the dashboard. Nav link "News & Weather" added to the existing nav.

9. **Scheduler: in-process, same pattern as YouTube.** `NewsScheduler` mirrors `YoutubeRssScheduler` — first-poll ~15s after boot, `.unref()`-ed `setInterval`, idempotent `start()`/`stop()`, deterministic test scheduler via `RssIntervalScheduler` interface.

10. **Explicitly NOT in v5.0** (deferred):
    - HLN, De Standaard (URL TBD), BRUZZ Politics, BRUZZ Mobility → PRD-009
    - KMI warnings configurable link → PRD-009
    - Article search, AI summaries, event clustering, relevance scoring → not on roadmap
    - Admin UI to manage sources → deferred until actual toggle pain is felt
    - Article pruning / retention policy → deferred (see decision 4)

## Consequences

**Positive:**
- Architecture matches the YouTube precedent (DB-backed source list + scheduler + fetcher). Onboarding a future contributor is one ADR read.
- Failure isolation is structural (`Promise.allSettled`). One slow feed cannot starve the others.
- Adding new sources is a migration, not a deploy.
- The dispatcher pattern (RSS/Atom/JSON) is open to new source types later (e.g., a hypothetical Mastodon API) without touching the scheduler.
- Storage is bounded for weather (1 row/source), unbounded-but-cheap for articles (~9MB/year).
- No premature complexity: no admin UI, no prune job, no HTML escape code.

**Negative:**
- Some code duplication with YouTube RSS (fetcher + scheduler + interval). Acceptable: dedupe keys and lifecycle differ enough that cramming them together creates conditionals everywhere.
- Weather forecasts older than ~30 min can be slightly stale (matches the refresh interval). For a personal glance dashboard, fine.
- The `category` value is an implicit enum (string column, app-layer allowlist). A typo in a seed migration could create a fifth category nobody renders.
- Per-source in-flight tracking is a small piece of state to maintain. If missed, double-fetches are possible under heavy load.
- Five sources with `last_fetched_at` writes happening every tick that has any due source. SQLite serializes writes; trivial for our scale.

## Alternatives Considered

- **Reuse YouTube RSS plumbing** — Rejected. Different dedupe keys, different lifecycles, different failure-isolation shapes. Sharing creates conditionals.
- **Hardcoded source list in TS code** — Rejected. The user explicitly wants sources configurable without code changes.
- **Admin UI for source management in v5.0** — Rejected. No shipped user value without actual toggle pain. Defer until you've used the feature for a few weeks.
- **Article sliding-window retention** — Rejected. "What did the news say about X last week" is a real use case. Storage is cheap.
- **Weather forecast history (per-fetch snapshots kept)** — Rejected. No UI consumer. One row per source overwrites cleanly; switch later if history becomes wanted.
- **Single global env-var source config** — Rejected. Loses per-source state (`lastFetchedAt`, `lastError`). DB-backed state is required by the spec.
- **Sequential fetching with per-source try/catch** — Rejected. `Promise.allSettled` is the canonical expression of the spec's "continue updating other feeds when one feed fails" requirement.
- **Decompose `weather_snapshots` into relational `weather_current`, `weather_daily`, `weather_hourly` tables** — Rejected. No search, no join, no aggregation. JSON blobs are simpler and faster.

## References

- ADR-009 — YouTube subscriptions + RSS-based new-video detection (v3.0) — pattern paralleled for scheduler + fetcher shape
- ADR-001 — Self-hosted deployment (LAN-only, no cloud)
- ADR-007 — Auth: HTTP Basic password + Bearer API token
- PRD-008 — News & Weather (first implementation) — this ADR's consumer
- PRD-009 — News & Weather (extended sources) — follow-up
