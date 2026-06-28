import type { Context, MiddlewareHandler } from 'hono'
import bcrypt from 'bcryptjs'
import type { TokenStore } from './token-store.js'

// ─── Header parsers (pure, exported for tests) ────────────────────────────

/**
 * Decode an HTTP Basic `Authorization` header.
 *
 * Returns `null` if the header is missing, malformed, or not Basic auth.
 * Never throws — header parsing is part of the auth flow itself.
 */
export function parseBasicAuth(
  header: string | undefined,
): { username: string; password: string } | null {
  if (!header) return null

  const [scheme, encoded] = header.split(' ')
  if (scheme?.toLowerCase() !== 'basic' || !encoded) return null

  let decoded: string
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8')
  } catch {
    return null
  }

  const colonIndex = decoded.indexOf(':')
  if (colonIndex < 0) return null

  const username = decoded.slice(0, colonIndex)
  const password = decoded.slice(colonIndex + 1)
  return { username, password }
}

/**
 * Decode an HTTP Bearer `Authorization` header.
 * Returns the raw token string, or null if the header is missing, malformed,
 * or not Bearer auth.
 */
export function parseBearerAuth(header: string | undefined): string | null {
  if (!header) return null
  const [scheme, token] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null
  return token
}

// ─── Middleware ───────────────────────────────────────────────────────────

export interface AuthDeps {
  readonly passwordHash: string
  readonly tokenStore: TokenStore
}

/**
 * Typed context variables populated by the auth middleware. Handlers can
 * check which auth method succeeded.
 */
export type AuthVariables = { user?: string; tokenId?: string }

/**
 * Unified auth middleware. Accepts either HTTP Basic (UI) or a Bearer
 * token (extension) on every route.
 *
 * On success, sets exactly one of:
 *   - `c.set('user', username)` for Basic auth
 *   - `c.set('tokenId', id)` for Bearer auth
 *
 * On failure, returns 401. The `WWW-Authenticate` challenge is only sent
 * for Basic-related failures (and missing auth) — NOT for failed Bearer
 * attempts. Sending `WWW-Authenticate: Basic` on a Bearer-failed response
 * makes Chrome's `fetch()` pop up the HTTP Basic dialog even though the
 * request was Bearer-authenticated, which traps the user in an
 * interactive prompt they can't actually satisfy (a password doesn't fix
 * an invalid token).
 *
 * Per ADR-007, the user password is a bcrypt hash and `bcrypt.compare`
 * is constant-time. Bearer tokens are looked up via SHA-256 (O(1)) and
 * verified via bcrypt (constant-time) — see token-store.ts.
 */
export function auth({
  passwordHash,
  tokenStore,
}: AuthDeps): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const header = c.req.header('authorization')
    const scheme = header?.split(' ')[0]?.toLowerCase()

    // 1) Bearer (extension). Try first so a missing scheme is unambiguous.
    if (scheme === 'bearer') {
      const token = parseBearerAuth(header)
      if (!token) return denyBearer(c)
      const record = await tokenStore.findByPlaintext(token)
      if (!record) return denyBearer(c)
      c.set('tokenId', record.id)
      await next()
      return
    }

    // 2) Basic (UI).
    if (scheme === 'basic') {
      const credentials = parseBasicAuth(header)
      if (!credentials) return denyBasic(c)
      const matches = await bcrypt.compare(credentials.password, passwordHash)
      if (!matches) return denyBasic(c)
      c.set('user', credentials.username)
      await next()
      return
    }

    // 3) Missing or unrecognized scheme — tell browsers to prompt for Basic.
    return denyBasic(c)
  }
}

/** 401 with no challenge — Chrome will NOT pop a Basic auth dialog. */
function denyBearer(c: Context): Response {
  return c.body('Unauthorized', 401)
}

/** 401 with `WWW-Authenticate: Basic` — browsers prompt for credentials. */
function denyBasic(c: Context): Response {
  c.header('WWW-Authenticate', 'Basic realm="Dashboard"')
  return c.body('Unauthorized', 401)
}
