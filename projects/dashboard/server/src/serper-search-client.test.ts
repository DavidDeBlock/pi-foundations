import { describe, expect, it, vi } from 'vitest'
import { SerperSearchClient, SerperSearchError } from './serper-search-client.js'

describe('SerperSearchClient', () => {
  it('sends only bounded search fields and validates organic results', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ organic: [
      { title: 'SQLite', link: 'https://sqlite.org/', snippet: 'Small and reliable.', position: 1, date: 'Jul 2026' },
      { title: 42, link: 'https://invalid.test/' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = new SerperSearchClient({ apiKey: 'server-secret', fetchFn, endpoint: 'https://serper.test/search' })
    await expect(client.search({ query: 'SQLite reliability', country: 'NL', language: 'nl' })).resolves.toEqual([
      { title: 'SQLite', link: 'https://sqlite.org/', snippet: 'Small and reliable.', position: 1, date: 'Jul 2026' },
    ])
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://serper.test/search')
    expect(JSON.parse(String(init.body))).toEqual({ q: 'SQLite reliability', gl: 'nl', hl: 'nl' })
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-api-key': 'server-secret' })
  })

  it.each([[401, 'auth'], [403, 'auth'], [429, 'quota'], [500, 'http']] as const)(
    'maps HTTP %s to a typed %s error without response bodies', async (status, code) => {
      const client = new SerperSearchClient({ apiKey: 'secret', fetchFn: vi.fn().mockResolvedValue(
        new Response('provider body with secret-looking data', { status })) })
      await expect(client.search({ query: 'q', country: 'US', language: 'en' }))
        .rejects.toMatchObject({ code, status })
    })

  it('rejects malformed payloads and bounds timeouts', async () => {
    const malformed = new SerperSearchClient({ apiKey: 'secret', fetchFn: vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ organic: {} }), { status: 200 })) })
    await expect(malformed.search({ query: 'q', country: 'US', language: 'en' }))
      .rejects.toMatchObject({ code: 'malformed_response' })

    const waiting = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })) as typeof fetch
    const timeout = new SerperSearchClient({ apiKey: 'secret', fetchFn: waiting, timeoutMs: 5 })
    const error = await timeout.search({ query: 'q', country: 'US', language: 'en' }).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(SerperSearchError)
    expect(error).toMatchObject({ code: 'timeout' })
  })
})
