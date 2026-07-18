import { Hono } from 'hono'
import type { Database } from './db.js'
import { getPlaybackState, PlaybackVideoNotFoundError, savePlayback, type PlaybackEvent, type PlaybackSource } from './youtube-playback.js'

const EVENTS = new Set<PlaybackEvent>(['playing', 'progress', 'paused', 'ended', 'closed'])
const SOURCES = new Set<PlaybackSource>(['search', 'playlist', 'subscription', 'embedded_player'])

export function youtubePlaybackApi(deps: { readonly db: Database }): Hono {
  const app = new Hono()
  app.get('/:id/playback', (c) => {
    const video = deps.db.get('SELECT 1 FROM videos WHERE id = ?', [c.req.param('id')])
    if (!video) return c.json({ error: 'Video not found.' }, 404)
    return c.json({ playback: serialize(getPlaybackState(deps.db, c.req.param('id'))) })
  })
  app.put('/:id/playback', async (c) => {
    let body: Record<string, unknown>
    try { body = await c.req.json<Record<string, unknown>>() } catch { return c.json({ error: 'Request body must be JSON.' }, 400) }
    if (typeof body.session_id !== 'string' || typeof body.event !== 'string' || !EVENTS.has(body.event as PlaybackEvent)
      || typeof body.source !== 'string' || !SOURCES.has(body.source as PlaybackSource)
      || typeof body.position_seconds !== 'number' || typeof body.duration_seconds !== 'number') {
      return c.json({ error: 'Invalid playback update.' }, 400)
    }
    try {
      const state = savePlayback(deps.db, {
        videoId: c.req.param('id'), sessionId: body.session_id, event: body.event as PlaybackEvent,
        source: body.source as PlaybackSource, positionSeconds: body.position_seconds, durationSeconds: body.duration_seconds,
      })
      return c.json({ playback: serialize(state) })
    } catch (error) {
      if (error instanceof PlaybackVideoNotFoundError) return c.json({ error: 'Video not found.' }, 404)
      if (error instanceof RangeError) return c.json({ error: error.message }, 400)
      throw error
    }
  })
  return app
}

function serialize(state: ReturnType<typeof getPlaybackState>): object | null {
  return state && {
    video_id: state.videoId, first_started_at: state.firstStartedAt, last_watched_at: state.lastWatchedAt,
    position_seconds: state.positionSeconds, duration_seconds: state.durationSeconds, play_count: state.playCount,
    completed: state.completed, completion_threshold: state.completionThreshold, source: state.lastSource,
  }
}
