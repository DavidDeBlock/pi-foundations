// news/news-atom-fetcher.test.ts — issue NW-002
//
// Unit tests for the Atom fetcher. Mirrors the RSS fetcher
// suite but with Atom-specific fixtures and AC coverage:
//   * Valid Atom → RawArticle[] with the `<id>` mapped to `id`.
//   * Missing `<id>` → id field is empty string (the
//     normalizer's URL-fallback path takes over).
//   * Empty feed → [].
//   * Malformed XML → FetchError({ kind: 'parse' }).
//   * Non-2xx → FetchError({ kind: 'network' }).
//   * User-Agent header is the documented Dashboard/1.0 form.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewsAtomFetcher } from './news-atom-fetcher.js'
import type { HttpFetcher } from './news-rss-fetcher.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────

const VALID_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom feed</title>
  <link href="https://example.com/"/>
  <updated>2024-07-16T12:00:00Z</updated>
  <id>https://example.com/</id>
  <entry>
    <title>First entry</title>
    <link href="https://example.com/posts/1"/>
    <id>tag:example.com,2024:posts/1</id>
    <updated>2024-07-16T12:00:00Z</updated>
    <published>2024-07-16T12:00:00Z</published>
    <summary>First entry body</summary>
    <content type="html">&lt;p&gt;Body&lt;/p&gt;&lt;img src="https://cdn.example.com/atom.jpg"&gt;</content>
  </entry>
  <entry>
    <title>Second entry</title>
    <link href="https://example.com/posts/2"/>
    <id>tag:example.com,2024:posts/2</id>
    <updated>2024-07-16T13:00:00Z</updated>
    <published>2024-07-16T13:00:00Z</published>
    <summary>Second entry body</summary>
  </entry>
</feed>`

const ATOM_NO_ID = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>No id</title>
  <link href="https://example.com/"/>
  <updated>2024-07-16T12:00:00Z</updated>
  <id>https://example.com/</id>
  <entry>
    <title>Entry with no id</title>
    <link href="https://example.com/posts/x"/>
    <updated>2024-07-16T12:00:00Z</updated>
    <summary>Body</summary>
  </entry>
</feed>`

const EMPTY_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Empty</title>
  <link href="https://example.com/"/>
  <updated>2024-07-16T12:00:00Z</updated>
  <id>https://example.com/</id>
</feed>`

// ─── Helpers ──────────────────────────────────────────────────────────────

interface RecordedCall {
  url: string
  headers: Record<string, string> | undefined
}

function makeResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response
}

function makeRecordingFetcher(
  impl: () => Response,
): { fetcher: HttpFetcher; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetcher: HttpFetcher = async (url, init) => {
    calls.push({ url, headers: init.headers })
    return impl()
  }
  return { fetcher, calls }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('NewsAtomFetcher', () => {
  beforeEach(() => vi.useRealTimers())
  afterEach(() => vi.useRealTimers())

  it('returns RawArticle[] with <id> mapped to id', async () => {
    const { fetcher } = makeRecordingFetcher(() => makeResponse(VALID_ATOM))
    const f = new NewsAtomFetcher({ httpFetcher: fetcher })
    const out = await f.fetch('https://example.com/atom.xml')
    expect(out).toHaveLength(2)
    expect(out[0]?.title).toBe('First entry')
    expect(out[0]?.url).toBe('https://example.com/posts/1')
    expect(out[0]?.id).toBe('tag:example.com,2024:posts/1')
    // Atom `<published>` is ISO 8601; the parser normalizes
    // onto `isoDate` which we prefer.
    expect(out[0]?.publishedAt).toBe('2024-07-16T12:00:00.000Z')
    expect(out[0]?.imageUrl).toBe('https://cdn.example.com/atom.jpg')
  })

  it('emits an empty id when the entry omits <id> (URL fallback at the normalizer)', async () => {
    const { fetcher } = makeRecordingFetcher(() => makeResponse(ATOM_NO_ID))
    const f = new NewsAtomFetcher({ httpFetcher: fetcher })
    const out = await f.fetch('https://example.com/atom.xml')
    expect(out).toHaveLength(1)
    // The fetcher doesn't synthesize the URL; it leaves id
    // empty. The normalizer's URL-fallback path then maps
    // id ← url in the next step.
    expect(out[0]?.id).toBe('')
    expect(out[0]?.url).toBe('https://example.com/posts/x')
  })

  it('returns [] for a valid but empty Atom feed', async () => {
    const { fetcher } = makeRecordingFetcher(() => makeResponse(EMPTY_ATOM))
    const f = new NewsAtomFetcher({ httpFetcher: fetcher })
    const out = await f.fetch('https://example.com/atom.xml')
    expect(out).toEqual([])
  })

  it('throws FetchError({ kind: "parse" }) on malformed XML', async () => {
    const { fetcher } = makeRecordingFetcher(() => makeResponse('<not><valid></feed>'))
    const f = new NewsAtomFetcher({ httpFetcher: fetcher })
    await expect(f.fetch('https://example.com/atom.xml')).rejects.toMatchObject({
      name: 'FetchError',
      kind: 'parse',
    })
  })

  it('throws FetchError({ kind: "network" }) on non-2xx', async () => {
    const { fetcher } = makeRecordingFetcher(() => makeResponse('not found', 404))
    const f = new NewsAtomFetcher({ httpFetcher: fetcher })
    await expect(f.fetch('https://example.com/atom.xml')).rejects.toMatchObject({
      name: 'FetchError',
      kind: 'network',
    })
  })

  it('sends the documented Atom-specific Accept header', async () => {
    const { fetcher, calls } = makeRecordingFetcher(() => makeResponse(VALID_ATOM))
    const f = new NewsAtomFetcher({ httpFetcher: fetcher, serverUrl: 'https://lan.example' })
    await f.fetch('https://example.com/atom.xml')
    const headers = calls[0]!.headers!
    expect(headers['user-agent']).toBe('Dashboard/1.0 (+https://lan.example)')
    expect(headers['accept']).toBe('application/atom+xml, application/xml;q=0.9, */*;q=0.5')
  })
})
