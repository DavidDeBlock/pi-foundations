# 010 — Smoke test, README, deployment docs

**Labels**: `v1`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md)

## What to build

End-to-end smoke-test script that runs the full v1 flow against a fresh server. README polished with the actual stack, the actual quick-start, and the actual extension install steps. Deployment runbook covering: password setup, server boot (systemd or pm2), Chrome extension load-unpacked steps, and a backup note (the SQLite file is the source of truth — back up the server).

## Acceptance criteria

- [ ] `scripts/smoke.sh` (or similar) boots server, simulates extension sync with a fixture of 100 bookmarks, walks through the activity feed → search → edit flows, and asserts the expected state
- [ ] README has the actual tech stack, the actual `pnpm start` command, the actual extension install steps
- [ ] Deployment docs cover: env vars, systemd unit (or pm2 config), backup strategy, log location
- [ ] All 7 acceptance criteria from PRD-001 verified manually against the running system

## Blocked by

- 001 (server skeleton)
- 002 (API tokens)
- 003 (schema)
- 004 (extension skeleton)
- 005 (FolderTreeBuilder + first sync)
- 006 (BookmarkDiffer + ongoing sync)
- 007 (activity feed UI)
- 008 (categorize UI)
- 009 (search)