# NW-002 — Fetcher dispatcher + normalization + NewsStore

**Labels**: `news-weather`, `v5.0`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-008](../35-prds/PRD-008-news-weather.md)

## What to build

The data-ingestion layer: three fetchers (RSS, Atom, JSON API for Open-Meteo), an `ArticleNormalizer` that strips HTML and truncates to 500 chars, a `NewsStore` for typed DB reads/writes, and a `NewsFetchJob` orchestrator that ties a source row to the right fetcher and writes the result. This is the "feed importer" the spec calls out, minus the scheduler (NW-003) and page (NW-004).

All architectural decisions (dedupe key, description handling, storage shape) come from [ADR-010](../40-decisions/010-news-weather-architecture.md).

## Acceptance criteria

### Fetchers

- [ ] `NewsRssFetcher` (in `server/src/news/news-rss-fetcher.ts`): `fetch(url: string, opts?: { timeoutMs?: number }) → Promise<RawArticle[]>`. Uses `rss-parser`. Throws `FetchError` on network failure / parse failure / timeout. Returns empty array on empty feed.
- [ ] `NewsAtomFetcher` (in `server/src/news/news-atom-fetcher.ts`): same shape as RSS. Atom 1.0 supported by `rss-parser`.
- [ ] `OpenMeteoFetcher` (in `server/src/news/open-meteo-fetcher.ts`): `fetch(url: string, opts?: { timeoutMs?: number }) → Promise<WeatherSnapshot>`. Parses Open-Meteo JSON, returns `{ fetchedAt, current: {...}, daily: [...], hourly: [...] }`. Throws `FetchError` on failure.
- [ ] All fetchers set HTTP `User-Agent: Dashboard/1.0 (+<server url>)` header
- [ ] Default timeout: 15s (per ADR-010). Configurable per call via `opts.timeoutMs`.

### Normalizer

- [ ] `ArticleNormalizer` (in `server/src/news/article-normalizer.ts`): `normalize(rawItem): NormalizedArticle | null`. Returns `null` if the item lacks both a usable `guid`/`id` AND a usable `url` (we can't dedupe or link without one).
- [ ] Strips HTML from description; decodes common entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`)
- [ ] Truncates description to 500 chars at a word boundary (or hard-cut if no boundary within last 50 chars)
- [ ] Extracts `id` (guid) → falls back to `url` when guid missing
- [ ] Parses `publishedAt` from RFC 822 (RSS), ISO 8601 (Atom), or returns `undefined` if unparseable
- [ ] Title is plain text (trimmed, collapsed whitespace); empty title → returns `null`

### Store

- [ ] `NewsStore` (in `server/src/news/news-store.ts`): typed DB wrapper with methods:
  - `listEnabledSources() → Source[]`
  - `listDueSources(now: Date) → Source[]` (where `last_fetched_at IS NULL OR last_fetched_at + refresh_interval_min * 60s < now`)
  - `updateSourceState(id: number, state: { lastFetchedAt?: string; lastSuccessfulFetchAt?: string; lastError?: string | null })`
  - `insertArticles(sourceId: number, articles: NormalizedArticle[]) → { inserted: number }` — uses `INSERT OR IGNORE` so duplicates by `(source_id, id)` are silently skipped
  - `listArticlesByCategory(category: string, limit: number) → Article[]` — newest first by `published_at DESC NULLS LAST, fetched_at DESC`
  - `upsertWeatherSnapshot(sourceId: number, snapshot: WeatherSnapshot) → void` — uses `INSERT OR REPLACE` keyed on PK
  - `getWeatherSnapshot(sourceId: number) → WeatherSnapshot | null`
- [ ] All `Source`, `NormalizedArticle`, `Article`, `WeatherSnapshot` types live in `server/src/news/types.ts`

### Orchestrator

- [ ] `NewsFetchJob` (in `server/src/news/news-fetch-job.ts`): `run(source: Source) → Promise<{ ok: boolean; error?: string; inserted?: number }>`. Dispatches to the right fetcher based on `source.type`, normalizes, writes via `NewsStore`. Catches all errors and returns `{ ok: false, error: message }`. Never throws.

### Tests (per PRD-008 testing section)

- [ ] RSS fetcher: valid feed → articles; malformed XML → throws; empty feed → empty array; timeout → throws
- [ ] Atom fetcher: missing `<id>` → falls back to URL
- [ ] Open-Meteo fetcher: valid JSON → snapshot; missing fields → typed error
- [ ] ArticleNormalizer: HTML stripped; CDATA handled; entities decoded; 500-char truncation at word boundary; guid extraction; URL fallback; RFC 822 and ISO 8601 date parsing; missing guid + missing URL → returns null; empty title → returns null
- [ ] NewsStore: `INSERT OR IGNORE` on duplicate `(source_id, id)` (insert second batch with overlapping id → second batch silently skipped, count returned); weather REPLACE on PK conflict; `listDueSources` due-check math correct (uses mocked `now`)
- [ ] NewsFetchJob: happy path; fetcher throws → returns `{ ok: false }`; empty normalized list → returns `{ ok: true, inserted: 0 }`

## Blocked by

- [NW-001](./NW-001-schema-migration.md) (needs the tables to exist)

## Files to touch

- `server/src/news/types.ts` (new)
- `server/src/news/news-rss-fetcher.ts` (new)
- `server/src/news/news-atom-fetcher.ts` (new)
- `server/src/news/open-meteo-fetcher.ts` (new)
- `server/src/news/article-normalizer.ts` (new)
- `server/src/news/news-store.ts` (new)
- `server/src/news/news-fetch-job.ts` (new)
- `server/src/news/*.test.ts` (new — one per module)
