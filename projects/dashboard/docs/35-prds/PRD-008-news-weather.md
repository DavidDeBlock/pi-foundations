# [PRD] News & Weather (first implementation)

**Labels**: `parent-prd`, `v5.0`
**Date**: 2026-07-16
**Status**: Draft

## Problem Statement

The dashboard currently focuses on personal data the user owns and curates (Chrome bookmarks, email, YouTube subscriptions). The next slice adds **ambient information**: a glance view of Belgian news and weather the user wants to see without leaving the dashboard.

Concretely, the user wants:

- News from Belgian sources: general (VRT NWS, De Tijd General), cybersecurity (CCB News, CCB Advisories)
- Current weather + 7-day forecast for Ghent (Open-Meteo)
- One page that puts weather on top and news by category below
- Source list + refresh intervals configurable without code changes
- Failure isolation: one feed failing doesn't block the others

The first implementation is the 5 sources listed above. HLN, De Standaard (URL TBD), BRUZZ Politics + Mobility, and the KMI warnings link are deferred to **PRD-009**. AI summaries, event clustering, relevance scoring, project linking, and advanced filtering are explicitly **out of scope**.

For architectural decisions, see [ADR-010](../40-decisions/010-news-weather-architecture.md).

## Solution

**Dashboard v5.0 — News & Weather (first implementation)** adds:

- **Background feed importer** that polls every enabled source on its own interval, fetches in parallel, isolates failures, and writes new articles to a normalized store
- **News & Weather page** (`/news-weather`) that renders weather on top and news grouped by category below
- **DB-backed source registry** seeded by a single migration; adding new sources = new migration, not deploy

All data flows through a Hono route + a few deep modules. No new framework, no build step, no client-side state. Same HTTP Basic auth as the rest of the dashboard.

## User Stories

### Source management (operator flow)

1. As an operator, I can add a new RSS source by writing a new row into `news_sources` (via migration), so adding a source doesn't require a code change.
2. As an operator, I can disable a source by flipping `enabled = 0`, so a flaky feed doesn't spam errors.
3. As an operator, I can change a source's refresh interval by editing `refresh_interval_min`, so chatty vs sparse sources are polled at the right cadence.

### News ingestion

4. As a user, the importer fetches all enabled sources on schedule, so I see fresh news without manual refresh.
5. As a user, when one source fails, the others continue updating, so a single broken feed doesn't break my morning glance.
6. As a user, duplicate articles (same `guid` appearing in multiple fetches) don't clutter the page, so I see each story once.
7. As a user, the page shows new articles within ~30 min of publication, so the dashboard reflects current events.

### Weather

8. As a user, I see the current temperature in Ghent on the News & Weather page, so I know what to wear today.
9. As a user, I see the 7-day forecast, so I can plan my week.
10. As a user, weather refreshes every 30 min, so the page stays reasonably current.

### Page

11. As a user, the News & Weather page is reachable from the main nav, so I don't have to remember a URL.
12. As a user, I see weather at the top of the page and news by category below, so the most-glanceable info is most prominent.
13. As a user, each news card shows title, source, publication date, short description, and a link, so I can decide what to read.
14. As a user, I can click any article title to open the original in a new tab.

## Implementation Decisions

### Tech stack (per ADR-010)

- Inherits: Hono + `better-sqlite3` + vanilla JS UI + Vitest + `tsx` runtime.
- New dependency: `rss-parser` (RSS 2.0 + Atom 1.0, dedupe-by-guid support). Already covered by Node 22 native `fetch`.

### Modules

**Deep modules** (encapsulate complex logic; unit-tested in isolation):

| Module | Purpose |
|--------|---------|
| `NewsRssFetcher` | Fetch one RSS source, parse with `rss-parser`, normalize to `RawArticle[]` |
| `NewsAtomFetcher` | Fetch one Atom source, normalize (Atom 1.0 supported by `rss-parser`) |
| `OpenMeteoFetcher` | Fetch Open-Meteo JSON, normalize to a `WeatherSnapshot` |
| `ArticleNormalizer` | Strip HTML from description, truncate to 500 chars, extract guid/URL/id, parse `publishedAt` |
| `NewsScheduler` | Tick loop, due-check per source, `Promise.allSettled`, in-flight tracking, per-source timeout |
| `NewsStore` | All DB reads/writes for `news_sources`, `news_articles`, `weather_snapshots` — typed, single-responsibility |

**Thin orchestrators** (compose deep modules; covered by integration tests):

- `NewsFetchJob` — given a source row, runs the right fetcher + normalizer, then writes via `NewsStore`. Records success/failure on the source row.
- `NewsSchedulerOrchestrator` — on tick: query due sources, `Promise.allSettled(sources.map(runJob))`, update per-source state.
- `NewsWeatherView` — renders `/news-weather` (HTML).

**External-facing modules** (HTTP boundaries):

