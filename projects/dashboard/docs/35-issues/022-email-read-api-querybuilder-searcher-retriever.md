# 022 — EmailQueryBuilder + EmailSearcher + EmailRetriever + read API

**Labels**: `email`, `v4`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-002](../35-prds/PRD-002-email-mirror.md)

## What to build

The user (and the upcoming UI in 023) can read their synced emails via a typed JSON API. `GET /api/email` returns paginated emails with structured filters. `GET /api/email/:id` returns one email with full plain-text body. `GET /api/email/thread/:threadId` returns all messages in a thread, chronological. `GET /api/email/search?q=...` does full-text + typo-tolerant search via FTS5 + trigram, with snippet highlighting. All read queries filter `WHERE hidden_at IS NULL` (defense-in-depth even before slice 024 lands — if a row happens to have `hidden_at` set, it's invisible).

## Acceptance criteria

- [ ] Migration adds `email_fts` (FTS5 virtual) + `email_trigram` virtual tables covering `subject`, `body_plain`, `sender`, `sender_email`
- [ ] FTS5 index is kept in sync via triggers on `emails` INSERT/UPDATE/DELETE
- [ ] `EmailQueryBuilder.build({from, to, subject_contains, label, unread, since, until, tag, limit, cursor}) → {sql, params}` produces safe parameterized SQL (no string interpolation of user input)
- [ ] `EmailSearcher.search({query, filters}) → EmailSummary[]` returns results with snippet text wrapped in `<mark>...</mark>` for matched terms
- [ ] `EmailRetriever.getById(id) → EmailDetail` returns full email; `getThread(threadId) → EmailDetail[]` returns chronological order
- [ ] `GET /api/email?from=&to=&subject_contains=&label=&unread=&since=&until=&tag=&limit=&cursor=` returns paginated results
- [ ] `GET /api/email/:id` returns full email with `body_plain`; 404 for missing id
- [ ] `GET /api/email/thread/:threadId` returns thread in chronological order
- [ ] `GET /api/email/search?q=&limit=` returns FTS5 + trigram matches with highlighted snippets
- [ ] All read endpoints filter `WHERE hidden_at IS NULL`
- [ ] Search responds <200ms against 10,000 emails (smoke check)
- [ ] Tests: query builder filter combinations + SQL injection attempt rejected, FTS5 snippet highlighting, trigram typo tolerance (`"postgers"` finds `"postgres"`), retriever thread ordering, missing-id returns 404, `hidden_at IS NOT NULL` rows excluded from all reads

## Blocked by

- [021](./021-email-sync-worker-differ-initial-sync.md)