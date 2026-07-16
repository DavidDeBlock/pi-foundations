// youtube-video-ingest.ts — issue YT-004
//
// Deep module: takes feed entries from one channel and writes
// them to the `videos` table, idempotently. The poller calls
// `ingest(db, channelId, entries)` once per channel after the
// fetcher returns.
//
// Why this is split from the poller:
//   * Idempotency-by-video-id is the same algorithm no matter who
//     calls it (manual API, scheduled poller, future mirror from
//     Takeout, etc.). Keeping it isolated means the AC's test
//     "re-poll is no-op" is a model assertion, not a poller-runs-
//     an-integration-test assertion.
//   * The actual DB writes (`INSERT OR IGNORE`) live here so the
//     poller stays focused on concurrency + per-channel lifecycle.
//   * All DB transactions are owned by the ingest module; the
//     poller never sees `db.transaction(...)`.
//
// Output is a small count object the poller can fold into its
// own per-channel result.

import type { Database } from './db.js'
import { insertVideo } from './youtube-videos.js'
import type { FeedEntry } from './youtube-rss-fetcher.js'

/** Outcome of ingesting one channel's batch. */
export interface IngestResult {
  /** Number of new rows inserted. */
  readonly added: number
  /** Number of incoming entries that already existed (skipped). */
  readonly skipped: number
  /** Total entries the caller passed in. */
  readonly total: number
  /** Dashboard ids for newly inserted rows. Used to queue optional
   *  follow-up work such as transcript extraction. */
  readonly insertedVideoIds: readonly string[]
}

/**
 * Insert `entries` for `channelId` into `videos`, skipping rows
 * that already exist (UNIQUE constraint on `video_id`).
 *
 *   * `added` counts the rows we just wrote.
 *   * `skipped` counts rows the UNIQUE constraint rejected
 *     (already in the DB).
 *   * `total === entries.length` so the caller can sanity-check
 *     `added + skipped === total`.
 *
 * One transaction wraps the whole batch — partial success would
 * leave the per-channel dedupe in a half-state, which would
 * silently cause double-inserts in some SQLite versions.
 *
 * `nowMs` is passed straight through to `insertVideo` so the
 * `discovered_at` / `created_at` timestamps are deterministic in
 * tests.
 */
export function ingestVideos(
  db: Database,
  channelId: string,
  entries: ReadonlyArray<FeedEntry>,
  nowMs?: () => number,
): IngestResult {
  if (entries.length === 0) {
    return { added: 0, skipped: 0, total: 0, insertedVideoIds: [] }
  }

  let added = 0
  let skipped = 0
  const insertedVideoIds: string[] = []
  db.transaction(() => {
    for (const entry of entries) {
      const { outcome, id } = insertVideo(
        db,
        {
          videoId: entry.videoId,
          channelId,
          title: entry.title,
          publishedAt: entry.publishedAt,
          thumbnailUrl: entry.thumbnailUrl,
          link: entry.link,
        },
        nowMs,
      )
      if (outcome === 'inserted') {
        added++
        insertedVideoIds.push(id)
      }
      else skipped++
    }
  })
  return { added, skipped, total: entries.length, insertedVideoIds }
}
