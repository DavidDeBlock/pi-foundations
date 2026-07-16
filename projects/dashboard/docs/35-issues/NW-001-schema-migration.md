# NW-001 — Schema migration + 5-source seed data

**Labels**: `news-weather`, `v5.0`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-008](../35-prds/PRD-008-news-weather.md)

## What to build

The DB foundation for the News & Weather feature: three new tables (`news_sources`, `news_articles`, `weather_snapshots`) plus seed data for the 5 first-implementation sources (VRT NWS, De Tijd General, CCB News, CCB Advisories, Open-Meteo Ghent). All definitions come from [ADR-010](../40-decisions/010-news-weather-architecture.md) and the schema section of PRD-008.

## Acceptance criteria

- [ ] New migration file `server/migrations/025_news.sql` creates:
  - `news_sources` table with: `id`, `name`, `category`, `type`, `url`, `enabled` (DEFAULT 1), `refresh_interval_min` (DEFAULT 30), `last_fetched_at`, `last_successful_fetch_at`, `last_error`, `created_at`
  - `idx_news_sources_due` index on `(enabled, last_fetched_at)`
  - `news_articles` table with composite PRIMARY KEY on `(source_id, id)`: `id`, `source_id` (FK → `news_sources.id`), `title`, `description`, `url`, `published_at`, `fetched_at`
  - `idx_news_articles_published` index on `(source_id, published_at DESC)`
  - `weather_snapshots` table with PRIMARY KEY on `source_id`: `source_id` (FK), `fetched_at`, `current_json`, `daily_json`, `hourly_json`
- [ ] Seed data inserts the 5 sources with full URLs from PRD-008 (all `enabled = 1`, `refresh_interval_min = 30`):
  - VRT NWS → `https://www.vrt.be/vrtnws/nl.rss.articles.xml`
  - De Tijd — General → `https://www.tijd.be/rss/nieuws.xml`
  - CCB News → `https://ccb.belgium.be/news.xml`
  - CCB Advisories → `https://ccb.belgium.be/advisories.xml`
  - Open-Meteo Ghent → full Open-Meteo URL from PRD-008 (with `latitude=51.0543`, `longitude=3.7174`, full `current`/`hourly`/`daily` param set, `forecast_days=7`, `timezone=Europe/Brussels`)
- [ ] Migration is idempotent — re-running on a DB that already has these tables does not duplicate rows or error. Use `CREATE TABLE IF NOT EXISTS` and guard the seed INSERTs (e.g., `INSERT ... WHERE NOT EXISTS (...)`) or rely on running migrations on a fresh DB and accept the trade-off (document the choice).
- [ ] `server/src/migrations.ts` picks up `025_news.sql` automatically (no manual registration needed — confirm by reading the existing migration loader)
- [ ] `server/src/migrations.test.ts` is extended to assert the new tables and expected columns exist after applying all migrations against an in-memory DB
- [ ] `created_at` populated for all seeded sources with the current ISO timestamp at migration run time
- [ ] Manual smoke: fresh `pnpm migrate` applies cleanly; `SELECT * FROM news_sources` shows exactly 5 rows

## Blocked by

None — can start immediately.

## Files to touch

- `server/migrations/025_news.sql` (new)
- `server/src/migrations.test.ts` (add coverage)
