// news/news-store.ts — issue NW-002
//
// Typed DB wrapper for the news & weather tables. One class
// per surface area: all reads/writes for `news_sources`,
// `news_articles`, and `weather_snapshots` go through here so
// the schema assumptions (column names, dedupe keys, indexes)
// are expressed once.
//
// Mirrors the pattern of `youtube-video-upsert.ts` and
// `youtube-accounts.ts`: a `Database` instance is injected, the
// store prepares statements lazily on first use, and the
// returned shapes are typed. No business logic lives here —
// the fetchers own "how to talk to Open-Meteo", the
// normalizer owns "how to clean up HTML", and the orchestrator
// (NewsFetchJob) owns "how to put it all together". The store
// is the dumb pipe between them.

import type { Database } from '../db.js'
import type {
  Article,
  NormalizedArticle,
  Source,
  SourceStateUpdate,
  SourceType,
  WeatherSnapshot,
} from './types.js'

// ─── Row shapes (raw, snake_case) ─────────────────────────────────────────

interface SourceRow {
  readonly id: number
  readonly name: string
  readonly category: string
  readonly type: string
  readonly url: string
  readonly enabled: number
  readonly refresh_interval_min: number
  readonly last_fetched_at: string | null
  readonly last_successful_fetch_at: string | null
  readonly last_error: string | null
  readonly created_at: string
}

interface ArticleRow {
  readonly id: string
  readonly source_id: number
  readonly title: string
  readonly description: string | null
  readonly image_url: string | null
  readonly url: string
  readonly published_at: string | null
  readonly fetched_at: string
}

interface WeatherSnapshotRow {
  readonly source_id: number
  readonly fetched_at: string
  readonly current_json: string
  readonly daily_json: string
  readonly hourly_json: string
}

// ─── Public surface ───────────────────────────────────────────────────────

/**
 * Encapsulates every read and write against the three news
 * tables. Construct once per request / scheduler tick with
 * the shared `Database`; the instance is cheap (no state).
 */
export class NewsStore {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  // ─── Sources ────────────────────────────────────────────────────────

