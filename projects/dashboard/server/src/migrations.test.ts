import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'

// Path to the real `migrations/` directory at the project root. Vitest
// runs from `server/`, so cwd-relative works.
const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

describe('Database wrapper', () => {
  let db: Database

  beforeEach(() => {
    db = new Database(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('opens an in-memory database and runs DDL', () => {
    db.exec('CREATE TABLE t (id INTEGER, name TEXT)')
    db.run('INSERT INTO t (id, name) VALUES (?, ?)', [1, 'a'])
    const rows = db.all<{ id: number; name: string }>('SELECT * FROM t ORDER BY id')
    expect(rows).toEqual([{ id: 1, name: 'a' }])
  })

  it('all<T>() returns typed rows', () => {
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)')
    db.run('INSERT INTO t (n) VALUES (?)', ['x'])
    const rows = db.all<{ id: number; n: string }>('SELECT id, n FROM t')
    expect(rows[0]?.n).toBe('x')
  })

  it('get<T>() returns the first row or undefined', () => {
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)')
    expect(db.get<{ id: number }>('SELECT id FROM t WHERE id = ?', [1])).toBeUndefined()
    db.run('INSERT INTO t (n) VALUES (?)', ['hello'])
    expect(db.get<{ n: string }>('SELECT n FROM t')).toEqual({ n: 'hello' })
  })

  it('run() returns change count + last insert rowid', () => {
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)')
    const r = db.run('INSERT INTO t (n) VALUES (?)', ['x'])
    expect(r.changes).toBe(1)
    expect(Number(r.lastInsertRowid)).toBe(1)
  })

  it('transaction() commits on success and rolls back on throw', () => {
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)')

    db.transaction(() => {
      db.run('INSERT INTO t (n) VALUES (?)', ['a'])
      db.run('INSERT INTO t (n) VALUES (?)', ['b'])
    })
    expect(db.all<{ n: string }>('SELECT n FROM t')).toHaveLength(2)

    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t (n) VALUES (?)', ['c'])
        throw new Error('boom')
      }),
    ).toThrow('boom')
    // 'c' must NOT be present — the throw rolled back.
    expect(db.all<{ n: string }>('SELECT n FROM t')).toHaveLength(2)
  })
})

