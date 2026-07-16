// news/news-rss-fetcher.test.ts — issue NW-002
//
// Unit tests for the RSS fetcher. We split coverage:
//   1. HTTP happy path: valid RSS → RawArticle[] (via stubbed fetcher).
//   2. Malformed XML → throws FetchError({ kind: 'parse' }).
//   3. Non-2xx response → throws FetchError({ kind: 'network' }).
//   4. Timeout → throws FetchError({ kind: 'timeout' }).
//   5. Empty feed (parser returns 0 items) → [].
//   6. Headers include the documented User-Agent + Accept.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  NewsRssFetcher,
  type HttpFetcher,
} from './news-rss-fetcher.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────

const VALID_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example feed</title>
    <link>https://example.com</link>
    <description>An example RSS feed</description>
    <item>
      <title>First post</title>
      <link>https://example.com/posts/1</link>
      <guid>https://example.com/posts/1</guid>
      <pubDate>Tue, 16 Jul 2024 12:00:00 GMT</pubDate>
      <description>First post body</description>
    </item>
    <item>
      <title>Second post</title>
      <link>https://example.com/posts/2</link>
      <guid>https://example.com/posts/2</guid>
      <pubDate>Tue, 16 Jul 2024 13:00:00 GMT</pubDate>
      <description>Second post body</description>
    </item>
  </channel>
</rss>`

const EMPTY_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Empty</title>
    <link>https://example.com</link>
    <description>No items</description>
  </channel>
</rss>`

// ─── Helpers ──────────────────────────────────────────────────────────────

interface FakeResponse {
  ok: boolean
  status: number
  statusText: string
  text: () => Promise<string>
  json: () => Promise<unknown>
}

function makeResponse(body: string, status = 200): Response {
  const r: FakeResponse = {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    text: async () => body,
    json: async () => JSON.parse(body),
  }
  return r as unknown as Response
}

/** Records the headers + URL each call received. */
interface RecordedCall {
  url: string
  headers: Record<string, string> | undefined
}

function makeRecordingFetcher(
  impl: (url: string, headers: Record<string, string> | undefined) => Response,
): { fetcher: HttpFetcher; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetcher: HttpFetcher = async (url, init) => {
    calls.push({ url, headers: init.headers })
    return impl(url, init.headers)
  }
  return { fetcher, calls }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('NewsRssFetcher', () => {
  // Use real timers by default — AbortController + setTimeout
  // is the production path. Each test sets a short timeout
  // (e.g. 50ms) so a stuck fetcher can't drag the suite.
  beforeEach(() => {
    vi.useRealTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns parsed RawArticle[] for a valid RSS feed', async () => {
    const { fetcher } = makeRecordingFetcher(() => makeResponse(VALID_RSS))
    const f = new NewsRssFetcher({ httpFetcher: fetcher })
    const out = await f.fetch('https://example.com/feed.xml')
    expect(out).toHaveLength(2)
    expect(out[0]?.title).toBe('First post')
    expect(out[0]?.url).toBe('https://example.com/posts/1')
    expect(out[0]?.id).toBe('https://example.com/posts/1')
    // rss-parser normalizes `pubDate` to ISO 8601 on `isoDate`;
    // the fetcher prefers `isoDate` (we wrote the code to do so).
    expect(out[0]?.publishedAt).toBe('2024-07-16T12:00:00.000Z')
    expect(out[0]?.description).toBe('First post body')
  })

  it('returns [] for a valid but empty feed', async () => {
    const { fetcher } = makeRecordingFetcher(() => makeResponse(EMPTY_RSS))
    const f = new NewsRssFetcher({ httpFetcher: fetcher })
    const out = await f.fetch('https://example.com/empty.xml')
    expect(out).toEqual([])
  })

  it('returns [] for a 2xx with an empty body', async () => {
    const { fetcher } = makeRecordingFetcher(() => makeResponse(''))
    const f = new NewsRssFetcher({ httpFetcher: fetcher })
    const out = await f.fetch('https://example.com/empty-body.xml')
    expect(out).toEqual([])
  })

  it('throws FetchError({ kind: "network" }) on non-2xx', async () => {
    const { fetcher } = makeRecordingFetcher(() => makeResponse('not found', 404))
    const f = new NewsRssFetcher({ httpFetcher: fetcher })
    await expect(f.fetch('https://example.com/missing.xml')).rejects.toMatchObject({
      name: 'FetchError',
      kind: 'network',
    })
  })

  it('throws FetchError({ kind: "parse" }) on malformed XML', async () => {
    const { fetcher } = makeRecordingFetcher(() => makeResponse('<not><valid></rss>'))
    const f = new NewsRssFetcher({ httpFetcher: fetcher })
    await expect(f.fetch('https://example.com/bad.xml')).rejects.toMatchObject({
      name: 'FetchError',
      kind: 'parse',
    })
  })

  it('throws FetchError({ kind: "timeout" }) when the request aborts', async () => {
    // Fetcher that never resolves — the AbortController in
    // the fetcher will fire after `timeoutMs` and reject with
    // an AbortError, which the fetcher maps to a timeout.
    const fetcher: HttpFetcher = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    const f = new NewsRssFetcher({ httpFetcher: fetcher, defaultTimeoutMs: 30 })
    await expect(f.fetch('https://example.com/slow.xml')).rejects.toMatchObject({
      name: 'FetchError',
      kind: 'timeout',
    })
  })

  it('sends the documented User-Agent and Accept headers', async () => {
    const { fetcher, calls } = makeRecordingFetcher(() => makeResponse(VALID_RSS))
    const f = new NewsRssFetcher({ httpFetcher: fetcher, serverUrl: 'https://lan.example' })
    await f.fetch('https://example.com/feed.xml')
    expect(calls).toHaveLength(1)
    const headers = calls[0]!.headers!
    expect(headers['user-agent']).toBe('Dashboard/1.0 (+https://lan.example)')
    expect(headers['accept']).toBe('application/rss+xml, application/xml;q=0.9, */*;q=0.5')
  })

  it('uses per-call timeoutMs override when provided', async () => {
    const fetcher: HttpFetcher = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    const f = new NewsRssFetcher({ httpFetcher: fetcher, defaultTimeoutMs: 10_000 })
    await expect(
      f.fetch('https://example.com/slow.xml', { timeoutMs: 20 }),
    ).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('defaults to a 15s timeout when none is configured', () => {
    // The constant is the documented default; this test is a
    // guard against an accidental change. (We can't easily
    // wait 15s in a test.)
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(15_000)
  })
})
