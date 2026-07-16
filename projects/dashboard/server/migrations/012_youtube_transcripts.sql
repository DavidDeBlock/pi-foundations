-- Per-subscription transcript preference plus persisted transcript results.
-- Transcript extraction uses YouTube's public caption data and is therefore
-- best-effort: unavailable and failed are normal, retryable states.

ALTER TABLE subscriptions
  ADD COLUMN auto_fetch_transcripts INTEGER NOT NULL DEFAULT 0;

CREATE TABLE video_transcripts (
  video_id       TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'unavailable', 'failed')),
  language       TEXT,
  requested_at   TEXT NOT NULL,
  fetched_at     TEXT,
  error_message  TEXT,
  updated_at     TEXT NOT NULL
);

CREATE TABLE video_transcript_segments (
  video_id       TEXT NOT NULL REFERENCES video_transcripts(video_id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  start_ms       INTEGER NOT NULL,
  duration_ms    INTEGER NOT NULL,
  text           TEXT NOT NULL,
  PRIMARY KEY (video_id, position)
);

CREATE INDEX idx_video_transcripts_status
  ON video_transcripts(status, updated_at);