- `NewsWeatherPageRoute` — `GET /news-weather` (HTML, HTTP Basic)
- `NewsSourceStatusAPI` — `GET /api/news/sources` (debug JSON of source state) — optional in v5.0

**UI modules** (server-rendered HTML; covered by manual smoke):

- `WeatherBlock` — current conditions + 7-day forecast
- `NewsCategoryBlock` — title + list of article cards per category

**Storage modules:**

- Reuse existing `Database` and `Migrations` from the codebase
- New migration: `025_news.sql`

### Schema (per ADR-010)

```sql
-- news_sources: one row per feed
CREATE TABLE news_sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,                    -- "VRT NWS"
  category TEXT NOT NULL,                -- "General" | "Economy" | "Local and Politics" | "Technology and Cybersecurity" | "Weather"
  type TEXT NOT NULL,                    -- "rss" | "atom" | "json_api"
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  refresh_interval_min INTEGER NOT NULL DEFAULT 30,
  last_fetched_at TEXT,
  last_successful_fetch_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_news_sources_due
  ON news_sources(enabled, last_fetched_at);

-- news_articles: normalized articles, dedupe on (source_id, id)
CREATE TABLE news_articles (
  id TEXT NOT NULL,                      -- feed's guid, Atom <id>, or fallback URL
  source_id INTEGER NOT NULL REFERENCES news_sources(id),
  title TEXT NOT NULL,
  description TEXT,                      -- plain text, truncated to 500 chars
  url TEXT NOT NULL,
  published_at TEXT,                     -- ISO 8601, may be null if feed omits
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (source_id, id)
);

CREATE INDEX idx_news_articles_published
  ON news_articles(source_id, published_at DESC);

-- weather_snapshots: one row per source, overwritten on each fetch
CREATE TABLE weather_snapshots (
  source_id INTEGER PRIMARY KEY REFERENCES news_sources(id),
  fetched_at TEXT NOT NULL,
  current_json TEXT NOT NULL,
  daily_json TEXT NOT NULL,
  hourly_json TEXT NOT NULL
);
```

Seed (in `025_news.sql`):

```sql
INSERT INTO news_sources (name, category, type, url, refresh_interval_min, enabled) VALUES
  ('VRT NWS', 'General', 'rss',
   'https://www.vrt.be/vrtnws/nl.rss.articles.xml', 30, 1),
  ('De Tijd — General', 'Economy', 'rss',
   'https://www.tijd.be/rss/nieuws.xml', 30, 1),
  ('CCB News', 'Technology and Cybersecurity', 'rss',
   'https://ccb.belgium.be/news.xml', 30, 1),
  ('CCB Advisories', 'Technology and Cybersecurity', 'rss',
   'https://ccb.belgium.be/advisories.xml', 30, 1),
  ('Open-Meteo Ghent', 'Weather', 'json_api',
   'https://api.open-meteo.com/v1/forecast?latitude=51.0543&longitude=3.7174&current=temperature_2m,apparent_temperature,precipitation,rain,weather_code,wind_speed_10m,wind_gusts_10m&hourly=temperature_2m,precipitation_probability,precipitation,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset&timezone=Europe%2FBrussels&forecast_days=7',
   30, 1);
```

### API contracts

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| GET | `/news-weather` | Render the page (HTML) | HTTP Basic |
| GET | `/api/news/sources` | List sources with state (debug) | HTTP Basic |

### UI surface

| Path | View |
|------|------|
| `/news-weather` | Weather block + news by category |
| `/` | (unchanged) Recent activity feed |

Nav: add "News & Weather" link to existing nav, between activity feed and settings.

### Category display order

Fixed, in this order:
1. General
2. Economy
3. Local and Politics
4. Technology and Cybersecurity

Weather is rendered separately on top, not as a category.

### Architectural decisions (locked in ADR-010)

- **Source registry**: DB-backed `news_sources`, type discriminator, seeded by migration
- **Article dedupe**: feed `guid`/Atom `id` → `(source_id, id)` UNIQUE → `INSERT OR IGNORE`
- **Article retention**: forever
- **Weather storage**: one row per source, overwritten on fetch (PRIMARY KEY source_id)
- **Concurrent fetch**: `Promise.allSettled` + 15s per-source timeout + in-flight tracking
- **Scheduler pattern**: parallel infrastructure, in-process, mirrors YouTube RSS scheduler
- **Article description**: plain text, 500 chars, HTML stripped at import
- **Auth**: HTTP Basic (ADR-007)
- **Tech stack**: Hono + better-sqlite3 + vanilla JS

## Testing Decisions

### What makes a good test

A good test exercises **external behavior**: the inputs and outputs of a module as a consumer would use them. It does not test implementation details (which SQLite query ran, which scheduler tick rate). Tests that depend on implementation get rewritten when the implementation changes; tests on behavior survive.

### Unit tests (Vitest) — for the deep modules

