# 003 — Schema migrations + folder read API

**Labels**: `v1`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md)

## What to build

The SQLite database is initialized from a numbered migration that creates every v1 table from the PRD's schema (folders, bookmarks, tags, bookmark_tags, api_tokens). A migrations runner executes pending migrations on server boot. A typed query helper wraps `better-sqlite3`. The first read endpoint, `GET /api/folders`, returns the folder tree as a nested JSON structure (empty array if no folders).

## Acceptance criteria

- [ ] `migrations/001_initial.sql` creates every v1 table per the PRD schema
- [ ] Migrations runner applies pending migrations on boot, tracks applied migrations in a `migrations` table
- [ ] `Database` wrapper exposes typed query helpers (e.g. `db.all(sql, params)`)
- [ ] `GET /api/folders` returns the nested folder tree (empty array if no folders exist)
- [ ] Tests cover: migrations apply cleanly, idempotent on re-run, folder read returns nested structure

## Blocked by

- 001 (server skeleton + auth)