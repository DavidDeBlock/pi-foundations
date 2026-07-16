const YOUTUBE_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos'

export const MAX_VIDEO_DURATION_BATCH = 50
export const DEFAULT_VIDEO_DURATION_CONCURRENCY = 4
export const DEFAULT_VIDEO_DURATION_TIMEOUT_MS = 15_000

export type VideoDurationResult =
  | { readonly status: 'ready'; readonly durationSeconds: number }
  | { readonly status: 'unavailable' }

export interface VideoDurationFetcher {
  fetch(accessToken: string, videoIds: readonly string[]): Promise<ReadonlyMap<string, VideoDurationResult>>
}

export class YouTubeVideoDurationError extends Error {
  readonly status: number | null
  readonly retryable: boolean

  constructor(message: string, options: { readonly status?: number; readonly retryable?: boolean } = {}) {
    super(message)
    this.name = 'YouTubeVideoDurationError'
    this.status = options.status ?? null
    this.retryable = options.retryable ?? false
  }
}

interface RawVideoItem {
  readonly id?: unknown
  readonly contentDetails?: { readonly duration?: unknown } | unknown
}

/** Fetches public duration metadata in bounded batches for history classification. */
export class YouTubeVideoDurationFetcher implements VideoDurationFetcher {
  readonly #fetchFn: typeof fetch
  readonly #timeoutMs: number
  readonly #concurrency: number

  constructor(options: {
    readonly fetchFn?: typeof fetch
    readonly timeoutMs?: number
    readonly concurrency?: number
  } = {}) {
    this.#fetchFn = options.fetchFn ?? globalThis.fetch
    this.#timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_VIDEO_DURATION_TIMEOUT_MS)
    this.#concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_VIDEO_DURATION_CONCURRENCY))
  }

  async fetch(accessToken: string, videoIds: readonly string[]): Promise<ReadonlyMap<string, VideoDurationResult>> {
    const ids = [...new Set(videoIds)]
    const batches: string[][] = []
    for (let offset = 0; offset < ids.length; offset += MAX_VIDEO_DURATION_BATCH) {
      batches.push(ids.slice(offset, offset + MAX_VIDEO_DURATION_BATCH))
    }
    const result = new Map<string, VideoDurationResult>()
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < batches.length) {
        const batch = batches[cursor++]
        if (!batch) return
        const values = await this.#fetchBatch(accessToken, batch)
        for (const [id, value] of values) result.set(id, value)
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.#concurrency, batches.length) }, worker))
    return result
  }

  async #fetchBatch(accessToken: string, ids: readonly string[]): Promise<ReadonlyMap<string, VideoDurationResult>> {
    const url = new URL(YOUTUBE_VIDEOS_URL)
    url.searchParams.set('part', 'contentDetails')
    url.searchParams.set('id', ids.join(','))
    url.searchParams.set('fields', 'items(id,contentDetails/duration)')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs)
    let response: Response
    try {
      response = await this.#fetchFn(url, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      })
    } catch (error: unknown) {
      if (controller.signal.aborted) throw new YouTubeVideoDurationError('YouTube duration lookup timed out.', { retryable: true })
      throw new YouTubeVideoDurationError('YouTube duration lookup failed.', { retryable: true })
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) {
      throw new YouTubeVideoDurationError(
        response.status === 401 ? 'YouTube authentication failed during duration lookup.' : 'YouTube duration lookup was rejected.',
        { status: response.status, retryable: response.status === 403 || response.status === 429 || response.status >= 500 },
      )
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new YouTubeVideoDurationError('YouTube returned invalid duration metadata.')
    }
    if (!isRecord(body) || !Array.isArray(body.items)) {
      throw new YouTubeVideoDurationError('YouTube returned an invalid duration response.')
    }
    const requested = new Set(ids)
    const values = new Map<string, VideoDurationResult>()
    for (const item of body.items as RawVideoItem[]) {
      if (!isRecord(item) || typeof item.id !== 'string' || !requested.has(item.id)) continue
      const duration = isRecord(item.contentDetails) && typeof item.contentDetails.duration === 'string'
        ? parseIsoDurationSeconds(item.contentDetails.duration)
        : null
      if (duration === null) throw new YouTubeVideoDurationError('YouTube returned invalid video duration metadata.')
      values.set(item.id, { status: 'ready', durationSeconds: duration })
    }
    for (const id of ids) if (!values.has(id)) values.set(id, { status: 'unavailable' })
    return values
  }
}

export function parseIsoDurationSeconds(value: string): number | null {
  const match = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/)
  if (!match || !match.slice(1).some((part) => part !== undefined)) return null
  const seconds = Number(match[1] ?? 0) * 86_400
    + Number(match[2] ?? 0) * 3_600
    + Number(match[3] ?? 0) * 60
    + Number(match[4] ?? 0)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
