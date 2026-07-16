-- 009_subscriptions.sql — issue YT-002
--
-- One row per YouTube channel David is subscribed to (per Google
-- account). Sourced from the Data API `subscriptions.list` endpoint
-- and refreshed daily by the SubscriptionsSync orchestrator.
--
-- Schema decisions locked here (matches PRD-003 + YT-002 AC):
--
--   * `google_account_id` FK to `youtube_accounts(id)` with
--     ON DELETE CASCADE: disconnecting YouTube drops all of David's
--     subscriptions in one statement. No orphan rows.
--
--   * UNIQUE(channel_id) — PRD-003 schema says channel_id is the
--     identity column. David has one Google account, so global
--     uniqueness is equivalent to per-account uniqueness today. If
--     a second Google account is ever added (v3.x?), the unique
--     constraint will need to widen to (google_account_id, channel_id)
--     via a migration — left as future work.
--
--   * `is_included` defaults to 1 — every imported subscription is
--     "included" by default. The /subscriptions UI lets the user
--     toggle this off for music channels they want to keep
--     subscribed on YouTube but hide from the dashboard view.
--     Reserved for the RSS poller (YT-004) which queries "where
--     is_included = 1".
--
--   * `is_important` defaults to 0 — reserved for a future LLM
--     summarization job (v3.x). No behavior in v3.0; the column is
--     captured today so we don't have to migrate later.
--
--   * `last_polled_at` is NULLABLE — the RSS poller (YT-004) writes
--     it; the subscriptions sync (this issue) does not. NULL means
--     "we haven't polled this channel's RSS feed yet".
--
--   * `subscribed_at` is YouTube's `snippet.publishedAt` of the
--     subscription record (when the user subscribed). ISO 8601, UTC.
--
--   * `created_at` / `updated_at` are dashboard-side timestamps.
--     `updated_at` advances on every sync when the title / thumb
--     changes; `created_at` is set on first insert and never moves.
--
--   * Partial index on `is_included = 1` accelerates the RSS
--     poller's "which channels do I poll?" query (YT-004). The
--     where-clause is folded into the index so the query is a
--     direct range scan over a small index, not a table scan.

CREATE TABLE subscriptions (
  id                    TEXT PRIMARY KEY,
  google_account_id     TEXT NOT NULL,
  channel_id            TEXT NOT NULL UNIQUE,
  channel_title         TEXT NOT NULL,
  channel_thumbnail_url TEXT,
  subscribed_at         TEXT NOT NULL,
  is_included           INTEGER NOT NULL DEFAULT 1,
  is_important          INTEGER NOT NULL DEFAULT 0,
  last_polled_at        TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (google_account_id) REFERENCES youtube_accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_subscriptions_google_account_id
  ON subscriptions(google_account_id);

CREATE INDEX idx_subscriptions_included
  ON subscriptions(channel_id) WHERE is_included = 1;