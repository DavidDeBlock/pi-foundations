-- YT-022: canonical, restart-safe YouTube video description metadata.

CREATE TABLE video_descriptions (
  video_id           TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  description        TEXT,
  fingerprint        TEXT,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'stale', 'unavailable', 'failed')),
  unavailable_reason TEXT CHECK (unavailable_reason IS NULL OR unavailable_reason IN ('not_found', 'no_description')),
  is_truncated       INTEGER NOT NULL DEFAULT 0 CHECK (is_truncated IN (0, 1)),
  requested_at       TEXT NOT NULL,
  fetched_at         TEXT,
  last_attempted_at  TEXT,
  attempt_count      INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 10),
  next_retry_at      TEXT,
  error_code         TEXT,
  error_message      TEXT,
  updated_at         TEXT NOT NULL,
  CHECK (
    (description IS NULL AND fingerprint IS NULL) OR
    (description IS NOT NULL AND fingerprint IS NOT NULL)
  )
);

CREATE INDEX idx_video_descriptions_queue
  ON video_descriptions(status, next_retry_at, requested_at)
  WHERE status = 'pending';
