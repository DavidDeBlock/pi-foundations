const YOUTUBE_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos'

export const MAX_VIDEO_METADATA_BATCH = 50
export const MAX_VIDEO_DESCRIPTION_CHARS = 100_000
export const DEFAULT_VIDEO_METADATA_TIMEOUT_MS = 15_000

export type VideoMetadataResult =
  | {
      readonly status: 'ready'
      readonly description: string
      readonly truncated: boolean
    }
  | {
      readonly status: 'unavailable'
      readonly reason: 'not_found' | 'no_description'
    }
  | {
      readonly status: 'failed'
      readonly code: 'invalid_response'
      readonly message: string
      readonly retryable: false
    }

export class YouTubeVideoMetadataError extends Error {
  readonly code: 'timeout' | 'auth' | 'quota' | 'http' | 'invalid_response'
  readonly status: number | null
  readonly retryable: boolean

  constructor(
    code: YouTubeVideoMetadataError['code'],
    message: string,
    options: { readonly status?: number; readonly retryable?: boolean } = {},
  ) {
    super(message)
    this.name = 'YouTubeVideoMetadataError'
    this.code = code
    this.status = options.status ?? null
    this.retryable = options.retryable ?? false
  }
}

export interface VideoMetadataFetcher {
  fetch(
    accessToken: string,
    videoIds: readonly string[],
  ): Promise<ReadonlyMap<string, VideoMetadataResult>>
}

interface RawVideoItem {
  id?: unknown
  snippet?: { description?: unknown } | unknown
}

export class YouTubeVideoMetadataFetcher implements VideoMetadataFetcher {
  readonly #fetchFn: typeof fetch
  readonly #timeoutMs: number
  readonly #maxDescriptionChars: number

  constructor(options: {
    readonly fetchFn?: typeof fetch
    readonly timeoutMs?: number
    readonly maxDescriptionChars?: number
  } = {}) {
    this.#fetchFn = options.fetchFn ?? globalThis.fetch
    this.#timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_VIDEO_METADATA_TIMEOUT_MS)
    this.#maxDescriptionChars = Math.max(1, options.maxDescriptionChars ?? MAX_VIDEO_DESCRIPTION_CHARS)
  }

  async fetch(
    accessToken: string,
    videoIds: readonly string[],
  ): Promise<ReadonlyMap<string, VideoMetadataResult>> {
    const ids = [...new Set(videoIds)]
    if (ids.length === 0) return new Map()
    const results = new Map<string, VideoMetadataResult>()
    for (let offset = 0; offset < ids.length; offset += MAX_VIDEO_METADATA_BATCH) {
      const batch = await this.#fetchBatch(
        accessToken,
        ids.slice(offset, offset + MAX_VIDEO_METADATA_BATCH),
      )
      for (const [id, result] of batch) results.set(id, result)
    }
    return results
  }

  async #fetchBatch(
    accessToken: string,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, VideoMetadataResult>> {
    const url = new URL(YOUTUBE_VIDEOS_URL)
    url.searchParams.set('part', 'snippet')
    url.searchParams.set('id', ids.join(','))
    url.searchParams.set('maxResults', String(ids.length))
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(new YouTubeVideoMetadataError(
          'timeout',
          'YouTube metadata request timed out',
          { retryable: true },
        ))
      }, this.#timeoutMs)
    })

    let response: Response
    try {
      response = await Promise.race([
        this.#fetchFn(url, {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        }),
        timedOut,
      ])
    } catch (error: unknown) {
      if (timeout !== undefined) clearTimeout(timeout)
      if (error instanceof YouTubeVideoMetadataError) throw error
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new YouTubeVideoMetadataError(
          'timeout',
          'YouTube metadata request timed out',
          { retryable: true },
        )
      }
      throw new YouTubeVideoMetadataError(
        'http',
        'YouTube metadata request failed',
        { retryable: true },
      )
    }
    try {
      if (!response.ok) throw httpError(response.status)

      let body: unknown
      try {
        body = await Promise.race([response.json(), timedOut])
      } catch (error: unknown) {
        if (error instanceof YouTubeVideoMetadataError) throw error
        throw new YouTubeVideoMetadataError(
          'invalid_response',
          'YouTube returned invalid metadata JSON',
        )
      }
      if (!isRecord(body) || !Array.isArray(body.items)) {
        throw new YouTubeVideoMetadataError(
          'invalid_response',
          'YouTube returned an invalid metadata response',
        )
      }

      const requested = new Set(ids)
      const results = new Map<string, VideoMetadataResult>()
      const duplicates = new Set<string>()
      for (const raw of body.items as RawVideoItem[]) {
        if (!isRecord(raw) || typeof raw.id !== 'string' || !requested.has(raw.id)) continue
        if (results.has(raw.id)) {
          duplicates.add(raw.id)
          continue
        }
        if (!isRecord(raw.snippet) || typeof raw.snippet.description !== 'string') {
          results.set(raw.id, invalidItem())
          continue
        }
        const description = raw.snippet.description
        if (description.trim() === '') {
          results.set(raw.id, { status: 'unavailable', reason: 'no_description' })
          continue
        }
        results.set(raw.id, {
          status: 'ready',
          description: description.slice(0, this.#maxDescriptionChars),
          truncated: description.length > this.#maxDescriptionChars,
        })
      }
      for (const id of duplicates) results.set(id, invalidItem())
      for (const id of ids) {
        if (!results.has(id)) {
          results.set(id, { status: 'unavailable', reason: 'not_found' })
        }
      }
      return results
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }
}

function httpError(status: number): YouTubeVideoMetadataError {
  if (status === 401) {
    return new YouTubeVideoMetadataError('auth', 'YouTube authentication failed', { status })
  }
  if (status === 403 || status === 429) {
    return new YouTubeVideoMetadataError(
      'quota',
      'YouTube quota or rate limit prevented metadata refresh',
      { status, retryable: true },
    )
  }
  return new YouTubeVideoMetadataError(
    'http',
    `YouTube metadata request failed with HTTP ${status}`,
    { status, retryable: status >= 500 },
  )
}

function invalidItem(): VideoMetadataResult {
  return {
    status: 'failed',
    code: 'invalid_response',
    message: 'YouTube returned invalid metadata for this video',
    retryable: false,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
