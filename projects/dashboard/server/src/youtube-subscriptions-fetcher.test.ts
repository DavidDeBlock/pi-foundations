// youtube-subscriptions-fetcher.test.ts — issue YT-002
//
// Unit tests for the Data API `subscriptions.list` wrapper. Two
// layers of coverage:
//   1. `parseSubscription` — pure function: raw API JSON → typed
//      `Subscription`. Exercises the documented optional-field
//      fallbacks (thumbnail picking, missing fields → null).
//   2. `YouTubeSubscriptionsFetcher.fetchAll` — uses an injected
//      `fetch` to return canned pages. Verifies pagination
//      (multiple pages collapsed into one array), empty responses,
//      and error propagation.

import { describe, expect, it } from 'vitest'
import {
  parseSubscription,
  YouTubeSubscriptionsFetcher,
} from './youtube-subscriptions-fetcher.js'

// ─── parseSubscription ───────────────────────────────────────────────────

describe('parseSubscription', () => {
  it('extracts channel_id, title, thumbnail (medium), subscribedAt', () => {
    const raw = {
      snippet: {
        publishedAt: '2024-01-15T10:00:00Z',
        title: 'Cool Channel',
        resourceId: { channelId: 'UCabc' },
        thumbnails: {
          default: { url: 'https://x/dflt.jpg' },
          medium: { url: 'https://x/med.jpg' },
          high: { url: 'https://x/high.jpg' },
        },
      },
    }
    const out = parseSubscription(raw)
    expect(out).toEqual({
      id: '',
      googleAccountId: '',
      channelId: 'UCabc',
      channelTitle: 'Cool Channel',
      channelThumbnailUrl: 'https://x/med.jpg',
      subscribedAt: '2024-01-15T10:00:00Z',
      isIncluded: true,
      isImportant: false,
      autoFetchTranscripts: false,
      lastPolledAt: null,
      backfillStatus: null,
      lastBackfillDays: null,
      lastBackfillCount: 0,
      lastBackfillSkippedCount: 0,
      lastBackfilledAt: null,
      backfillError: null,
      backfillRetryable: false,
      createdAt: '',
      updatedAt: '',
    })
  })

  it('falls back to default thumbnail when medium is missing', () => {
    const raw = {
      snippet: {
        title: 'C',
        resourceId: { channelId: 'UC1' },
        thumbnails: { default: { url: 'https://x/d.jpg' } },
      },
    }
    expect(parseSubscription(raw)?.channelThumbnailUrl).toBe('https://x/d.jpg')
  })

  it('returns null thumbnail when no thumbnails object', () => {
    const raw = {
      snippet: {
        title: 'C',
        resourceId: { channelId: 'UC1' },
      },
    }
    expect(parseSubscription(raw)?.channelThumbnailUrl).toBeNull()
  })

  it('returns null thumbnail when thumbnails exist but have no url', () => {
    const raw = {
      snippet: {
        title: 'C',
        resourceId: { channelId: 'UC1' },
        thumbnails: { medium: {}, high: {} },
      },
    }
    expect(parseSubscription(raw)?.channelThumbnailUrl).toBeNull()
  })

  it('returns null when channelId is missing', () => {
    expect(
      parseSubscription({ snippet: { title: 'C', resourceId: {} } }),
    ).toBeNull()
  })

  it('returns null when title is missing', () => {
    expect(
      parseSubscription({ snippet: { resourceId: { channelId: 'UC1' } } }),
    ).toBeNull()
  })

  it('returns null when snippet is missing entirely', () => {
    expect(parseSubscription({})).toBeNull()
  })

  it('returns empty subscribedAt when publishedAt is absent', () => {
    const raw = {
      snippet: {
        title: 'C',
        resourceId: { channelId: 'UC1' },
      },
    }
    expect(parseSubscription(raw)?.subscribedAt).toBe('')
  })
})

// ─── fetchAll ────────────────────────────────────────────────────────────

/** A fake `fetch` that returns queued responses in order. Useful
 *  for verifying pagination (nextPageToken-driven loops) without
 *  hitting the network. */
function queueFetch(
  responses: ReadonlyArray<{
    status?: number
    body: unknown
  }>,
): { fn: typeof fetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  let idx = 0
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    const headers: Record<string, string> = {}
    if (init?.headers) {
      const h = init.headers
      if (h instanceof Headers) {
        h.forEach((v, k) => {
          headers[k] = v
        })
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) headers[k] = v
      } else {
        Object.assign(headers, h)
      }
    }
    calls.push({ url, headers })
    const r = responses[idx++] ?? responses[responses.length - 1]
    const status = r.status ?? 200
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fn, calls }
}

