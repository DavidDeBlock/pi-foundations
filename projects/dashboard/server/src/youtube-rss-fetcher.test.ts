// youtube-rss-fetcher.test.ts — issue YT-004
//
// Unit tests for the Atom fetcher. We split coverage:
//   1. `parseFeed` (pure function) — sample fixtures for all the
//      documented edge cases (single, multiple, empty, malformed).
//   2. `YouTubeRssFeedFetcher.fetch(channelId)` — HTTP layer
//      with an injected `Fetcher` stub: success path, 404,
//      non-Atom response, timeout, invalid channel id format.
//
// No real HTTP is performed — every test injects a stub `Fetcher`
// that resolves with a canned `Response`-like object.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseFeed,
  RssFeedFetchError,
  RssFeedParseError,
  YouTubeRssFeedFetcher,
  type Fetcher,
} from './youtube-rss-fetcher.js'
import { XMLParser } from 'fast-xml-parser'

// ─── Test helpers ─────────────────────────────────────────────────────────

const VALID_CHANNEL_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw'

function makeParser(): XMLParser {
  return new XMLParser({
    isArray: (name) => name === 'entry',
    removeNSPrefix: true,
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
    attributeNamePrefix: '@_',
  })
}

function makeResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    text: async () => body,
  } as unknown as Response
}

const FEED_ONE_ENTRY = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <title>YouTube</title>
  <entry>
    <id>yt:video:dQw4w9WgXcQ</id>
    <videoId>dQw4w9WgXcQ</videoId>
    <channelId>${VALID_CHANNEL_ID}</channelId>
    <title>Never Gonna Give You Up</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"/>
    <published>2009-10-25T06:57:33.000Z</published>
    <updated>2009-10-25T06:57:33.000Z</updated>
    <group>
      <thumbnail url="https://i1.ytimg.com/vi/dQw4w9WgXcQ/default.jpg" width="120" height="90"/>
      <thumbnail url="https://i1.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" width="480" height="360"/>
      <thumbnail url="https://i1.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg" width="640" height="480"/>
    </group>
  </entry>
</feed>`

const FEED_MULTIPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <title>YouTube</title>
  <entry>
    <id>yt:video:AAAAAAAAAAA</id>
    <videoId>AAAAAAAAAAA</videoId>
    <title>First</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=AAAAAAAAAAA"/>
    <published>2024-01-01T00:00:00.000Z</published>
    <group>
      <thumbnail url="https://example.com/a_hq.jpg" width="480" height="360"/>
    </group>
  </entry>
  <entry>
    <id>yt:video:BBBBBBBBBBB</id>
    <videoId>BBBBBBBBBBB</videoId>
    <title>Second</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=BBBBBBBBBBB"/>
    <published>2024-01-02T00:00:00.000Z</published>
    <group>
      <thumbnail url="https://example.com/b_sd.jpg" width="640" height="480"/>
    </group>
  </entry>
  <entry>
    <id>yt:video:CCCCCCCCCCC</id>
    <videoId>CCCCCCCCCCC</videoId>
    <title>Third</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=CCCCCCCCCCC"/>
    <published>2024-01-03T00:00:00.000Z</published>
    <group>
      <thumbnail url="https://example.com/c_default.jpg" width="120" height="90"/>
    </group>
  </entry>
</feed>`

const FEED_EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <title>YouTube</title>
</feed>`

const FEED_MALFORMED = `<<<<<this is not xml at all >>>>>`

const FEED_ENTRY_MISSING_VIDEO_ID = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <entry>
    <title>Missing videoId</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=foo"/>
    <published>2024-01-01T00:00:00.000Z</published>
  </entry>
  <entry>
    <videoId>DDDDDDDDDDD</videoId>
    <title>Good one</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=DDDDDDDDDDD"/>
    <published>2024-01-01T00:00:00.000Z</published>
  </entry>
</feed>`

