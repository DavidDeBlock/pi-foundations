import { YouTubeApiError } from './youtube-backfill-fetcher.js'

const PLAYLISTS_URL = 'https://www.googleapis.com/youtube/v3/playlists'
const PLAYLIST_ITEMS_URL = 'https://www.googleapis.com/youtube/v3/playlistItems'
const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels'

export type PlaylistPrivacy = 'public' | 'private' | 'unlisted' | 'unknown'
export type PlaylistSpecialType = 'liked' | 'watch_later' | 'history' | null

export interface FetchedYouTubePlaylist {
  readonly playlistId: string
  readonly title: string
  readonly description: string
  readonly thumbnailUrl: string | null
  readonly privacyStatus: PlaylistPrivacy
  readonly remoteItemCount: number
  readonly specialType: PlaylistSpecialType
  readonly liveSyncSupported: boolean
}

export interface FetchedYouTubePlaylistItem {
  readonly playlistItemId: string
  readonly position: number
  readonly addedAt: string | null
  readonly videoId: string
  readonly channelId: string
  readonly channelTitle: string
  readonly title: string
  readonly publishedAt: string
  readonly thumbnailUrl: string | null
  readonly link: string
}

interface PlaylistListResponse {
  nextPageToken?: string
  items?: RawPlaylist[]
}

interface RawPlaylist {
  id?: string
  snippet?: {
    title?: string
    description?: string
    thumbnails?: Record<string, { url?: string; width?: number } | undefined>
  }
  contentDetails?: { itemCount?: number }
  status?: { privacyStatus?: string }
}

interface RelatedPlaylistsResponse {
  items?: Array<{ contentDetails?: { relatedPlaylists?: {
    likes?: string
    watchLater?: string
    watchHistory?: string
  } } }>
}

interface PlaylistItemsResponse {
  nextPageToken?: string
  items?: RawPlaylistItem[]
}

interface RawPlaylistItem {
  id?: string
  snippet?: {
    title?: string
    publishedAt?: string
    position?: number
    videoOwnerChannelId?: string
    videoOwnerChannelTitle?: string
    resourceId?: { videoId?: string }
    thumbnails?: Record<string, { url?: string; width?: number } | undefined>
  }
  contentDetails?: { videoId?: string; videoPublishedAt?: string }
}

export class YouTubePlaylistsFetcher {
  readonly #fetchFn: typeof fetch

  constructor(fetchFn?: typeof fetch) {
    this.#fetchFn = fetchFn ?? globalThis.fetch
  }

  /** A complete metadata snapshot. Any failed page rejects the whole call. */
  async fetchAll(accessToken: string): Promise<readonly FetchedYouTubePlaylist[]> {
    const playlists: FetchedYouTubePlaylist[] = []
    let pageToken: string | undefined
    do {
      const url = new URL(PLAYLISTS_URL)
      url.searchParams.set('part', 'snippet,contentDetails,status')
      url.searchParams.set('mine', 'true')
      url.searchParams.set('maxResults', '50')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const body = await this.#request<PlaylistListResponse>(url, accessToken, 'playlists.list')
      for (const raw of body.items ?? []) {
        const parsed = parsePlaylist(raw)
        if (parsed) playlists.push(parsed)
      }
      pageToken = body.nextPageToken
    } while (pageToken)

    const relatedUrl = new URL(CHANNELS_URL)
    relatedUrl.searchParams.set('part', 'contentDetails')
    relatedUrl.searchParams.set('mine', 'true')
    const related = await this.#request<RelatedPlaylistsResponse>(
      relatedUrl, accessToken, 'channels.list',
    )
    const ids = related.items?.[0]?.contentDetails?.relatedPlaylists
    addSpecial(playlists, ids?.likes, 'Liked Videos', 'liked', true)
    addSpecial(playlists, ids?.watchLater, 'Watch Later', 'watch_later', false)
    addSpecial(playlists, ids?.watchHistory, 'Watch History', 'history', false)
    return playlists
  }

  /** A complete membership snapshot. Any failed page rejects the whole call. */
  async fetchItems(
    accessToken: string,
    playlistId: string,
  ): Promise<{ readonly items: readonly FetchedYouTubePlaylistItem[]; readonly skipped: number }> {
    const items: FetchedYouTubePlaylistItem[] = []
    let skipped = 0
    let pageToken: string | undefined
    do {
      const url = new URL(PLAYLIST_ITEMS_URL)
      url.searchParams.set('part', 'snippet,contentDetails')
      url.searchParams.set('playlistId', playlistId)
      url.searchParams.set('maxResults', '50')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const body = await this.#request<PlaylistItemsResponse>(
        url, accessToken, 'playlistItems.list',
      )
      for (const raw of body.items ?? []) {
        const parsed = parsePlaylistItem(raw)
        if (parsed) items.push(parsed)
        else skipped++
      }
      pageToken = body.nextPageToken
    } while (pageToken)
    return { items, skipped }
  }

  async #request<T>(url: URL, token: string, operation: string): Promise<T> {
    const response = await this.#fetchFn(url, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw new YouTubeApiError(operation, response.status)
    return await response.json() as T
  }
}

