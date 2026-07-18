import { randomUUID } from 'node:crypto'
import type { Database } from './db.js'

export type PlaybackSource = 'search' | 'playlist' | 'subscription' | 'embedded_player'
export type PlaybackEvent = 'playing' | 'progress' | 'paused' | 'ended' | 'closed'

export interface PlaybackState {
  readonly videoId: string
  readonly firstStartedAt: string
  readonly lastWatchedAt: string
  readonly positionSeconds: number
  readonly durationSeconds: number
  readonly playCount: number
  readonly completed: boolean
  readonly completionThreshold: number
  readonly lastSource: PlaybackSource
}

interface PlaybackRow {
  video_id: string
  first_started_at: string
  last_watched_at: string
  position_seconds: number
  duration_seconds: number
  play_count: number
  completed: number
  completion_threshold: number
  last_source: PlaybackSource
}

export function getPlaybackState(db: Database, videoId: string): PlaybackState | null {
  const row = db.get<PlaybackRow>('SELECT * FROM youtube_playback_state WHERE video_id = ?', [videoId])
  return row ? mapState(row) : null
}

export function savePlayback(
  db: Database,
  input: {
    readonly videoId: string
    readonly sessionId: string
    readonly event: PlaybackEvent
    readonly positionSeconds: number
    readonly durationSeconds: number
    readonly source: PlaybackSource
  },
  now: () => Date = () => new Date(),
): PlaybackState {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.sessionId)) throw new RangeError('Invalid playback session id.')
  if (!Number.isFinite(input.positionSeconds) || input.positionSeconds < 0) throw new RangeError('Invalid playback position.')
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds < 0 || input.durationSeconds > 86_400) throw new RangeError('Invalid video duration.')
  const video = db.get<{ video_id: string; title: string; channel_id: string; channel_title: string }>(
    `SELECT v.video_id, COALESCE(v.local_title_override, v.title) AS title,
            v.channel_id, yc.title AS channel_title
       FROM videos v JOIN youtube_channels yc ON yc.channel_id = v.channel_id
      WHERE v.id = ?`, [input.videoId],
  )
  if (!video) throw new PlaybackVideoNotFoundError()

  return db.transaction(() => {
    const timestamp = now().toISOString()
    const boundedPosition = input.durationSeconds > 0
      ? Math.min(input.positionSeconds, input.durationSeconds)
      : input.positionSeconds
    const existing = getPlaybackState(db, input.videoId)
    const threshold = existing?.completionThreshold ?? 0.9
    const completed = input.event === 'ended'
      || (input.durationSeconds > 0 && boundedPosition / input.durationSeconds >= threshold)
    const newSession = input.event === 'playing' && db.run(
      `INSERT OR IGNORE INTO youtube_playback_sessions
         (id, video_id, source, started_at, last_saved_at)
       VALUES (?, ?, ?, ?, ?)`,
      [input.sessionId, input.videoId, input.source, timestamp, timestamp],
    ).changes > 0
    if (!newSession) {
      db.run(
        `UPDATE youtube_playback_sessions SET last_saved_at = ?, ended_at = CASE WHEN ? IN ('ended','closed') THEN ? ELSE ended_at END
          WHERE id = ? AND video_id = ?`,
        [timestamp, input.event, timestamp, input.sessionId, input.videoId],
      )
    }
    db.run(
      `INSERT INTO youtube_playback_state
         (video_id, first_started_at, last_watched_at, position_seconds, duration_seconds,
          play_count, completed, completion_threshold, last_source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(video_id) DO UPDATE SET
         last_watched_at = excluded.last_watched_at,
         position_seconds = excluded.position_seconds,
         duration_seconds = CASE WHEN excluded.duration_seconds > 0 THEN excluded.duration_seconds ELSE youtube_playback_state.duration_seconds END,
         play_count = youtube_playback_state.play_count + ?,
         completed = MAX(youtube_playback_state.completed, excluded.completed),
         last_source = excluded.last_source,
         updated_at = excluded.updated_at`,
      [input.videoId, timestamp, timestamp, boundedPosition, input.durationSeconds,
        newSession ? 1 : 0, completed ? 1 : 0, threshold, input.source, timestamp,
        newSession ? 1 : 0],
    )
    if (newSession) {
      db.run(
        `INSERT OR IGNORE INTO youtube_watch_events
           (id, video_id, youtube_video_id, watched_at, title_snapshot, channel_id_snapshot,
            channel_title_snapshot, event_fingerprint, history_import_id, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [randomUUID(), input.videoId, video.video_id, timestamp, video.title, video.channel_id,
          video.channel_title, `embedded:${input.sessionId}`, input.source, timestamp],
      )
    }
    return getPlaybackState(db, input.videoId)!
  })
}

export class PlaybackVideoNotFoundError extends Error {}

function mapState(row: PlaybackRow): PlaybackState {
  return {
    videoId: row.video_id,
    firstStartedAt: row.first_started_at,
    lastWatchedAt: row.last_watched_at,
    positionSeconds: row.position_seconds,
    durationSeconds: row.duration_seconds,
    playCount: row.play_count,
    completed: row.completed === 1,
    completionThreshold: row.completion_threshold,
    lastSource: row.last_source,
  }
}
