// youtube-video-tags-api.ts — issue YT-005
//
// Tag sub-resource HTTP routes for `/api/videos/:id/tags/*`.
//
//   POST   /api/videos/:id/tags        — attach a tag by name (creates if new)
//   DELETE /api/videos/:id/tags/:tagId — remove the (video, tag) link
//
// Reuses `tags.ts` storage helpers' normalization contract by
// routing through `attachTagByNameToVideo` from `youtube-videos.ts`
// (which calls the project-wide `normalize()`). The result is
// a canonical-form tag (`"postgresql-server"`, not
// `"PostgreSQL Server"`).
//
// Splitting this into its own factory mirrors how YT-005's
// AC describe the resource: `/api/videos/:id/tags` is a
// sub-resource, not a different entity. Keeps `videosApi`'s DI
// surface to just `{ db }`.

import { Hono } from 'hono'
import type { AuthVariables } from './auth.js'
import type { Database } from './db.js'
import {
  attachTagByNameToVideo,
  detachTagFromVideo,
  getVideoDetail,
  listTagsForVideo,
} from './youtube-videos.js'

// ─── Body parsing ────────────────────────────────────────────────────────

interface AddBody {
  readonly name?: unknown
}

function isAddBody(raw: unknown): raw is AddBody {
  return typeof raw === 'object' && raw !== null
}

function validateAddBody(body: AddBody): string | null {
  if (Object.keys(body).length === 0) return 'must provide a `name` field'
  if (body.name === undefined) return 'must provide a `name` field'
  if (typeof body.name !== 'string') return '`name` must be a string'
  if (body.name.trim() === '') return '`name` must be a non-empty string'
  if (body.name.length > 200) return '`name` must be ≤ 200 characters'
  return null
}

// ─── Factory ─────────────────────────────────────────────────────────────

export interface YouTubeVideoTagsApiDeps {
  readonly db: Database
}

export function youtubeVideoTagsApi(
  deps: YouTubeVideoTagsApiDeps,
): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  // ─── POST /api/videos/:id/tags ───────────────────────────────────
  api.post('/:id/tags', async (c) => {
    const id = c.req.param('id')
    if (!id) return c.json({ error: 'missing id' }, 400)

    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }
    if (!isAddBody(raw)) return c.json({ error: 'body must be a JSON object' }, 400)

    const err = validateAddBody(raw)
    if (err !== null) return c.json({ error: err }, 400)

    // Confirm the video exists. Distinguishing "video missing"
    // from "tag name normalized to empty" matters here — both
    // would otherwise return 200 with null/empty response body.
    const exists = getVideoDetail(deps.db, id)
    if (exists === null) return c.json({ error: 'not found' }, 404)

    // The model's `attachTagByNameToVideo` returns `null` when the
    // raw name normalizes to empty (e.g. user typed only spaces).
    // We've already trimmed in `validateAddBody`, so we always
    // expect a tag here.
    const tag = attachTagByNameToVideo(deps.db, id, raw.name as string)
    if (tag === null) return c.json({ error: 'tag name normalized to empty' }, 400)

    const effectiveTag = listTagsForVideo(deps.db, id).find((item) => item.id === tag.id)
    return c.json(effectiveTag ?? { ...tag, source: 'manual', sources: ['manual'] }, 201)
  })

  // ─── DELETE /api/videos/:id/tags/:tagId ──────────────────────────
  api.delete('/:id/tags/:tagId', (c) => {
    const id = c.req.param('id')
    const tagId = c.req.param('tagId')
    if (!id || !tagId) return c.json({ error: 'missing path param' }, 400)

    // Distinguish "video not found" (404) from "link didn't exist"
    // (204 — the desired end state is met either way, no-op is fine).
    const exists = getVideoDetail(deps.db, id)
    if (exists === null) return c.json({ error: 'not found' }, 404)

    detachTagFromVideo(deps.db, id, tagId)
    // Always 204; idempotent.
    return c.body(null, 204)
  })

  return api
}
