-- YT-008: canonical YouTube channels and provenance.
--
-- Rebuild the subscription/video side of the schema so a canonical video can
-- outlive (or exist without) a subscription. All dashboard-side video ids are
-- copied verbatim; dependent enrichment tables are rebuilt only to retarget
-- their foreign keys after SQLite renames the old videos table.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE youtube_channels (
  channel_id     TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  thumbnail_url  TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO youtube_channels (channel_id, title, thumbnail_url, created_at, updated_at)
SELECT channel_id, channel_title, channel_thumbnail_url, created_at, updated_at
  FROM subscriptions;

ALTER TABLE subscriptions RENAME TO subscriptions_legacy_014;

CREATE TABLE subscriptions (
  id                     TEXT PRIMARY KEY,
  google_account_id      TEXT NOT NULL,
  channel_id             TEXT NOT NULL UNIQUE,
  channel_title          TEXT NOT NULL,
  channel_thumbnail_url  TEXT,
  subscribed_at          TEXT NOT NULL,
  is_included            INTEGER NOT NULL DEFAULT 1,
  is_important           INTEGER NOT NULL DEFAULT 0,
  last_polled_at         TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  auto_fetch_transcripts INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (google_account_id) REFERENCES youtube_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES youtube_channels(channel_id) ON DELETE RESTRICT
);

INSERT INTO subscriptions
  (id, google_account_id, channel_id, channel_title,
   channel_thumbnail_url, subscribed_at, is_included, is_important,
   last_polled_at, created_at, updated_at, auto_fetch_transcripts)
SELECT id, google_account_id, channel_id, channel_title,
       channel_thumbnail_url, subscribed_at, is_included, is_important,
       last_polled_at, created_at, updated_at, auto_fetch_transcripts
  FROM subscriptions_legacy_014;

ALTER TABLE videos RENAME TO videos_legacy_014;
ALTER TABLE video_tags RENAME TO video_tags_legacy_014;
ALTER TABLE video_transcript_segments RENAME TO video_transcript_segments_legacy_014;
ALTER TABLE video_summaries RENAME TO video_summaries_legacy_014;
ALTER TABLE video_transcripts RENAME TO video_transcripts_legacy_014;

CREATE TABLE videos (
  id                   TEXT PRIMARY KEY,
  video_id             TEXT NOT NULL UNIQUE,
  channel_id           TEXT NOT NULL REFERENCES youtube_channels(channel_id) ON DELETE RESTRICT,
  title                TEXT NOT NULL,
  local_title_override TEXT,
  published_at         TEXT NOT NULL,
  thumbnail_url        TEXT,
  link                 TEXT NOT NULL,
  discovered_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  folder_id            TEXT REFERENCES folders(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Existing titles may have been edited locally. Migration 010 had no way to
-- distinguish them from remote titles, so preserve every legacy title as an
-- explicit override. New videos start without an override.
INSERT INTO videos
  (id, video_id, channel_id, title, local_title_override, published_at,
   thumbnail_url, link, discovered_at, folder_id, created_at, updated_at)
SELECT id, video_id, channel_id, title, title, published_at,
       thumbnail_url, link, discovered_at, folder_id, created_at, updated_at
  FROM videos_legacy_014;

CREATE TABLE video_tags (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, tag_id)
);
INSERT INTO video_tags SELECT video_id, tag_id FROM video_tags_legacy_014;

CREATE TABLE video_transcripts (
  video_id      TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'unavailable', 'failed')),
  language      TEXT,
  requested_at  TEXT NOT NULL,
  fetched_at    TEXT,
  error_message TEXT,
  updated_at    TEXT NOT NULL
);
INSERT INTO video_transcripts
SELECT video_id, status, language, requested_at, fetched_at, error_message, updated_at
  FROM video_transcripts_legacy_014;

CREATE TABLE video_transcript_segments (
  video_id    TEXT NOT NULL REFERENCES video_transcripts(video_id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  start_ms    INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  text        TEXT NOT NULL,
  PRIMARY KEY (video_id, position)
);
INSERT INTO video_transcript_segments
SELECT video_id, position, start_ms, duration_ms, text
  FROM video_transcript_segments_legacy_014;

CREATE TABLE video_summaries (
  video_id          TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  tldr              TEXT,
  key_points_json   TEXT,
  worth_watching    TEXT,
  action_items_json TEXT,
  mentioned_json    TEXT,
  model             TEXT NOT NULL,
  prompt_version    INTEGER NOT NULL,
  requested_at      TEXT NOT NULL,
  generated_at      TEXT,
  error_message     TEXT,
  updated_at        TEXT NOT NULL
);
INSERT INTO video_summaries
SELECT video_id, status, tldr, key_points_json, worth_watching,
       action_items_json, mentioned_json, model, prompt_version,
       requested_at, generated_at, error_message, updated_at
  FROM video_summaries_legacy_014;

CREATE TABLE video_origins (
  video_id      TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  origin_type   TEXT NOT NULL CHECK (origin_type IN ('subscription_rss', 'subscription_backfill', 'manual')),
  source_id     TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (video_id, origin_type, source_id)
);

INSERT INTO video_origins (video_id, origin_type, source_id, first_seen_at)
SELECT v.id, 'subscription_rss', s.id, v.discovered_at
  FROM videos v
  JOIN subscriptions s ON s.channel_id = v.channel_id;

DROP TABLE video_transcript_segments_legacy_014;
DROP TABLE video_summaries_legacy_014;
DROP TABLE video_tags_legacy_014;
DROP TABLE video_transcripts_legacy_014;
DROP TABLE videos_legacy_014;
DROP TABLE subscriptions_legacy_014;

CREATE INDEX idx_subscriptions_google_account_id ON subscriptions(google_account_id);
CREATE INDEX idx_subscriptions_included ON subscriptions(channel_id) WHERE is_included = 1;
CREATE INDEX idx_videos_channel_id_published_at ON videos(channel_id, published_at DESC);
CREATE INDEX idx_videos_discovered_at ON videos(discovered_at DESC);
CREATE INDEX idx_videos_folder_id ON videos(folder_id);
CREATE INDEX idx_video_tags_tag_id ON video_tags(tag_id);
CREATE INDEX idx_video_transcripts_status ON video_transcripts(status, updated_at);
CREATE INDEX idx_video_summaries_status ON video_summaries(status, updated_at);
CREATE INDEX idx_video_origins_type ON video_origins(origin_type, first_seen_at DESC);
