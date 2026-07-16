# Dashboard

Personal dashboard for Chrome bookmarks, browsing history, and YouTube saves — self-hosted on a home Ubuntu server.

> **Status:** v1 shipped (issues #001–#010). The Chrome extension syncs bookmarks into a self-hosted Hono + SQLite server; the dashboard lets you browse, categorize (folders + tags), and search with typo tolerance. See [`docs/deployment.md`](./docs/deployment.md) for the production runbook.

## Stack

- **Server**: [Hono](https://hono.dev/) on Node.js (via `@hono/node-server`)
- **DB**: [SQLite](https://www.sqlite.org/) via [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) — file-based, synchronous
- **UI**: Server-rendered HTML + ~400 lines of vanilla JS for categorize + search (no build step, no client framework)
- **Search**: SQLite FTS5 + app-layer trigram index (regular table — better-sqlite3 doesn't bundle the trigram extension)
- **Chrome data**: Manifest V3 extension (load unpacked — no Chrome Web Store)
- **Auth**: HTTP Basic (browser) + Bearer API token (extension), bcrypt-hashed (per ADR-007)
- **Runtime**: Node 22+, run via `tsx` (no compile step)
- **Tests**: Vitest

## Roadmap

| Slice | Scope |
|-------|-------|
| **v1** | Read-only Chrome bookmarks + categorize (folders + tags) + search |
| **v2** | Chrome write-back + browsing history (bulk import + ongoing) |
| **v3.0** | YouTube subscriptions + RSS-based new-video detection (PRD-003, YT-001..YT-006) |
| **v3.1** | YouTube saves (Data API) + watch history (Takeout) + user playlists |
| **v5.0** | News & Weather — Belgian feeds (VRT NWS, De Tijd, CCB) + Open-Meteo forecast for Ghent (PRD-008, NW-001..NW-005) |

## Repository layout

```
projects/dashboard/
├── README.md                   ← you are here
├── docs/
│   ├── _index.md
│   ├── CONTEXT.md              ← project context
│   ├── deployment.md           ← production runbook (systemd, backups, firewall)
│   ├── deployment/             ← drop-in unit files (dashboard.service, backup.sh)
│   ├── 30-plans/               ← fluid planning notes
│   ├── 35-prds/                ← PRDs (PRD-001 = v1)
│   ├── 35-issues/              ← issue tracker (one .md per issue)
│   └── 40-decisions/           ← ADRs (001–008 + grill decisions)
├── scripts/                    ← cross-cutting scripts (backup.sh)
├── extension/                  ← (v1) Chrome extension (Manifest V3)
└── server/                     ← (v1) Hono server
    ├── scripts/                ← smoke.sh — end-to-end smoke against a fresh server
    ├── static/                 ← vanilla JS for categorize + search
    └── src/                    ← TypeScript (Hono routes + deep modules)
```

## Status

| Issue | Title | Status |
|-------|-------|--------|
| #001 | Server skeleton + HTTP Basic auth | ✅ Shipped |
| #002 | API token generation + management | ✅ Shipped |
| #003 | Schema migrations + folder read API | ✅ Shipped |
| #004 | Extension skeleton + bulk sync API stub | ✅ Shipped |
| #005 | FolderTreeBuilder + first sync E2E | ✅ Shipped |
| #006 | BookmarkDiffer + ongoing sync (event listener) | ✅ Shipped |
| #007 | Activity feed landing + bookmark detail | ✅ Shipped |
| #008 | TagNormalizer + categorize UI (folders + tags) | ✅ Shipped |
| #009 | SearchQueryBuilder + search UI (FTS5 + trigram) | ✅ Shipped |
| #010 | Smoke test, README, deployment docs | ✅ Shipped |

## Getting started

```bash
cd projects/dashboard/server
pnpm install
DASHBOARD_PASSWORD=yourpassword pnpm start
# → http://ubuntu-server:8080
```

Then load `extension/` unpacked in `chrome://extensions` and paste the API token from the dashboard's `/settings` page.

For a production-style deployment (systemd unit, backups, firewall), see [`docs/deployment.md`](./docs/deployment.md).

For full v1 scope, see [`docs/35-prds/PRD-001-v1-chrome-bookmarks.md`](./docs/35-prds/PRD-001-v1-chrome-bookmarks.md).

## News & Weather

Since v5.0 the dashboard renders a `/news-weather` page with Belgian news and a 7-day Ghent weather forecast at the top. Sources are configured in the `news_sources` table (seeded by migration `025_news.sql`):

- **VRT NWS** (General) — VRT's general news feed
- **De Tijd — General** (Economy) — De Tijd's general feed
- **CCB News** + **CCB Advisories** (Technology and Cybersecurity) — Belgian Centre for Cybersecurity
- **Open-Meteo Ghent** (Weather) — public weather API for 51.0543°N, 3.7174°E

Adding a new source is a migration, not a code change. See [PRD-008](./docs/35-prds/PRD-008-news-weather.md) for the full design (parallel ingestion pipeline, per-source due-check, failure isolation). The pipeline is covered by `pnpm smoke:news`.

Manual refresh is exposed at `POST /api/news/refresh` (auth-gated) for forcing a tick outside the 60s cadence.