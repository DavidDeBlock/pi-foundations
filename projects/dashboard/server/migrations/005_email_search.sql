-- 005_email_search.sql — issue #022
--
-- Adds search infrastructure for the `emails` table plus the
-- `hidden_at` soft-delete column. Decisions locked here (matches
-- PRD-002 schema + v4 module map):
--
--   * `hidden_at` is added NOW (not in #024) so the read endpoints
--     built in this slice can already filter `WHERE hidden_at IS NULL`.
--     The column is NULL by default (visible). Slice #024 wires up
--     the hide/unhide endpoints that WRITE to this column — this
--     slice doesn't. The sync worker's UPSERT (issue #021) already
--     excludes `hidden_at` from its column list, so any value written
--     here survives a re-sync.
--
--   * `email_fts` is a contentless FTS5 virtual table over the four
--     searchable fields: subject, body_plain, sender, sender_email.
--     Sender is split into the rendered "Name <addr>" shape AND the
--     bare email so "from:sarah" searches match either form.
--
--   * Triggers mirror the bookmark_fts pattern (001_initial.sql):
--     AFTER INSERT/UPDATE/DELETE on emails maintain the FTS row set
--     automatically. The sync worker's UPSERT fires the UPDATE
--     trigger, so the index stays in sync with the mirror without
--     any application-layer work.
--
--   * `email_trigrams` is a regular table (not a virtual table)
--     because better-sqlite3 doesn't bundle the SQLite trigram
--     extension. Same pattern as `bookmark_trigrams` (002_search
--     _trigram.sql). The application layer (`EmailSearcher`) writes
--     rows on first access; future slices can backfill existing rows
--     lazily on read.

-- ─── hidden_at (soft-delete) ──────────────────────────────────────────────
-- Soft-delete column. NULL = visible; non-NULL = hidden.
-- The read endpoints (issue #022) filter on this; the hide/unhide
-- endpoints (issue #024) write to it. Index supports the filter.

ALTER TABLE emails ADD COLUMN hidden_at TEXT;

CREATE INDEX idx_emails_hidden_at ON emails(hidden_at);

-- ─── email_fts (FTS5) ────────────────────────────────────────────────────
-- Contentless FTS5 over the searchable fields. Mirrors the
-- bookmark_fts pattern in 001_initial.sql.

CREATE VIRTUAL TABLE email_fts USING fts5(
  subject,
  body_plain,
  sender,
  sender_email,
  content='emails',
  content_rowid='rowid'
);

-- Triggers keep email_fts in sync with the emails table. The sync
-- worker's UPSERT fires `emails_au`, so a re-sync re-indexes every
-- changed row. A DELETE (e.g. disconnect cascade) fires `emails_ad`.

CREATE TRIGGER emails_ai AFTER INSERT ON emails BEGIN
  INSERT INTO email_fts(rowid, subject, body_plain, sender, sender_email)
    VALUES (new.rowid, new.subject, new.body_plain, new.sender, new.sender_email);
END;

CREATE TRIGGER emails_ad AFTER DELETE ON emails BEGIN
  INSERT INTO email_fts(email_fts, rowid, subject, body_plain, sender, sender_email)
    VALUES ('delete', old.rowid, old.subject, old.body_plain, old.sender, old.sender_email);
END;

CREATE TRIGGER emails_au AFTER UPDATE ON emails BEGIN
  INSERT INTO email_fts(email_fts, rowid, subject, body_plain, sender, sender_email)
    VALUES ('delete', old.rowid, old.subject, old.body_plain, old.sender, old.sender_email);
  INSERT INTO email_fts(rowid, subject, body_plain, sender, sender_email)
    VALUES (new.rowid, new.subject, new.body_plain, new.sender, new.sender_email);
END;

-- ─── email_trigrams (fuzzy fallback) ─────────────────────────────────────
-- Per-(email, trigram) row set. The PK gives leftmost-prefix lookup
-- on email_id; the secondary index supports the
--   `SELECT DISTINCT email_id FROM email_trigrams WHERE trigram IN (...)`
-- pre-filter the fuzzy search uses. Same pattern as bookmark_trigrams.

CREATE TABLE email_trigrams (
  email_id  TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  trigram   TEXT NOT NULL,
  PRIMARY KEY (email_id, trigram)
);

CREATE INDEX idx_email_trigrams_trigram ON email_trigrams(trigram);