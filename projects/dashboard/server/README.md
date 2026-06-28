# Dashboard Server

Hono server for the personal dashboard. v1 covers server skeleton + HTTP Basic auth + Bearer-token API + `/settings` for token management + SQLite schema + folder read API; the activity feed, bookmarks, tags, and search land in later issues.

> **Scope of this folder today:** issues #001–#003. See [`docs/35-issues/`](../../docs/35-issues/) and [`docs/35-prds/PRD-001-v1-chrome-bookmarks.md`](../../docs/35-prds/PRD-001-v1-chrome-bookmarks.md).

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
| GET | `/` | Placeholder home page |
| GET | `/health` | `{"status":"ok"}` |
| GET | `/settings` | Token list + generate form |
| POST | `/settings/tokens` | Create token; renders the plaintext exactly once |
| POST | `/settings/tokens/:id/revoke` | Revoke from UI; redirects to `/settings` |

### JSON

| Method | Path | Response |
|--------|------|----------|
| GET | `/api/tokens` | `{"tokens": [{"id","label","createdAt","lastUsedAt"}, ...]}` — never the plaintext |
| POST | `/api/tokens` | 201 + `{...record, "plaintext": "..."}` — plaintext shown exactly once |
| DELETE | `/api/tokens/:id` | 204 on success; 404 if id is unknown |
| GET | `/api/folders` | Nested folder tree; `[]` if no folders |

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
pnpm test          # one run
pnpm test:watch    # watch mode
pnpm typecheck     # tsc --noEmit
```

The suite covers:
- Auth header parsers (`parseBasicAuth`, `parseBearerAuth`)
- Database wrapper (`exec` / `run` / `all<T>` / `get<T>` / `transaction`)
- Migrations runner (applies cleanly, idempotent on re-run, FK cascades, FTS triggers)
- Token store CRUD (in-memory and JSON file, including concurrent writes)
- Bearer auth roundtrip (create → hash → validate, invalid rejected, revoked rejected)
- `/api/tokens` JSON API + `/settings` HTML UI
- `/api/folders` HTTP endpoint + tree builder (`buildTree`)

## What's here

```
server/
├── migrations/
│   └── 001_initial.sql       # v1 schema (issue #003)
├── src/
│   ├── index.ts              # entry: loadConfig → JsonTokenStore → DB → runMigrations → createApp → @hono/node-server
│   ├── env.ts                # DASHBOARD_PASSWORD + DATA_DIR + DB_PATH + PORT/HOSTNAME; bcrypt-hashes password
│   ├── auth.ts               # unified auth middleware (Basic + Bearer) + header parsers
│   ├── token.ts              # token generate/hash/verify + SHA-256 lookup hash
│   ├── token-store.ts        # TokenStore iface, InMemoryTokenStore, JsonTokenStore
│   ├── api-tokens.ts         # JSON API for /api/tokens
│   ├── settings-view.ts      # server-rendered HTML for /settings
│   ├── db.ts                 # Database wrapper over better-sqlite3
│   ├── migrations.ts         # migration runner
│   ├── folders.ts            # /api/folders handler + inline tree builder
│   ├── app.ts                # Hono app factory (separate from server boot, for tests)
│   ├── auth.test.ts          # header parsers
│   ├── tokens.test.ts        # store, bearer auth, JSON API, settings UI
│   ├── migrations.test.ts    # Database wrapper + migrations runner
│   └── folders.test.ts       # buildTree unit tests + /api/folders HTTP tests
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

## What's NOT here yet

- Token storage backed by SQL (issue #004+) — currently still JSON
- `/api/bookmarks`, `/api/bookmarks/sync` (issues #004, #005, #006)
- Folder write endpoints (issue #005+)
- `FolderTreeBuilder` deep module + tests (issue #005) — currently inline in `folders.ts`
- Activity feed UI, bookmark detail, search bar
- `bookmark_trgm` virtual table (issue #009)

These land in the next batch of issues under `docs/35-issues/`.