function parsePlaylist(raw: RawPlaylist): FetchedYouTubePlaylist | null {
  const playlistId = raw.id
  const title = raw.snippet?.title?.trim()
  if (!playlistId || !title) return null
  const privacy = raw.status?.privacyStatus
  return {
    playlistId,
    title,
    description: raw.snippet?.description ?? '',
    thumbnailUrl: bestThumbnail(raw.snippet?.thumbnails),
    privacyStatus: privacy === 'public' || privacy === 'private' || privacy === 'unlisted'
      ? privacy : 'unknown',
    remoteItemCount: Math.max(0, raw.contentDetails?.itemCount ?? 0),
    specialType: null,
    liveSyncSupported: true,
  }
}

function parsePlaylistItem(raw: RawPlaylistItem): FetchedYouTubePlaylistItem | null {
  const snippet = raw.snippet
  const playlistItemId = raw.id
  const videoId = raw.contentDetails?.videoId ?? snippet?.resourceId?.videoId
  const channelId = snippet?.videoOwnerChannelId
  const channelTitle = snippet?.videoOwnerChannelTitle?.trim()
  const title = snippet?.title?.trim()
  const publishedAt = raw.contentDetails?.videoPublishedAt
  if (!playlistItemId || !videoId || !channelId || !channelTitle || !title ||
      !publishedAt || title === 'Private video' || title === 'Deleted video') return null
  return {
    playlistItemId,
    position: Math.max(0, snippet?.position ?? 0),
    addedAt: snippet?.publishedAt ?? null,
    videoId,
    channelId,
    channelTitle,
    title,
    publishedAt,
    thumbnailUrl: bestThumbnail(snippet?.thumbnails),
    link: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
  }
}

function bestThumbnail(
  thumbnails?: Record<string, { url?: string; width?: number } | undefined>,
): string | null {
  return Object.values(thumbnails ?? {})
    .filter((value): value is { url?: string; width?: number } => value !== undefined)
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
    .find((thumbnail) => thumbnail.url)?.url ?? null
}

function addSpecial(
  playlists: FetchedYouTubePlaylist[],
  playlistId: string | undefined,
  title: string,
  specialType: Exclude<PlaylistSpecialType, null>,
  liveSyncSupported: boolean,
): void {
  if (!playlistId) return
  const existingIndex = playlists.findIndex((playlist) => playlist.playlistId === playlistId)
  if (existingIndex >= 0) {
    playlists[existingIndex] = { ...playlists[existingIndex]!, specialType, liveSyncSupported }
    return
  }
  playlists.push({
    playlistId, title, description: '', thumbnailUrl: null,
    privacyStatus: 'private', remoteItemCount: 0, specialType, liveSyncSupported,
  })
}
