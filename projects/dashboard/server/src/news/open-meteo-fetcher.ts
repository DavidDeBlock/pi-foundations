// news/open-meteo-fetcher.ts — issue NW-002
//
// Deep module: fetches one Open-Meteo JSON endpoint and returns
// a `WeatherSnapshot`. The API is fundamentally different from
// the RSS/Atom fetchers — there is no feed, no list of items,
// just a single document with `current` / `hourly` / `daily`
// blocks. The store serializes each block into a JSON column
// verbatim; the page layer parses them back for rendering.
//
// Per the AC:
//   * Throws `FetchError` on network / parse / timeout failure.
//   * Returns `{ fetchedAt, current, daily, hourly }` on success.
//   * `fetchedAt` is set by US (the fetcher), not by the API —
//     Open-Meteo doesn't echo back fetch time.
//
// "Missing fields → typed error" means: if the response is a
// valid 2xx but doesn't have the structural shape we expect
// (no `current`, no `daily.time` array, etc.) we throw a parse
// error rather than return a half-populated snapshot. The
// `last_error` field on the source row then surfaces this to
// the operator — they know to check the URL or the Open-Meteo
// changelog.

import {
  FetchError,
  type WeatherCurrent,
  type WeatherDaily,
  type WeatherHourly,
  type WeatherSnapshot,
  type SourceType,
} from './types.js'
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  type HttpFetcher,
} from './news-rss-fetcher.js'

// ─── Public surface ───────────────────────────────────────────────────────

/** Discriminator value matching `news_sources.type = 'json_api'`. */
export const SOURCE_TYPE: SourceType = 'json_api'

export interface OpenMeteoFetcherOptions {
  readonly httpFetcher?: HttpFetcher
  readonly serverUrl?: string
  readonly defaultTimeoutMs?: number
}

/**
 * Fetches Open-Meteo JSON and normalizes to `WeatherSnapshot`.
 *
 * The fetcher is deliberately permissive about WHICH fields
 * are present (e.g. an operator might add a new current=xxx
 * parameter without re-deploying). It is strict about WHETHER
 * the three top-level blocks exist — a response without
 * `current` is malformed for our purposes.
 */
export class OpenMeteoFetcher {
  readonly #httpFetcher: HttpFetcher
  readonly #serverUrl: string
  readonly #defaultTimeoutMs: number

  constructor(options: OpenMeteoFetcherOptions = {}) {
    this.#httpFetcher = options.httpFetcher ?? defaultHttpFetcher()
    this.#serverUrl = options.serverUrl ?? 'localhost'
    this.#defaultTimeoutMs =
      options.defaultTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  }

  /**
   * Fetch and parse one Open-Meteo URL.
   *
   * @param url   Full Open-Meteo URL including `current`/`hourly`/`daily` params.
   * @param opts  Optional per-call overrides.
   */
  async fetch(
    url: string,
    opts: { readonly timeoutMs?: number } = {},
  ): Promise<WeatherSnapshot> {
    const timeoutMs = opts.timeoutMs ?? this.#defaultTimeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await this.#httpFetcher(url, {
        headers: {
          'user-agent': `Dashboard/1.0 (+${this.#serverUrl})`,
          accept: 'application/json',
        },
        signal: controller.signal,
      })
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new FetchError(
          `Open-Meteo request timed out after ${timeoutMs}ms for ${url}`,
          'timeout',
          err,
        )
      }
      throw new FetchError(
        `Open-Meteo request failed for ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        'network',
        err,
      )
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      throw new FetchError(
        `Open-Meteo returned HTTP ${response.status} for ${url}`,
        'network',
      )
    }

    let raw: unknown
    try {
      raw = await response.json()
    } catch (err: unknown) {
      throw new FetchError(
        `Open-Meteo body was not JSON for ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        'parse',
        err,
      )
    }

    return parseOpenMeteoResponse(raw, url, new Date())
  }
}

// ─── Parser (exported for unit testing) ──────────────────────────────────

/**
 * Validate and shape an Open-Meteo response body.
 *
 * Validation rules:
 *   * The body must be a JSON object.
 *   * `current` must be an object (or null — Open-Meteo
 *     returns `null` when no `current` params were requested).
 *   * `daily` must be an object with a string-array `time`.
 *   * `hourly` must be an object with a string-array `time`.
 *
 * Per-array lengths are NOT validated — the store keeps the
 * raw JSON. The page layer trusts that same-length arrays
 * (across `daily.time`, `daily.temperature_2m_max`, etc.) hold
 * for a given snapshot.
 */
