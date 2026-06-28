import bcrypt from 'bcryptjs'

/**
 * Runtime config derived from environment variables.
 *
 * `passwordHash` is bcrypt-hashed so the plaintext secret is never kept in
 * memory beyond startup — matching ADR-007 ("bcrypt-hashed and stored").
 *
 * `dataDir` holds the JSON token store from #002 (still active until #004+
 * moves token storage to SQL). `dbPath` holds the SQLite file used by the
 * schema/migrations landed in #003. They live side by side for now.
 */
export interface Config {
  readonly port: number
  readonly hostname: string
  readonly passwordHash: string
  readonly dataDir: string
  readonly dbPath: string
}

/**
 * Load and validate runtime config.
 *
 * Throws with a clear, actionable message if a required variable is missing.
 */
export async function loadConfig(): Promise<Config> {
  const password = process.env.DASHBOARD_PASSWORD
  if (!password) {
    throw new Error(
      'DASHBOARD_PASSWORD is not set. ' +
        'Set it before starting the server, e.g. `DASHBOARD_PASSWORD=yourpassword pnpm start`.',
    )
  }

  const port = Number.parseInt(process.env.PORT ?? '8080', 10)
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`)
  }

  const hostname = process.env.HOSTNAME ?? '0.0.0.0'

  // Resolve to absolute paths relative to cwd. Resolving at startup means
  // later cwd changes (if any) can't break the stores.
  const dataDir = process.env.DASHBOARD_DATA_DIR
    ? await resolveAbsolute(process.env.DASHBOARD_DATA_DIR)
    : await resolveAbsolute('./data')

  const dbPath = process.env.DASHBOARD_DB_PATH
    ? await resolveAbsolute(process.env.DASHBOARD_DB_PATH)
    : await resolveAbsolute('./data/dashboard.db')

  // Hash the env-var password once at startup. After this, only the hash
  // lives in memory; incoming Basic-auth requests are verified via
  // bcrypt.compare, which is constant-time.
  const passwordHash = await bcrypt.hash(password, 10)

  return { port, hostname, passwordHash, dataDir, dbPath }
}

async function resolveAbsolute(path: string): Promise<string> {
  const { resolve, isAbsolute } = await import('node:path')
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}
