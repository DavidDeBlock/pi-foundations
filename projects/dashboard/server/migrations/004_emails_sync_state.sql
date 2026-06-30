-- 004_emails_sync_state.sql — issue #021
--
-- The Gmail mirror + per-account sync state.
--
-- Decisions locked here (matches PRD-002 + the v4 module map):
--   * `emails.id` is Gmail's stable message id (PK). One row per
--     Gmail message. Future multi-account support would change PK
--     to (account_id, id); for v1 one account per dashboard so the
--     simpler PK is fine and matches the issue spec ("PK = Gmail's
--     stable id").
--   * The columns UPSERT'd by the sync worker EXCLUDE any
--     local-state columns (e.g. `hidden_at` arrives in #024). The
--     worker uses an explicit column list, so adding new
--     local-only columns later does NOT require touching the sync
--     code — they just aren't in the list.
--   * `to_addrs` / `cc_addrs` / `labels` are JSON-encoded TEXT —
--     matches the rest of the schema (TEXT for everything) and
--     keeps queries simple. The sync worker writes via
--     JSON.stringify, reads via JSON.parse.
--   * `sender_email` is split from `sender` so "from:sarah"
--     filters (PRD-002 #15) can be O(log n) on the index. The
--     syncer writes the rendered `sender` ("Name <addr>") AND
--     the bare email so both shapes are queryable.
--   * `sync_state.in_progress` is the runtime lock so a manual
--     refresh and the background poll (#026) don't trample each
--     other. Cleared to 0 on completion or failure.
--   * `last_page_token` and `last_history_id` are nullable; NULL
--     = "first sync for this account". A pending future slice
--     will use `last_history_id` for Gmail's push-notification
--     history API; v1 uses the polling cursor pattern.
--   * ON DELETE CASCADE on both tables means disconnecting an
--     account (#020 DELETE /api/email/accounts/:id) wipes its
--     mirror + sync state — no orphaned rows.

CREATE TABLE emails (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  subject       TEXT NOT NULL DEFAULT '',
  sender        TEXT NOT NULL DEFAULT '',
  sender_email  TEXT NOT NULL DEFAULT '',
  to_addrs      TEXT NOT NULL DEFAULT '[]',
  cc_addrs      TEXT NOT NULL DEFAULT '[]',
  received_at   TEXT NOT NULL,
  snippet       TEXT NOT NULL DEFAULT '',
  body_plain    TEXT NOT NULL DEFAULT '',
  is_unread     INTEGER NOT NULL DEFAULT 0,
  labels        TEXT NOT NULL DEFAULT '[]',
  synced_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_emails_account_received ON emails(account_id, received_at DESC);
CREATE INDEX idx_emails_account_sender_email ON emails(account_id, sender_email);
CREATE INDEX idx_emails_account_thread ON emails(account_id, thread_id);

CREATE TABLE sync_state (
  account_id              TEXT PRIMARY KEY,
  provider                TEXT NOT NULL,
  last_page_token         TEXT,
  last_history_id         TEXT,
  last_sync_at            TEXT,
  last_messages_synced    INTEGER NOT NULL DEFAULT 0,
  last_added              INTEGER NOT NULL DEFAULT 0,
  last_updated            INTEGER NOT NULL DEFAULT 0,
  last_removed            INTEGER NOT NULL DEFAULT 0,
  in_progress             INTEGER NOT NULL DEFAULT 0,
  started_at              TEXT,
  -- Timestamp set when a run completes a full first-window scan
  -- (no cursor + reaches null cursor without interruption). Once
  -- set, future syncs skip the global remove pass so a resume of
  -- an interrupted first scan doesn't accidentally delete rows
  -- that were fetched on earlier pages of the same lookback.
  -- The semantics: `NULL` = "no full scan has completed", so the
  -- next clean completion marks it. Cleared only when the
  -- account is removed (via the email_accounts CASCADE).
  lookback_completed_at   TEXT,
  FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
);
