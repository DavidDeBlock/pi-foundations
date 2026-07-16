import { describe, expect, it, vi } from 'vitest'
import { parseIsoDurationSeconds, YouTubeVideoDurationFetcher } from './youtube-video-duration-fetcher.js'

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})

describe('YouTubeVideoDurationFetcher', () => {
  it('fetches durations, reports unavailable ids, and sends no token in the URL', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json({ items: [
      { id: 'short-id', contentDetails: { duration: 'PT2M59S' } },
      { id: 'long-id', contentDetails: { duration: 'PT1H2M3S' } },
    ] }))
    const result = await new YouTubeVideoDurationFetcher({ fetchFn }).fetch('private-token', [
      'short-id', 'long-id', 'gone-id',
    ])
    expect(result.get('short-id')).toEqual({ status: 'ready', durationSeconds: 179 })
    expect(result.get('long-id')).toEqual({ status: 'ready', durationSeconds: 3723 })
    expect(result.get('gone-id')).toEqual({ status: 'unavailable' })
    const [input, init] = fetchFn.mock.calls[0]!
    const url = new URL(String(input))
    expect(url.searchParams.get('part')).toBe('contentDetails')
    expect(url.searchParams.get('fields')).toBe('items(id,contentDetails/duration)')
    expect(String(input)).not.toContain('private-token')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-token')
  })

  it('batches at 50 with bounded concurrency', async () => {
    let active = 0
    let maxActive = 0
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      active -= 1
      const ids = new URL(String(input)).searchParams.get('id')!.split(',')
      return json({ items: ids.map((id) => ({ id, contentDetails: { duration: 'PT4M' } })) })
    })
    const ids = Array.from({ length: 121 }, (_, index) => `video-${index}`)
    expect((await new YouTubeVideoDurationFetcher({ fetchFn, concurrency: 2 }).fetch('token', ids)).size).toBe(121)
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(maxActive).toBeLessThanOrEqual(2)
  })

  it('classifies provider failures without retaining response bodies or secrets', async () => {
    const fetcher = new YouTubeVideoDurationFetcher({ fetchFn: async () => new Response('private-token leaked', { status: 403 }) })
    const error = await fetcher.fetch('private-token', ['video-id']).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ status: 403, retryable: true })
    expect(String(error)).not.toContain('private-token')
  })
})

describe('parseIsoDurationSeconds', () => {
  it.each([['PT3M', 180], ['PT3M1S', 181], ['PT1H2M3S', 3723], ['P1DT1S', 86401]])('%s', (input, output) => {
    expect(parseIsoDurationSeconds(input)).toBe(output)
  })
  it.each(['', '3 minutes', 'PT'])('rejects %s', (input) => expect(parseIsoDurationSeconds(input)).toBeNull())
})
