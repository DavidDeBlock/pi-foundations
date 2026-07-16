-- Persisted, on-demand AI summaries generated from locally stored transcripts.
-- Structured fields remain JSON so the Insight Card can evolve without a table
-- per section; status/model/prompt metadata stay queryable for operations.

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

CREATE INDEX idx_video_summaries_status
  ON video_summaries(status, updated_at);
