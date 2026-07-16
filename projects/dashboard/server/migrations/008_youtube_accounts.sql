-- 008_youtube_accounts.sql — issue YT-001
--
-- Stores connected YouTube accounts with encrypted OAuth tokens.
-- One row per (provider, email_address) pair, so multi-account
-- support works without a schema change later (David is solo but
-- the email slice already does this for symmetry).
--
-- Tokens are encrypted at rest using AES-256-GCM with a key
-- derived from YOUTUBE_TOKEN_ENCRYPTION_KEY. See token-encryption.ts
-- for the wire format (iv.tag.ciphertext, all base64).
--
-- Decisions locked here (matches PRD-003 + the v3.0 module map):
--   * `provider` is constrained to 'youtube' in v3.0 (CHECK).
--     Future YouTube Brand Accounts could add a second provider
--     value; defer until needed.
--   * `google_user_id` is the stable Google user ID from the
--     userinfo endpoint. Identifies the same person across
--     reconnects. Distinct from any `channel_id` — the user's
--     own channel_id is fetched separately by YT-002's
--     SubscriptionsFetcher via `channels.list?mine=true`.
--   * `scopes` is the space-separated scope string Google returned
--     with the tokens. Lets the UI show "Permissions: youtube.readonly"
--     and lets a future audit confirm the granted scope set matches
--     what we requested.
--   * Tokens are stored encrypted; no plaintext column exists.
--   * `token_expires_at` is ISO 8601 (matches the rest of the schema).
--     NULL = unknown expiry (older accounts) — the client treats NULL
--     as "refresh proactively on next use".
--   * `connected_at` defaults to the current UTC timestamp.
--   * `last_refreshed_at` is updated by YouTubeOAuthClient.refreshIfNeeded
--     whenever the access token is rotated, NOT by the OAuth callback
--     itself (a callback with a fresh grant doesn't count as a refresh).
--   * Unique index on (provider, email_address) prevents accidental
--     double-linking. Re-link flow (OAuth callback handler) detaches
--     first, then re-inserts — mirrors the email slice pattern.

CREATE TABLE youtube_accounts (
  id                  TEXT PRIMARY KEY,
  provider            TEXT NOT NULL CHECK (provider IN ('youtube')),
  google_user_id      TEXT NOT NULL,
  email_address       TEXT NOT NULL,
  access_token_enc    TEXT NOT NULL,
  refresh_token_enc   TEXT NOT NULL,
  token_expires_at    TEXT,
  scopes              TEXT NOT NULL,
  connected_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_refreshed_at   TEXT
);

CREATE UNIQUE INDEX idx_youtube_accounts_provider_email
  ON youtube_accounts(provider, email_address);