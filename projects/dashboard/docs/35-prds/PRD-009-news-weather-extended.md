# [PRD] News & Weather (extended sources)

**Labels**: `parent-prd`, `v5.1`
**Date**: 2026-07-16
**Status**: Draft

## Problem Statement

PRD-008 shipped News & Weather with the 5 first-implementation sources (VRT NWS, De Tijd General, CCB News, CCB Advisories, Open-Meteo Ghent). The user wants to extend the source list to:

- **HLN** — RSS URL known (`https://www.hln.be/home/rss.xml`); goes straight into the General category
- **De Standaard** — RSS overview page known (`https://www.standaard.be/extra/rss-feeds/49064508.html`); exact RSS endpoint needs verification
- **BRUZZ Politics + BRUZZ Mobility** — RSS overview page known (`https://www.bruzz.be/rss-feeds-op-bruzzbe`); exact RSS endpoints need verification
- **KMI warnings configurable link** — rendered on the weather block, links to `https://www.meteo.be/en/weather/warnings` by default

This is a small follow-up slice. No new modules, no new architectural decisions — it's an exercise of the levers ADR-010 already gave us.

For architectural decisions, see [ADR-010](../40-decisions/010-news-weather-architecture.md). For the first-implementation PRD, see [PRD-008](./PRD-008-news-weather.md).

## Solution

- New migration `026_news_extended_sources.sql` inserts 4 rows into `news_sources`: HLN enabled, De Standaard + BRUZZ Politics + BRUZZ Mobility disabled (`enabled = 0`) with placeholder URLs the operator updates once verified.
- New env var `KMI_WARNINGS_URL` (default `https://www.meteo.be/en/weather/warnings`). Read at boot via existing `env.ts`.
- `NewsWeatherView` updated to render the KMI warnings link in the weather block.

No new modules, no new endpoints, no schema changes.

## User Stories

### News

1. As a user, HLN articles appear in the General category within 30 min of the next scheduler tick.
2. As an operator, the De Standaard, BRUZZ Politics, and BRUZZ Mobility sources are seeded with `enabled = 0` and a clear placeholder URL, so they don't fetch noise until the real RSS endpoint is verified.
3. As an operator, I can verify the De Standaard / BRUZZ RSS endpoints and enable each source by updating the `url` column and flipping `enabled = 1`, without touching code.

### KMI warnings link

4. As an operator, I can change the KMI warnings URL by setting the `KMI_WARNINGS_URL` env var and restarting the server.
5. As a user, I see a "Official weather warnings (KMI) →" link in the weather block, which opens `meteo.be` warnings in a new tab.

## Implementation Decisions

### New sources

| Source | Category | URL (seeded) | Enabled |
|--------|----------|--------------|---------|
| HLN | General | `https://www.hln.be/home/rss.xml` | Yes |
| De Standaard | General | `https://www.standaard.be/extra/rss-feeds/49064508.html` (placeholder — operator updates once RSS endpoint verified) | No |
| BRUZZ Politics | Local and Politics | `https://www.bruzz.be/rss-feeds-op-bruzzbe` (placeholder — operator updates) | No |
| BRUZZ Mobility | Local and Politics | `https://www.bruzz.be/rss-feeds-op-bruzzbe` (placeholder — operator updates; Politics and Mobility may resolve to the same URL or different URLs) | No |

The placeholder URLs are the source's own RSS overview/info pages. They're intentionally not valid RSS feeds — but `enabled = 0` prevents the scheduler from fetching them, so this is safe. When the operator verifies the real RSS endpoint, they update the `url` column and flip `enabled = 1`. The `last_error` column on `news_sources` will capture any future fetch failures clearly.

A short SQL comment in the migration explains this to future readers.

### KMI warnings link

- New env var: `KMI_WARNINGS_URL`, read in `server/src/env.ts` alongside existing vars.
- Default: `https://www.meteo.be/en/weather/warnings`.
- Missing env var → default used (no error).
- `NewsWeatherView` reads the URL from a passed-in `kmiWarningsUrl` parameter (no module-level global reads; keeps the view testable).
- Rendered in the weather block: `<a href={kmiWarningsUrl} target="_blank" rel="noopener">Official weather warnings (KMI) →</a>`.

### Schema

No schema changes. Migration `026_news_extended_sources.sql` only INSERTs into `news_sources`.

### API contracts

No new endpoints.

### UI surface

`/news-weather` weather block gets one additional line: the KMI warnings link.

### Architectural decisions (inherited from ADR-010, no new ones)

- Source registry is DB-backed; adding sources = new migration (no deploy). This is the lever this PRD pulls.
- Per-source `enabled` flag is the mechanism for "not yet verified" sources.
- Per-source `url` column is the mechanism for "configurable" RSS endpoints.
- HTTP Basic auth still gates the page.

## Testing Decisions

### Unit tests

- `NewsWeatherView`: renders the KMI warnings link with the URL passed in; URL is escaped (defense in depth)
- `env.ts`: `KMI_WARNINGS_URL` reads correctly; missing env var falls back to default

### Manual / smoke tests

- Apply `026_news_extended_sources.sql` against a DB with PRD-008 seeded → 9 rows in `news_sources`, 4 new (1 enabled, 3 disabled)
- Wait one scheduler tick (~30 min) → HLN articles appear in General category, no errors in `last_error`
- Set `KMI_WARNINGS_URL=https://example.com` in env, restart server, visit `/news-weather` → link points to `https://example.com`
- Set `KMI_WARNINGS_URL=` (empty), restart server, visit page → link falls back to default
- Verify a placeholder URL via SQL: `UPDATE news_sources SET url = '<real RSS URL>', enabled = 1 WHERE name = 'De Standaard'`; wait one tick → articles appear, `last_error` is null

### What's NOT tested

- Automated URL verification from RSS info/overview pages — out of scope
- Admin UI for source management — out of scope (deferred per ADR-010)

## Out of Scope

- **De Tijd Top Stories + De Tijd Technology and ICT** — not in the user's "rest" list. Defer if requested.
- **Auto-discovery of RSS endpoints from overview pages** — would require fetching HTML and parsing. Not justified.
- **Admin UI for source management** — still deferred (per ADR-010)
- **HLN tracker-stripped URLs / clean canonicalization** — not asked

## Acceptance Criteria

These map directly to issues NW-006 and NW-007.

1. **Migration applies cleanly** — `026_news_extended_sources.sql` adds 4 rows to `news_sources` (1 enabled, 3 disabled). Idempotent on re-run.
2. **HLN works end-to-end** — HLN articles appear in the General category within 30 min of the next scheduler tick after migration.
3. **De Standaard + BRUZZ sources are inert until enabled** — they don't fetch (`enabled = 0`); when the operator updates the URL and flips `enabled = 1`, they begin fetching.
4. **`KMI_WARNINGS_URL` env var is wired** — env var read by `env.ts`, default fallback works, page renders the link with the configured URL.
5. **End-to-end smoke** — boot server with HLN + KMI defaults → `/news-weather` shows HLN articles in General and the KMI link in the weather block.

### References

- [ADR-010](../40-decisions/010-news-weather-architecture.md) — News & Weather architecture
- [PRD-008](./PRD-008-news-weather.md) — News & Weather (first implementation)
- [NW-001](./../35-issues/NW-001-schema-migration.md) — initial schema migration (the table `news_sources` this PRD inserts into)
