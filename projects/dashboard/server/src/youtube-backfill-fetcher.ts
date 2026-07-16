const YOUTUBE_CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels'
const YOUTUBE_PLAYLIST_ITEMS_URL =
  'https://www.googleapis.com/youtube/v3/playlistItems'

const MAX_RESULTS = 50
export const MAX_BACKFILL_ITEMS = 500

export interface BackfillVideo {
  readonly videoId: string
  readonly channelId: string
  readonly channelTitle: string
  readonly title: string
  readonly publishedAt: string
  readonly thumbnailUrl: string | null
  readonly link: string
}

export interface BackfillFetchResult {
  readonly videos: readonly BackfillVideo[]
  readonly skipped: number
  readonly inspected: number
}

export class YouTubeApiError extends Error {
  readonly status: number
  readonly retryable: boolean

  constructor(operation: string, status: number) {
    super(`${operation} failed with HTTP ${status}`)
    this.name = 'YouTubeApiError'
    this.status = status
    this.retryable = status === 429 || status === 403 || status >= 500
  }
}

interface ChannelsResponse {
  items?: Array<{
    id?: string
    contentDetails?: { relatedPlaylists?: { uploads?: string } }
  }>
}

interface PlaylistItemsResponse {
  nextPageToken?: string
  items?: RawPlaylistItem[]
}

interface RawPlaylistItem {
  snippet?: {
    title?: string
    channelId?: string
    channelTitle?: string
    publishedAt?: string
    resourceId?: { videoId?: string }
    thumbnails?: Record<string, { url?: string; width?: number } | undefined>
  }
  contentDetails?: { videoId?: string; videoPublishedAt?: string }
}

export class YouTubeBackfillFetcher {
  readonly #fetchFn: typeof fetch

  constructor(fetchFn?: typeof fetch) {
    this.#fetchFn = fetchFn ?? globalThis.fetch
  }

  async resolveUploadsPlaylistIds(
    accessToken: string,
    channelIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const resolved = new Map<string, string>()
    for (let offset = 0; offset < channelIds.length; offset += 50) {
      const batch = channelIds.slice(offset, offset + 50)
      const url = new URL(YOUTUBE_CHANNELS_URL)
      url.searchParams.set('part', 'contentDetails')
      url.searchParams.set('id', batch.join(','))
      url.searchParams.set('maxResults', '50')
      const response = await this.#fetchFn(url, {
        headers: { authorization: `Bearer ${accessToken}` },
      })
      if (!response.ok) throw new YouTubeApiError('channels.list', response.status)
      const body = (await response.json()) as ChannelsResponse
      for (const channel of body.items ?? []) {
        const playlistId = channel.contentDetails?.relatedPlaylists?.uploads
        if (channel.id && playlistId) resolved.set(channel.id, playlistId)
      }
    }
    return resolved
  }

  async fetchRecentUploads(
    accessToken: string,
    uploadsPlaylistId: string,
    cutoffIso: string,
  ): Promise<BackfillFetchResult> {
    const videos: BackfillVideo[] = []
    let skipped = 0
    let inspected = 0
    let pageToken: string | undefined
    let crossedCutoff = false
    const cutoffMs = new Date(cutoffIso).getTime()

    do {
      const remaining = MAX_BACKFILL_ITEMS - inspected
      if (remaining <= 0) break
      const url = new URL(YOUTUBE_PLAYLIST_ITEMS_URL)
      url.searchParams.set('part', 'snippet,contentDetails')
      url.searchParams.set('playlistId', uploadsPlaylistId)
      url.searchParams.set('maxResults', String(Math.min(MAX_RESULTS, remaining)))
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const response = await this.#fetchFn(url, {
        headers: { authorization: `Bearer ${accessToken}` },
      })
      if (!response.ok) {
        throw new YouTubeApiError('playlistItems.list', response.status)
      }
      const body = (await response.json()) as PlaylistItemsResponse
      for (const item of body.items ?? []) {
        inspected++
        const parsed = parsePlaylistItem(item)
        if (!parsed) {
          skipped++
          continue
        }
        if (new Date(parsed.publishedAt).getTime() < cutoffMs) {
          crossedCutoff = true
          break
        }
        videos.push(parsed)
        if (inspected >= MAX_BACKFILL_ITEMS) break
      }
      pageToken = body.nextPageToken
    } while (pageToken && !crossedCutoff && inspected < MAX_BACKFILL_ITEMS)

    return { videos, skipped, inspected }
  }
}

function parsePlaylistItem(item: RawPlaylistItem): BackfillVideo | null {
  const snippet = item.snippet
  const videoId = item.contentDetails?.videoId ?? snippet?.resourceId?.videoId
  const title = snippet?.title?.trim()
  const publishedAt = item.contentDetails?.videoPublishedAt ?? snippet?.publishedAt
  const channelId = snippet?.channelId
  const channelTitle = snippet?.channelTitle
  if (
    !videoId || !title || !publishedAt || !channelId || !channelTitle ||
    title === 'Private video' || title === 'Deleted video'
  ) return null
  const thumbnails = Object.values(snippet.thumbnails ?? {})
    .filter((value): value is { url?: string; width?: number } => value !== undefined)
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
  return {
    videoId,
    channelId,
    channelTitle,
    title,
    publishedAt,
    thumbnailUrl: thumbnails.find((thumbnail) => thumbnail.url)?.url ?? null,
    link: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
  }
}
