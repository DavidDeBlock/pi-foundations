-- Google Takeout HTML support and durable duration-based Shorts filtering.

ALTER TABLE youtube_history_imports ADD COLUMN source_format TEXT NOT NULL DEFAULT 'json'
  CHECK (source_format IN ('json', 'html'));
ALTER TABLE youtube_history_imports ADD COLUMN shorts_excluded_event_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE youtube_history_imports ADD COLUMN shorts_excluded_video_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE youtube_history_imports ADD COLUMN unavailable_video_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE youtube_history_video_classifications (
  history_import_id TEXT NOT NULL REFERENCES youtube_history_imports(id) ON DELETE CASCADE,
  youtube_video_id  TEXT NOT NULL,
  classification   TEXT NOT NULL CHECK (classification IN ('long', 'short', 'unavailable')),
  duration_seconds REAL,
  PRIMARY KEY (history_import_id, youtube_video_id)
);

CREATE INDEX idx_youtube_history_video_classification
  ON youtube_history_video_classifications(history_import_id, classification);