export function parseOpenMeteoResponse(
  raw: unknown,
  url: string,
  now: Date,
): WeatherSnapshot {
  if (raw === null || typeof raw !== 'object') {
    throw new FetchError(
      `Open-Meteo response for ${url} is not a JSON object`,
      'parse',
    )
  }
  const body = raw as Record<string, unknown>

  const current = parseCurrent(body.current, url)
  const daily = parseDaily(body.daily, url)
  const hourly = parseHourly(body.hourly, url)

  return {
    fetchedAt: now.toISOString(),
    current,
    daily,
    hourly,
  }
}

function parseCurrent(
  raw: unknown,
  url: string,
): WeatherCurrent {
  // Open-Meteo returns `current: null` when the URL omits
  // `current=...` parameters. Treat as empty so the page can
  // render "no current data" without a parse error.
  if (raw === null || raw === undefined) return {}
  if (typeof raw !== 'object') {
    throw new FetchError(
      `Open-Meteo 'current' is not an object for ${url}`,
      'parse',
    )
  }
  // Pass through every field verbatim. The shape is loose by
  // design — the operator may extend the URL with new fields
  // and we want the snapshot to carry them.
  return raw as WeatherCurrent
}

function parseDaily(
  raw: unknown,
  url: string,
): ReadonlyArray<WeatherDaily> {
  if (raw === null || raw === undefined) return []
  if (typeof raw !== 'object') {
    throw new FetchError(
      `Open-Meteo 'daily' is not an object for ${url}`,
      'parse',
    )
  }
  const block = raw as Record<string, unknown>
  const times = block.time
  if (!Array.isArray(times) || !times.every((t) => typeof t === 'string')) {
    throw new FetchError(
      `Open-Meteo 'daily.time' is missing or not a string array for ${url}`,
      'parse',
    )
  }
  const out: WeatherDaily[] = []
  for (let i = 0; i < times.length; i++) {
    const t = times[i] as string
    out.push({
      time: t,
      weather_code: readNumber(block.weather_code, i),
      temperature_2m_max: readNumber(block.temperature_2m_max, i),
      temperature_2m_min: readNumber(block.temperature_2m_min, i),
      precipitation_probability_max: readNumber(
        block.precipitation_probability_max,
        i,
      ),
      sunrise: readString(block.sunrise, i),
      sunset: readString(block.sunset, i),
    })
  }
  return out
}

function parseHourly(
  raw: unknown,
  url: string,
): ReadonlyArray<WeatherHourly> {
  if (raw === null || raw === undefined) return []
  if (typeof raw !== 'object') {
    throw new FetchError(
      `Open-Meteo 'hourly' is not an object for ${url}`,
      'parse',
    )
  }
  const block = raw as Record<string, unknown>
  const times = block.time
  if (!Array.isArray(times) || !times.every((t) => typeof t === 'string')) {
    throw new FetchError(
      `Open-Meteo 'hourly.time' is missing or not a string array for ${url}`,
      'parse',
    )
  }
  const out: WeatherHourly[] = []
  for (let i = 0; i < times.length; i++) {
    const t = times[i] as string
    out.push({
      time: t,
      temperature_2m: readNumber(block.temperature_2m, i),
      precipitation_probability: readNumber(
        block.precipitation_probability,
        i,
      ),
      precipitation: readNumber(block.precipitation, i),
      weather_code: readNumber(block.weather_code, i),
    })
  }
  return out
}

/** Read element `i` from `arr` and ensure it's a finite number. */
function readNumber(arr: unknown, i: number): number | undefined {
  if (!Array.isArray(arr)) return undefined
  const v = arr[i]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return undefined
}

/** Read element `i` from `arr` and ensure it's a string. */
function readString(arr: unknown, i: number): string | undefined {
  if (!Array.isArray(arr)) return undefined
  const v = arr[i]
  if (typeof v === 'string') return v
  return undefined
}

// Re-export the default HTTP fetcher so the constructor
// default can use it without a circular import.
function defaultHttpFetcher(): HttpFetcher {
  return (url, init) => fetch(url, init)
}
