-- 003_email_accounts.sql — issue #020
--
-- Stores connected email accounts (Gmail in v1) with encrypted OAuth
-- tokens. One row per (provider, email_address) pair, so multi-account
-- support works without a schema change later.
--
-- Tokens are encrypted at rest using AES-256-GCM with a key derived
-- from EMAIL_TOKEN_ENCRYPTION_KEY. See token-encryption.ts for the
-- wire format (iv.tag.ciphertext, all base64).
--
-- Decisions locked here (matches PRD-002 + the v4 module map):
--   * `provider` is constrained to 'gmail' in v1 (CHECK).
--     Outlook support is a later slice (#029) — relax the CHECK there.
--   * Tokens are stored encrypted; no plaintext column exists.
--   * `token_expires_at` is ISO 8601 (matches the rest of the schema).
--     NULL = unknown expiry (older accounts) — the client treats NULL
--     as "refresh proactively on next use".
--   * `connected_at` defaults to the current UTC timestamp.
--   * `last_sync_at` is updated by the sync worker (#021), not here.
--   * Unique index on (provider, email_address) prevents accidental
--     double-linking. Re-link flow (#021 will manage) will detach
--     first, then re-insert.

CREATE TABLE email_accounts (
  id                TEXT PRIMARY KEY,
  provider          TEXT NOT NULL CHECK (provider IN ('gmail')),
  email_address     TEXT NOT NULL,
  access_token_enc  TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  token_expires_at  TEXT,
  connected_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_sync_at      TEXT
);

CREATE UNIQUE INDEX idx_email_accounts_provider_email
  ON email_accounts(provider, email_address);
