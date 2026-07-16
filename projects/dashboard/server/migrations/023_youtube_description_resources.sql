-- YT-023: deterministic resources derived from stored video descriptions.

CREATE TABLE video_description_resources (
  id                           TEXT PRIMARY KEY,
  video_id                     TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  original_url                 TEXT NOT NULL,
  canonical_url                TEXT NOT NULL,
  domain                       TEXT NOT NULL,
  label                        TEXT,
  context_before               TEXT NOT NULL DEFAULT '',
  context_after                TEXT NOT NULL DEFAULT '',
  source_positions_json        TEXT NOT NULL DEFAULT '[]',
  first_position               INTEGER NOT NULL CHECK (first_position >= 0),
  automatic_category           TEXT NOT NULL CHECK (automatic_category IN
    ('repository', 'documentation', 'tool', 'article', 'dataset', 'community',
     'creator', 'social', 'promotional', 'other')),
  automatic_visibility         TEXT NOT NULL CHECK (automatic_visibility IN
    ('featured', 'normal', 'hidden')),
  automatic_confidence         REAL CHECK (automatic_confidence IS NULL OR
    (automatic_confidence >= 0 AND automatic_confidence <= 1)),
  automatic_source             TEXT NOT NULL DEFAULT 'deterministic',
  automatic_reason             TEXT NOT NULL,
  effective_category           TEXT NOT NULL CHECK (effective_category IN
    ('repository', 'documentation', 'tool', 'article', 'dataset', 'community',
     'creator', 'social', 'promotional', 'other')),
  effective_visibility         TEXT NOT NULL CHECK (effective_visibility IN
    ('featured', 'normal', 'hidden')),
  effective_source             TEXT NOT NULL DEFAULT 'deterministic',
  effective_reason             TEXT NOT NULL,
  is_present                   INTEGER NOT NULL DEFAULT 1 CHECK (is_present IN (0, 1)),
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL,
  UNIQUE (video_id, canonical_url)
);

CREATE INDEX idx_video_description_resources_read
  ON video_description_resources(video_id, is_present, effective_visibility, first_position);

