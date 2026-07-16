import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Database } from './db.js'

/**
 * Manifest of every migration known to the application. New migrations
 * get appended here AND a matching `.sql` file in `migrations/`.
 *
 * Hardcoded instead of directory-scanned so:
 *   * TypeScript catches ordering mistakes at build time.
 *   * Renaming a migration file doesn't accidentally re-run it (the
 *     `name` field is the durable identifier — keep it stable).
 *   * Tests can target a specific subset of migrations.
 */
const MIGRATIONS = [
  {
    name: '001_initial',
    filename: '001_initial.sql',
  },
  {
    name: '002_search_trigram',
    filename: '002_search_trigram.sql',
  },
  {
    name: '003_email_accounts',
    filename: '003_email_accounts.sql',
  },
  {
    name: '004_emails_sync_state',
    filename: '004_emails_sync_state.sql',
  },
  {
    name: '005_email_search',
    filename: '005_email_search.sql',
  },
  {
    name: '006_email_tags',
    filename: '006_email_tags.sql',
  },
  {
    name: '007_email_sync_debounce',
    filename: '007_email_sync_debounce.sql',
  },
  {
    name: '008_youtube_accounts',
    filename: '008_youtube_accounts.sql',
  },
  {
    name: '009_subscriptions',
    filename: '009_subscriptions.sql',
  },
] as const

export interface RunMigrationsOptions {
  /** Directory containing the `.sql` files referenced by MIGRATIONS. */
  readonly dir: string
}

/**
 * Apply any pending migrations to `db`. Idempotent — calling twice is a
 * no-op the second time. Each migration runs inside a single transaction
 * so a partial failure rolls back cleanly.
 *
 * The first migration (the `migrations` table itself) is created via a
 * separate non-transactional `exec` so the tracking table exists before
 * we try to read it.
 */
export async function runMigrations(
  db: Database,
  options: RunMigrationsOptions,
): Promise<void> {
  // Bootstrap the tracking table. Plain `exec` because we don't want this
  // to be its own transaction — it must be visible immediately to the
  // SELECT below even on a brand-new DB.
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`)

  const applied = new Set(
    db.all<{ name: string }>('SELECT name FROM migrations').map((r) => r.name),
  )

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue

    const sql = await readFile(join(options.dir, migration.filename), 'utf8')

    // One transaction per migration. If the SQL throws, the row in
    // `migrations` is never inserted — next boot retries from scratch.
    db.transaction(() => {
      db.exec(sql)
      db.run('INSERT INTO migrations (name) VALUES (?)', [migration.name])
    })
  }
}