  /**
   * Every source with `enabled = 1`. Ordered by id for stable
   * scheduler behavior (so a tick's `Promise.allSettled` order
   * is deterministic across runs).
   */
  listEnabledSources(): Source[] {
    const rows = this.#db.all<SourceRow>(
      `SELECT id, name, category, type, url, enabled,
              refresh_interval_min, last_fetched_at,
              last_successful_fetch_at, last_error, created_at
         FROM news_sources
        WHERE enabled = 1
        ORDER BY id ASC`,
    )
    return rows.map(rowToSource)
  }

  /**
   * Every source where `enabled = 1` AND the due-check is met:
   *
   *   * `last_fetched_at IS NULL` (never been polled), OR
   *   * `last_fetched_at + refresh_interval_min * 60s < now`
   *
   * The due-check runs in SQL so the scheduler can drop the
   * result straight into `Promise.allSettled` without further
   * filtering in JS. We convert `last_fetched_at` to a Unix
   * epoch via `strftime('%s', ...)` so the math is numeric.
   */
  listDueSources(now: Date): Source[] {
    const nowEpochSeconds = Math.floor(now.getTime() / 1000)
    const rows = this.#db.all<SourceRow>(
      `SELECT id, name, category, type, url, enabled,
              refresh_interval_min, last_fetched_at,
              last_successful_fetch_at, last_error, created_at
         FROM news_sources
        WHERE enabled = 1
          AND (
            last_fetched_at IS NULL
            OR CAST(strftime('%s', last_fetched_at) AS INTEGER)
               + refresh_interval_min * 60 < ?
          )
        ORDER BY id ASC`,
      [nowEpochSeconds],
    )
    return rows.map(rowToSource)
  }

  /**
   * Update one source's state. Only the fields present on
   * `state` are touched — passing `{ lastError: null }` clears
   * the error without resetting the timestamps.
   *
   * `lastError: null` is rendered as SQL `NULL` (not the
   * string `"null"`). Any other value is stored verbatim.
   */
  updateSourceState(id: number, state: SourceStateUpdate): void {
    const sets: string[] = []
    const params: Array<string | number | null> = []
    if (state.lastFetchedAt !== undefined) {
      sets.push('last_fetched_at = ?')
      params.push(state.lastFetchedAt)
    }
    if (state.lastSuccessfulFetchAt !== undefined) {
      sets.push('last_successful_fetch_at = ?')
      params.push(state.lastSuccessfulFetchAt)
    }
    if (state.lastError !== undefined) {
      // Distinguish "don't touch" (undefined) from "set to NULL"
      // (explicit null). The boolean is implicit in the type:
      // `state.lastError === null` → set to SQL NULL.
      sets.push('last_error = ?')
      params.push(state.lastError)
    }
    if (sets.length === 0) return
    params.push(id)
    this.#db.run(
      `UPDATE news_sources SET ${sets.join(', ')} WHERE id = ?`,
      params,
    )
  }

  // ─── Articles ───────────────────────────────────────────────────────

  /**
   * Insert a batch of normalized articles using
   * `INSERT OR IGNORE` so duplicates (by `(source_id, id)`)
   * are silently skipped. Returns the count of rows actually
   * inserted (i.e. the number of duplicates removed by the
   * UNIQUE constraint is `articles.length - inserted`).
   */
  insertArticles(
    sourceId: number,
    articles: ReadonlyArray<NormalizedArticle>,
  ): { readonly inserted: number } {
    if (articles.length === 0) return { inserted: 0 }
    let inserted = 0
    // Each INSERT is its own statement rather than one big
    // batched INSERT. The PK conflict semantics of
    // `INSERT OR IGNORE` are per-statement; running them
    // individually lets us sum `changes` accurately without
    // parsing the prepared-statement result.
    this.#db.transaction(() => {
      const stmt = this.#db
        .rawConnection()
        .prepare(
          `INSERT OR IGNORE INTO news_articles
             (id, source_id, title, description, image_url, url, published_at, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
      for (const a of articles) {
        const info = stmt.run(
          a.id,
          sourceId,
          a.title,
          a.description,
          a.imageUrl ?? null,
          a.url,
          a.publishedAt ?? null,
          new Date().toISOString(),
        )
        if (info.changes > 0) {
          inserted++
        } else if (a.imageUrl) {
          this.#db.run(
            `UPDATE news_articles
                SET image_url = ?
              WHERE source_id = ? AND id = ? AND image_url IS NULL`,
            [a.imageUrl, sourceId, a.id],
          )
        }
      }
    })
    return { inserted }
  }

  /**
   * Newest articles in a category. Joins `news_articles` to
   * `news_sources` on `source_id` and filters by
   * `news_sources.category`. Ordering:
   *
   *   `published_at DESC NULLS LAST, fetched_at DESC`
   *
   * Articles with no `published_at` (feeds that omit the
   * timestamp) sink to the bottom of each category block.
   */
  listArticlesByCategory(category: string, limit: number): Article[] {
    const rows = this.#db.all<ArticleRow>(
      `SELECT a.id, a.source_id, a.title, a.description, a.image_url, a.url,
              a.published_at, a.fetched_at
         FROM news_articles a
         JOIN news_sources s ON s.id = a.source_id
        WHERE s.category = ?
        ORDER BY a.published_at DESC NULLS LAST, a.fetched_at DESC
        LIMIT ?`,
      [category, limit],
    )
    return rows.map(rowToArticle)
  }

  // ─── Weather ────────────────────────────────────────────────────────

  /**
   * Replace the snapshot for one source. Implemented with
   * `INSERT OR REPLACE` so re-fetching the same source
   * overwrites the prior row atomically (the table has at
   * most one row per source_id at any time, per ADR-010).
   *
   * The three sub-arrays are stored as raw JSON strings; the
   * page layer parses them back into the typed shape. We use
   * `JSON.stringify` with no replacer — the structure is
   * already a plain object.
   */
  upsertWeatherSnapshot(sourceId: number, snapshot: WeatherSnapshot): void {
    this.#db.run(
      `INSERT OR REPLACE INTO weather_snapshots
         (source_id, fetched_at, current_json, daily_json, hourly_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        sourceId,
        snapshot.fetchedAt,
        JSON.stringify(snapshot.current),
        JSON.stringify(snapshot.daily),
        JSON.stringify(snapshot.hourly),
      ],
    )
  }

  /**
   * Fetch the snapshot for one source. Returns `null` when no
   * fetch has succeeded yet (so the page can render a
   * "fetched_at: never" placeholder without an error).
   */
  getWeatherSnapshot(sourceId: number): WeatherSnapshot | null {
    const row = this.#db.get<WeatherSnapshotRow>(
      `SELECT source_id, fetched_at, current_json, daily_json, hourly_json
         FROM weather_snapshots
        WHERE source_id = ?`,
      [sourceId],
    )
    return row ? rowToWeatherSnapshot(row) : null
  }

  /**
   * Find the json_api source with the most recently fetched
   * weather snapshot. Returns `null` if no weather source is
   * registered (seed is missing) or no snapshot has been
   * written yet (cold start).
   *
   * In v5.0 there is exactly one weather source (Open-Meteo
   * Ghent, seeded by `025_news.sql`). The "latest" lookup
   * tolerates a future where multiple weather locations are
   * added (PRD-009) without a code change — the page would
   * just show whichever location's snapshot is most recent.
   */
  getLatestWeatherSnapshot(): WeatherSnapshot | null {
    const row = this.#db.get<WeatherSnapshotRow>(
      `SELECT ws.source_id, ws.fetched_at, ws.current_json,
              ws.daily_json, ws.hourly_json
         FROM weather_snapshots ws
         JOIN news_sources s ON s.id = ws.source_id
        WHERE s.type = 'json_api'
        ORDER BY ws.fetched_at DESC
        LIMIT 1`,
    )
    return row ? rowToWeatherSnapshot(row) : null
  }
}

