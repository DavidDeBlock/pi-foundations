-- 006_email_tags.sql — issue #025
--
-- Dashboard-only tags. Tags are user-created labels that live
-- entirely in the dashboard's SQLite — they never propagate to
-- Gmail, never come from Gmail, and the sync worker doesn't even
-- know this table exists. They survive re-syncs by design: the
-- sync UPSERT (issue #021) writes to `emails`, never to
-- `email_tags`, so an email's tags are untouched when Gmail is
-- re-fetched.
--
-- Schema decisions (matches PRD-002 v1 + PRD-002 v4 schema):
--
--   * `email_tags` is a separate join table, not a column on
--     `emails`. This keeps tag CRUD a small, focused module
--     (`email-tags.ts`) and avoids dynamic-column-set JSON.
--   * Composite PK (email_id, tag) gives free idempotent inserts
--     (re-adding the same tag is a no-op via INSERT OR IGNORE)
--     and free lookups (no separate unique index).
--   * `tag` is stored as the NORMALIZED form: trimmed,
--     lowercased. Normalization happens at the application layer
--     (`normalizeTag` in email-tags.ts); a CHECK constraint is not
--     used because we'd rather emit a clean error from the
--     helper than have SQLite reject bad input mid-statement.
--   * FK on email_id with ON DELETE CASCADE: if an email is
--     removed from the mirror (Gmail-side deletion, disconnect
--     cascade), its tags die with it. Matches the bookmarks /
--     hidden_at invariants elsewhere in the schema.
--   * Secondary index on `tag` supports the autocomplete query
--     `GROUP BY tag` and the "show me everything tagged #X"
--     filter (issue #025 AC: inbox tag filter).

CREATE TABLE email_tags (
  email_id  TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (email_id, tag)
);

CREATE INDEX idx_email_tags_tag ON email_tags(tag);