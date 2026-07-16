import { Hono } from 'hono'
import type { AuthVariables } from './auth.js'
import type { Database } from './db.js'
import {
  getVideoTranscript,
  type VideoTranscript,
  type YouTubeTranscriptService,
} from './youtube-transcripts.js'

export function youtubeTranscriptsApi(deps: {
  readonly db: Database
  readonly service: YouTubeTranscriptService
}): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  api.get('/:id/transcript', (c) => {
    const videoId = c.req.param('id')
    const exists = deps.db.get<{ id: string }>('SELECT id FROM videos WHERE id = ?', [videoId])
    if (!exists) return c.json({ ok: false, error: 'not_found' }, 404)
    const transcript = getVideoTranscript(deps.db, videoId)
    return c.json({ ok: true, transcript: transcript ? toApiTranscript(transcript) : null })
  })

  api.post('/:id/transcript', (c) => {
    const transcript = deps.service.request(c.req.param('id'))
    if (!transcript) return c.json({ ok: false, error: 'not_found' }, 404)
    return c.json(
      { ok: true, transcript: toApiTranscript(transcript) },
      transcript.status === 'ready' ? 200 : 202,
    )
  })

  return api
}

function toApiTranscript(transcript: VideoTranscript): Record<string, unknown> {
  return {
    status: transcript.status,
    language: transcript.language,
    requested_at: transcript.requestedAt,
    fetched_at: transcript.fetchedAt,
    error_message: transcript.errorMessage,
    segments: transcript.segments.map((segment) => ({
      start_ms: segment.startMs,
      duration_ms: segment.durationMs,
      text: segment.text,
    })),
  }
}