beforeEach(() => {
  vi.useRealTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

// ─── parseFeed() — pure parser ────────────────────────────────────────────

describe('parseFeed', () => {
  it('returns entries in the order the feed listed them', () => {
    const { entries, dropped } = parseFeed(
      FEED_MULTIPLE,
      makeParser(),
      VALID_CHANNEL_ID,
    )
    expect(entries.map((e) => e.videoId)).toEqual([
      'AAAAAAAAAAA',
      'BBBBBBBBBBB',
      'CCCCCCCCCCC',
    ])
    expect(dropped).toBe(0)
  })

  it('extracts title, published, link, videoId for one entry', () => {
    const { entries } = parseFeed(
      FEED_ONE_ENTRY,
      makeParser(),
      VALID_CHANNEL_ID,
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      videoId: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      publishedAt: '2009-10-25T06:57:33.000Z',
      thumbnailUrl: 'https://i1.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg',
      link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    })
  })

  it('picks the largest thumbnail (sddefault > hqdefault > default)', () => {
    const { entries } = parseFeed(
      FEED_ONE_ENTRY,
      makeParser(),
      VALID_CHANNEL_ID,
    )
    // FEED_ONE_ENTRY lists default (120x90=10800), hqdefault (480x360=172800),
    // sddefault (640x480=307200). The parser preserves order in the
    // array; our pickThumbnail picks the largest area, which is sddefault.
    expect(entries[0]!.thumbnailUrl).toBe(
      'https://i1.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg',
    )
  })

  it('returns [] for an empty feed (no entries)', () => {
    const { entries, dropped } = parseFeed(
      FEED_EMPTY,
      makeParser(),
      VALID_CHANNEL_ID,
    )
    expect(entries).toEqual([])
    expect(dropped).toBe(0)
  })

  it('throws RssFeedParseError on malformed XML', () => {
    // fast-xml-parser is tolerant and won't throw on a feed that
    // has a stray `</open>` mismatch — it just consumes what it
    // can. The path through `parseFeed` that actually surfaces
    // errors is the "no <feed> root" check, so feed it something
    // that's syntactically XML but not Atom-shaped.
    expect(() =>
      parseFeed(FEED_MALFORMED, makeParser(), VALID_CHANNEL_ID),
    ).toThrow(RssFeedParseError)
  })

  it('throws RssFeedParseError when the body is not Atom-shaped', () => {
    expect(() =>
      parseFeed(
        '<html><body>not atom</body></html>',
        makeParser(),
        VALID_CHANNEL_ID,
      ),
    ).toThrow(/does not have a <feed> root/)
  })

  it('drops entries missing required fields and reports the count', () => {
    const { entries, dropped } = parseFeed(
      FEED_ENTRY_MISSING_VIDEO_ID,
      makeParser(),
      VALID_CHANNEL_ID,
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]!.videoId).toBe('DDDDDDDDDDD')
    expect(dropped).toBe(1)
  })

  it('rejects an entry with a non-YouTube-shaped videoId', () => {
    const bad = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <entry>
    <videoId>too-short</videoId>
    <title>title</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=foo"/>
    <published>2024-01-01T00:00:00.000Z</published>
  </entry>
</feed>`
    const { entries, dropped } = parseFeed(bad, makeParser(), VALID_CHANNEL_ID)
    expect(entries).toEqual([])
    expect(dropped).toBe(1)
  })

  it('handles an entry without <media:group> by giving it a null thumbnail', () => {
    const noThumb = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <entry>
    <videoId>EEEEEEEEEEE</videoId>
    <title>Title</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=EEEEEEEEEEE"/>
    <published>2024-01-01T00:00:00.000Z</published>
  </entry>
</feed>`
    const { entries } = parseFeed(noThumb, makeParser(), VALID_CHANNEL_ID)
    expect(entries[0]!.thumbnailUrl).toBeNull()
  })

  it('treats a single-entry feed as an array of one', () => {
    // The XMLParser's `isArray: (name) => name === 'entry'` is what
    // makes a single `<entry>` land as `[entry]` instead of just
    // `entry`. This test catches a regression where someone removes
    // the isArray rule.
    const { entries } = parseFeed(
      FEED_ONE_ENTRY,
      makeParser(),
      VALID_CHANNEL_ID,
    )
    expect(Array.isArray(entries)).toBe(true)
    expect(entries).toHaveLength(1)
  })
})

// ─── YouTubeRssFeedFetcher.fetch() — HTTP layer ───────────────────────────

