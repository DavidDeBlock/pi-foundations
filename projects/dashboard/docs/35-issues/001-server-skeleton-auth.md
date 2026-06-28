# 001 — Server skeleton + HTTP Basic auth

**Labels**: `v1`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md)

## What to build

A working Hono server that boots from a single command, reads its password from an environment variable, and gates every route with HTTP Basic auth. The home page is a placeholder ("Dashboard is up") rendered as server-side HTML — no SPA, no build step. Includes a Vitest test suite scaffold and a passing test for the auth middleware.

## Acceptance criteria

- [ ] `pnpm install && pnpm start` boots the server on `0.0.0.0:8080`
- [ ] Server reads `DASHBOARD_PASSWORD` from the environment; refuses to start with a clear error if unset
- [ ] HTTP Basic auth middleware gates every route (UI + API)
- [ ] Wrong password returns 401 with a `WWW-Authenticate: Basic` header
- [ ] Correct password returns 200 on `GET /` and renders a placeholder HTML page
- [ ] Vitest is set up with one passing test for the auth middleware
- [ ] README has the quick-start commands

## Blocked by

None — can start immediately.