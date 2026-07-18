import bcrypt from 'bcryptjs'
import { parseEncryptionKey } from './token-encryption.js'

/**
 * Runtime config derived from environment variables.
 *
 * `passwordHash` is bcrypt-hashed so the plaintext secret is never kept in
 * memory beyond startup — matching ADR-007 ("bcrypt-hashed and stored").
 *
 * `dataDir` holds the JSON token store from #002 (still active until #004+
 * moves token storage to SQL). `dbPath` holds the SQLite file used by the
 * schema/migrations landed in #003. They live side by side for now.
 *
 * Email (issue #020) requires four additional env vars:
 *   * `emailTokenEncryptionKey` — hex-encoded 32-byte key for AES-256-GCM
 *     at-rest encryption of OAuth tokens.
 *   * `googleOauthClientId` / `googleOauthClientSecret` — created in the
 *     Google Cloud Console.
 *   * `emailOauthRedirectUri` — full callback URL the dashboard serves.
 *
 * These are OPTIONAL at boot. The server starts without them and logs a
 * clear banner listing what's missing so the operator can visit
 * `/settings/email` for the one-time Google Cloud Console setup steps.
 * Email routes return 503 until the deps are present. Failing fast at
 * boot was the v1 choice, but it created a chicken-and-egg: the page
 * that documents the env vars was unreachable without those env vars.
 */
export interface EmailConfig {
  readonly emailTokenEncryptionKey: Buffer
  readonly googleOauthClientId: string
  readonly googleOauthClientSecret: string
  readonly emailOauthRedirectUri: string
}

/**
 * The set of email env vars that were missing at boot. Captured so the
 * `/settings/email` page can highlight exactly what's needed; an empty
 * array means email is fully configured.
 */
export type MissingEmailEnv = ReadonlyArray<EmailEnvName>

export type EmailEnvName =
  | 'EMAIL_TOKEN_ENCRYPTION_KEY'
  | 'GOOGLE_OAUTH_CLIENT_ID'
  | 'GOOGLE_OAUTH_CLIENT_SECRET'
  | 'EMAIL_OAUTH_REDIRECT_URI'

/**
 * YouTube slice (issue YT-001) requires four additional env vars:
 *   * `youtubeTokenEncryptionKey` — hex-encoded 32-byte key for
 *     AES-256-GCM at-rest encryption of OAuth tokens.
 *   * `youtubeOauthClientId` / `youtubeOauthClientSecret` — created
 *     in the Google Cloud Console. Separate from the Gmail OAuth
 *     client (different env-var prefix) so the operator can use
 *     distinct OAuth apps per slice; in practice both can live on
 *     the same Google Cloud project.
 *   * `youtubeOauthRedirectUri` — full callback URL the dashboard
 *     serves.
 *
 * These are OPTIONAL at boot. The server starts without them and
 * logs a clear banner listing what's missing so the operator can
 * visit `/settings/youtube` for the one-time setup steps. YouTube
 * routes return 503 until the deps are present. Same pattern as
 * the email slice above (chicken-and-egg: docs page is unreachable
 * without the env vars; without the docs page the operator can't
 * set the env vars).
 */
export interface YouTubeConfig {
  readonly youtubeTokenEncryptionKey: Buffer
  readonly youtubeOauthClientId: string
  readonly youtubeOauthClientSecret: string
  readonly youtubeOauthRedirectUri: string
  /** Server-only developer key used for public YouTube search requests. */
  readonly youtubeApiKey: string | null
}

/**
 * The set of YouTube env vars that were missing at boot. Captured
 * so the `/settings/youtube` page can highlight exactly what's
 * needed; an empty array means YouTube is fully configured.
 */
export type MissingYouTubeEnv = ReadonlyArray<YouTubeEnvName>

export type YouTubeEnvName =
  | 'YOUTUBE_TOKEN_ENCRYPTION_KEY'
  | 'YOUTUBE_OAUTH_CLIENT_ID'
  | 'YOUTUBE_OAUTH_CLIENT_SECRET'
  | 'YOUTUBE_OAUTH_REDIRECT_URI'