describe('YouTubeSubscriptionsFetcher.fetchAll', () => {
  it('returns an empty array on an empty response', async () => {
    const { fn } = queueFetch([{ body: {} }])
    const fetcher = new YouTubeSubscriptionsFetcher(fn)
    const out = await fetcher.fetchAll('TOKEN')
    expect(out).toEqual([])
  })

  it('returns an empty array when items is an empty array', async () => {
    const { fn } = queueFetch([{ body: { items: [] } }])
    const fetcher = new YouTubeSubscriptionsFetcher(fn)
    const out = await fetcher.fetchAll('TOKEN')
    expect(out).toEqual([])
  })

  it('sends Authorization: Bearer <token> on the request', async () => {
    const { fn, calls } = queueFetch([{ body: {} }])
    const fetcher = new YouTubeSubscriptionsFetcher(fn)
    await fetcher.fetchAll('ya29.test')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers['authorization']).toBe('Bearer ya29.test')
  })

  it('uses part=snippet, mine=true, maxResults=50 on the first request', async () => {
    const { fn, calls } = queueFetch([{ body: {} }])
    const fetcher = new YouTubeSubscriptionsFetcher(fn)
    await fetcher.fetchAll('TOKEN')
    const u = new URL(calls[0]!.url)
    expect(u.searchParams.get('part')).toBe('snippet')
    expect(u.searchParams.get('mine')).toBe('true')
    expect(u.searchParams.get('maxResults')).toBe('50')
    // First page must NOT include a pageToken.
    expect(u.searchParams.get('pageToken')).toBeNull()
  })

  it('paginates through nextPageToken until exhausted', async () => {
    const { fn, calls } = queueFetch([
      {
        body: {
          items: [
            { snippet: { title: 'A', resourceId: { channelId: 'UCa' } } },
            { snippet: { title: 'B', resourceId: { channelId: 'UCb' } } },
          ],
          nextPageToken: 'page-2',
        },
      },
      {
        body: {
          items: [
            { snippet: { title: 'C', resourceId: { channelId: 'UCc' } } },
          ],
          nextPageToken: 'page-3',
        },
      },
      {
        body: {
          items: [
            { snippet: { title: 'D', resourceId: { channelId: 'UCd' } } },
          ],
          // no nextPageToken → end of pagination
        },
      },
    ])
    const fetcher = new YouTubeSubscriptionsFetcher(fn)
    const out = await fetcher.fetchAll('TOKEN')
    expect(out.map((s) => s.channelTitle)).toEqual(['A', 'B', 'C', 'D'])
    expect(calls).toHaveLength(3)
    // Verify pageToken was threaded through on subsequent calls.
    expect(new URL(calls[1]!.url).searchParams.get('pageToken')).toBe('page-2')
    expect(new URL(calls[2]!.url).searchParams.get('pageToken')).toBe('page-3')
  })

  it('throws on a non-2xx response with the status code in the message', async () => {
    const { fn } = queueFetch([
      { status: 401, body: 'Unauthorized' },
    ])
    const fetcher = new YouTubeSubscriptionsFetcher(fn)
    await expect(fetcher.fetchAll('TOKEN')).rejects.toThrow(/subscriptions\.list 401/)
  })

  it('throws on a 403 insufficient-scope with the body included', async () => {
    const { fn } = queueFetch([
      { status: 403, body: 'Insufficient authentication scopes' },
    ])
    const fetcher = new YouTubeSubscriptionsFetcher(fn)
    await expect(fetcher.fetchAll('TOKEN')).rejects.toThrow(
      /Insufficient authentication scopes/,
    )
  })

  it('skips malformed items but keeps the well-formed ones', async () => {
    const { fn } = queueFetch([
      {
        body: {
          items: [
            { snippet: { title: 'Good', resourceId: { channelId: 'UCa' } } },
            { snippet: { title: 'No channelId' } }, // malformed
            { /* no snippet at all */ }, // malformed
            { snippet: { title: 'Also good', resourceId: { channelId: 'UCb' } } },
          ],
        },
      },
    ])
    const fetcher = new YouTubeSubscriptionsFetcher(fn)
    const out = await fetcher.fetchAll('TOKEN')
    expect(out.map((s) => s.channelTitle)).toEqual(['Good', 'Also good'])
  })
})