// ─── Row → typed converters ──────────────────────────────────────────────

function rowToSource(row: SourceRow): Source {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    type: row.type as SourceType,
    url: row.url,
    enabled: row.enabled === 1,
    refreshIntervalMin: row.refresh_interval_min,
    lastFetchedAt: row.last_fetched_at,
    lastSuccessfulFetchAt: row.last_successful_fetch_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  }
}

function rowToArticle(row: ArticleRow): Article {
  return {
    id: row.id,
    sourceId: row.source_id,
    title: row.title,
    description: row.description,
    imageUrl: row.image_url,
    url: row.url,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
  }
}

function rowToWeatherSnapshot(row: WeatherSnapshotRow): WeatherSnapshot {
  // Defensive: the JSON columns SHOULD always be valid JSON
  // (we wrote them). If a manual UPDATE corrupted one, we'd
  // rather throw a clear error than silently render garbage.
  // Use a small parse-or-throw helper so the message points
  // at the source_id.
  const current = parseJson(row.current_json, row.source_id, 'current_json') as WeatherSnapshot['current']
  const daily = parseJson(row.daily_json, row.source_id, 'daily_json') as WeatherSnapshot['daily']
  const hourly = parseJson(row.hourly_json, row.source_id, 'hourly_json') as WeatherSnapshot['hourly']
  return {
    fetchedAt: row.fetched_at,
    current,
    daily,
    hourly,
  }
}

function parseJson(
  raw: string,
  sourceId: number,
  column: string,
): unknown {
  try {
    return JSON.parse(raw)
  } catch (err: unknown) {
    throw new Error(
      `weather_snapshots.${column} for source_id=${sourceId} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}