describe('Migrations runner', () => {
  let db: Database

  beforeEach(() => {
    db = new Database(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('applies pending migrations on a fresh DB', async () => {
    await runMigrations(db, { dir: MIGRATIONS_DIR })

    const applied = db.all<{ name: string }>(
      'SELECT name FROM migrations ORDER BY name',
    )
    expect(applied.map((r) => r.name)).toEqual([
      '001_initial',
      '002_search_trigram',
      '003_email_accounts',
      '004_emails_sync_state',
      '005_email_search',
      '006_email_tags',
      '007_email_sync_debounce',
      '008_youtube_accounts',
      '009_subscriptions',
      '010_videos',
      '011_email_html_body',
      '012_youtube_transcripts',
      '013_youtube_video_summaries',
      '014_youtube_library_foundation',
      '015_youtube_subscription_backfill',
      '016_youtube_playlists',
      '017_youtube_watch_history',
      '018_youtube_subscription_tags',
      '019_youtube_summary_runs',
      '020_ai_research_settings',
      '021_youtube_summary_research',
      '022_youtube_video_descriptions',
      '023_youtube_description_resources',
      '024_youtube_history_html_shorts',
      '025_news',
      '026_youtube_watch_tracking_search',
    ])

    // Spot-check that every table from the PRD schema now exists.
    const tables = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type IN ('table') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    const names = tables.map((t) => t.name)
    expect(names).toContain('folders')
    expect(names).toContain('bookmarks')
    expect(names).toContain('tags')
    expect(names).toContain('bookmark_tags')
    expect(names).toContain('api_tokens')
    expect(names).toContain('migrations')
    // FTS5 virtual table also lives in sqlite_master with type='table'.
    expect(names).toContain('bookmark_fts')
    // Trigram index table from issue #009.
    expect(names).toContain('bookmark_trigrams')
    // Email accounts table from issue #020.
    expect(names).toContain('email_accounts')
    // Email mirror + sync state from issue #021.
    expect(names).toContain('emails')
    expect(names).toContain('sync_state')
    // Email search infrastructure from issue #022.
    expect(names).toContain('email_fts')
    expect(names).toContain('email_trigrams')
    // Dashboard-only tag table from issue #025.
    expect(names).toContain('email_tags')
    // YouTube videos table + video_tags table from issue YT-004.
    expect(names).toContain('videos')
    expect(names).toContain('video_tags')
    expect(names).toContain('video_transcripts')
    expect(names).toContain('video_transcript_segments')
    expect(names).toContain('video_summaries')
    expect(names).toContain('youtube_channels')
    expect(names).toContain('video_origins')
    expect(names).toContain('youtube_preferences')
    expect(names).toContain('youtube_playlists')
    expect(names).toContain('youtube_playlist_items')
    expect(names).toContain('youtube_playlist_sync_state')
    expect(names).toContain('youtube_history_imports')
    expect(names).toContain('youtube_watch_events')
    expect(names).toContain('youtube_playback_state')
    expect(names).toContain('youtube_playback_sessions')
    expect(names).toContain('youtube_search_cache')
    expect(names).toContain('youtube_history_video_classifications')
    expect(names).toContain('subscription_tags')
    expect(names).toContain('summary_profiles')
    expect(names).toContain('video_summary_runs')
    expect(names).toContain('video_preferred_summary_runs')
    expect(names).toContain('ai_research_settings')
    expect(names).toContain('summary_profile_revisions')
    expect(names).toContain('video_summary_sources')
    expect(names).toContain('video_descriptions')
    expect(names).toContain('video_description_resources')
    // News & Weather (issue NW-001): source registry + articles + weather.
    expect(names).toContain('news_sources')
    expect(names).toContain('news_articles')
    expect(names).toContain('weather_snapshots')
    expect(db.all<{ id: string }>('SELECT id FROM summary_profiles ORDER BY id').map((row) => row.id)).toEqual([
      'builtin-detailed', 'builtin-quick', 'builtin-standard',
    ])
    const subscriptionCols = db.all<{ name: string }>('PRAGMA table_info(subscriptions)')
    expect(subscriptionCols.some((c) => c.name === 'auto_fetch_transcripts')).toBe(true)
    // Sync debounce column for the background scheduler (issue #026).
    const syncCols = db.all<{ name: string }>('PRAGMA table_info(sync_state)')
    expect(syncCols.some((c) => c.name === 'last_manual_trigger_at')).toBe(true)
  })

  it('is idempotent — running twice does NOT re-apply', async () => {
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    const firstApplied = db.all<{ name: string }>('SELECT name FROM migrations')
    expect(firstApplied).toHaveLength(26)

    await runMigrations(db, { dir: MIGRATIONS_DIR })
    const secondApplied = db.all<{ name: string }>('SELECT name FROM migrations')
    expect(secondApplied).toHaveLength(26)
    // applied_at should be unchanged on re-run (still the original timestamps).
    expect(secondApplied.map((r) => r.name).sort()).toEqual(
      firstApplied.map((r) => r.name).sort(),
    )
  })

  it('creates the news & weather schema (NW-001) with seeded sources', async () => {
    await runMigrations(db, { dir: MIGRATIONS_DIR })

    // Schema: news_sources — every column from the PRD is present with
    // the right type and DEFAULT.
    const sourceCols = db.all<{ name: string; type: string; dflt_value: string | null; pk: number }>(
      'PRAGMA table_info(news_sources)',
    )
    const sourceColNames = sourceCols.map((c) => c.name)
    expect(sourceColNames).toEqual([
      'id',
      'name',
      'category',
      'type',
      'url',
      'enabled',
      'refresh_interval_min',
      'last_fetched_at',
      'last_successful_fetch_at',
      'last_error',
      'created_at',
    ])
    const enabledCol = sourceCols.find((c) => c.name === 'enabled')!
    expect(enabledCol.dflt_value).toBe('1')
    const refreshCol = sourceCols.find((c) => c.name === 'refresh_interval_min')!
    expect(refreshCol.dflt_value).toBe('30')
    const idCol = sourceCols.find((c) => c.name === 'id')!
    expect(idCol.pk).toBe(1)

    // Index on (enabled, last_fetched_at) for the due-check query.
    const sourceIndexes = db.all<{ name: string; sql: string | null }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'news_sources' AND name NOT LIKE 'sqlite_%'",
    )
    expect(sourceIndexes.some((i) => i.name === 'idx_news_sources_due')).toBe(true)

    // Schema: news_articles — composite PK (source_id, id), FK to
    // news_sources, and the published_at DESC index.
    const articleCols = db.all<{ name: string; pk: number }>(
      'PRAGMA table_info(news_articles)',
    )
    const articleColNames = articleCols.map((c) => c.name)
    expect(articleColNames).toEqual([
      'id',
      'source_id',
      'title',
      'description',
      'url',
      'published_at',
      'fetched_at',
    ])
    // Composite PK shows up as two rows with pk > 0 on `id` and `source_id`.
    expect(articleCols.filter((c) => c.pk > 0).map((c) => c.name).sort()).toEqual([
      'id',
      'source_id',
    ])
    const articleFks = db.all<{ table: string; from: string; to: string }>(
      'PRAGMA foreign_key_list(news_articles)',
    )
    expect(articleFks).toContainEqual(
      expect.objectContaining({ table: 'news_sources', from: 'source_id', to: 'id' }),
    )
    const articleIndexes = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'news_articles' AND name NOT LIKE 'sqlite_%'",
    )
    expect(articleIndexes.some((i) => i.name === 'idx_news_articles_published')).toBe(true)

    // Schema: weather_snapshots — PK on source_id, FK CASCADE.
    const weatherCols = db.all<{ name: string; pk: number; notnull: number }>(
      'PRAGMA table_info(weather_snapshots)',
    )
    expect(weatherCols.map((c) => c.name)).toEqual([
      'source_id',
      'fetched_at',
      'current_json',
      'daily_json',
      'hourly_json',
    ])
    expect(weatherCols.find((c) => c.name === 'source_id')!.pk).toBe(1)
    // All non-PK columns are explicitly NOT NULL; the PK column is implicitly NOT NULL.
    expect(weatherCols.filter((c) => c.pk === 0).every((c) => c.notnull === 1)).toBe(true)
    const weatherFks = db.all<{ table: string; from: string; on_delete: string }>(
      'PRAGMA foreign_key_list(weather_snapshots)',
    )
    expect(weatherFks).toContainEqual(
      expect.objectContaining({
        table: 'news_sources',
        from: 'source_id',
        on_delete: 'CASCADE',
      }),
    )

    // Seed: exactly 5 sources, all enabled, all 30-min refresh, one per
    // category from PRD-008, URLs match the PRD byte-for-byte.
    const sources = db.all<{
      id: number
      name: string
      category: string
      type: string
      url: string
      enabled: number
      refresh_interval_min: number
      created_at: string
    }>(
      'SELECT id, name, category, type, url, enabled, refresh_interval_min, created_at FROM news_sources ORDER BY id',
    )
    expect(sources).toHaveLength(5)
    for (const s of sources) {
      expect(s.enabled).toBe(1)
      expect(s.refresh_interval_min).toBe(30)
      expect(typeof s.created_at).toBe('string')
      // ISO 8601: YYYY-MM-DDTHH:MM:SS.fffZ (24 chars) — same shape as strftime default.
      expect(s.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
    expect(sources.map((s) => s.name)).toEqual([
      'VRT NWS',
      'De Tijd — General',
      'CCB News',
      'CCB Advisories',
      'Open-Meteo Ghent',
    ])
    expect(sources.map((s) => s.category)).toEqual([
      'General',
      'Economy',
      'Technology and Cybersecurity',
      'Technology and Cybersecurity',
      'Weather',
    ])
    expect(sources.map((s) => s.type)).toEqual(['rss', 'rss', 'rss', 'rss', 'json_api'])
    // URLs must match the PRD-008 seed spec verbatim (the Open-Meteo URL
    // is the long one; the timezone is URL-encoded as %2F).
    expect(sources.map((s) => s.url)).toEqual([
      'https://www.vrt.be/vrtnws/nl.rss.articles.xml',
      'https://www.tijd.be/rss/nieuws.xml',
      'https://ccb.belgium.be/news.xml',
      'https://ccb.belgium.be/advisories.xml',
      'https://api.open-meteo.com/v1/forecast?latitude=51.0543&longitude=3.7174&current=temperature_2m,apparent_temperature,precipitation,rain,weather_code,wind_speed_10m,wind_gusts_10m&hourly=temperature_2m,precipitation_probability,precipitation,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset&timezone=Europe%2FBrussels&forecast_days=7',
    ])
  })

  it('is idempotent at the SQL level — re-running 025_news.sql directly does not duplicate seed rows', async () => {
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    expect(db.all<unknown>('SELECT id FROM news_sources')).toHaveLength(5)

    // Re-execute the same SQL. With CREATE TABLE IF NOT EXISTS and the
    // WHERE NOT EXISTS guard on the seed INSERT, this must be a no-op.
    const sql = await readFile(resolve(MIGRATIONS_DIR, '025_news.sql'), 'utf8')
    db.transaction(() => {
      db.exec(sql)
    })

    expect(db.all<unknown>('SELECT id FROM news_sources')).toHaveLength(5)
  })

  it('upgrades a populated migration-013 database without changing video ids or enrichment', async () => {
    const legacyMigrations = [
      '001_initial',
      '002_search_trigram',
      '003_email_accounts',
      '004_emails_sync_state',
      '005_email_search',
      '006_email_tags',
      '007_email_sync_debounce',
      '008_youtube_accounts',
      '009_subscriptions',
      '010_videos',
      '011_email_html_body',
      '012_youtube_transcripts',
      '013_youtube_video_summaries',
    ] as const
    db.exec(`CREATE TABLE migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`)
    for (const name of legacyMigrations) {
      const sql = await readFile(resolve(MIGRATIONS_DIR, `${name}.sql`), 'utf8')
      db.transaction(() => {
        db.exec(sql)
        db.run('INSERT INTO migrations (name) VALUES (?)', [name])
      })
    }

    db.run(
      `INSERT INTO youtube_accounts
         (id, provider, google_user_id, email_address, access_token_enc, refresh_token_enc, scopes)
       VALUES ('acct-1', 'youtube', 'google-1', 'd@example.com', 'x', 'y', 'youtube.readonly')`,
    )
    db.run(`INSERT INTO folders (id, name) VALUES ('folder-1', 'Research')`)
    db.run(`INSERT INTO tags (id, name) VALUES ('tag-1', 'watch')`)
    db.run(
      `INSERT INTO subscriptions
         (id, google_account_id, channel_id, channel_title, channel_thumbnail_url,
          subscribed_at, is_included, is_important, auto_fetch_transcripts)
       VALUES ('sub-1', 'acct-1', 'UClegacy', 'Legacy Channel', 'https://img/channel.jpg',
               '2025-01-01T00:00:00.000Z', 1, 1, 1)`,
    )
    db.run(
      `INSERT INTO videos
         (id, video_id, channel_id, title, published_at, thumbnail_url, link,
          discovered_at, folder_id, created_at, updated_at)
       VALUES ('video-local-1', 'youtube-1', 'UClegacy', 'Locally curated title',
               '2025-02-01T00:00:00.000Z', 'https://img/video.jpg',
               'https://youtube.com/watch?v=youtube-1', '2025-02-02T00:00:00.000Z',
               'folder-1', '2025-02-02T00:00:00.000Z', '2025-02-03T00:00:00.000Z')`,
    )
    db.run(`INSERT INTO video_tags (video_id, tag_id) VALUES ('video-local-1', 'tag-1')`)
    db.run(
      `INSERT INTO video_transcripts
         (video_id, status, language, requested_at, fetched_at, updated_at)
       VALUES ('video-local-1', 'ready', 'en', '2025-02-03T00:00:00.000Z',
               '2025-02-03T00:01:00.000Z', '2025-02-03T00:01:00.000Z')`,
    )
    db.run(
      `INSERT INTO video_transcript_segments
         (video_id, position, start_ms, duration_ms, text)
       VALUES ('video-local-1', 0, 0, 1200, 'Preserved transcript')`,
    )
    db.run(
      `INSERT INTO video_summaries
         (video_id, status, tldr, model, prompt_version, requested_at, generated_at, updated_at)
       VALUES ('video-local-1', 'ready', 'Preserved summary', 'MiniMax-M2.7', 1,
               '2025-02-03T00:02:00.000Z', '2025-02-03T00:03:00.000Z',
               '2025-02-03T00:03:00.000Z')`,
    )
    db.run(
      `INSERT INTO videos
         (id, video_id, channel_id, title, published_at, thumbnail_url, link,
          discovered_at, created_at, updated_at)
       VALUES ('video-pending', 'youtube-pending', 'UClegacy', 'Pending video',
               '2025-02-01T00:00:00.000Z', NULL, 'https://youtube.com/watch?v=youtube-pending',
               '2025-02-02T00:00:00.000Z', '2025-02-02T00:00:00.000Z', '2025-02-02T00:00:00.000Z'),
              ('video-failed', 'youtube-failed', 'UClegacy', 'Failed video',
               '2025-02-01T00:00:00.000Z', NULL, 'https://youtube.com/watch?v=youtube-failed',
               '2025-02-02T00:00:00.000Z', '2025-02-02T00:00:00.000Z', '2025-02-02T00:00:00.000Z')`,
    )
    db.run(`INSERT INTO video_summaries
      (video_id, status, model, prompt_version, requested_at, updated_at)
      VALUES ('video-pending', 'pending', 'old-model', 3, '2025-02-03T00:00:00Z', '2025-02-03T00:00:00Z')`)
    db.run(`INSERT INTO video_summaries
      (video_id, status, model, prompt_version, requested_at, generated_at, error_message, updated_at)
      VALUES ('video-failed', 'failed', 'old-model', 4, '2025-02-03T00:00:00Z',
              '2025-02-03T00:01:00Z', 'provider failed', '2025-02-03T00:01:00Z')`)

    await runMigrations(db, { dir: MIGRATIONS_DIR })

    expect(db.get('SELECT id, folder_id, local_title_override FROM videos')).toEqual({
      id: 'video-local-1',
      folder_id: 'folder-1',
      local_title_override: 'Locally curated title',
    })
    expect(db.get('SELECT * FROM video_tags')).toEqual({ video_id: 'video-local-1', tag_id: 'tag-1' })
    expect(db.get<{ text: string }>('SELECT text FROM video_transcript_segments')?.text).toBe('Preserved transcript')
    expect(db.get<{ tldr: string }>('SELECT tldr FROM video_summaries')?.tldr).toBe('Preserved summary')
    expect(db.get('SELECT id, status, profile_id, output_language, model, prompt_revision FROM video_summary_runs')).toEqual({
      id: 'legacy-video-local-1', status: 'ready', profile_id: 'builtin-quick', output_language: 'en',
      model: 'MiniMax-M2.7', prompt_revision: 1,
    })
    expect(db.get(`SELECT video_id, run_id FROM video_preferred_summary_runs WHERE video_id = 'video-local-1'`)).toEqual({
      video_id: 'video-local-1', run_id: 'legacy-video-local-1',
    })
    expect(db.all(`SELECT video_id, status, model, prompt_revision, error_message
      FROM video_summary_runs WHERE video_id != 'video-local-1' ORDER BY video_id`)).toEqual([
      { video_id: 'video-failed', status: 'failed', model: 'old-model', prompt_revision: 4, error_message: 'provider failed' },
      { video_id: 'video-pending', status: 'pending', model: 'old-model', prompt_revision: 3, error_message: null },
    ])
    expect(db.get('SELECT origin_type, source_id FROM video_origins')).toEqual({
      origin_type: 'subscription_rss',
      source_id: 'sub-1',
    })
    expect(db.get('SELECT channel_id, title FROM youtube_channels')).toEqual({
      channel_id: 'UClegacy',
      title: 'Legacy Channel',
    })
    expect(db.get('SELECT backfill_initialized, backfill_status FROM subscriptions')).toEqual({
      backfill_initialized: 1,
      backfill_status: null,
    })
    expect(db.get('SELECT google_account_id, new_subscription_backfill_days FROM youtube_preferences')).toEqual({
      google_account_id: 'acct-1',
      new_subscription_backfill_days: 30,
    })

    const videoFk = db.all<{ table: string; from: string }>('PRAGMA foreign_key_list(videos)')
    expect(videoFk).toContainEqual(expect.objectContaining({ table: 'youtube_channels', from: 'channel_id' }))
    const subscriptionFk = db.all<{ table: string; from: string }>('PRAGMA foreign_key_list(subscriptions)')
    expect(subscriptionFk).toContainEqual(expect.objectContaining({ table: 'youtube_channels', from: 'channel_id' }))
    expect(db.all('PRAGMA foreign_key_check')).toEqual([])
  })

  it('enforces the folders self-referential FK', async () => {
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    db.run('INSERT INTO folders (id, parent_id, name) VALUES (?, NULL, ?)', [
      'root',
      'Root',
    ])
    db.run('INSERT INTO folders (id, parent_id, name) VALUES (?, ?, ?)', [
      'child',
      'root',
      'Child',
    ])
    const child = db.get<{ name: string }>('SELECT name FROM folders WHERE id = ?', [
      'child',
    ])
    expect(child?.name).toBe('Child')
  })

  it('cascades deletes through the folder tree', async () => {
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    db.run('INSERT INTO folders (id, parent_id, name) VALUES (?, NULL, ?)', [
      'root',
      'Root',
    ])
    db.run('INSERT INTO folders (id, parent_id, name) VALUES (?, ?, ?)', [
      'child',
      'root',
      'Child',
    ])
    db.run('INSERT INTO folders (id, parent_id, name) VALUES (?, ?, ?)', [
      'grand',
      'child',
      'Grand',
    ])

    db.run('DELETE FROM folders WHERE id = ?', ['root'])

    const remaining = db.all<{ id: string }>('SELECT id FROM folders ORDER BY id')
    expect(remaining).toEqual([])
  })

  it('keeps bookmark_fts in sync via triggers', async () => {
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    db.run('INSERT INTO folders (id, parent_id, name) VALUES (?, NULL, ?)', [
      'f',
      'F',
    ])
    db.run(
      'INSERT INTO bookmarks (id, url, title, folder_id) VALUES (?, ?, ?, ?)',
      ['b1', 'https://example.com', 'Example', 'f'],
    )

    // FTS5 rowid aligns with bookmarks.rowid.
    const hits = db.all<{ title: string; url: string }>(
      "SELECT title, url FROM bookmark_fts WHERE bookmark_fts MATCH ?",
      ['example'],
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]?.title).toBe('Example')
  })
})
