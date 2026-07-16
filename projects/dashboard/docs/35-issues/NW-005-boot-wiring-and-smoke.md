# NW-005 — Boot wiring + end-to-end smoke + docs updates

**Labels**: `news-weather`, `v5.0`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-008](../35-prds/PRD-008-news-weather.md)

## What to build

The integration step: wire the scheduler into server boot, add an end-to-end smoke test, and update the project docs (README, CONTEXT) to reflect v5.0. This is the "ship" issue — when NW-005 passes, PRD-008 is done.

## Acceptance criteria

### Boot wiring

- [ ] `server/src/index.ts` constructs `NewsSchedulerOrchestrator` (with the `Database` instance), wires it as the tick callback of `NewsScheduler`, and starts the scheduler after the Hono server binds
- [ ] Scheduler stopped on `SIGTERM` / `SIGINT` (best-effort; matches existing shutdown pattern)
- [ ] First tick fires ~15s after start; subsequent ticks every 60s

### Smoke test

- [ ] New smoke script: `server/scripts/news-smoke.sh` (or extend `server/scripts/smoke.sh`)
  - Fresh in-memory or temp SQLite DB
  - Apply migrations
  - Boot server
  - Wait up to 90s
  - GET `/news-weather` with HTTP Basic
  - Assert: 200 status; HTML contains one of the seeded source names (e.g., "VRT NWS"); HTML contains the weather block; HTML contains at least one category header
- [ ] Smoke script exits 0 on success, non-zero on failure
- [ ] Document the smoke command in the slice's README/comment

### Docs

- [ ] `README.md` roadmap table gets a v5.0 row linking to PRD-008
- [ ] `docs/CONTEXT.md` "What's locked in" table gets one row for v5.0 referencing ADR-010 + PRD-008
- [ ] Optional: a brief "News & Weather" section in README explaining the page exists at `/news-weather` and the source list lives in the DB

### Acceptance gate

- [ ] All NW-001..NW-004 acceptance criteria pass
- [ ] `pnpm test` passes (including the new tests)
- [ ] Smoke script passes
- [ ] Manual end-to-end: fresh DB → `pnpm migrate` → `pnpm start` → open browser → `/news-weather` shows weather + news within ~90s

## Blocked by

- [NW-001](./NW-001-schema-migration.md)
- [NW-002](./NW-002-fetcher-dispatcher-and-normalizer.md)
- [NW-003](./NW-003-news-scheduler.md)
- [NW-004](./NW-004-news-weather-page.md)

## Files to touch

- `server/src/index.ts` (wire scheduler + shutdown handler)
- `server/scripts/news-smoke.sh` (new) — or extend `server/scripts/smoke.sh`
- `README.md` (roadmap row + optional section)
- `docs/CONTEXT.md` (locked-in row)
