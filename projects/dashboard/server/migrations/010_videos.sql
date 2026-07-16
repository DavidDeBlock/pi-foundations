-- 010_videos.sql — issue YT-004
--
-- Two tables that close the loop on the YouTube ingestion pipeline:
--   * `videos` — one row per discovered YouTube video, populated by
--     the RSS poller every 15 min (YT-004).
--   * `video_tags` — many-to-many, mirroring `bookmark_tags`. The
--     UI slice (YT-005) and the categorize actions live here.
--
-- Schema decisions locked here (matches PRD-003 + YT-004 AC):
--
--   * Identity: `video_id` is the YouTube video ID (11-char string
--     like `dQw4w9WgXcQ`), UNIQUE. Dashboard-side `id` (UUID) is
--     the JOIN/FK target for local tables (folders, video_tags).
--     Insert idempotency is on `video_id` — re-polling the same
--     channel produces zero duplicates. `INSERT OR IGNORE` in the
--     poller relies on this constraint.
--
--   * FK `videos.channel_id → subscriptions.channel_id` with
--     `ON DELETE RESTRICT`. The poller explicitly wants RESTRICT
--     (per AC): deleting a subscription should not silently drop
--     the videos the operator may have curated. Implication: the
--     disconnect flow (YT-001 / handle DELETE on /api/youtube/connection)
--     must clear videos for the account first, BEFORE deleting the
--     subscriptions (which auto-cascade from youtube_accounts).
--     This is a small footgun that surfaces only at disconnect
--     time; a future ADR may relax the FK to CASCADE if the
--     operator finds the disconnect flow surprising.
--
--   * `published_at` is YouTube's `<published>` element — when the
--     video went live on YouTube. ISO 8601, UTC.
--
--   * `discovered_at` is when the dashboard first saw the entry —
--     distinct from `published_at` because it lets the operator
--     distinguish "old video, just discovered" from "new today".
--     Reverse-chronological sorting in the Videos view keys off
--     this column (per PRD-003).
--
--   * `folder_id` is nullable — uncategorized is the default. The
--     Videos detail page (YT-005) lets the operator pick a folder.
--     FK is to `folders(id)` and CASCADEs on folder deletion: if
--     the operator deletes a folder, videos that lived in it are
--     unfoldered (folder_id NULL) rather than deleted entirely.
--
--   * `title` is local-mutable: YT-005 lets the operator rename a
--     video inline (e.g. to fix typos). Poller UPSERTs the title
--     on every re-poll, so renames get overwritten by the next
--     poll unless the poller skips the column for known rows. v3.0
--     accepts the overwrite — a future issue can change this to a
--     "title_locked" flag if the operator wants it.
--
--   * Indexes:
--       * `idx_videos_channel_id_published_at` — composite, used by
--         the poller's "newest entries we know about" query and the
--         Videos view's "filter by channel" query.
--       * `idx_videos_discovered_at` — the Videos view's primary
--         sort (`ORDER BY discovered_at DESC`).
--       * `idx_videos_folder_id` — Videos filter by folder.
--       * `idx_video_tags_tag_id` — mirrors the bookmark_tags index.

CREATE TABLE videos (
  id              TEXT PRIMARY KEY,
  video_id        TEXT NOT NULL UNIQUE,
  channel_id      TEXT NOT NULL REFERENCES subscriptions(channel_id) ON DELETE RESTRICT,
  title           TEXT NOT NULL,
  published_at    TEXT NOT NULL,
  thumbnail_url   TEXT,
  link            TEXT NOT NULL,
  discovered_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  folder_id       TEXT REFERENCES folders(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_videos_channel_id_published_at
  ON videos(channel_id, published_at DESC);

CREATE INDEX idx_videos_discovered_at
  ON videos(discovered_at DESC);

CREATE INDEX idx_videos_folder_id
  ON videos(folder_id);

CREATE TABLE video_tags (
  video_id  TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  tag_id    TEXT NOT NULL REFERENCES tags(id)   ON DELETE CASCADE,
  PRIMARY KEY (video_id, tag_id)
);

CREATE INDEX idx_video_tags_tag_id ON video_tags(tag_id);