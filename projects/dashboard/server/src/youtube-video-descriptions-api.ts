import { Hono } from 'hono'
import type { AuthVariables } from './auth.js'
import type { Database } from './db.js'
import {
  getVideoDescription,
  type VideoDescription,
  type YouTubeVideoDescriptionService,
} from './youtube-video-descriptions.js'
import { getVideoDescriptionResources } from './youtube-description-resources.js'

export function youtubeVideoDescriptionsApi(deps: {
  readonly db: Database
  readonly service: YouTubeVideoDescriptionService
}): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  api.get('/:id/description', (c) => {
    const videoId = c.req.param('id')
    const exists = deps.db.get<{ id: string }>('SELECT id FROM videos WHERE id = ?', [videoId])
    if (!exists) return c.json({ ok: false, error: 'not_found' }, 404)
    const description = getVideoDescription(deps.db, videoId)
    return c.json({
      ok: true,
      description: description ? toApiDescription(description) : null,
    })
  })

  api.post('/:id/description/refresh', (c) => {
    const description = deps.service.request(c.req.param('id'))
    if (!description) return c.json({ ok: false, error: 'not_found' }, 404)
    return c.json({ ok: true, description: toApiDescription(description) }, 202)
  })

  api.get('/:id/resources', (c) => {
    const videoId = c.req.param('id')
    const exists = deps.db.get<{ id: string }>('SELECT id FROM videos WHERE id = ?', [videoId])
    if (!exists) return c.json({ ok: false, error: 'not_found' }, 404)
    const resources = getVideoDescriptionResources(deps.db, videoId)
      .map((resource) => ({
        id: resource.id,
        original_url: resource.originalUrl,
        canonical_url: resource.canonicalUrl,
        domain: resource.domain,
        label: resource.label,
        context_before: resource.contextBefore,
        context_after: resource.contextAfter,
        source_positions: resource.sourcePositions,
        first_position: resource.firstPosition,
        category: resource.effectiveCategory,
        visibility: resource.effectiveVisibility,
        confidence: resource.confidence,
        classification_source: resource.effectiveSource,
        classification_reason: resource.effectiveReason,
        updated_at: resource.updatedAt,
      }))
    return c.json({
      ok: true,
      resources,
      counts: {
        total: resources.length,
        featured: resources.filter((resource) => resource.visibility === 'featured').length,
        normal: resources.filter((resource) => resource.visibility === 'normal').length,
        hidden: resources.filter((resource) => resource.visibility === 'hidden').length,
      },
      groups: {
        featured: resources.filter((resource) => resource.visibility === 'featured'),
        normal: resources.filter((resource) => resource.visibility === 'normal'),
        hidden: resources.filter((resource) => resource.visibility === 'hidden'),
      },
    })
  })

  return api
}

function toApiDescription(description: VideoDescription): Record<string, unknown> {
  return {
    status: description.status,
    description: description.description,
    fingerprint: description.fingerprint,
    unavailable_reason: description.unavailableReason,
    truncated: description.truncated,
    requested_at: description.requestedAt,
    fetched_at: description.fetchedAt,
    last_attempted_at: description.lastAttemptedAt,
    attempt_count: description.attemptCount,
    next_retry_at: description.nextRetryAt,
    error_code: description.errorCode,
    error_message: description.errorMessage,
    updated_at: description.updatedAt,
  }
}
