# ADR-007: App password + extension API token

**Status**: Accepted
**Date**: 2026-06-28
**Authors**: David

## Context

The dashboard has two surfaces that need auth: a human (David) using the dashboard UI in a browser, and the Chrome extension calling the dashboard's REST API. They are different clients with different needs.

The dashboard is LAN-accessible (ADR-001). The user does not use Tailscale.

## Decision Drivers

- Data is sensitive (bookmarks, history, watch history) — must not be open on the LAN
- One user, one LAN — no need for full multi-user session management
- Browser can remember a password forever — UX cost of a password is ~zero
- Extension cannot log in like a human — needs an API token
- Tailscale is a new dependency the user has no familiarity with

## Decision

**Two auth mechanisms, both simple:**

### App auth: Single password (HTTP Basic)
- One password, set during initial setup, bcrypt-hashed and stored in the server config
- Browser prompts once, remembers forever
- No login page, no sessions, no logout
- Sent as `Authorization: Basic <base64(user:pass)>` on every request

### Extension auth: Shared secret API token
- Dashboard generates a long random token on demand (shown once in the dashboard UI)
- User pastes the token into the extension's config
- Extension sends `Authorization: Bearer <token>` on every request
- Token scoped to "this extension on this machine"; can be revoked and rotated
- Token stored in extension's local storage (per Chrome's standard extension storage)

## Consequences

**Positive:**
- No external auth dependencies (no OAuth provider, no JWT library)
- Browser remembers password → zero ongoing UX cost
- Token can be rotated independently of password
- LAN snooping, accidental port forwards, and visitors on the network are all blocked
- Implementation is ~50 lines of code total

**Negative:**
- No fine-grained permissions (one token grants everything)
- No per-user audit trail (only one user, so doesn't matter)
- HTTP Basic sends credentials on every request — mitigated by HTTPS in any future non-LAN deployment
- If password leaks, attacker has full access (mitigated by being LAN-only and the user being the only human)