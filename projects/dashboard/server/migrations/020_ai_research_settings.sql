-- YT-019: non-secret AI defaults, append-only profile revisions, and test runs.

CREATE TABLE ai_research_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_profile_id TEXT NOT NULL REFERENCES summary_profiles(id),
  default_language TEXT NOT NULL CHECK (default_language IN ('en', 'nl', 'en_nl')),
  search_country TEXT NOT NULL,
  search_language TEXT NOT NULL,
  max_search_queries INTEGER NOT NULL CHECK (max_search_queries BETWEEN 1 AND 10),
  max_input_chars INTEGER NOT NULL CHECK (max_input_chars BETWEEN 10000 AND 500000),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens BETWEEN 500 AND 16000),
  updated_at TEXT NOT NULL
);

INSERT INTO ai_research_settings VALUES
  (1, 'builtin-standard', 'en', 'US', 'en', 3, 120000, 12000,
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE summary_profile_revisions (
  profile_id TEXT NOT NULL REFERENCES summary_profiles(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  options_json TEXT NOT NULL,
  default_language TEXT NOT NULL CHECK (default_language IN ('en', 'nl', 'en_nl')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, revision)
);

INSERT INTO summary_profile_revisions
  (profile_id, revision, name, description, instructions, options_json, default_language, created_at)
SELECT id, revision, name, description, instructions, options_json, default_language, updated_at
FROM summary_profiles;

ALTER TABLE video_summary_runs
  ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1));

CREATE INDEX idx_summary_profile_revisions_profile
  ON summary_profile_revisions(profile_id, revision DESC);
