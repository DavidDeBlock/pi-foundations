// youtube-videos-api.ts — issue YT-005
//
// HTTP boundary for `/api/videos/*` (excluding the tag sub-
// resource which lives in `youtube-video-tags-api.ts`).
//
// Routes:
//   GET  /api/videos         — paginated list with channel/folder/tag filters
//   GET  /api/videos/:id     — single video detail
//   PATCH /api/videos/:id    — partial update of folder_id / title
//
// All three share the same auth middleware (mounted by app.ts
// via the `auth()` module). The Hono pattern (one factory per
// mount path with separate dep surfaces) matches YT-001..YT-004.

import { Hono } from 'hono'
import type { AuthVariables } from './auth.js'
import type { Database } from './db.js'
import {
  getVideoDetail,
  renameVideoTitle,
  searchVideos,
  updateVideoFolder,
  type VideoDetail,
  type EffectiveVideoTag,
  type VideoListItem,
} from './youtube-videos.js'
import { parseVideoDiscoveryQuery } from './youtube-video-search-query.js'

// ─── Public API shape (issue YT-005 AC) ──────────────────────────────────

interface ApiVideoItem {
  readonly id: string
  readonly video_id: string
  readonly channel_id: string
  readonly channel_title: string
  readonly channel_thumbnail_url: string | null
  readonly title: string
  readonly published_at: string
  readonly thumbnail_url: string | null
  readonly link: string
  readonly discovered_at: string
  readonly folder_id: string | null
  readonly folder_name: string | null
  readonly tags: ReadonlyArray<EffectiveVideoTag>
  readonly playlists: ReadonlyArray<{ readonly id: string; readonly title: string }>
  readonly watched: boolean
  readonly watch_count: number
  readonly last_watched_at: string | null
}

interface ApiVideoDetail extends ApiVideoItem {
  readonly channel_is_included: boolean
  readonly channel_is_subscribed: boolean
}

function toApiItem(item: VideoListItem): ApiVideoItem {
  return {
    id: item.id,
    video_id: item.videoId,
    channel_id: item.channelId,
    channel_title: item.channelTitle,
    channel_thumbnail_url: item.channelThumbnailUrl,
    title: item.title,
    published_at: item.publishedAt,
    thumbnail_url: item.thumbnailUrl,
    link: item.link,
    discovered_at: item.discoveredAt,
    folder_id: item.folderId,
    folder_name: item.folderName,
    tags: item.tags,
    playlists: item.playlists,
    watched: item.watchCount > 0,
    watch_count: item.watchCount,
    last_watched_at: item.lastWatchedAt,
  }
}

function toApiDetail(detail: VideoDetail): ApiVideoDetail {
  return {
    ...toApiItem(detail),
    channel_is_included: detail.channelIsIncluded,
    channel_is_subscribed: detail.channelIsSubscribed,
  }
}

// ─── Parsing helpers (mirror subscriptions list API) ─────────────────────

/** Folder id filter values. The model layer understands `folderId`
 *  vs `unfoldered` boolean. The HTTP layer translates raw query
 *  strings to typed inputs. */
type FolderFilter =
  | { readonly kind: 'any' }
  | { readonly kind: 'folder'; readonly id: string }
  | { readonly kind: 'unfoldered' }

function parseFolderFilter(raw: string | undefined): FolderFilter {
  if (raw === undefined || raw === '' || raw === 'all') return { kind: 'any' }
  if (raw === 'none' || raw === 'null' || raw === '0') return { kind: 'unfoldered' }
  return { kind: 'folder', id: raw }
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n)) return null
  return n
}

// ─── Body parsing ────────────────────────────────────────────────────────

interface PatchBody {
  readonly folder_id?: unknown
  readonly title?: unknown
}

function isPatchBody(raw: unknown): raw is PatchBody {
  return typeof raw === 'object' && raw !== null
}

/** Validate PATCH body shape. Returns `null` if the body is
 *  structurally OK (empty {} counts as OK — caught downstream
 *  by the "no fields" check); returns a string error for each
 *  diagnostic case. Empty body is `mustProvideAtLeastOneField`
 *  because a no-op PATCH is almost always a client bug. */
function validatePatchBody(body: PatchBody): string | null {
  if (Object.keys(body).length === 0) return 'must provide at least one of: folder_id, title'
  const { folder_id, title } = body
  let fieldsSpecified = 0
  if (folder_id !== undefined) {
    if (folder_id !== null && typeof folder_id !== 'string') {
      return 'folder_id must be a string or null'
    }
    fieldsSpecified++
  }
  if (title !== undefined) {
    if (typeof title !== 'string' || title.trim() === '') {
      return 'title must be a non-empty string'
    }
    if (title.length > 500) return 'title must be ≤ 500 characters'
    fieldsSpecified++
  }
  if (fieldsSpecified === 0) return 'must provide at least one of: folder_id, title'
  return null
}

// ─── Hono factory ────────────────────────────────────────────────────────

export interface YouTubeVideosApiDeps {
  readonly db: Database
}

/**
 * Mounted at `/api/videos`.  See module header for routes.
 *
 * Why split tag sub-routes into their own factory (`youtube-video-
 * tags-api.ts`): the tag endpoints use `attachTagByNameToVideo` +
 * `detachTagFromVideo`, and grouping them together keeps the dep
 * surface of `videosApi` minimal (just the DB) while the tag
 * factory gets the same DB (no other deps). One factory per
 * sub-resource keeps the test surfaces aligned to the URL space.
 */
