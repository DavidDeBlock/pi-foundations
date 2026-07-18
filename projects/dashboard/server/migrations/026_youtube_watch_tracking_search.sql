-- Embedded-player watch tracking and quota-conscious YouTube search cache.

PRAGMA defer_foreign_keys = ON;

ALTER TABLE youtube_watch_events RENAME TO youtube_watch_events_legacy_026;

CREATE TABLE youtube_watch_events (
  id                     TEXT PRIMARY KEY,
  video_id               TEXT REFERENCES videos(id) ON DELETE SET NULL,
  youtube_video_id       TEXT,
  watched_at             TEXT NOT NULL,
  title_snapshot         TEXT NOT NULL,
  channel_id_snapshot    TEXT,
  channel_title_snapshot TEXT,
  event_fingerprint      TEXT NOT NULL UNIQUE,
  history_import_id      TEXT REFERENCES youtube_history_imports(id) ON DELETE RESTRICT,
  source                 TEXT NOT NULL DEFAULT 'takeout'
                         CHECK (source IN ('takeout', 'search', 'playlist', 'subscription', 'embedded_player')),
  created_at             TEXT NOT NULL
);

INSERT INTO youtube_watch_events
  (id, video_id, youtube_video_id, watched_at, title_snapshot,
   channel_id_snapshot, channel_title_snapshot, event_fingerprint,
   history_import_id, source, created_at)
SELECT id, video_id, youtube_video_id, watched_at, title_snapshot,
       channel_id_snapshot, channel_title_snapshot, event_fingerprint,
       history_import_id, 'takeout', created_at
  FROM youtube_watch_events_legacy_026;

DROP TABLE youtube_watch_events_legacy_026;

CREATE INDEX idx_youtube_watch_events_watched
  ON youtube_watch_events(watched_at DESC, id);
CREATE INDEX idx_youtube_watch_events_video
  ON youtube_watch_events(video_id, watched_at DESC);
CREATE INDEX idx_youtube_watch_events_source
  ON youtube_watch_events(source, watched_at DESC);

CREATE TABLE youtube_playback_state (
  video_id                 TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  first_started_at         TEXT NOT NULL,
  last_watched_at          TEXT NOT NULL,
  position_seconds         REAL NOT NULL DEFAULT 0 CHECK (position_seconds >= 0),
  duration_seconds         REAL NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  play_count               INTEGER NOT NULL DEFAULT 0 CHECK (play_count >= 0),
  completed                INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  completion_threshold     REAL NOT NULL DEFAULT 0.9 CHECK (completion_threshold > 0 AND completion_threshold <= 1),
  last_source              TEXT NOT NULL CHECK (last_source IN ('search', 'playlist', 'subscription', 'embedded_player')),
  updated_at               TEXT NOT NULL
);

CREATE INDEX idx_youtube_playback_continue
  ON youtube_playback_state(completed, last_watched_at DESC);

CREATE TABLE youtube_playback_sessions (
  id              TEXT PRIMARY KEY,
  video_id        TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  source          TEXT NOT NULL CHECK (source IN ('search', 'playlist', 'subscription', 'embedded_player')),
  started_at      TEXT NOT NULL,
  last_saved_at   TEXT NOT NULL,
  ended_at        TEXT
);

CREATE INDEX idx_youtube_playback_sessions_video
  ON youtube_playback_sessions(video_id, started_at DESC);

CREATE TABLE youtube_search_cache (
  query_key       TEXT PRIMARY KEY,
  response_json   TEXT NOT NULL,
  fetched_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);

CREATE INDEX idx_youtube_search_cache_expiry ON youtube_search_cache(expires_at);
