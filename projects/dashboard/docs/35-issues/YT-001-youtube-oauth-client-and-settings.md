# YT-001 — YouTube OAuth + YouTubeOAuthClient + /settings/youtube connect

**Labels**: `youtube`, `v3.0`, `needs-triage`
**Type**: AFK (with manual smoke for OAuth round-trip)
**Parent**: [PRD-003](../35-prds/PRD-003-youtube-v3-subscriptions.md)

## What to build

David can connect his YouTube account from a new `/settings/youtube` page. Clicking "Connect YouTube" redirects to Google's consent screen requesting only read access (`youtube.readonly` + `youtube.force-ssl` if `subscriptions.list` requires it). After consent, the dashboard encrypts and stores the OAuth tokens, then redirects back to `/settings/youtube` showing the connected account. He can disconnect from the same page. A `YouTubeOAuthClient` deep module wraps the OAuth + Data API token lifecycle (exchange, refresh, revoke) so downstream slices don't talk to Google directly.

## Acceptance criteria

- [ ] Migration adds `youtube_accounts` table with encrypted `access_token`, `refresh_token`, `token_expires_at`, `google_user_id`, `email_address`, `connected_at`, `last_refreshed_at`
- [ ] `YouTubeOAuthClient` deep module exposes: `getAuthorizationUrl(state) → string`, `exchangeCode(code) → { access_token, refresh_token, expires_in, scope }`, `refresh(refresh_token) → { access_token, expires_in }`, `revoke(token) → void`
- [ ] Scopes requested are exactly `https://www.googleapis.com/auth/youtube.readonly`; add `https://www.googleapis.com/auth/youtube.force-ssl` only if `subscriptions.list` returns an error without it (verify empirically; document the chosen set)
- [ ] `/api/youtube/oauth/start` generates a CSRF nonce, stores it in session/cookie, redirects to Google's consent screen
- [ ] `/api/youtube/oauth/callback` validates state nonce, exchanges code, encrypts + stores tokens, redirects to `/settings/youtube?connected=1`
- [ ] `GET /api/youtube/connection` returns `{ connected: true, email_address, connected_at, last_refreshed_at, scopes }` or `{ connected: false }`
- [ ] `DELETE /api/youtube/connection` revokes the token at Google (`https://oauth2.googleapis.com/revoke`) and removes the row
- [ ] Auto-refresh: if `token_expires_at` is within 5 min of now, `YouTubeOAuthClient` refreshes transparently before any Data API call (used by YT-002)
- [ ] `/settings/youtube` shows "Connect YouTube" button when not connected; shows email + Disconnect button + "last refreshed at" when connected
- [ ] Tokens encrypted at rest using a key from `YOUTUBE_TOKEN_ENCRYPTION_KEY` env var; missing key fails server boot with a clear error
- [ ] Tests: OAuth state CSRF validation; token exchange with mocked Google endpoints; token refresh; revoke flow; token encrypt/decrypt round-trip; scopes asserted to match exactly the documented set
- [ ] Manual smoke test (documented in slice): OAuth round-trip against a real Google account works end-to-end
- [ ] README/doc update: one-time Google Cloud Console OAuth client registration steps + required env vars (`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_TOKEN_ENCRYPTION_KEY`, `YOUTUBE_OAUTH_REDIRECT_URI`)

## Blocked by

None — can start immediately.