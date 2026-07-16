-- YT-012: private Google Takeout watch-history staging and event log.

CREATE TABLE youtube_history_imports (
  id                    TEXT PRIMARY KEY,
  file_hash             TEXT NOT NULL,
  original_filename     TEXT NOT NULL,
  staged_filename       TEXT NOT NULL UNIQUE,
  status                TEXT NOT NULL CHECK (status IN ('previewed', 'committed', 'expired', 'failed')),
  total_count           INTEGER NOT NULL,
  new_event_count       INTEGER NOT NULL,
  duplicate_count       INTEGER NOT NULL,
  malformed_count       INTEGER NOT NULL,
  unique_video_count    INTEGER NOT NULL,
  new_video_count       INTEGER NOT NULL,
  committed_event_count INTEGER,
  oldest_watched_at     TEXT,
  newest_watched_at     TEXT,
  created_at            TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  committed_at          TEXT
);

CREATE TABLE youtube_watch_events (
  id                     TEXT PRIMARY KEY,
  video_id               TEXT REFERENCES videos(id) ON DELETE SET NULL,
  youtube_video_id       TEXT,
  watched_at             TEXT NOT NULL,
  title_snapshot         TEXT NOT NULL,
  channel_id_snapshot    TEXT,
  channel_title_snapshot TEXT,
  event_fingerprint      TEXT NOT NULL UNIQUE,
  history_import_id      TEXT NOT NULL REFERENCES youtube_history_imports(id) ON DELETE RESTRICT,
  created_at             TEXT NOT NULL
);

CREATE INDEX idx_youtube_history_imports_created
  ON youtube_history_imports(created_at DESC);
CREATE INDEX idx_youtube_history_imports_expiry
  ON youtube_history_imports(status, expires_at);
CREATE INDEX idx_youtube_watch_events_watched
  ON youtube_watch_events(watched_at DESC, id);
CREATE INDEX idx_youtube_watch_events_video
  ON youtube_watch_events(video_id, watched_at DESC);
