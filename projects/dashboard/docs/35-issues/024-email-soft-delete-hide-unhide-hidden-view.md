# 024 — Soft-delete: hidden_at + hide/unhide endpoints + /email/hidden view

**Labels**: `email`, `v4`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-002](../35-prds/PRD-002-email-mirror.md)

## What to build

Users can hide an email from their dashboard view without touching live Gmail. The detail view's "Hide" button (placeholder from 023) now wires through to `POST /api/email/:id/hide`, setting `hidden_at = now()`. Hidden emails disappear from `/email`, `/email/search`, and `/email/thread/:id`. A new `/email/hidden` route lists all hidden emails (most recently hidden first) with an "Unhide" button. **Critical architectural invariant:** the sync UPSERT never overwrites `hidden_at` — local soft-deletes survive every re-sync forever.

## Acceptance criteria

- [ ] Migration adds `hidden_at` (nullable TIMESTAMP) column to `emails` table
- [ ] `POST /api/email/:id/hide` sets `hidden_at = now()`, returns 204
- [ ] `POST /api/email/:id/unhide` sets `hidden_at = NULL`, returns 204
- [ ] `/email` (default) excludes hidden emails from the list and counts
- [ ] `/email/search` excludes hidden emails from results
- [ ] `/email/thread/:threadId` excludes hidden messages (only non-hidden messages shown)
- [ ] `/email/hidden` lists all hidden emails sorted by `hidden_at DESC`, with sender/subject/snippet/time-hidden and an "Unhide" button per row
- [ ] Detail view "Hide" button toggles to "Unhide" (and stays that way after page reload) when an email is hidden
- [ ] `GET /api/email/hidden` returns the same list as `/email/hidden` view (for API completeness)
- [ ] Sync UPSERT explicitly excludes `hidden_at` from its UPDATE column list — verified by integration test: seed `hidden_at` on a row, run a sync that re-imports the same message with different `subject`, assert `subject` updated but `hidden_at` unchanged
- [ ] If a Gmail message is deleted at the source, sync removes the row entirely (including any `hidden_at` and tags) — there's nothing left to mirror
- [ ] Tests: hide persists across sync, unhide restores row to default view, list/search/thread exclude hidden, sync never overwrites `hidden_at`, source-side deletion removes the row even if hidden

## Blocked by

- [023](./023-email-ui-inbox-detail-thread-sidebar.md)