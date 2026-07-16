-- 025_news.sql — issue NW-001 (News & Weather v5.0)
--
-- DB foundation for the News & Weather slice: the source registry,
-- the normalized article store, and the weather snapshot table.
-- All architectural decisions (source discriminator, dedupe key,
-- weather PK, retention policy) come from ADR-010.
--
-- Idempotency: every CREATE uses `IF NOT EXISTS` and every seed
-- INSERT is guarded by `WHERE NOT EXISTS (SELECT 1 ...)` keyed on
-- `news_sources.url`. This means re-running this file directly
-- (outside the migrations runner) is safe — the runner itself
-- already prevents re-application via the `migrations` table, but
-- the SQL is also self-defensive in case someone runs it by hand
-- during development or recovery.

-- ─── news_sources ─────────────────────────────────────────────────────────
-- One row per feed. `type` is the fetcher discriminator
-- ('rss' | 'atom' | 'json_api'). `enabled` lets the operator
-- silence a flaky feed without losing its state. `last_fetched_at`
-- is the most recent fetch attempt; `last_successful_fetch_at` is
-- only updated on success. The due-check query
-- (NewsScheduler, NW-003) uses the indexed
-- `(enabled, last_fetched_at)` pair.

CREATE TABLE IF NOT EXISTS news_sources (
  id                      INTEGER PRIMARY KEY,
  name                    TEXT NOT NULL,
  category                TEXT NOT NULL,
  type                    TEXT NOT NULL,
  url                     TEXT NOT NULL,
  enabled                 INTEGER NOT NULL DEFAULT 1,
  refresh_interval_min    INTEGER NOT NULL DEFAULT 30,
  last_fetched_at         TEXT,
  last_successful_fetch_at TEXT,
  last_error              TEXT,
  created_at              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_news_sources_due
  ON news_sources(enabled, last_fetched_at);

-- ─── news_articles ────────────────────────────────────────────────────────
-- One row per article, deduped on (source_id, id). The `id` column
-- holds the feed-supplied guid (RSS) or Atom <id>; if absent, the
-- fetcher (NW-002) falls back to the article URL. Insertion uses
-- `INSERT OR IGNORE` so a re-fetch of the same feed is a no-op for
-- already-known articles.
--
-- `description` is plain text, truncated to 500 chars at ingest
-- (NW-002 ArticleNormalizer). `published_at` may be NULL for feeds
-- that omit a publication timestamp.

CREATE TABLE IF NOT EXISTS news_articles (
  id           TEXT NOT NULL,
  source_id    INTEGER NOT NULL REFERENCES news_sources(id),
  title        TEXT NOT NULL,
  description  TEXT,
  url          TEXT NOT NULL,
  published_at TEXT,
  fetched_at   TEXT NOT NULL,
  PRIMARY KEY (source_id, id)
);

CREATE INDEX IF NOT EXISTS idx_news_articles_published
  ON news_articles(source_id, published_at DESC);

-- ─── weather_snapshots ────────────────────────────────────────────────────
-- One row per weather source, overwritten on every successful fetch.
-- PRIMARY KEY on source_id (with ON DELETE CASCADE so removing a
-- source cleans up its snapshot). The three `_json` columns are
-- raw JSON blobs from Open-Meteo — no relational decomposition in
-- v5.0 (ADR-010).

CREATE TABLE IF NOT EXISTS weather_snapshots (
  source_id    INTEGER PRIMARY KEY REFERENCES news_sources(id) ON DELETE CASCADE,
  fetched_at   TEXT NOT NULL,
  current_json TEXT NOT NULL,
  daily_json   TEXT NOT NULL,
  hourly_json  TEXT NOT NULL
);

-- ─── Seed: 5 first-implementation sources ────────────────────────────────
-- Idempotent via WHERE NOT EXISTS on `url`. Adding a sixth source
-- means writing a new INSERT here (not a code change) — matches the
-- PRD's "adding new sources = new migration, not deploy" promise.
--
-- `created_at` is populated at migration run time using SQLite's
-- strftime so every seeded row has a fresh, accurate timestamp.
-- Each row is its own INSERT (rather than a multi-row VALUES) so
-- the SQL stays portable across SQLite versions and stays readable
-- for the next operator adding a sixth source.

INSERT INTO news_sources
  (name, category, type, url, refresh_interval_min, enabled, created_at)
SELECT 'VRT NWS', 'General', 'rss',
       'https://www.vrt.be/vrtnws/nl.rss.articles.xml', 30, 1,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (
  SELECT 1 FROM news_sources WHERE url = 'https://www.vrt.be/vrtnws/nl.rss.articles.xml'
);

INSERT INTO news_sources
  (name, category, type, url, refresh_interval_min, enabled, created_at)
SELECT 'De Tijd — General', 'Economy', 'rss',
       'https://www.tijd.be/rss/nieuws.xml', 30, 1,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (
  SELECT 1 FROM news_sources WHERE url = 'https://www.tijd.be/rss/nieuws.xml'
);

INSERT INTO news_sources
  (name, category, type, url, refresh_interval_min, enabled, created_at)
SELECT 'CCB News', 'Technology and Cybersecurity', 'rss',
       'https://ccb.belgium.be/news.xml', 30, 1,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (
  SELECT 1 FROM news_sources WHERE url = 'https://ccb.belgium.be/news.xml'
);

INSERT INTO news_sources
  (name, category, type, url, refresh_interval_min, enabled, created_at)
SELECT 'CCB Advisories', 'Technology and Cybersecurity', 'rss',
       'https://ccb.belgium.be/advisories.xml', 30, 1,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (
  SELECT 1 FROM news_sources WHERE url = 'https://ccb.belgium.be/advisories.xml'
);

INSERT INTO news_sources
  (name, category, type, url, refresh_interval_min, enabled, created_at)
SELECT 'Open-Meteo Ghent', 'Weather', 'json_api',
       'https://api.open-meteo.com/v1/forecast?latitude=51.0543&longitude=3.7174&current=temperature_2m,apparent_temperature,precipitation,rain,weather_code,wind_speed_10m,wind_gusts_10m&hourly=temperature_2m,precipitation_probability,precipitation,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset&timezone=Europe%2FBrussels&forecast_days=7',
       30, 1,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (
  SELECT 1 FROM news_sources WHERE url = 'https://api.open-meteo.com/v1/forecast?latitude=51.0543&longitude=3.7174&current=temperature_2m,apparent_temperature,precipitation,rain,weather_code,wind_speed_10m,wind_gusts_10m&hourly=temperature_2m,precipitation_probability,precipitation,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset&timezone=Europe%2FBrussels&forecast_days=7'
);