export function youtubeVideosApi(
  deps: YouTubeVideosApiDeps,
): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  // ─── GET /api/videos ──────────────────────────────────────────────
  api.get('/', (c) => {
    const channelId = c.req.query('channel_id') || undefined
    const folder = parseFolderFilter(c.req.query('folder_id'))
    const tagId = c.req.query('tag_id') || undefined
    const sourceRaw = c.req.query('source')
    if (sourceRaw && sourceRaw !== 'playlist' && sourceRaw !== 'history') {
      return c.json({ error: 'source must be playlist or history' }, 400)
    }
    const source = sourceRaw as 'playlist' | 'history' | undefined
    const playlistId = c.req.query('playlist_id') || undefined
    const watchedRaw = c.req.query('watched')
    const unwatchedRaw = c.req.query('unwatched')
    if ((watchedRaw !== undefined && watchedRaw !== 'true') || (unwatchedRaw !== undefined && unwatchedRaw !== 'true')) {
      return c.json({ error: 'watched and unwatched must be true when provided' }, 400)
    }
    if (watchedRaw === 'true' && unwatchedRaw === 'true') {
      return c.json({ error: 'watched and unwatched filters are contradictory' }, 400)
    }
    const discovery = parseVideoDiscoveryQuery({
      sort: c.req.query('sort'),
      order: c.req.query('order'),
      publishedFrom: c.req.query('published_from'),
      publishedTo: c.req.query('published_to'),
    })
    if (!discovery.ok) return c.json({ error: discovery.error }, 400)
    const page = parsePositiveInt(c.req.query('page')) ?? 1
    const limitRaw = parsePositiveInt(c.req.query('limit')) ?? 50

    const options =
      folder.kind === 'any'
        ? {
            ...(channelId !== undefined ? { channelId } : {}),
            ...(tagId !== undefined ? { tagId } : {}),
            ...(source !== undefined ? { source } : {}),
            ...(playlistId !== undefined ? { playlistId } : {}),
            ...(watchedRaw === 'true' ? { watched: true } : {}),
            ...(unwatchedRaw === 'true' ? { unwatched: true } : {}),
            ...discovery.value,
            page,
            limit: limitRaw,
          }
        : folder.kind === 'folder'
          ? {
              ...(channelId !== undefined ? { channelId } : {}),
              folderId: folder.id,
              ...(tagId !== undefined ? { tagId } : {}),
              ...(source !== undefined ? { source } : {}),
              ...(playlistId !== undefined ? { playlistId } : {}),
              ...(watchedRaw === 'true' ? { watched: true } : {}),
              ...(unwatchedRaw === 'true' ? { unwatched: true } : {}),
              ...discovery.value,
              page,
              limit: limitRaw,
            }
          : {
              ...(channelId !== undefined ? { channelId } : {}),
              unfoldered: true,
              ...(tagId !== undefined ? { tagId } : {}),
              ...(source !== undefined ? { source } : {}),
              ...(playlistId !== undefined ? { playlistId } : {}),
              ...(watchedRaw === 'true' ? { watched: true } : {}),
              ...(unwatchedRaw === 'true' ? { unwatched: true } : {}),
              ...discovery.value,
              page,
              limit: limitRaw,
            }

    const r = searchVideos(deps.db, options)
    return c.json({
      items: r.items.map(toApiItem),
      total: r.total,
      page: r.page,
      limit: r.limit,
    })
  })

  // ─── GET /api/videos/:id ──────────────────────────────────────────
  api.get('/:id', (c) => {
    const id = c.req.param('id')
    if (!id) return c.json({ error: 'missing id' }, 400)
    const detail = getVideoDetail(deps.db, id)
    if (detail === null) return c.json({ error: 'not found' }, 404)
    return c.json(toApiDetail(detail))
  })

  // ─── PATCH /api/videos/:id ────────────────────────────────────────
  api.patch('/:id', async (c) => {
    const id = c.req.param('id')
    if (!id) return c.json({ error: 'missing id' }, 400)

    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }
    if (!isPatchBody(raw)) return c.json({ error: 'body must be a JSON object' }, 400)

    const err = validatePatchBody(raw)
    if (err !== null) return c.json({ error: err }, 400)

    // Confirm the id exists before any update — first attempt
    // would otherwise silently return 404-or-false with no clear
    // 404 (since updateVideoFolder returns `false` instead of
    // throwing). Match the subscriptions PATCH semantics.
    const exists = getVideoDetail(deps.db, id)
    if (exists === null) return c.json({ error: 'not found' }, 404)

    if (raw.folder_id !== undefined) {
      // string or null — `updateVideoFolder` handles both
      // (null = unfolder).
      const ok = updateVideoFolder(deps.db, id, raw.folder_id as string | null)
      if (!ok) return c.json({ error: 'not found' }, 404)
    }
    if (raw.title !== undefined) {
      const ok = renameVideoTitle(deps.db, id, (raw.title as string).trim())
      if (!ok) return c.json({ error: 'not found' }, 404)
    }

    const detail = getVideoDetail(deps.db, id)
    return c.json(toApiDetail(detail!))
  })

  return api
}
