import { Hono } from 'hono'
import type { AuthVariables } from './auth.js'
import type { Database } from './db.js'
import {
  getVideoSummary,
  type VideoSummary,
  type YouTubeVideoSummaryService,
} from './youtube-video-summaries.js'

export function youtubeVideoSummariesApi(deps: {
  readonly db: Database
  readonly service?: YouTubeVideoSummaryService
}): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  api.get('/:id/summary', (c) => {
    const videoId = c.req.param('id')
    const exists = deps.db.get<{ id: string }>('SELECT id FROM videos WHERE id = ?', [videoId])
    if (!exists) return c.json({ ok: false, error: 'not_found' }, 404)
    const summary = getVideoSummary(deps.db, videoId)
    return c.json({ ok: true, configured: deps.service !== undefined, summary: summary ? toApiSummary(summary) : null })
  })

  api.post('/:id/summary', async (c) => {
    if (!deps.service) {
      return c.json({ ok: false, error: 'llm_not_configured' }, 503)
    }
    let force = false
    try {
      const body = await c.req.json<{ force?: unknown }>()
      force = body.force === true
    } catch {
      // Empty body is the common request shape.
    }
    const result = deps.service.request(c.req.param('id'), { force })
    if (result.kind === 'not_found') return c.json({ ok: false, error: 'not_found' }, 404)
    if (result.kind === 'transcript_required') {
      return c.json({ ok: false, error: 'transcript_required' }, 409)
    }
    return c.json(
      { ok: true, summary: toApiSummary(result.summary) },
      result.summary.status === 'ready' ? 200 : 202,
    )
  })

  return api
}

function toApiSummary(summary: VideoSummary): Record<string, unknown> {
  return {
    status: summary.status,
    tldr: summary.tldr,
    key_points: summary.keyPoints.map(toApiInsight),
    worth_watching: summary.worthWatching,
    action_items: summary.actionItems.map(toApiInsight),
    mentioned: summary.mentioned,
    model: summary.model,
    prompt_version: summary.promptVersion,
    requested_at: summary.requestedAt,
    generated_at: summary.generatedAt,
    error_message: summary.errorMessage,
  }
}

function toApiInsight(insight: { readonly text: string; readonly startMs: number | null }): Record<string, unknown> {
  return { text: insight.text, start_ms: insight.startMs }
}
