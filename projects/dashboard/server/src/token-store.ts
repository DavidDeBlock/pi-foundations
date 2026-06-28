import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { generateToken, hashToken, lookupHash, verifyToken } from './token.js'

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * Token record as exposed to API consumers and the UI.
 * NEVER includes `plaintext`, `lookupHash`, or `verifyHash`.
 */
export interface TokenRecord {
  readonly id: string
  readonly label: string
  readonly createdAt: string // ISO 8601
  lastUsedAt: string | null // mutated on each successful Bearer auth
}

export interface CreateTokenResult {
  /** Record that was just persisted (no plaintext). */
  readonly record: TokenRecord
  /** Plaintext shown to the caller exactly once. Never persisted. */
  readonly plaintext: string
}

export interface TokenStore {
  create(label: string): Promise<CreateTokenResult>
  list(): Promise<TokenRecord[]>
  revoke(id: string): Promise<boolean>
  /**
   * Look up a token by its plaintext value. Returns null for unknown or
   * invalid tokens. Updates `lastUsedAt` as a side effect of success.
   */
  findByPlaintext(plaintext: string): Promise<TokenRecord | null>
}

// ─── Internal storage shape ────────────────────────────────────────────────

interface StoredToken {
  readonly id: string
  readonly label: string
  readonly createdAt: string
  lastUsedAt: string | null
  readonly lookupHash: string
  readonly verifyHash: string
}

function publicView(t: StoredToken): TokenRecord {
  return {
    id: t.id,
    label: t.label,
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
  }
}

// ─── In-memory implementation (used by tests) ──────────────────────────────

export class InMemoryTokenStore implements TokenStore {
  private readonly tokens: StoredToken[] = []

  async create(label: string): Promise<CreateTokenResult> {
    const plaintext = generateToken()
    const record: StoredToken = {
      id: randomUUID(),
      label,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      lookupHash: lookupHash(plaintext),
      verifyHash: await hashToken(plaintext),
    }
    this.tokens.push(record)
    return { record: publicView(record), plaintext }
  }

  async list(): Promise<TokenRecord[]> {
    // Return copies so callers can't mutate the internal `lastUsedAt`.
    return this.tokens.map(publicView)
  }

  async revoke(id: string): Promise<boolean> {
    const idx = this.tokens.findIndex((t) => t.id === id)
    if (idx < 0) return false
    this.tokens.splice(idx, 1)
    return true
  }

  async findByPlaintext(plaintext: string): Promise<TokenRecord | null> {
    const target = lookupHash(plaintext)
    const candidate = this.tokens.find((t) => t.lookupHash === target)
    if (!candidate) return null
    if (!(await verifyToken(plaintext, candidate.verifyHash))) return null
    candidate.lastUsedAt = new Date().toISOString()
    return publicView(candidate)
  }
}

// ─── JSON file implementation (used in production) ─────────────────────────
//
// This is a placeholder for the SQLite-backed store that lands in #003.
// Kept self-contained so #002 has zero dependency on schema work.

interface PersistedFile {
  readonly version: 1
  readonly tokens: readonly StoredToken[]
}

export interface JsonTokenStoreOptions {
  readonly dataDir: string
  readonly filename?: string
}

export class JsonTokenStore implements TokenStore {
  private readonly filePath: string
  private cache: StoredToken[] = []
  private loaded = false
  // Serialize writes so concurrent requests don't interleave file I/O.
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options: JsonTokenStoreOptions) {
    this.filePath = join(options.dataDir, options.filename ?? 'tokens.json')
  }

  async create(label: string): Promise<CreateTokenResult> {
    await this.ensureLoaded()
    return this.withWriteLock(async () => {
      const plaintext = generateToken()
      const record: StoredToken = {
        id: randomUUID(),
        label,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        lookupHash: lookupHash(plaintext),
        verifyHash: await hashToken(plaintext),
      }
      this.cache.push(record)
      await this.persist()
      return { record: publicView(record), plaintext }
    })
  }

  async list(): Promise<TokenRecord[]> {
    await this.ensureLoaded()
    return this.cache.map(publicView)
  }

  async revoke(id: string): Promise<boolean> {
    await this.ensureLoaded()
    return this.withWriteLock(async () => {
      const idx = this.cache.findIndex((t) => t.id === id)
      if (idx < 0) return false
      this.cache.splice(idx, 1)
      await this.persist()
      return true
    })
  }

  async findByPlaintext(plaintext: string): Promise<TokenRecord | null> {
    await this.ensureLoaded()
    const target = lookupHash(plaintext)
    const candidate = this.cache.find((t) => t.lookupHash === target)
    if (!candidate) return null
    if (!(await verifyToken(plaintext, candidate.verifyHash))) return null
    candidate.lastUsedAt = new Date().toISOString()
    // lastUsedAt is high-frequency; persist async without blocking the
    // caller on the file write.
    void this.persist()
    return publicView(candidate)
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as PersistedFile
      if (parsed.version !== 1) {
        throw new Error(`Unsupported tokens.json version: ${parsed.version}`)
      }
      this.cache = [...parsed.tokens]
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') throw err
      this.cache = []
    }
    await mkdir(dirname(this.filePath), { recursive: true })
    this.loaded = true
  }

  private async persist(): Promise<void> {
    const data: PersistedFile = { version: 1, tokens: this.cache }
    // Atomic write: write to a temp file, then rename over the target.
    // rename() on POSIX is atomic, so a reader either sees the old file
    // or the new file — never a torn write.
    const tmpPath = `${this.filePath}.tmp`
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8')
    await rename(tmpPath, this.filePath)
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    // Chain the new operation after any pending one. This serializes
    // create/revoke writes; reads are unsynchronized but harmless (they
    // just return whatever's currently in cache).
    const result = this.writeQueue.then(fn, fn)
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
