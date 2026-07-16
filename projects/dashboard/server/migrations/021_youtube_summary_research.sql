ALTER TABLE video_summary_runs ADD COLUMN research_country TEXT;
ALTER TABLE video_summary_runs ADD COLUMN research_language TEXT;
ALTER TABLE video_summary_runs ADD COLUMN research_query_limit INTEGER;
ALTER TABLE video_summary_runs ADD COLUMN research_error_message TEXT;

-- Complete the original built-in defaults without overwriting profiles the
-- operator has already revised in Prompt Studio.
UPDATE summary_profiles SET options_json = json_set(options_json, '$.default_research',
  CASE built_in_key WHEN 'detailed' THEN json('true') ELSE json('false') END)
WHERE built_in_key IS NOT NULL AND revision = 1;
UPDATE summary_profile_revisions SET options_json = json_set(options_json, '$.default_research',
  CASE (SELECT built_in_key FROM summary_profiles WHERE id = profile_id)
    WHEN 'detailed' THEN json('true') ELSE json('false') END)
WHERE revision = 1 AND profile_id IN (SELECT id FROM summary_profiles WHERE built_in_key IS NOT NULL AND revision = 1);

CREATE TABLE video_summary_sources (
  id TEXT PRIMARY KEY,
  summary_run_id TEXT NOT NULL REFERENCES video_summary_runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 1),
  query TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  snippet TEXT NOT NULL,
  published_at TEXT,
  retrieved_at TEXT NOT NULL,
  UNIQUE(summary_run_id, position),
  UNIQUE(summary_run_id, url)
);

CREATE INDEX idx_video_summary_sources_run
  ON video_summary_sources(summary_run_id, position);

DROP TRIGGER prevent_ready_summary_run_mutation;
CREATE TRIGGER prevent_ready_summary_run_mutation
BEFORE UPDATE ON video_summary_runs
WHEN OLD.status = 'ready' AND (
  NEW.status != OLD.status OR NEW.profile_snapshot_json != OLD.profile_snapshot_json OR
  NEW.prompt_revision != OLD.prompt_revision OR COALESCE(NEW.focus_instruction, '') != COALESCE(OLD.focus_instruction, '') OR
  NEW.output_language != OLD.output_language OR NEW.transcript_fingerprint != OLD.transcript_fingerprint OR
  NEW.model != OLD.model OR NEW.research_status != OLD.research_status OR
  COALESCE(NEW.research_country, '') != COALESCE(OLD.research_country, '') OR
  COALESCE(NEW.research_language, '') != COALESCE(OLD.research_language, '') OR
  COALESCE(NEW.research_query_limit, -1) != COALESCE(OLD.research_query_limit, -1) OR
  COALESCE(NEW.research_error_message, '') != COALESCE(OLD.research_error_message, '') OR
  COALESCE(NEW.evidence_json, '') != COALESCE(OLD.evidence_json, '') OR
  COALESCE(NEW.outputs_json, '') != COALESCE(OLD.outputs_json, '') OR
  COALESCE(NEW.generated_at, '') != COALESCE(OLD.generated_at, '')
)
BEGIN
  SELECT RAISE(ABORT, 'ready summary runs are immutable');
END;

CREATE TRIGGER prevent_ready_summary_source_insert BEFORE INSERT ON video_summary_sources
WHEN (SELECT status FROM video_summary_runs WHERE id = NEW.summary_run_id) = 'ready'
BEGIN SELECT RAISE(ABORT, 'ready summary sources are immutable'); END;
CREATE TRIGGER prevent_ready_summary_source_update BEFORE UPDATE ON video_summary_sources
WHEN (SELECT status FROM video_summary_runs WHERE id = OLD.summary_run_id) = 'ready'
BEGIN SELECT RAISE(ABORT, 'ready summary sources are immutable'); END;
