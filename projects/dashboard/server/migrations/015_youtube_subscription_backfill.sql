-- YT-009: recent-video backfill preferences and persistent per-subscription jobs.

CREATE TABLE youtube_preferences (
  google_account_id              TEXT PRIMARY KEY REFERENCES youtube_accounts(id) ON DELETE CASCADE,
  new_subscription_backfill_days INTEGER NOT NULL DEFAULT 30
    CHECK (new_subscription_backfill_days IN (0, 7, 30, 90)),
  created_at                     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO youtube_preferences (google_account_id)
SELECT id FROM youtube_accounts;

ALTER TABLE subscriptions ADD COLUMN backfill_initialized INTEGER NOT NULL DEFAULT 0
  CHECK (backfill_initialized IN (0, 1));
ALTER TABLE subscriptions ADD COLUMN backfill_status TEXT
  CHECK (backfill_status IS NULL OR backfill_status IN ('pending', 'running', 'completed', 'failed'));
ALTER TABLE subscriptions ADD COLUMN last_backfill_days INTEGER
  CHECK (last_backfill_days IS NULL OR last_backfill_days IN (7, 30, 90));
ALTER TABLE subscriptions ADD COLUMN last_backfill_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN last_backfill_skipped_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN last_backfilled_at TEXT;
ALTER TABLE subscriptions ADD COLUMN backfill_requested_at TEXT;
ALTER TABLE subscriptions ADD COLUMN backfill_started_at TEXT;
ALTER TABLE subscriptions ADD COLUMN backfill_completed_at TEXT;
ALTER TABLE subscriptions ADD COLUMN backfill_error TEXT;
ALTER TABLE subscriptions ADD COLUMN backfill_retryable INTEGER NOT NULL DEFAULT 0
  CHECK (backfill_retryable IN (0, 1));

-- Upgrade safety: subscriptions that pre-date this feature must not suddenly
-- import up to 90 days of videos on the first post-migration sync.
UPDATE subscriptions SET backfill_initialized = 1;

CREATE INDEX idx_subscriptions_backfill_status
  ON subscriptions(backfill_status, backfill_requested_at)
  WHERE backfill_status IN ('pending', 'running');