/** OpenAI-compatible text model configuration. Optional at boot: the
 * dashboard remains fully usable without AI, and summary routes surface a
 * setup message until an API key is present. */
export interface LlmConfig {
  readonly apiKey: string
  readonly baseUrl: string
  readonly model: string
}

export interface Config {
  readonly port: number
  readonly hostname: string
  readonly passwordHash: string
  readonly dataDir: string
  readonly dbPath: string
  /**
   * TLS material for serving the dashboard over HTTPS. When both
   * `cert` and `key` are present, the server binds via
   * `node:https.createServer`; otherwise plain HTTP. The HTTPS mode
   * is required for any redirect URI that isn't loopback — Google's
   * Web-app client now refuses `http://` for non-loopback hosts.
   *
   * Typical local setup: `mkcert 192.168.0.136.nip.io` (or the
   * Python `trustme` library) produces a cert + key pair; point the
   * env vars at those files. The CA needs to be installed in your
   * OS/browser trust store for the browser to accept the cert.
   */
  readonly tls: { readonly cert: Buffer; readonly key: Buffer } | null
  /**
   * Email slice deps, or null when one or more required env vars are
   * missing. When null, no `/api/email/*` route is mounted and the
   * `/settings/email` page renders a setup-instructions-only mode
   * with the missing var list highlighted.
   */
  readonly email: EmailConfig | null
  readonly missingEmailEnv: MissingEmailEnv
  /**
   * YouTube slice deps (issue YT-001), or null when one or more
   * required env vars are missing. When null, no `/api/youtube/*`
   * route is mounted and the `/settings/youtube` page renders a
   * setup-instructions-only mode with the missing var list
   * highlighted.
   */
  readonly youtube: YouTubeConfig | null
  readonly missingYoutubeEnv: MissingYouTubeEnv
  /** MiniMax (or another OpenAI-compatible provider), when configured. */
  readonly llm: LlmConfig | null
  /** Whether the environment contains a Serper credential. The key itself never leaves config. */
  readonly serperConfigured: boolean
  /** Server-only Serper credential, or null when research is disabled. */
  readonly serperApiKey: string | null
  /**
   * Initial-sync lookback window in days. When a Gmail account is
   * synced for the first time, the worker fetches messages newer than
   * now − `emailSyncHistoryDays`. Defaults to 90 (issue spec).
   * Configurable for users with lighter/heavier inboxes. Must be a
   * positive integer; values <1 or non-numeric fall back to 90.
   */
  readonly emailSyncHistoryDays: number
  /**
   * Background sync poll interval, in minutes. The scheduler in
   * `email-sync-scheduler.ts` runs `EmailSyncWorker.sync` for every
   * connected account at this interval. Defaults to 10 (issue
   * spec). Set to `0` to disable automatic syncing — manual
   * `POST /api/email/sync` is the only way new mail arrives in that
   * mode. Negative / non-numeric values fall back to 10; `0` is
   * honored literally so operators can opt out without editing
   * config.
   */
  readonly emailSyncIntervalMin: number
  /**
   * News & Weather scheduler tick interval, in minutes (issue NW-005).
   * The scheduler in `news-scheduler.ts` runs `tick()` at this
   * interval; each tick re-evaluates the per-source due-check inside
   * the orchestrator. Defaults to 1 minute (the design doc says
   * "re-evaluate every 60s"). Set to `0` to disable the automatic
   * scheduler — the manual `POST /api/news/refresh` route is the
   * only way news gets ingested in that mode. Negative / non-numeric
   * values fall back to 1; `0` is honored literally so operators can
   * opt out without editing config (smoke script uses this).
   */
  readonly newsIntervalMin: number
}

/**
 * Load and validate runtime config.
 *
 * Throws with a clear, actionable message if a required variable is missing.
 */
