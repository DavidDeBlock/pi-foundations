# Dashboard

Personal dashboard for Chrome bookmarks, browsing history, and YouTube saves — self-hosted on a home Ubuntu server.

> **Status:** Planning — v1 PRD drafted. See [`docs/`](./docs/).

## Stack

- **Server**: Hono on Node.js
- **DB**: SQLite via `better-sqlite3`
- **UI**: Server-rendered HTML with HTMX
- **Search**: SQLite FTS5 + trigram
- **Chrome data**: browser extension (Manifest V3)
- **Auth**: HTTP Basic password (app) + Bearer API token (extension)

## Roadmap

| Slice | Scope |
|-------|-------|
| **v1** | Read-only Chrome bookmarks + categorize (folders + tags) + search |
| **v2** | Chrome write-back + browsing history (bulk import + ongoing) |
| **v3** | YouTube saves (Data API) + watch history (Takeout) |

## Repository layout

```
projects/dashboard/
├── README.md                   ← you are here
├── docs/
│   ├── _index.md
│   ├── CONTEXT.md              ← project context
│   ├── 30-plans/               ← fluid planning notes
│   ├── 35-prds/                ← PRDs (PRD-001 = v1)
│   └── 40-decisions/           ← ADRs (001–008 + grill decisions)
├── extension/                  ← (v1) Chrome extension (Manifest V3)
└── server/                     ← (v1) Hono server
```

## Getting started (v1, once implemented)

```bash
cd projects/dashboard
pnpm install
DASHBOARD_PASSWORD=yourpassword pnpm start
# → http://ubuntu-server:8080
```

Then load `extension/` unpacked in `chrome://extensions` and paste the API token from the dashboard's `/settings` page.

See [`docs/35-prds/PRD-001-v1-chrome-bookmarks.md`](./docs/35-prds/PRD-001-v1-chrome-bookmarks.md) for full v1 scope.