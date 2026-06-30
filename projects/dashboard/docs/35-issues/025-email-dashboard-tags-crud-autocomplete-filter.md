# 025 — Dashboard tags: tag CRUD + autocomplete + filter + chips

**Labels**: `email`, `v4`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-002](../35-prds/PRD-002-email-mirror.md)

## What to build

Users can add dashboard-only tags to emails (e.g. `#launch`, `#waiting-on-sarah`) for cross-provider, cross-project organization. Tags are dashboard-private — they don't exist in Gmail and never propagate back. Tags survive re-syncs because sync never touches the `email_tags` table. The detail view shows existing tags as removable chips and has an "Add tag" input with autocomplete from existing tags (Enter to create a new tag). The inbox view gets a tag filter.

## Acceptance criteria

- [ ] Migration adds `email_tags` table (`email_id`, `tag` — composite PRIMARY KEY)
- [ ] `POST /api/email/:id/tags` with body `{tag: "launch"}` adds the tag (idempotent — adding the same tag twice does not error)
- [ ] `DELETE /api/email/:id/tags/:tag` removes the tag (no-op if not present)
- [ ] `GET /api/email/tags` returns all tags with their email counts, sorted by count DESC then alphabetical — used for autocomplete
- [ ] Email detail view shows existing tags as chips with × to remove
- [ ] Email detail view has "Add tag" input that fetches `/api/email/tags` for autocomplete; pressing Enter creates the typed tag (if new) or attaches the selected existing tag
- [ ] Tags are normalized (trimmed, lowercased, deduped case-insensitively) before storage
- [ ] Inbox view has a tag filter that narrows to emails containing the selected tag (works in combination with other filters)
- [ ] Sync never touches the `email_tags` table — verified by integration test: add a tag, run sync, assert tag still present
- [ ] No Gmail label is created, modified, or read for tags — tags live entirely in the dashboard's SQLite (verified by `GmailClient` mocks showing no `labels.create` or `labels.modify` calls during the sync path)
- [ ] Tests: CRUD round-trip, idempotent add, autocomplete data shape, normalize (case/whitespace), filter narrows correctly, sync never touches `email_tags`, Gmail client mock confirms no label operations

## Blocked by

- [023](./023-email-ui-inbox-detail-thread-sidebar.md)

(can run in parallel with [024](./024-email-soft-delete-hide-unhide-hidden-view.md) — both modify the detail view but don't interact)