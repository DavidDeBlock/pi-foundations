# Dashboard Server

Hono server for the personal dashboard. v1 ships the full feature set: HTTP Basic auth, Bearer-token API for the extension, SQLite schema with FTS5 search, folder tree, bookmarks, tags, the activity feed, the bookmark detail view, the categorize UI, and the search page. See [`docs/deployment.md`](../../docs/deployment.md) for production setup (systemd unit, backups, firewall).

> **Scope of this folder today:** issues #001–#010 (v1 complete). See [`docs/35-issues/`](../../docs/35-issues/) and [`docs/35-prds/PRD-001-v1-chrome-bookmarks.md`](../../docs/35-prds/PRD-001-v1-chrome-bookmarks.md).

## Stack

- **Framework**: [Hono](https://hono.dev/) on Node (via `@hono/node-server`)
- **Auth**: HTTP Basic (UI) and Bearer token (extension), bcrypt-verified (per ADR-007)
- **DB**: SQLite via [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) — file at `data/dashboard.db`, schema applied from `migrations/*.sql`
- **Token storage**: JSON file at `data/tokens.json` (placeholder — replaced by SQLite in #004+)
- **Runtime**: Node 22+, run via `tsx` (no build step)
- **Tests**: Vitest

## Quick start

```bash
# from this directory (projects/dashboard/server/)
pnpm install
DASHBOARD_PASSWORD=yourpassword pnpm start
# → http://0.0.0.0:8080
```

Then visit:

- `http://<host>:8080/` — home page (placeholder)
- `http://<host>:8080/settings` — generate, list, and revoke API tokens

The browser prompts for credentials once (the password is `DASHBOARD_PASSWORD`, the username can be anything). After that, forms on `/settings` POST with Basic auth automatically because the browser caches the credentials per realm.

### Custom host / port / data dir

```bash
DASHBOARD_PASSWORD=yourpassword \
  PORT=9000 \
  HOSTNAME=127.0.0.1 \
  DASHBOARD_DATA_DIR=/var/lib/dashboard \
  DASHBOARD_DB_PATH=/var/lib/dashboard/dashboard.db \
  pnpm start
```

Defaults: `PORT=8080`, `HOSTNAME=0.0.0.0` (LAN-accessible, matching ADR-001), `DASHBOARD_DATA_DIR=./data`, `DASHBOARD_DB_PATH=./data/dashboard.db` (relative to cwd, created on first boot).

### MiniMax YouTube summaries

Put the MiniMax key in `server/.env` (this directory's `.env`; it is
git-ignored), then restart the server:

```ini
LLM_API_KEY=your-minimax-api-key
LLM_BASE_URL=https://api.minimax.io/v1
LLM_MODEL=MiniMax-M2.7
```

In a systemd deployment, put the same variables in
`/etc/dashboard/dashboard.env` instead. The API key is read only by the
server and is never included in rendered pages or API responses.

## Auth model

| Caller | Scheme | Where it's used |
|--------|--------|-----------------|
| Browser (you) | `Authorization: Basic <base64(user:pass)>` | Every route; password is `DASHBOARD_PASSWORD` |
| Chrome extension | `Authorization: Bearer <token>` | Every route; token generated at `/settings` |

A 401 response carries `WWW-Authenticate: Basic realm="Dashboard"`. Browsers ignore the Bearer challenge and prompt for Basic, so the same header works for both UI and API surfaces. Per ADR-007, the user password is bcrypt-hashed at startup; tokens are bcrypt-hashed at creation with an additional SHA-256 lookup hash for fast O(1) verification.

## Database

The server uses SQLite for everything except the (still-JSON) token store. Migrations in `migrations/` apply on boot. The `migrations` table tracks what's already applied — adding a new migration is appending to `src/migrations.ts` plus a new `00X_name.sql` file.

Schema created by `001_initial.sql`:

- `folders` — self-referential tree, mirrors Chrome
- `bookmarks` — one row per Chrome bookmark
- `tags` — unique tag names
- `bookmark_tags` — many-to-many
- `api_tokens` — schema placeholder (table created, populated in #004+)
- `bookmark_fts` — FTS5 virtual table over `bookmarks(title, url)`

Deferred to later issues:

- `bookmark_trgm` — needs a loadable SQLite extension that better-sqlite3 doesn't bundle; lands in #009 with the search implementation

## API

All routes require auth (Basic or Bearer).

### HTML (browser)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Activity feed landing (most recent first; 50/page; `?page=N&perPage=M`). Folder sidebar + search bar in header. |
| GET | `/bookmarks/:id` | Single bookmark detail (404 if missing) |
| GET | `/search?q=...` | Server-rendered search results page |
| GET | `/settings` | Token list + generate form |
| POST | `/settings/tokens` | Create token; renders the plaintext exactly once |
| POST | `/settings/tokens/:id/revoke` | Revoke from UI; redirects to `/settings` |
| GET | `/health` | `{"status":"ok"}` (auth required) |

### JSON

| Method | Path | Response |
|--------|------|----------|
| GET | `/api/tokens` | `{"tokens": [{"id","label","createdAt","lastUsedAt"}, ...]}` — never the plaintext |
| POST | `/api/tokens` | 201 + `{...record, "plaintext": "..."}` — plaintext shown exactly once |
| DELETE | `/api/tokens/:id` | 204 on success; 404 if id is unknown |
| GET | `/api/folders` | Nested folder tree (root folders with nested `children`); `[]` if no folders |
| POST | `/api/bookmarks/sync` | Bulk sync from extension. Real implementation in #005 + #006 — accepts `{folders, bookmarks}` JSON, validates via `FolderTreeBuilder`, then `BookmarkDiffer` computes minimal CRUD ops (insert/update/delete/move) against current DB state. Applied in a single transaction. Returns `{ok, idMap: {folders, bookmarks}, counts: {foldersCreated, foldersUpdated, foldersDeleted, bookmarksCreated, bookmarksUpdated, bookmarksDeleted}}`. Empty body returns `{ok:true, received:false, reason:"empty_body"}`. Malformed JSON or wrong shape → 400. Validation errors (cycles, duplicates, dangling refs) → 400 with structured error code. See `src/folder-tree-builder.ts` for the input contract and `src/bookmark-differ.ts` for the op semantics. |
| GET | `/` | Activity feed landing page (HTML, server-rendered). Reverse-chronological list of bookmarks (newest first), 50 per page, with folder path + tag chips + pagination (`?page=N&perPage=M`). Folder sidebar on the left with `+ New folder` button. Each card includes categorize controls (inline title edit, folder picker, tag input + ×, delete) when JavaScript is enabled. Added in #007; categorize UI in #008. |
| GET | `/bookmarks/:id` | Bookmark detail page (HTML, server-rendered). Shows title, URL, full folder path (root → ... → bookmark folder), tags, created_at, updated_at, last_seen_at. Includes the same categorize controls as feed cards. 404 if id missing. Added in #007; categorize UI in #008. |
| POST | `/api/bookmarks/:id` | Update one bookmark. Body: `{title?: string, tags?: string[], tagReplace?: boolean}`. Empty/missing fields are no-ops. With `tagReplace: true`, the new tag set replaces the existing set; otherwise tags are added (idempotent). Returns `{ok, bookmark: {id, title, folderId, tags}}`. 400 invalid_title / malformed_json; 404 unknown id. Added in #008. |
| POST | `/api/bookmarks/:id/move` | Move a bookmark to a different folder. Body: `{folderId: string}`. 404 if bookmark or target folder missing. Added in #008. |
| DELETE | `/api/bookmarks/:id` | Delete one bookmark (cascades to its tag links). 204 / 404. Added in #008. |
| GET | `/api/folders` | Full folder tree (nested `children` arrays). Folders only — no bookmarks. |
| POST | `/api/folders` | Create a folder. Body: `{name: string, parentId?: string}`. 201 with the new node. 400 invalid_name / unknown_parent / malformed_json. Added in #008. |
| PATCH | `/api/folders/:id` | Rename a folder. Body: `{name: string}`. 200 with the updated node / 404. Added in #008. |
| DELETE | `/api/folders/:id` | Delete a folder. Direct children are re-parented to the deleted folder's parent; bookmarks in the folder (and its descendants) are cascade-deleted. 204 / 404. Added in #008. |
| GET | `/api/tags` | List every tag with usage counts: `[{id, name, usageCount}]`. Used by the categorize UI's autocomplete `<datalist>`. Added in #008. |
| GET | `/api/search` | Full-text + fuzzy search. Query params: `q` (free text, supports prefix + fuzzy), `folder` (folder id), `tag` (tag id), `from` (ISO 8601 date lower bound), `to` (upper bound), `page` (1-based), `perPage` (1–200, default 50). Returns `{mode: 'fts5' \| 'fuzzy' \| 'empty', query, results: [{id, url, title, folderPath, createdAt, tags, snippet}], totalCount}`. Snippet contains `<mark>` tags around matched terms. Added in #009. |
| GET | `/search` | Server-rendered HTML search page with filter dropdowns (folder, tag) + date inputs + search input. Same query params as `/api/search`. Deep-linkable (`/search?q=postgres&folder=…`). The page includes a `<script src="/static/search.js" defer>` for live search-as-you-type. Added in #009. |
| GET | `/static/categorize.js` | Browser-side JavaScript for the categorize UI (inline title edit, folder picker, tag add/remove, sidebar create + rename, delete). Vanilla JS, no build step. Added in #008. |
| GET | `/static/search.js` | Browser-side JavaScript for the search UI (debounced search-as-you-type at 150ms; fetches `/api/search`; renders results inline without page reload). Vanilla JS, no build step. Added in #009. |

Example:

```bash
# Create a token via Basic auth
curl -u you:secret -X POST -H "Content-Type: application/json" \
  -d '{"label":"Chrome extension"}' \
  http://ubuntu-server:8080/api/tokens

# Use the returned token to call the API
curl -H "Authorization: Bearer THE_TOKEN_FROM_ABOVE" \
  http://ubuntu-server:8080/api/folders
```

## Tests

```bash
pnpm test          # unit + integration suite (Vitest)
pnpm test:watch    # watch mode
pnpm typecheck     # tsc --noEmit
pnpm smoke         # end-to-end smoke against a fresh server (boots isolated DB, runs HTTP flow)
```

The unit + integration suite covers:
- Auth header parsers (`parseBasicAuth`, `parseBearerAuth`)
- Database wrapper (`exec` / `run` / `all<T>` / `get<T>` / `transaction`)
- Migrations runner (applies cleanly, idempotent on re-run, FK cascades, FTS triggers)
- Token store CRUD (in-memory and JSON file, including concurrent writes)
- Bearer auth roundtrip (create → hash → validate, invalid rejected, revoked rejected)
- `/api/tokens` JSON API + `/settings` HTML UI
- Folder tree builder (read + write directions), bookmark differ, sync orchestrator
- Activity feed query + HTML render (including categorize UI markers)
- Tag normalizer (case, whitespace, unicode, dedupe) + tag CRUD + `/api/tags`
- Single-bookmark CRUD (update / move / delete)
- SearchQueryBuilder (FTS5 tokenization, escaping, filters, trigram extraction)
- Search orchestrator (FTS5 + fuzzy fallback + 1000-bookmark <200ms perf) + `/api/search` + `/search` HTML
- Static asset handler (serves `categorize.js` + `search.js`)

The smoke script (`scripts/smoke.sh`) boots an isolated server in a temp data dir, runs a 99-bookmark fixture sync that mirrors the extension's payload shape, walks the activity feed → search → categorize flows, and asserts the expected state at each step. Use it for release verification or after touching any wire-layer code.

## What's here

```
server/
├── migrations/
│   └── 001_initial.sql            # v1 schema (issue #003)
├── scripts/
│   └── smoke.sh                   # (issue #010) end-to-end smoke against a fresh isolated server
├── static/
│   ├── categorize.js              # (issue #008) vanilla JS categorize UI
│   └── search.js                  # (issue #009) vanilla JS search-as-you-type
├── src/
│   ├── index.ts                   # entry: loadConfig → JsonTokenStore → DB → runMigrations → createApp → @hono/node-server
│   ├── env.ts                     # DASHBOARD_PASSWORD + DATA_DIR + DB_PATH + PORT/HOSTNAME; bcrypt-hashes password
│   ├── auth.ts                    # unified auth middleware (Basic + Bearer) + header parsers
│   ├── token.ts                   # token generate/hash/verify + SHA-256 lookup hash
│   ├── token-store.ts             # TokenStore iface, InMemoryTokenStore, JsonTokenStore
│   ├── api-tokens.ts              # JSON API for /api/tokens
│   ├── settings-view.ts           # server-rendered HTML for /settings
│   ├── db.ts                      # Database wrapper over better-sqlite3
│   ├── migrations.ts              # migration runner
│   ├── folders.ts                 # /api/folders handler + read-direction tree builder
│   ├── folder-tree-builder.ts     # (issue #005) write-direction deep module: validate + topological-sort incoming tree
│   ├── bookmark-differ.ts         # (issue #006) pure diff: incoming tree + DB state → minimal CRUD ops
│   ├── sync.ts                    # (issues #005 + #006) applySync: buildSyncPlan → BookmarkDiffer → transactional apply
│   ├── bookmarks.ts               # /api/bookmarks/sync POST + #008 update/move/delete endpoints
│   ├── tags.ts                    # (issue #008) tag storage helpers + /api/tags GET endpoint
│   ├── tag-normalizer.ts          # (issue #008) pure: lowercase + trim + dedupe (case-insensitive) + slugify (unicode-aware)
│   ├── activity-feed.ts           # (issue #007) queryFeed + queryBookmark + HTML renderers + activity-feed/detail API sub-apps; (issue #008) adds categorize HTML controls + datalists
│   ├── static-handler.ts          # (issues #008 + #009) tiny static-asset handler (serves categorize.js + search.js)
│   ├── search-query-builder.ts    # (issue #009) pure: buildFtsMatchQuery + buildFtsSearchQuery + buildCandidateFetchQuery + extractTrigrams
│   ├── search.ts                  # (issue #009) orchestrator: searchBookmarks (FTS5 + fuzzy fallback) + /api/search + /search page + recomputeTrigramsForBookmark
│   ├── app.ts                     # Hono app factory: wires all routes
│   ├── auth.test.ts               # header parsers
│   ├── tokens.test.ts             # store, bearer auth, JSON API, settings UI
│   ├── migrations.test.ts         # Database wrapper + migrations runner
│   ├── folders.test.ts            # buildTree unit tests + /api/folders HTTP tests
│   ├── folder-tree-builder.test.ts # (issue #005) 18 unit tests for buildSyncPlan
│   ├── bookmark-differ.test.ts    # (issue #006) 20 unit tests for diffIncoming
│   ├── sync.test.ts               # (issues #005 + #006) 13 integration tests for applySync
│   ├── bookmarks.test.ts          # (issues #005 + #006 + #008) 41 HTTP tests for sync POST + update + move + delete
│   ├── activity-feed.test.ts      # (issue #007) 30 tests for queryFeed, queryBookmark, and HTML renderers
│   ├── tag-normalizer.test.ts     # (issue #008) 26 tests for case / whitespace / unicode / dedupe
│   ├── tags.test.ts               # (issue #008) 21 tests for tag CRUD + /api/tags endpoint
│   ├── static-handler.test.ts     # (issues #008 + #009) 3 tests for /static/{categorize,search}.js serving
│   ├── search-query-builder.test.ts # (issue #009) 35 tests for SQL building, escaping, filters, trigram extraction, clamping
│   ├── search.test.ts             # (issue #009) 36 tests for orchestrator + /api/search + /search HTML + 1000-bookmark <200ms perf + sync hooks populate trigrams
│   └── home.test.ts               # (issues #007 + #008) 19 tests for GET / feed page (sidebar + activity + 1000-bookmark <500ms smoke + pagination + categorize UI markers including data-remove-tag) + GET /bookmarks/:id (404, content, auth, categorize UI markers)
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

## What's NOT here yet

These are intentional v1 deferrals (see ADR-008 and the PRD's "Out of Scope" section):

- **Token storage in SQL** — currently still JSON at `data/tokens.json`. Migrating to a SQL table would mean rewriting ~150 lines of token-store + token-API tests; not worth the churn while the JSON file is serving correctly. Tracked but not scheduled.
- **JSON API counterparts for the HTML pages** (e.g. `GET /api/bookmarks` for machine consumers). The extension talks to the bulk sync endpoint; nothing else needs JSON access to the feed right now.
- **Browser-side tests for `categorize.js` and `search.js`**. The JS is verified by `node --check` + the smoke script's assertions that the assets are served + the data-attribute hooks they target. Full Playwright headless tests are deferred (the project's `e2e-testing` skill has the scaffolding; we just haven't wired it up).
- **Write-back to Chrome** — v2 (ADR-008). The `write-tracker.js` in the extension has the scaffolding for it.
- **Browsing history / YouTube** — v2 / v3 (ADR-008).
