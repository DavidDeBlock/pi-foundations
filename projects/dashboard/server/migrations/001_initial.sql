-- 001_initial.sql — Dashboard v1 schema
--
-- Creates every v1 table per PRD-001:
--   folders, bookmarks, tags, bookmark_tags, api_tokens
--   bookmark_fts (FTS5 virtual table for full-text search)
--
-- NOT created here:
--   bookmark_trgm (trigram virtual table for fuzzy search)
--     → deferred to issue #009. Trigram requires the SQLite trigram
--       loadable extension, which better-sqlite3 doesn't bundle. #009
--       will load the extension at runtime and create the table.
--
-- Conventions:
--   * All ids are TEXT (UUIDs from `randomUUID()`); no ROWID aliasing.
--   * All timestamps are ISO 8601 strings from SQLite's `strftime`.
--   * Foreign keys cascade on delete so removing a folder cleans up
--     its descendants + their bookmarks + their tag links in one go.

-- ─── folders ────────────────────────────────────────────────────────────────
-- Self-referential tree mirroring Chrome's folder structure.
-- `parent_id` NULL = root-level folder.

CREATE TABLE folders (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  chrome_id   TEXT UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_folders_parent_id ON folders(parent_id);

-- ─── bookmarks ─────────────────────────────────────────────────────────────
-- One row per Chrome bookmark. `folder_id` is required (Chrome enforces
-- single-parent). `chrome_id` is the source-of-truth id from Chrome.

CREATE TABLE bookmarks (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  title         TEXT NOT NULL,
  folder_id     TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  chrome_id     TEXT UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at  TEXT
);

CREATE INDEX idx_bookmarks_folder_id   ON bookmarks(folder_id);
CREATE INDEX idx_bookmarks_chrome_id   ON bookmarks(chrome_id);
CREATE INDEX idx_bookmarks_created_at  ON bookmarks(created_at DESC);

-- ─── tags ──────────────────────────────────────────────────────────────────
-- One row per unique tag name. Names are normalized by `TagNormalizer`
-- (lands in #008) before insertion. UNIQUE constraint enforces dedupe.

CREATE TABLE tags (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ─── bookmark_tags ─────────────────────────────────────────────────────────
-- Many-to-many. Composite PK prevents duplicate (bookmark, tag) pairs.

CREATE TABLE bookmark_tags (
  bookmark_id  TEXT NOT NULL REFERENCES bookmarks(id)  ON DELETE CASCADE,
  tag_id       TEXT NOT NULL REFERENCES tags(id)       ON DELETE CASCADE,
  PRIMARY KEY (bookmark_id, tag_id)
);

CREATE INDEX idx_bookmark_tags_tag_id ON bookmark_tags(tag_id);

-- ─── api_tokens ────────────────────────────────────────────────────────────
-- Schema created now per PRD-001, but the runtime store is still the JSON
-- file from #002. SqlTokenStore migration lands in #004+ — when it does,
-- the table gets populated and `JsonTokenStore` is removed.

CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL,    -- bcrypt (verifyHash)
  lookup_hash  TEXT NOT NULL UNIQUE, -- SHA-256 (deterministic lookup key)
  label        TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT
);

CREATE INDEX idx_api_tokens_lookup_hash ON api_tokens(lookup_hash);

-- ─── bookmark_fts (FTS5) ────────────────────────────────────────────────────
-- External-content FTS5 over bookmarks(title, url). Triggers keep it in
-- sync with the bookmarks table. Search lands in #009.

CREATE VIRTUAL TABLE bookmark_fts USING fts5(
  title,
  url,
  content='bookmarks',
  content_rowid='rowid'
);

CREATE TRIGGER bookmarks_ai AFTER INSERT ON bookmarks BEGIN
  INSERT INTO bookmark_fts(rowid, title, url)
    VALUES (new.rowid, new.title, new.url);
END;

CREATE TRIGGER bookmarks_ad AFTER DELETE ON bookmarks BEGIN
  INSERT INTO bookmark_fts(bookmark_fts, rowid, title, url)
    VALUES ('delete', old.rowid, old.title, old.url);
END;

CREATE TRIGGER bookmarks_au AFTER UPDATE ON bookmarks BEGIN
  INSERT INTO bookmark_fts(bookmark_fts, rowid, title, url)
    VALUES ('delete', old.rowid, old.title, old.url);
  INSERT INTO bookmark_fts(rowid, title, url)
    VALUES (new.rowid, new.title, new.url);
END;