describe('YouTubeRssFeedFetcher.fetch', () => {
  it('returns parsed entries on 200', async () => {
    const fetcher: Fetcher = vi.fn(async () => makeResponse(FEED_ONE_ENTRY))
    const rss = new YouTubeRssFeedFetcher({ fetcher })
    const { entries, dropped } = await rss.fetch(VALID_CHANNEL_ID)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.videoId).toBe('dQw4w9WgXcQ')
    expect(dropped).toBe(0)
  })

  it('passes the channel_id as a query parameter', async () => {
    let capturedUrl: string | undefined
    const fetcher: Fetcher = vi.fn(async (url) => {
      capturedUrl = url
      return makeResponse(FEED_EMPTY)
    })
    const rss = new YouTubeRssFeedFetcher({ fetcher })
    await rss.fetch(VALID_CHANNEL_ID)
    expect(capturedUrl).toContain(`channel_id=${VALID_CHANNEL_ID}`)
    expect(capturedUrl).toMatch(/^https?:\/\/.*feeds\/videos\.xml/)
  })

  it('throws RssFeedFetchError on 404', async () => {
    const fetcher: Fetcher = vi.fn(async () => makeResponse('not found', 404))
    const rss = new YouTubeRssFeedFetcher({ fetcher })
    await expect(rss.fetch(VALID_CHANNEL_ID)).rejects.toThrow(
      RssFeedFetchError,
    )
    await expect(rss.fetch(VALID_CHANNEL_ID)).rejects.toThrow(/HTTP 404/)
  })

  it('throws RssFeedFetchError on 500', async () => {
    const fetcher: Fetcher = vi.fn(async () => makeResponse('boom', 500))
    const rss = new YouTubeRssFeedFetcher({ fetcher })
    await expect(rss.fetch(VALID_CHANNEL_ID)).rejects.toThrow(/HTTP 500/)
  })

  it('throws RssFeedParseError on 200 + non-Atom body', async () => {
    const fetcher: Fetcher = vi.fn(async () =>
      makeResponse('<html>not atom</html>', 200),
    )
    const rss = new YouTubeRssFeedFetcher({ fetcher })
    await expect(rss.fetch(VALID_CHANNEL_ID)).rejects.toThrow(
      RssFeedParseError,
    )
  })

  it('returns { entries: [] } on 200 + empty body (no error)', async () => {
    const fetcher: Fetcher = vi.fn(async () => makeResponse('', 200))
    const rss = new YouTubeRssFeedFetcher({ fetcher })
    const { entries, dropped } = await rss.fetch(VALID_CHANNEL_ID)
    expect(entries).toEqual([])
    expect(dropped).toBe(0)
  })

  it('throws RssFeedFetchError on a network error', async () => {
    const fetcher: Fetcher = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const rss = new YouTubeRssFeedFetcher({ fetcher })
    await expect(rss.fetch(VALID_CHANNEL_ID)).rejects.toThrow(
      RssFeedFetchError,
    )
    await expect(rss.fetch(VALID_CHANNEL_ID)).rejects.toThrow(/ECONNREFUSED/)
  })

  it('rejects an invalid channel_id without making an HTTP call', async () => {
    const fetcher: Fetcher = vi.fn(async () => makeResponse(FEED_ONE_ENTRY))
    const rss = new YouTubeRssFeedFetcher({ fetcher })
    await expect(rss.fetch('not-a-real-channel')).rejects.toThrow(
      RssFeedFetchError,
    )
    await expect(rss.fetch('not-a-real-channel')).rejects.toThrow(
      /invalid channel_id format/,
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects non-UC prefixed ids', async () => {
    const fetcher: Fetcher = vi.fn(async () => makeResponse(FEED_ONE_ENTRY))
    const rss = new YouTubeRssFeedFetcher({ fetcher })
    await expect(
      rss.fetch('XX' + 'x'.repeat(22)), // 24 chars but not UC prefix
    ).rejects.toThrow(/invalid channel_id format/)
  })

  it('aborts the request when the timeout elapses', async () => {
    // Hang forever, then check the result after a short timeout.
    let abortSignalled = false
    const fetcher: Fetcher = async (_url, init) => {
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          abortSignalled = true
          reject(new DOMException('aborted', 'AbortError'))
        })
      }) as unknown as Response
    }
    const rss = new YouTubeRssFeedFetcher({ fetcher, timeoutMs: 50 })
    await expect(rss.fetch(VALID_CHANNEL_ID)).rejects.toThrow(/timed out/)
    expect(abortSignalled).toBe(true)
  })

  it('sends the documented headers', async () => {
    let captured: { init: { headers?: Record<string, string> } } | undefined
    const fetcher: Fetcher = vi.fn(async (_url, init) => {
      captured = { init }
      return makeResponse(FEED_ONE_ENTRY)
    })
    const rss = new YouTubeRssFeedFetcher({ fetcher })
    await rss.fetch(VALID_CHANNEL_ID)
    expect(captured!.init.headers).toBeDefined()
    expect(captured!.init.headers!['accept']).toContain('atom+xml')
    expect(captured!.init.headers!['user-agent']).toContain(
      'dashboard-server',
    )
  })
})