| Module | What to test |
|--------|--------------|
| `NewsRssFetcher` | Valid RSS feed → normalized articles; malformed XML throws; network timeout throws; empty feed → empty array |
| `NewsAtomFetcher` | Valid Atom feed → normalized articles; missing `<id>` falls back to URL |
| `OpenMeteoFetcher` | Valid JSON response → normalized snapshot; missing fields → typed error |
| `ArticleNormalizer` | HTML stripped; CDATA handled; entities decoded; 500-char truncation; guid extraction; URL fallback; `publishedAt` parsing (RFC 822, ISO 8601, missing) |
| `NewsScheduler` | Empty source list → no-op; one due source → fetched; due-check uses `last_fetched_at + interval`; in-flight source skipped on next tick; failed source updates `lastError`; succeeded source updates both timestamps; `Promise.allSettled` isolates failure |
| `NewsStore` | Insert new article; `INSERT OR IGNORE` on duplicate `(source_id, id)`; weather snapshot upsert (REPLACE on PK conflict); list articles by category with limit |

### Integration tests (Vitest + Hono test client) — for thin orchestrators + APIs

- `NewsSchedulerOrchestrator` end-to-end against in-memory DB: tick fetches all due sources, persists articles, updates source state
- `GET /news-weather` renders without error with seeded data
- Auth middleware gates the page (401 without password, 200 with)

### Manual / smoke tests

- Server boots cleanly; migration applies; sources seeded
- Page loads in browser; weather + news both render
- Wait 30 min; refresh page; new articles appear (or manually call `NewsSchedulerOrchestrator.tick()`)
- Disable a source via SQL (`UPDATE news_sources SET enabled = 0 WHERE id = ?`); that source stops fetching
- Force a 404 on one source; other sources continue; `last_error` populated
- Add a duplicate guid to the feed (manually crafted); only one row appears in `news_articles`

### What's NOT tested in v5.0

- **Visual regression** — no snapshot tests
- **Performance benchmarks** — only smoke latency checks
- **E2E browser tests** — deferred; manual smoke is enough for a single page
- **Scheduler behavior under extreme load** — single-user LAN, no need

## Out of Scope (deferred to PRD-009 or later)

- **HLN, De Standaard (URL TBD), BRUZZ Politics, BRUZZ Mobility** → PRD-009
- **KMI warnings configurable link** → PRD-009
- **Article search within news** → deferred (no immediate consumer)
- **AI summaries, event clustering, relevance scoring** → not on roadmap
- **Admin UI for source management** → deferred until toggle pain is real
- **Article retention/prune** → deferred (ADR-010 keeps articles forever)
- **Weather forecast history** → deferred (ADR-010 keeps one snapshot per source)

## Further Notes

- The Chrome extension is not involved in this slice. All ingestion is server-side.
- The scheduler runs in-process alongside the Hono server (mirrors `youtube-rss-scheduler.ts`). No separate worker.
- HTTP requests from the server use a custom `User-Agent: Dashboard/1.0` header so feeds that block default Node UAs don't 403.
- Page is server-rendered HTML with optional vanilla JS sprinkles for any future interactivity (none in v5.0).
- v5.0 ships when all 8 acceptance criteria pass.

### Acceptance Criteria

These map directly to issues NW-001..NW-005.

1. **Schema migration applies** — `025_news.sql` creates the three tables and seeds 5 sources; migration is idempotent on re-run; `migrations.test.ts` passes with new coverage.
2. **Fetcher dispatcher works for all three types** — given a source of each type (RSS, Atom, JSON), the corresponding fetcher is invoked; output normalized to a common `RawArticle` / `WeatherSnapshot` shape.
3. **Article normalization is correct** — HTML stripped, truncated to 500 chars, guid/Atom-id extracted with URL fallback, `publishedAt` parsed from common feed formats.
4. **Dedupe works** — running the same feed twice produces no duplicate rows in `news_articles`; `INSERT OR IGNORE` enforced by `UNIQUE (source_id, id)`.
5. **Scheduler fetches due sources in parallel with isolation** — scheduler tick fires every 60s; due-check uses `last_fetched_at + refresh_interval_min`; per-source in-flight tracking prevents double-fetch; `Promise.allSettled` isolates per-source failures; per-source timeout at 15s.
6. **Weather storage works** — `weather_snapshots` has exactly one row per weather source at any time; each fetch overwrites via REPLACE on PK conflict; `fetched_at` updated.
7. **Page renders** — `/news-weather` returns 200 with weather block + news grouped by category; top 20 per category, newest first; HTTP Basic auth gates the page; nav link added.
8. **End-to-end smoke** — server boots, sources seeded, scheduler fires, page renders fresh data within 90s of boot.

### References

- [ADR-010](../40-decisions/010-news-weather-architecture.md) — News & Weather ingestion + display
- [ADR-009](../40-decisions/009-youtube-subscriptions-rss.md) — YouTube subscriptions + RSS (parallel pattern)
- [ADR-001](../40-decisions/001-deployment-self-hosted.md) — Self-hosted deployment
- [ADR-007](../40-decisions/007-auth-password-and-token.md) — Auth
