-- YT-018: immutable, profiled and localized YouTube summary runs.

CREATE TABLE summary_profiles (
  id               TEXT PRIMARY KEY,
  built_in_key     TEXT UNIQUE CHECK (built_in_key IN ('quick', 'standard', 'detailed')),
  name             TEXT NOT NULL,
  description      TEXT NOT NULL,
  instructions     TEXT NOT NULL,
  options_json     TEXT NOT NULL,
  default_language TEXT NOT NULL DEFAULT 'en' CHECK (default_language IN ('en', 'nl', 'en_nl')),
  revision         INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO summary_profiles
  (id, built_in_key, name, description, instructions, options_json, default_language)
VALUES
  ('builtin-quick', 'quick', 'Quick', 'A fast briefing for deciding whether to watch.',
   'Be concise. Surface the central idea, the strongest takeaways, and whether the full video is worth watching.',
   '{"target_min_words":150,"target_max_words":250,"max_sections":3,"max_claims":5,"sections":["tldr","key_takeaways","worth_watching"]}', 'en'),
  ('builtin-standard', 'standard', 'Standard', 'A practical summary with examples, actions, and limitations.',
   'Explain the main argument clearly. Include important examples, practical actions, and meaningful limitations.',
   '{"target_min_words":500,"target_max_words":900,"max_sections":6,"max_claims":10,"sections":["overview","key_points","examples","actions","limitations","worth_watching"]}', 'en'),
  ('builtin-detailed', 'detailed', 'Detailed', 'A thorough report with a chapter-style walkthrough.',
   'Produce a thorough analysis without padding. Preserve nuance, arguments, examples, actions, limitations, and open questions.',
   '{"target_min_words":1200,"target_max_words":2500,"max_sections":9,"max_claims":20,"sections":["executive_summary","chapter_walkthrough","arguments","examples","actions","limitations","open_questions","worth_watching"]}', 'en');

CREATE TABLE video_summary_runs (
  id                     TEXT PRIMARY KEY,
  video_id               TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  status                 TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  profile_id             TEXT REFERENCES summary_profiles(id) ON DELETE SET NULL,
  profile_snapshot_json  TEXT NOT NULL,
  prompt_revision        INTEGER NOT NULL,
  focus_instruction      TEXT,
  output_language        TEXT NOT NULL CHECK (output_language IN ('en', 'nl', 'en_nl')),
  transcript_fingerprint TEXT NOT NULL,
  model                  TEXT NOT NULL,
  research_status        TEXT NOT NULL DEFAULT 'disabled' CHECK (research_status IN ('disabled', 'pending', 'ready', 'partial', 'failed')),
  evidence_json          TEXT,
  outputs_json           TEXT,
  requested_at           TEXT NOT NULL,
  generated_at           TEXT,
  updated_at             TEXT NOT NULL,
  error_message          TEXT
);

CREATE TABLE video_preferred_summary_runs (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  run_id   TEXT NOT NULL UNIQUE REFERENCES video_summary_runs(id) ON DELETE CASCADE
);

-- Preserve the original cached summaries as English Quick runs. Their IDs are
-- deterministic so the upgrade is repeatable in migration rehearsals.
INSERT INTO video_summary_runs
  (id, video_id, status, profile_id, profile_snapshot_json, prompt_revision,
   focus_instruction, output_language, transcript_fingerprint, model,
   research_status, evidence_json, outputs_json, requested_at, generated_at,
   updated_at, error_message)
SELECT 'legacy-' || video_id, video_id, status, 'builtin-quick',
       '{"id":"builtin-quick","built_in_key":"quick","name":"Quick","description":"Migrated Insight Card","instructions":"Legacy Insight Card","options":{"target_min_words":150,"target_max_words":250,"max_sections":3,"max_claims":5,"sections":["tldr","key_takeaways","worth_watching"]},"revision":1}',
       prompt_version, NULL, 'en', 'legacy-unavailable', model, 'disabled',
       CASE WHEN status = 'ready' THEN json_object(
         'sections', json_array(
           json_object('id','tldr','claim_ids',json_array('legacy-tldr')),
           json_object('id','key_takeaways','claim_ids',json_array()),
           json_object('id','worth_watching','claim_ids',json_array('legacy-worth'))
         ), 'actions', COALESCE(json(action_items_json), json('[]')),
         'mentioned', COALESCE(json(mentioned_json), json('[]'))
       ) ELSE NULL END,
       CASE WHEN status = 'ready' THEN json_object('en', json_object(
         'tldr', COALESCE(tldr, ''),
         'key_points', COALESCE(json(key_points_json), json('[]')),
         'worth_watching', COALESCE(worth_watching, ''),
         'action_items', COALESCE(json(action_items_json), json('[]')),
         'mentioned', COALESCE(json(mentioned_json), json('[]')),
         'sections', json_array()
       )) ELSE NULL END,
       requested_at, generated_at, updated_at, error_message
  FROM video_summaries;

INSERT INTO video_preferred_summary_runs (video_id, run_id)
SELECT video_id, 'legacy-' || video_id FROM video_summaries;

CREATE INDEX idx_video_summary_runs_video_requested
  ON video_summary_runs(video_id, requested_at DESC);
CREATE INDEX idx_video_summary_runs_status
  ON video_summary_runs(status, requested_at);
CREATE INDEX idx_summary_profiles_builtin
  ON summary_profiles(built_in_key);

CREATE TRIGGER prevent_ready_summary_run_mutation
BEFORE UPDATE ON video_summary_runs
WHEN OLD.status = 'ready' AND (
  NEW.status != OLD.status OR NEW.profile_snapshot_json != OLD.profile_snapshot_json OR
  NEW.prompt_revision != OLD.prompt_revision OR
  COALESCE(NEW.focus_instruction, '') != COALESCE(OLD.focus_instruction, '') OR
  NEW.output_language != OLD.output_language OR
  NEW.transcript_fingerprint != OLD.transcript_fingerprint OR NEW.model != OLD.model OR
  COALESCE(NEW.evidence_json, '') != COALESCE(OLD.evidence_json, '') OR
  COALESCE(NEW.outputs_json, '') != COALESCE(OLD.outputs_json, '') OR
  COALESCE(NEW.generated_at, '') != COALESCE(OLD.generated_at, '')
)
BEGIN
  SELECT RAISE(ABORT, 'ready summary runs are immutable');
END;
