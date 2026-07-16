// news/open-meteo-fetcher.test.ts — issue NW-002
//
// Unit tests for the Open-Meteo fetcher. The HTTP layer uses
// a stubbed fetcher; the parser is also exported as a pure
// function and gets direct coverage for the "missing fields →
// typed error" path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OpenMeteoFetcher,
  parseOpenMeteoResponse,
} from './open-meteo-fetcher.js'
import { FetchError, type WeatherSnapshot } from './types.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────

const VALID_BODY = {
  latitude: 51.0543,
  longitude: 3.7174,
  current: {
    time: '2024-07-16T12:00',
    temperature_2m: 20.5,
    apparent_temperature: 21.0,
    precipitation: 0,
    weather_code: 3,
  },
  hourly: {
    time: ['2024-07-16T12:00', '2024-07-16T13:00'],
    temperature_2m: [20.5, 21.0],
    precipitation_probability: [10, 20],
  },
  daily: {
    time: ['2024-07-16', '2024-07-17'],
    weather_code: [3, 61],
    temperature_2m_max: [22, 19],
    temperature_2m_min: [12, 11],
    precipitation_probability_max: [40, 80],
    sunrise: ['2024-07-16T05:45', '2024-07-17T05:46'],
    sunset: ['2024-07-16T21:55', '2024-07-17T21:54'],
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeResponse(body: unknown, status = 200): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  } as unknown as Response
}

// ─── HTTP tests ───────────────────────────────────────────────────────────

describe('OpenMeteoFetcher', () => {
  beforeEach(() => vi.useRealTimers())
  afterEach(() => vi.useRealTimers())

  it('returns a WeatherSnapshot for a valid response', async () => {
    const fetcher = (() => Promise.resolve(makeResponse(VALID_BODY))) as never
    const f = new OpenMeteoFetcher({ httpFetcher: fetcher as never })
    const snap = await f.fetch('https://api.open-meteo.com/v1/forecast?...')
    expect(snap.current.temperature_2m).toBe(20.5)
    expect(snap.daily).toHaveLength(2)
    expect(snap.daily[0]?.time).toBe('2024-07-16')
    expect(snap.daily[0]?.temperature_2m_max).toBe(22)
    expect(snap.hourly).toHaveLength(2)
    expect(snap.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('throws FetchError({ kind: "network" }) on non-2xx', async () => {
    const fetcher = (() =>
      Promise.resolve(makeResponse('error', 500))) as never
    const f = new OpenMeteoFetcher({ httpFetcher: fetcher as never })
    await expect(
      f.fetch('https://api.open-meteo.com/v1/forecast?...'),
    ).rejects.toMatchObject({ name: 'FetchError', kind: 'network' })
  })

  it('throws FetchError({ kind: "parse" }) on non-JSON body', async () => {
    const fetcher = (() =>
      Promise.resolve(makeResponse('<html>not json</html>'))) as never
    const f = new OpenMeteoFetcher({ httpFetcher: fetcher as never })
    await expect(
      f.fetch('https://api.open-meteo.com/v1/forecast?...'),
    ).rejects.toMatchObject({ name: 'FetchError', kind: 'parse' })
  })

  it('sends the Dashboard User-Agent and a JSON Accept header', async () => {
    let captured: Record<string, string> | undefined
    const fetcher = (async (
      _url: string,
      init: { headers?: Record<string, string> },
    ) => {
      captured = init.headers
      return makeResponse(VALID_BODY)
    }) as never
    const f = new OpenMeteoFetcher({
      httpFetcher: fetcher as never,
      serverUrl: 'https://lan.example',
    })
    await f.fetch('https://api.open-meteo.com/v1/forecast?...')
    expect(captured!['user-agent']).toBe('Dashboard/1.0 (+https://lan.example)')
    expect(captured!['accept']).toBe('application/json')
  })
})

// ─── Parser tests ─────────────────────────────────────────────────────────

describe('parseOpenMeteoResponse', () => {
  const now = new Date('2024-07-16T12:30:00Z')

  it('parses a well-formed response', () => {
    const out: WeatherSnapshot = parseOpenMeteoResponse(VALID_BODY, 'http://x', now)
    expect(out.current.temperature_2m).toBe(20.5)
    expect(out.daily).toHaveLength(2)
    expect(out.hourly).toHaveLength(2)
    expect(out.fetchedAt).toBe('2024-07-16T12:30:00.000Z')
  })

  it('throws on non-object body', () => {
    expect(() => parseOpenMeteoResponse('string body', 'http://x', now)).toThrow(FetchError)
    expect(() => parseOpenMeteoResponse(null, 'http://x', now)).toThrow(FetchError)
  })

  it('throws on missing daily.time array', () => {
    const bad = { ...VALID_BODY, daily: { weather_code: [1, 2] } }
    expect(() => parseOpenMeteoResponse(bad, 'http://x', now)).toThrow(FetchError)
  })

  it('throws on missing hourly.time array', () => {
    const bad = { ...VALID_BODY, hourly: { temperature_2m: [1, 2] } }
    expect(() => parseOpenMeteoResponse(bad, 'http://x', now)).toThrow(FetchError)
  })

  it('tolerates missing optional fields (current only)', () => {
    const minimal = {
      current: { time: '2024-07-16T12:00' },
      daily: { time: ['2024-07-16'] },
      hourly: { time: ['2024-07-16T12:00'] },
    }
    const out = parseOpenMeteoResponse(minimal, 'http://x', now)
    expect(out.current).toEqual({ time: '2024-07-16T12:00' })
    expect(out.daily[0]?.weather_code).toBeUndefined()
  })
})
