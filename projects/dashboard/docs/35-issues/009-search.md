# 009 — SearchQueryBuilder + search UI (FTS5 + trigram)

**Labels**: `v1`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md)

## What to build

The `SearchQueryBuilder` deep module (pure function) that composes FTS5 + trigram queries with filters (folder, tag, date range) into safe SQL with bound parameters. FTS5 + trigram virtual tables added to the migrations. `SearchHandler` composes the builder + DB query. `GET /api/search` endpoint with `q`, `folder`, `tag`, `from`, `to` query params. Search box in the header always visible; debounced search-as-you-type (150ms); filter UI; matched snippet highlighted in results.

## Acceptance criteria

- [ ] `SearchQueryBuilder` module implemented and exported
- [ ] Unit tests cover: plain query, query with quotes (escape), multi-token, filter combinations, empty result, SQL-injection attempt
- [ ] FTS5 + trigram virtual tables added to migrations
- [ ] `SearchHandler` composes builder + DB query, returns shaped results
- [ ] `GET /api/search?q=...&folder=...&tag=...&from=...&to=...` endpoint
- [ ] Search box in the header, always visible
- [ ] Debounced search-as-you-type (150ms)
- [ ] Filter UI: folder dropdown, tag dropdown, date range
- [ ] Matched snippet highlighted in results
- [ ] Smoke check: <200ms response against 1,000 seeded bookmarks
- [ ] Fuzzy match verified: "postgers" finds "Postgres tips"

## Blocked by

- 003 (schema + folder read)