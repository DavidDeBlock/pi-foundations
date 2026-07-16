# NW-006 — Extended sources migration (HLN enabled + De Standaard/BRUZZ disabled)

**Labels**: `news-weather`, `v5.1`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-009](../35-prds/PRD-009-news-weather-extended.md)

## What to build

A new migration that adds 4 sources to `news_sources`: HLN (enabled), De Standaard (disabled, placeholder URL), BRUZZ Politics (disabled, placeholder URL), BRUZZ Mobility (disabled, placeholder URL). The 3 disabled sources have placeholder URLs pointing at the source's own RSS overview/info page — they're intentionally not valid RSS feeds, but `enabled = 0` prevents the scheduler from fetching them. The operator updates the URL and flips `enabled = 1` once the real RSS endpoint is verified.

## Acceptance criteria

- [ ] New migration `server/migrations/026_news_extended_sources.sql` INSERTs into `news_sources`:
  - HLN — `category = 'General'`, `type = 'rss'`, `url = 'https://www.hln.be/home/rss.xml'`, `enabled = 1`, `refresh_interval_min = 30`
  - De Standaard — `category = 'General'`, `type = 'rss'`, `url = 'https://www.standaard.be/extra/rss-feeds/49064508.html'`, `enabled = 0`, `refresh_interval_min = 30`
  - BRUZZ Politics — `category = 'Local and Politics'`, `type = 'rss'`, `url = 'https://www.bruzz.be/rss-feeds-op-bruzzbe'`, `enabled = 0`, `refresh_interval_min = 30`
  - BRUZZ Mobility — `category = 'Local and Politics'`, `type = 'rss'`, `url = 'https://www.bruzz.be/rss-feeds-op-bruzzbe'`, `enabled = 0`, `refresh_interval_min = 30`
- [ ] SQL comment at the top of the migration explains the placeholder-URL + `enabled = 0` pattern (so a future reader understands why De Standaard is seeded with a non-RSS URL)
- [ ] Migration is idempotent on re-run (does not duplicate rows). Acceptable approaches: guard INSERTs with `WHERE NOT EXISTS (SELECT 1 FROM news_sources WHERE name = ?)`, OR run on fresh DB and document the trade-off (matching the approach chosen for `025_news.sql`).
- [ ] After running on a DB seeded with PRD-008, `SELECT COUNT(*) FROM news_sources` returns 9; `SELECT COUNT(*) FROM news_sources WHERE enabled = 1` returns 6 (the original 5 plus HLN)
- [ ] `server/src/migrations.test.ts` extended to assert the new sources exist with the expected `enabled` flag
- [ ] Manual smoke: `pnpm migrate` applies cleanly; `SELECT name, enabled FROM news_sources` lists all 9 with correct flags; HLN articles appear in the General category within ~30 min of the next scheduler tick (or manually trigger `NewsSchedulerOrchestrator.tick()`)

## Blocked by

- [NW-001](./NW-001-schema-migration.md) (the `news_sources` table must exist)

## Files to touch

- `server/migrations/026_news_extended_sources.sql` (new)
- `server/src/migrations.test.ts` (extend coverage)

## Notes

- The placeholder URLs are non-RSS HTML pages by design. With `enabled = 0`, the scheduler skips them entirely — no fetch attempt, no `last_error`. The operator's flow is: visit the overview page, find the real RSS endpoint, `UPDATE news_sources SET url = ?, enabled = 1 WHERE name = ?`.
- If the operator enables a source before updating the URL, the fetcher will fail and write the failure to `last_error` — which is the correct behavior. They see the error, fix the URL, and try again.
- This is the entire point of the `enabled` flag in ADR-010's design. No admin UI needed.
