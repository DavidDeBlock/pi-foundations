import { randomUUID } from 'node:crypto'
import type { Database } from './db.js'

export type VideoOriginType =
  | 'subscription_rss'
  | 'subscription_backfill'
  | 'manual'

export interface YouTubeVideoUpsertInput {
  readonly videoId: string
  readonly channelId: string
  readonly channelTitle?: string
  readonly channelThumbnailUrl?: string | null
  readonly title: string
  readonly publishedAt: string
  readonly thumbnailUrl: string | null
  readonly link: string
  readonly origin: {
    readonly type: VideoOriginType
    readonly sourceId?: string
  }
}

export interface YouTubeVideoUpsertResult {
  readonly outcome: 'inserted' | 'existing'
  readonly id: string
}

/**
 * Canonical write path for every YouTube video discovery source.
 *
 * Channel metadata, remote video metadata, and provenance are committed as one
 * unit. Remote refreshes update YouTube-owned fields while an explicit local
 * title override remains untouched.
 */
export function upsertYouTubeVideo(
  db: Database,
  input: YouTubeVideoUpsertInput,
  nowMs: () => number = () => Date.now(),
): YouTubeVideoUpsertResult {
  return db.transaction(() => {
    const now = new Date(nowMs()).toISOString()
    const knownChannel = db.get<{ title: string; thumbnail_url: string | null }>(
      'SELECT title, thumbnail_url FROM youtube_channels WHERE channel_id = ?',
      [input.channelId],
    )
    const channelTitle = input.channelTitle ?? knownChannel?.title ?? input.channelId
    const channelThumbnail = input.channelThumbnailUrl === undefined
      ? (knownChannel?.thumbnail_url ?? null)
      : input.channelThumbnailUrl

    db.run(
      `INSERT INTO youtube_channels
         (channel_id, title, thumbnail_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET
         title = excluded.title,
         thumbnail_url = excluded.thumbnail_url,
         updated_at = excluded.updated_at`,
      [input.channelId, channelTitle, channelThumbnail, now, now],
    )

    const existing = db.get<{ id: string }>(
      'SELECT id FROM videos WHERE video_id = ?',
      [input.videoId],
    )
    let id: string
    let outcome: YouTubeVideoUpsertResult['outcome']
    if (existing) {
      id = existing.id
      outcome = 'existing'
      db.run(
        `UPDATE videos
            SET channel_id = ?, title = ?, published_at = ?,
                thumbnail_url = ?, link = ?, updated_at = ?
          WHERE id = ?`,
        [
          input.channelId,
          input.title,
          input.publishedAt,
          input.thumbnailUrl,
          input.link,
          now,
          id,
        ],
      )
    } else {
      id = randomUUID()
      outcome = 'inserted'
      db.run(
        `INSERT INTO videos
           (id, video_id, channel_id, title, local_title_override,
            published_at, thumbnail_url, link, discovered_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.videoId,
          input.channelId,
          input.title,
          input.publishedAt,
          input.thumbnailUrl,
          input.link,
          now,
          now,
          now,
        ],
      )
    }

    db.run(
      `INSERT OR IGNORE INTO video_origins
         (video_id, origin_type, source_id, first_seen_at)
       VALUES (?, ?, ?, ?)`,
      [id, input.origin.type, input.origin.sourceId ?? '', now],
    )
    return { outcome, id }
  })
}
