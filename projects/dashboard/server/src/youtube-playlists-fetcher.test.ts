import { describe, expect, it, vi } from 'vitest'
import { YouTubePlaylistsFetcher } from './youtube-playlists-fetcher.js'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('YouTubePlaylistsFetcher', () => {
  it('paginates owned playlists and normalizes privacy plus related special playlists', async () => {
    const calls: URL[] = []
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      calls.push(url)
      if (url.pathname.endsWith('/playlists')) {
        if (!url.searchParams.has('pageToken')) return json({
          nextPageToken: 'next',
          items: [{ id: 'PL-public', snippet: { title: 'Public', thumbnails: { high: { url: 'large', width: 800 } } }, contentDetails: { itemCount: 2 }, status: { privacyStatus: 'public' } }],
        })
        return json({ items: [{ id: 'PL-private', snippet: { title: 'Private' }, contentDetails: { itemCount: 1 }, status: { privacyStatus: 'private' } }] })
      }
      return json({ items: [{ contentDetails: { relatedPlaylists: { likes: 'LL', watchLater: 'WL', watchHistory: 'HL' } } }] })
    })
    const result = await new YouTubePlaylistsFetcher(fetchFn as typeof fetch).fetchAll('token')
    expect(calls.filter((url) => url.pathname.endsWith('/playlists'))).toHaveLength(2)
    expect(calls[0]!.searchParams.get('mine')).toBe('true')
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ playlistId: 'PL-public', privacyStatus: 'public', thumbnailUrl: 'large' }),
      expect.objectContaining({ playlistId: 'PL-private', privacyStatus: 'private' }),
      expect.objectContaining({ playlistId: 'LL', specialType: 'liked', liveSyncSupported: true }),
      expect.objectContaining({ playlistId: 'WL', specialType: 'watch_later', liveSyncSupported: false }),
      expect.objectContaining({ playlistId: 'HL', specialType: 'history', liveSyncSupported: false }),
    ]))
  })

  it('paginates every item page, preserves order, and skips unusable private videos', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (!url.searchParams.has('pageToken')) return json({
        nextPageToken: 'two', items: [rawItem('PLI-2', 'video-2', 2), {
          id: 'private', snippet: { title: 'Private video', position: 3 }, contentDetails: { videoId: 'x' },
        }],
      })
      return json({ items: [rawItem('PLI-1', 'video-1', 1)] })
    })
    const result = await new YouTubePlaylistsFetcher(fetchFn as typeof fetch).fetchItems('token', 'PL1')
    expect(result.skipped).toBe(1)
    expect(result.items.map((item) => [item.playlistItemId, item.position, item.channelId])).toEqual([
      ['PLI-2', 2, 'UC-owner'], ['PLI-1', 1, 'UC-owner'],
    ])
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('rejects the complete snapshot when a later page fails', async () => {
    let call = 0
    const fetchFn = vi.fn(async () => ++call === 1
      ? json({ nextPageToken: 'two', items: [rawItem('one', 'v1', 0)] })
      : json({}, 503))
    await expect(new YouTubePlaylistsFetcher(fetchFn as typeof fetch).fetchItems('token', 'PL1'))
      .rejects.toThrow('playlistItems.list failed with HTTP 503')
  })
})

function rawItem(id: string, videoId: string, position: number): object {
  return {
    id,
    snippet: {
      title: `Video ${videoId}`, publishedAt: '2026-07-15T00:00:00Z', position,
      videoOwnerChannelId: 'UC-owner', videoOwnerChannelTitle: 'Owner',
      resourceId: { videoId }, thumbnails: { medium: { url: `${videoId}.jpg`, width: 320 } },
    },
    contentDetails: { videoId, videoPublishedAt: '2026-07-14T00:00:00Z' },
  }
}