export async function loadConfig(): Promise<Config> {
  // Auto-load a `.env` file from the cwd if one exists. Shell
  // env vars already set win over `.env` values — the `.env` is
  // treated as a fallback, not an override. This dodges the common
  // gotcha where an inline env-var prefix (`FOO=bar pnpm start`)
  // silently gets dropped when a copy-paste introduces a newline
  // before the command.
  const envFilePath = process.env.DASHBOARD_ENV_FILE ?? '.env'
  try {
    await loadDotenv(await resolveAbsolute(envFilePath))
  } catch (err: unknown) {
    throw new Error(
      `Failed to load ${envFilePath}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const password = process.env.DASHBOARD_PASSWORD
  if (!password) {
    throw new Error(
      'DASHBOARD_PASSWORD is not set. ' +
        'Set it before starting the server in one of three ways:\n' +
        '  1. Inline (must be on the SAME line as `pnpm start`):\n' +
        '       DASHBOARD_PASSWORD=secret pnpm start\n' +
        '  2. Export (survives newlines):\n' +
        '       export DASHBOARD_PASSWORD=secret\n' +
        '       pnpm start\n' +
        '  3. `.env` file in the cwd (simplest for multi-var setups):\n' +
        '       cp env.example .env  # then edit + fill in',
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

  // ─── Email OAuth setup ───────────────────────────────────────────────
  // Optional at boot. When one or more of the four email env vars are
  // missing, we return `email: null` and list the names so the boot
  // banner can show the operator exactly what to set. /settings/email
  // renders in setup-only mode and lists the missing vars in red.
  //
  // Why not fail fast? Because the page that documents the env vars
  // (/settings/email) is gated behind the same env vars. A new operator
  // could not reach the instructions without first knowing the
  // commands — which is exactly the loop we kept hitting.
  const emailTokenEncryptionKeyRaw = process.env.EMAIL_TOKEN_ENCRYPTION_KEY
  const googleOauthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const googleOauthClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  const emailOauthRedirectUri = process.env.EMAIL_OAUTH_REDIRECT_URI

  const missingEmailEnv: EmailEnvName[] = []
  let email: EmailConfig | null = null

  // Validate the encryption key in isolation: a malformed key is a
  // startup failure, since it's almost certainly a copy/paste mistake.
  // The other three "missing" cases (unset vars) just downgrade.
  let emailTokenEncryptionKey: Buffer | null = null
  if (emailTokenEncryptionKeyRaw) {
    try {
      emailTokenEncryptionKey = parseEncryptionKey(emailTokenEncryptionKeyRaw)
    } catch (err: unknown) {
      throw new Error(
        `EMAIL_TOKEN_ENCRYPTION_KEY is invalid: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else {
    missingEmailEnv.push('EMAIL_TOKEN_ENCRYPTION_KEY')
  }

  if (!googleOauthClientId) missingEmailEnv.push('GOOGLE_OAUTH_CLIENT_ID')
  if (!googleOauthClientSecret) missingEmailEnv.push('GOOGLE_OAUTH_CLIENT_SECRET')
  if (!emailOauthRedirectUri) missingEmailEnv.push('EMAIL_OAUTH_REDIRECT_URI')

  // Only assemble `email` when ALL four are present.
  if (
    emailTokenEncryptionKey !== null &&
    googleOauthClientId !== undefined &&
    googleOauthClientSecret !== undefined &&
    emailOauthRedirectUri !== undefined
  ) {
    email = {
      emailTokenEncryptionKey,
      googleOauthClientId,
      googleOauthClientSecret,
      emailOauthRedirectUri,
    }
  }

  // ─── YouTube OAuth setup ───────────────────────────────────────────
  // Optional at boot (issue YT-001). Mirrors the email slice's
  // pattern: missing env vars downgrade YouTube to setup-only mode
  // instead of failing fast. See the email config above for the
  // rationale.
  const youtubeTokenEncryptionKeyRaw = process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY
  const youtubeOauthClientId = process.env.YOUTUBE_OAUTH_CLIENT_ID
  const youtubeOauthClientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET
  const youtubeOauthRedirectUri = process.env.YOUTUBE_OAUTH_REDIRECT_URI
  const youtubeApiKey = process.env.YOUTUBE_API_KEY?.trim() || null

  const missingYoutubeEnv: YouTubeEnvName[] = []
  let youtube: YouTubeConfig | null = null

  // Validate the encryption key in isolation: a malformed key is a
  // startup failure, since it's almost certainly a copy/paste mistake.
  // The other three "missing" cases (unset vars) just downgrade.
  let youtubeTokenEncryptionKey: Buffer | null = null
  if (youtubeTokenEncryptionKeyRaw) {
    try {
      youtubeTokenEncryptionKey = parseEncryptionKey(youtubeTokenEncryptionKeyRaw)
    } catch (err: unknown) {
      throw new Error(
        `YOUTUBE_TOKEN_ENCRYPTION_KEY is invalid: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else {
    missingYoutubeEnv.push('YOUTUBE_TOKEN_ENCRYPTION_KEY')
  }

  if (!youtubeOauthClientId) missingYoutubeEnv.push('YOUTUBE_OAUTH_CLIENT_ID')
  if (!youtubeOauthClientSecret) missingYoutubeEnv.push('YOUTUBE_OAUTH_CLIENT_SECRET')
  if (!youtubeOauthRedirectUri) missingYoutubeEnv.push('YOUTUBE_OAUTH_REDIRECT_URI')

  // Only assemble `youtube` when ALL four are present.
  if (
    youtubeTokenEncryptionKey !== null &&
    youtubeOauthClientId !== undefined &&
    youtubeOauthClientSecret !== undefined &&
    youtubeOauthRedirectUri !== undefined
  ) {
    youtube = {
      youtubeTokenEncryptionKey,
      youtubeOauthClientId,
      youtubeOauthClientSecret,
      youtubeOauthRedirectUri,
      youtubeApiKey,
    }
  }

  // ─── Optional OpenAI-compatible LLM ────────────────────────────────
  // An API key opts the feature in. MiniMax defaults make the common case
  // one line in `.env`; base URL and model remain provider-neutral so a
  // future provider swap is configuration-only.
  const llmApiKey = process.env.LLM_API_KEY?.trim()
  const llm: LlmConfig | null = llmApiKey
    ? {
        apiKey: llmApiKey,
        baseUrl: (process.env.LLM_BASE_URL?.trim() || 'https://api.minimax.io/v1').replace(/\/+$/, ''),
        model: process.env.LLM_MODEL?.trim() || 'MiniMax-M2.7',
      }
    : null
  const serperApiKey = process.env.SERPER_API_KEY?.trim() || null
  const serperConfigured = serperApiKey !== null

  // Initial-sync lookback window (issue #021). Optional — defaults
  // to 90 days when missing or malformed. Negative / zero / non-
  // numeric values fall back to 90 so a stale `0` doesn't crash a
  // long-running install.
  const rawHistoryDays = process.env.EMAIL_SYNC_HISTORY_DAYS
  let emailSyncHistoryDays = 90
  if (rawHistoryDays !== undefined && rawHistoryDays !== '') {
    const parsed = Number.parseInt(rawHistoryDays, 10)
    if (Number.isFinite(parsed) && parsed >= 1) {
      emailSyncHistoryDays = parsed
    }
  }

  // Background poll interval (issue #026). Optional — defaults to
  // 10 minutes when missing or malformed. `0` is honored literally:
  // operators can run the server in manual-only mode by exporting
  // `EMAIL_SYNC_INTERVAL_MIN=0` (no automatic syncs). Negative or
  // non-numeric values fall back to 10. The two-decimal-style
  // floor on `0` is intentional — `parseInt('0', 10) === 0` is
  // truthy-as-a-number and we WANT it to disable the scheduler.
  const rawIntervalMin = process.env.EMAIL_SYNC_INTERVAL_MIN
  let emailSyncIntervalMin = 10
  if (rawIntervalMin !== undefined && rawIntervalMin !== '') {
    const parsed = Number.parseInt(rawIntervalMin, 10)
    if (Number.isFinite(parsed) && parsed >= 0) {
      emailSyncIntervalMin = parsed
    }
  }

  // News & Weather scheduler interval (issue NW-005). Mirrors the
  // email-sync pattern above: optional env var, defaults to 1 minute,
  // `0` honored literally so smoke scripts + offline installs can
  // disable auto-fetching. Negative / non-numeric values fall back to
  // the default. The manual `POST /api/news/refresh` route is the
  // only path when this is `0`.
  const rawNewsIntervalMin = process.env.DASHBOARD_NEWS_INTERVAL_MIN
  let newsIntervalMin = 1
  if (rawNewsIntervalMin !== undefined && rawNewsIntervalMin !== '') {
    const parsed = Number.parseInt(rawNewsIntervalMin, 10)
    if (Number.isFinite(parsed) && parsed >= 0) {
      newsIntervalMin = parsed
    }
  }

  // ─── Optional TLS (issue #021 follow-up) ──────────────────────────────────────
  // Load cert + key from disk when both env vars point at readable
  // files. A typo (e.g. wrong path, partial pair) is a startup error
  // — silently downgrading to plain HTTP would make the dashboard
  // reachable only on `http://`, which is the exact failure mode
  // the operator was trying to escape.
  const tlsCertPath = process.env.DASHBOARD_TLS_CERT
  const tlsKeyPath = process.env.DASHBOARD_TLS_KEY
  let tls: Config['tls'] = null
  if (tlsCertPath || tlsKeyPath) {
    if (!tlsCertPath || !tlsKeyPath) {
      throw new Error(
        'Both DASHBOARD_TLS_CERT and DASHBOARD_TLS_KEY must be set together. ' +
          'Set both to enable HTTPS, or neither for plain HTTP.',
      )
    }
    const { readFileSync } = await import('node:fs')
    let cert: Buffer
    let key: Buffer
    try {
      cert = readFileSync(tlsCertPath)
    } catch (err: unknown) {
      throw new Error(
        `DASHBOARD_TLS_CERT could not be read (${tlsCertPath}): ` +
          (err instanceof Error ? err.message : String(err)),
      )
    }
    try {
      key = readFileSync(tlsKeyPath)
    } catch (err: unknown) {
      throw new Error(
        `DASHBOARD_TLS_KEY could not be read (${tlsKeyPath}): ` +
          (err instanceof Error ? err.message : String(err)),
      )
    }
    tls = { cert, key }
  }

  return {
    port,
    hostname,
    passwordHash,
    dataDir,
    dbPath,
    tls,
    email,
    missingEmailEnv,
    emailSyncHistoryDays,
    emailSyncIntervalMin,
    newsIntervalMin,
    youtube,
    missingYoutubeEnv,
    llm,
    serperConfigured,
    serperApiKey,
  }
}

async function resolveAbsolute(path: string): Promise<string> {
  const { resolve, isAbsolute } = await import('node:path')
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

/**
 * Minimal `.env` loader. Reads `KEY=value` pairs from a file and
 * sets them into `process.env` ONLY for keys that aren't already
 * present — the shell wins, the file is a fallback. Lines that are
 * blank or start with `#` are ignored. Quoted values (`"x"` or `'x'`)
 * have the quotes stripped.
 *
 * Deliberately tiny: no variable expansion, no `export` keyword, no
 * multi-line values. The dashboard's env vars are all single-token,
 * so anything fancier would be premature.
 */
async function loadDotenv(filePath: string): Promise<void> {
  const { existsSync, readFileSync } = await import('node:fs')
  if (!existsSync(filePath)) return
  const content = readFileSync(filePath, 'utf8')
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key === '' || process.env[key] !== undefined) continue
    process.env[key] = value
  }
}
