import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'

/**
 * Positional bind params. `better-sqlite3` also supports named params via
 * `{ ':name': value }` objects; v1 only uses positional, named can land
 * if a query gets unwieldy.
 */
export type BindParams = ReadonlyArray<unknown>

/**
 * Result of a write statement (INSERT / UPDATE / DELETE).
 */
export interface RunResult {
  /** Number of rows changed by the statement. */
  readonly changes: number
  /** Rowid of the last inserted row. Bigint for huge tables; number otherwise. */
  readonly lastInsertRowid: number | bigint
}

/**
 * Thin wrapper over `better-sqlite3` exposing the four query shapes plus
 * transactions. Keeps the calling code free of `prepare(...)` boilerplate.
 *
 * Sync by design — better-sqlite3 is itself synchronous and personal-scale
 * queries complete in microseconds. If a future query becomes slow enough
 * to want async, prefer an off-thread worker over wrapping every call.
 */
export class Database {
  private readonly raw: BetterSqlite3.Database

  /**
   * @param path File path to the SQLite DB, or `':memory:'` for tests.
   */
  constructor(path: string) {
    if (path !== ':memory:') {
      // better-sqlite3 needs the parent directory to exist. Create it
      // recursively so `pnpm start` from a fresh checkout just works.
      mkdirSync(dirname(path), { recursive: true })
    }

    this.raw = new BetterSqlite3(path)

    // Foreign keys are OFF by default in SQLite. Turn them on so the
    // ON DELETE CASCADE clauses in migrations/001 actually fire.
    this.raw.pragma('foreign_keys = ON')

    // WAL: better concurrency for read-while-write patterns. Single-writer
    // is still guaranteed; readers don't block on the writer.
    this.raw.pragma('journal_mode = WAL')

    // Synchronous=NORMAL is the WAL-mode default that pairs with WAL for
    // durability without forcing a fsync on every commit.
    this.raw.pragma('synchronous = NORMAL')
  }

  /**
   * Close the underlying connection. After calling this, the instance
   * is unusable. The server's lifecycle keeps the DB open for the
   * process lifetime; tests should `close()` in `afterEach` to release
   * file handles.
   */
  close(): void {
    this.raw.close()
  }

  /**
   * Execute one or more SQL statements with no result rows.
   * Use for DDL (CREATE TABLE, etc.) and bulk inserts that come from a
   * migration file. Never pass user input here — it accepts any SQL.
   */
  exec(sql: string): void {
    this.raw.exec(sql)
  }

  /**
   * Run a write statement (INSERT / UPDATE / DELETE). Returns the change
   * count and the last inserted rowid.
   */
  run(sql: string, params?: BindParams): RunResult {
    const stmt = this.raw.prepare(sql)
    const info = stmt.run(...(params ?? []))
    return {
      changes: info.changes,
      lastInsertRowid: info.lastInsertRowid,
    }
  }

  /**
   * Run a query and return every row. Use the type parameter for typed
   * results: `db.all<Folder>('SELECT ...')`.
   */
  all<Row = unknown>(sql: string, params?: BindParams): Row[] {
    const stmt = this.raw.prepare(sql)
    return stmt.all(...(params ?? [])) as Row[]
  }

  /**
   * Run a query and return the first row (or undefined). Throws if the
   * query returns more than one row — better-sqlite3's `.get()` semantics.
   */
  get<Row = unknown>(sql: string, params?: BindParams): Row | undefined {
    const stmt = this.raw.prepare(sql)
    return stmt.get(...(params ?? [])) as Row | undefined
  }

  /**
   * Run `fn` inside a single transaction. If `fn` throws, the transaction
   * rolls back and the error re-throws. Otherwise it commits on return.
   *
   * Note: better-sqlite3's `db.transaction(fn)` returns a *new function*
   * that's optimized (the SQL is prepared once and cached). For simplicity
   * the wrapper re-creates the transactional fn on every call; for v1
   * throughput that's fine. Optimize if profiling shows it matters.
   */
  transaction<T>(fn: () => T): T {
    const transactional = this.raw.transaction(fn)
    return transactional()
  }

  /**
   * Open access to the underlying better-sqlite3 instance for advanced use
   * (loadable extensions, pragmas, raw prepared statements). Avoid when
   * the wrapper methods suffice.
   */
  rawConnection(): BetterSqlite3.Database {
    return this.raw
  }
}
