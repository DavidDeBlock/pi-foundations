import { describe, expect, it, vi } from 'vitest'
import {
  MAX_BACKFILL_ITEMS,
  YouTubeApiError,
  YouTubeBackfillFetcher,
} from './youtube-backfill-fetcher.js'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function item(id: string, publishedAt: string, title = `Video ${id}`): unknown {
  return {
    snippet: {
      title,
      channelId: 'UC1',
      channelTitle: 'Channel',
      publishedAt,
      resourceId: { videoId: id },
      thumbnails: { high: { url: `https://img/${id}`, width: 480 } },
    },
    contentDetails: { videoId: id, videoPublishedAt: publishedAt },
  }
}

describe('YouTubeBackfillFetcher', () => {
  it('batches channels.list requests in groups of 50', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const ids = new URL(String(input)).searchParams.get('id')!.split(',')
      return json({ items: ids.map((id) => ({
        id,
        contentDetails: { relatedPlaylists: { uploads: `UU${id}` } },
      })) })
    })
    const fetcher = new YouTubeBackfillFetcher(fetchFn)
    const ids = Array.from({ length: 101 }, (_, index) => `UC${index}`)
    const result = await fetcher.resolveUploadsPlaylistIds('token', ids)
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(result.get('UC100')).toBe('UUUC100')
  })

  it('paginates newest-first, skips unavailable items, and stops at cutoff', async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({
        nextPageToken: 'next',
        items: [
          item('new-1', '2026-07-15T00:00:00.000Z'),
          item('private', '2026-07-14T00:00:00.000Z', 'Private video'),
        ],
      }))
      .mockResolvedValueOnce(json({
        nextPageToken: 'unused',
        items: [
          item('new-2', '2026-07-10T00:00:00.000Z'),
          item('old', '2026-06-01T00:00:00.000Z'),
          item('never-read', '2026-07-12T00:00:00.000Z'),
        ],
      }))
    const result = await new YouTubeBackfillFetcher(fetchFn).fetchRecentUploads(
      'token',
      'UU1',
      '2026-07-01T00:00:00.000Z',
    )
    expect(result.videos.map((video) => video.videoId)).toEqual(['new-1', 'new-2'])
    expect(result.skipped).toBe(1)
    expect(result.inspected).toBe(4)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('never inspects more than the 500-item safety cap', async () => {
    let calls = 0
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => {
      const page = calls++
      return json({
        nextPageToken: 'more',
        items: Array.from({ length: 50 }, (_, index) =>
          item(`${page}-${index}`, '2026-07-15T00:00:00.000Z')),
      })
    })
    const result = await new YouTubeBackfillFetcher(fetchFn).fetchRecentUploads(
      'token', 'UU1', '2026-01-01T00:00:00.000Z',
    )
    expect(result.inspected).toBe(MAX_BACKFILL_ITEMS)
    expect(fetchFn).toHaveBeenCalledTimes(10)
  })

  it('marks quota and rate responses retryable without retaining response bodies', async () => {
    const fetcher = new YouTubeBackfillFetcher(async () =>
      new Response('token=secret', { status: 429 }))
    await expect(fetcher.resolveUploadsPlaylistIds('token', ['UC1']))
      .rejects.toMatchObject({ status: 429, retryable: true } satisfies Partial<YouTubeApiError>)
  })
})
