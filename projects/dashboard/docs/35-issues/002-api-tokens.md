# 002 — API token generation + management

**Labels**: `v1`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md)

## What to build

The user can generate, list, and revoke API tokens from a `/settings` page. Valid tokens authenticate calls to `/api/*` via `Authorization: Bearer <token>`. Tokens are bcrypt-hashed before storage; plaintext is shown to the user exactly once at creation time.

## Acceptance criteria

- [ ] `/settings` renders the token list (no plaintext shown)
- [ ] "Generate token" button creates a new token, displays the plaintext once, then hides it
- [ ] Tokens are stored as bcrypt hashes; the plaintext never persists
- [ ] `GET /api/tokens` lists tokens (id, label, created_at, last_used_at — no plaintext)
- [ ] `DELETE /api/tokens/:id` revokes a token
- [ ] Auth middleware accepts valid `Authorization: Bearer <token>` for `/api/*` routes alongside HTTP Basic
- [ ] Tests cover: token roundtrip (create → hash → validate), invalid token rejected, revoked token rejected

## Blocked by

- 001 (server skeleton + auth)