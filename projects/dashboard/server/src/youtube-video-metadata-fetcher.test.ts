import { describe, expect, it, vi } from 'vitest'
import {
  YouTubeVideoMetadataError,
  YouTubeVideoMetadataFetcher,
} from './youtube-video-metadata-fetcher.js'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('YouTubeVideoMetadataFetcher', () => {
  it('sends one authenticated videos.list request and returns typed per-video states', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json({
      items: [
        { id: 'ready', snippet: { description: 'Useful\nhttps://example.com' } },
        { id: 'empty', snippet: { description: '  ' } },
      ],
    }))
    const result = await new YouTubeVideoMetadataFetcher({ fetchFn }).fetch(
      'secret-access-token',
      ['ready', 'empty', 'missing'],
    )
    const [input, init] = fetchFn.mock.calls[0]!
    const url = new URL(String(input))
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/youtube/v3/videos')
    expect(url.searchParams.get('part')).toBe('snippet')
    expect(url.searchParams.get('id')).toBe('ready,empty,missing')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-access-token')
    expect(result.get('ready')).toEqual({
      status: 'ready', description: 'Useful\nhttps://example.com', truncated: false,
    })
    expect(result.get('empty')).toEqual({ status: 'unavailable', reason: 'no_description' })
    expect(result.get('missing')).toEqual({ status: 'unavailable', reason: 'not_found' })
  })

  it('bounds descriptions and isolates duplicate or malformed items', async () => {
    const fetcher = new YouTubeVideoMetadataFetcher({
      maxDescriptionChars: 5,
      fetchFn: async () => json({ items: [
        { id: 'long', snippet: { description: '123456789' } },
        { id: 'duplicate', snippet: { description: 'first' } },
        { id: 'duplicate', snippet: { description: 'second' } },
        { id: 'malformed', snippet: {} },
        { id: 'not-requested', snippet: { description: 'ignored' } },
      ] }),
    })
    const result = await fetcher.fetch('token', ['long', 'duplicate', 'malformed'])
    expect(result.get('long')).toEqual({ status: 'ready', description: '12345', truncated: true })
    expect(result.get('duplicate')).toMatchObject({ status: 'failed', code: 'invalid_response' })
    expect(result.get('malformed')).toMatchObject({ status: 'failed', code: 'invalid_response' })
    expect(result.has('not-requested')).toBe(false)
  })

  it.each([
    [401, 'auth', false],
    [403, 'quota', true],
    [429, 'quota', true],
    [503, 'http', true],
  ] as const)('classifies HTTP %i without retaining provider response bodies', async (status, code, retryable) => {
    const fetcher = new YouTubeVideoMetadataFetcher({
      fetchFn: async () => new Response('access_token=leaked', { status }),
    })
    const error = await fetcher.fetch('secret', ['id']).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(YouTubeVideoMetadataError)
    expect(error).toMatchObject({ code, retryable })
    expect(String(error)).not.toContain('leaked')
    expect(String(error)).not.toContain('secret')
  })

  it('times out a provider that never settles', async () => {
    const fetcher = new YouTubeVideoMetadataFetcher({
      timeoutMs: 5,
      fetchFn: async () => await new Promise<Response>(() => {}),
    })
    await expect(fetcher.fetch('secret', ['id'])).rejects.toMatchObject({
      code: 'timeout', retryable: true,
    })
  })

  it('rejects malformed top-level responses', async () => {
    const fetcher = new YouTubeVideoMetadataFetcher({ fetchFn: async () => json({ nope: [] }) })
    await expect(fetcher.fetch('token', ['id'])).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('splits arbitrary ID lists into provider batches of at most 50', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const ids = new URL(String(input)).searchParams.get('id')!.split(',')
      return json({ items: ids.map((id) => ({ id, snippet: { description: id } })) })
    })
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`)
    const result = await new YouTubeVideoMetadataFetcher({ fetchFn }).fetch('token', ids)
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(fetchFn.mock.calls.map(([input]) =>
      new URL(String(input)).searchParams.get('id')!.split(',').length,
    )).toEqual([50, 50, 1])
    expect(result.size).toBe(101)
  })
})
