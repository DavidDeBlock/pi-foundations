export type SerperErrorCode = 'timeout' | 'auth' | 'quota' | 'http' | 'network' | 'malformed_response'

export class SerperSearchError extends Error {
  constructor(readonly code: SerperErrorCode, message: string, readonly status?: number) {
    super(message)
    this.name = 'SerperSearchError'
  }
}

export interface SerperOrganicResult {
  readonly title: string
  readonly link: string
  readonly snippet: string
  readonly date?: string
  readonly position: number
}

export interface SerperSearchClientOptions {
  readonly apiKey: string
  readonly fetchFn?: typeof fetch
  readonly endpoint?: string
  readonly timeoutMs?: number
}

/** Server-only, deliberately small adapter around Serper's search endpoint. */
export class SerperSearchClient {
  readonly #apiKey: string
  readonly #fetch: typeof fetch
  readonly #endpoint: string
  readonly #timeoutMs: number

  constructor(options: SerperSearchClientOptions) {
    this.#apiKey = options.apiKey
    this.#fetch = options.fetchFn ?? fetch
    this.#endpoint = options.endpoint ?? 'https://google.serper.dev/search'
    this.#timeoutMs = options.timeoutMs ?? 8_000
  }

  async search(input: { readonly query: string; readonly country: string; readonly language: string }): Promise<SerperOrganicResult[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs)
    let response: Response
    try {
      response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.#apiKey },
        body: JSON.stringify({ q: input.query, gl: input.country.toLowerCase(), hl: input.language }),
        signal: controller.signal,
      })
    } catch (error: unknown) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new SerperSearchError('timeout', `Serper request timed out after ${this.#timeoutMs}ms`)
      }
      throw new SerperSearchError('network', 'Serper request could not be completed')
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new SerperSearchError('auth', 'Serper rejected the configured credential', response.status)
      if (response.status === 429) throw new SerperSearchError('quota', 'Serper query quota or rate limit was reached', response.status)
      throw new SerperSearchError('http', `Serper request failed with HTTP ${response.status}`, response.status)
    }
    let payload: unknown
    try { payload = await response.json() } catch { throw new SerperSearchError('malformed_response', 'Serper returned invalid JSON') }
    if (!isRecord(payload) || (payload.organic !== undefined && !Array.isArray(payload.organic))) {
      throw new SerperSearchError('malformed_response', 'Serper response did not contain a valid organic result list')
    }
    if (!Array.isArray(payload.organic)) return []
    return payload.organic.flatMap((value, index) => {
      if (!isRecord(value) || typeof value.title !== 'string' || typeof value.link !== 'string') return []
      return [{ title: value.title, link: value.link, snippet: typeof value.snippet === 'string' ? value.snippet : '',
        ...(typeof value.date === 'string' ? { date: value.date } : {}),
        position: typeof value.position === 'number' && Number.isFinite(value.position) ? value.position : index + 1 }]
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
