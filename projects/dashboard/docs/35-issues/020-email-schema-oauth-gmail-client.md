# 020 — Email schema + Gmail OAuth + GmailClient + /settings/email connect

**Labels**: `email`, `v4`, `needs-triage`
**Type**: AFK (with manual smoke test for OAuth round-trip)
**Parent**: [PRD-002](../35-prds/PRD-002-email-mirror.md)

## What to build

The user can connect their Gmail account to the dashboard from a new `/settings/email` page. Clicking "Connect Gmail" redirects to Google's consent screen requesting only `gmail.readonly` — no ability to delete, archive, label, or send. After consent, the dashboard encrypts and stores the OAuth tokens, then redirects the user back to `/settings/email` showing the connected account with their Gmail address. They can disconnect from the same page. A `GmailClient` deep module wraps the Gmail REST API (list messages, get message, get thread) for downstream slices to build on.

## Acceptance criteria

- [ ] Migration adds `email_accounts` table with encrypted `access_token` + `refresh_token` columns, `token_expires_at`, `email_address`, `connected_at`, `last_sync_at`
- [ ] `GmailClient` exposes `listMessages({since, pageToken}) → {messages, nextPageToken}`, `getMessage(id) → RawEmail`, `getThread(id) → RawEmail[]` with typed responses
- [ ] `/api/email/oauth/start` redirects to Google's consent screen with scope `https://www.googleapis.com/auth/gmail.readonly` only (no `gmail.modify`, no `gmail.send`, no `gmail.compose`)
- [ ] `/api/email/oauth/callback` exchanges authorization code, encrypts and stores tokens, redirects to `/settings/email` with a success indicator
- [ ] `DELETE /api/email/accounts/:id` revokes the token at Google (`https://oauth2.googleapis.com/revoke`) + removes the row
- [ ] `/settings/email` shows "Connect Gmail" button when no account; otherwise lists connected account(s) with email address and Disconnect button
- [ ] OAuth state parameter includes CSRF nonce; callback validates it
- [ ] Tokens are encrypted at rest using a key from `EMAIL_TOKEN_ENCRYPTION_KEY` env var; missing key fails the server boot with a clear error
- [ ] `/settings/email` documents the one-time Google Cloud Console OAuth client registration steps + required env vars
- [ ] Tests: `GmailClient` against mocked HTTP responses (list paginates, get returns full message, 401 triggers refresh, 429 triggers backoff); OAuth callback handler with fixtures; token encrypt/decrypt round-trip; scopes requested match exactly `gmail.readonly`
- [ ] Manual smoke test (documented in slice): OAuth round-trip against a real Gmail account works end-to-end

## Blocked by

None — can start immediately.