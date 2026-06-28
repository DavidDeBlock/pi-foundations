# [PRD] Dashboard v1 — Read-only Chrome bookmarks + categorize + search

**Labels**: `parent-prd`, `v1`
**Date**: 2026-06-28
**Status**: Draft

## Problem Statement

The user has years of Chrome bookmarks organized in folders, but no good way to:

- See all bookmarks in one chronological view (Chrome's UI is folder-first, not time-first)
- Tag bookmarks across multiple categories (Chrome folders are single-parent only)
- Search across titles, URLs, and tags with typo tolerance
- Customize the organization without manually dragging bookmarks around in Chrome

The dashboard should provide a personal, self-hosted view of the user's Chrome bookmarks with better organization and search than Chrome itself offers — without exposing data to the public internet.

The full feature set also includes write-back to Chrome, browsing history, and YouTube saves (see ADRs 002, 003, 005, 006). v1 deliberately defers all of those to v2/v3 (ADR-008) to ship something usable first.

## Solution

**Dashboard v1** — a self-hosted web app that:

- **Mirrors Chrome's folder tree** on first sync so the user's existing organization is preserved
- **Shows a recent activity feed** — chronological list of bookmarks, sortable by date — as the default landing view
- **Lets the user categorize** — move bookmarks between folders, add/remove tags
- **Lets the user search** with full-text + fuzzy match — exact words and typo-tolerant
- **Authenticates with a single password** for the human (browser-stored HTTP Basic), **API token** for the extension (Bearer)
- **Receives bookmarks via a Chrome extension** that POSTs to a JSON API

All data lives in a single SQLite file on the user's Ubuntu server. No cloud, no external services, no third-party auth.

## User Stories

### Setup & auth

1. As a user, I can install the dashboard server with a single command, so deployment is one step.
2. As a user, I set a password via environment variable on first boot, so the password is never transmitted in plaintext during setup.
3. As a user, I visit the dashboard URL, log in with my password, and the browser remembers it forever, so I never see the login screen again.
4. As a user, I can generate an API token from the dashboard settings page, so I can paste it into the extension.
5. As a user, I can revoke and rotate my API token at any time, so a leaked token can be cut off.

### Chrome extension

6. As a user, I install the extension via Chrome's "load unpacked" feature, so no Chrome Web Store friction for v1.
7. As a user, I paste the API token into the extension's options page, so the extension can authenticate.
8. As a user, the extension reads my bookmarks via the standard browser API on first run, so the dashboard seeds its folder structure from my existing organization.
9. As a user, the extension pushes all bookmarks to the dashboard in one batch on first sync, so the dashboard is populated within ~30 seconds.
10. As a user, the extension listens for bookmark change events (created, changed, removed, moved), so any bookmark change I make in Chrome flows to the dashboard in real time.
11. As a user, the extension tags its own writes with a "from extension" marker, so feedback loops are impossible.

### Browse bookmarks

12. As a user, the dashboard's landing page is a recent activity feed (most recent first), so I see what I just saved without clicking through folders.
13. As a user, I can filter the feed by content type (bookmark vs. all), so I can narrow focus.
14. As a user, I can click into any bookmark to see its detail page (title, URL, folder, tags, when added, when last updated).
15. As a user, I can navigate the folder tree in the sidebar, so I can browse by category.
16. As a user, I can create new folders and rename existing folders, so I can reorganize.

### Categorize

17. As a user, I can edit a bookmark's title inline, so typos in titles are easy to fix.
18. As a user, I can move a bookmark to a different folder, so I can reorganize.
19. As a user, I can add tags to a bookmark (autocomplete from existing tags), so multi-axis organization is supported.
20. As a user, I can remove tags from a bookmark, so tags can be cleaned up.
21. As a user, I can create a new tag by typing it and pressing Enter, so I don't need a separate "manage tags" page.
22. As a user, I see tags displayed as chips on each bookmark card, so I can see the categorization at a glance.

### Search

23. As a user, I can type in the search box and see results stream in as I type (debounced ~150ms), so search feels instant.
24. As a user, search matches bookmark titles, URLs, and tag names, so I find what I'm looking for.
25. As a user, search tolerates typos ("postgers" finds "Postgres tips"), so I don't need to remember exact spellings.
26. As a user, I can filter search results by folder, tag, and date range, so I can narrow down.
27. As a user, search results show the matched snippet highlighted, so I can see why each result matched.

## Implementation Decisions

### Tech stack (per ADR-Q9 / grill decisions)

- **Server**: Hono framework on Node.js (or Bun if available). Lightweight, TypeScript-native, fast cold start.
- **DB**: SQLite via `better-sqlite3`. Synchronous, file-based, fast for personal scale.
- **UI**: Server-rendered HTML with HTMX for interactivity. No client-side framework. No build step.
- **Search**: SQLite FTS5 + trigram virtual tables. Exact match + fuzzy/typo-tolerant.

### Modules (per step-2 sketch)

**Deep modules** (encapsulate complex logic; unit-tested in isolation):

| Module | Purpose | Interface (sketch) |
|--------|---------|---------------------|
| `FolderTreeBuilder` | Builds nested folder/bookmark tree from flat path list | `build(paths) → TreeNode` |
| `BookmarkDiffer` | Diffs incoming Chrome tree against DB state, produces minimal CRUD ops | `diff(incoming, current) → Ops[]` |
| `SearchQueryBuilder` | Builds FTS5 SQL from query + filters + pagination | `build(query, filters) → { sql, params }` |
| `TokenValidator` | Bcrypt token comparison with constant-time check | `validate(rawToken, hashedToken) → boolean` |
| `TagNormalizer` | Lowercases, trims, dedupes, slugifies tag names | `normalize(raw) → canonical` |

**Thin orchestrators** (compose deep modules; covered by integration tests):

- `SyncHandler` — calls `BookmarkDiffer` then writes to DB
- `SearchHandler` — calls `SearchQueryBuilder` then runs query
- `AuthMiddleware` — wraps `TokenValidator` into Hono middleware

**External-facing modules** (HTTP boundaries; covered by API tests):

- `BookmarkSyncAPI` — bulk POST endpoint for initial + ongoing extension sync
- `BookmarkAPI` — CRUD endpoints (single bookmark)
- `FolderAPI` — CRUD endpoints for folders
- `SearchAPI` — GET search endpoint
- `SettingsAPI` — token management endpoints

**UI modules** (server-rendered HTML; covered by E2E tests or manual smoke tests):

- `ActivityFeedView` — recent bookmarks list (default landing)
- `BookmarkDetailView` — single bookmark
- `FolderTreeSidebar` — folder navigation
- `SearchBar` — autocomplete / search

**Chrome extension modules** (out-of-process; covered by integration tests):

- `BookmarkPusher` — POSTs to server API
- `EventListener` — subscribes to bookmark change events, triggers `BookmarkPusher`
- `TokenStorage` — wrapper around the extension's local storage

**Storage modules:**

- `Database` — `better-sqlite3` wrapper with typed query helpers
- `Migrations` — schema migration runner

### Schema (per data model decisions)

| Table | Purpose | Key fields | Notable |
|-------|---------|-----------|---------|
| `folders` | Mirrors Chrome's folder tree | `id`, `parent_id` (self-ref), `name`, `chrome_id` (nullable) | Recursive parent_id allows arbitrary nesting |
| `bookmarks` | Each bookmark row | `id`, `url`, `title`, `folder_id`, `chrome_id` (unique), `created_at`, `updated_at`, `last_seen_at` | One folder per bookmark (single-parent) |
| `tags` | Unique tag names | `id`, `name` (unique) | Normalized via `TagNormalizer` |
| `bookmark_tags` | Many-to-many | `bookmark_id`, `tag_id` (composite PK) | Multi-tag per bookmark |
| `api_tokens` | Extension auth | `id`, `token_hash` (bcrypt, unique), `label`, `created_at`, `last_used_at` | Plaintext token shown once; only hash stored |
| `bookmark_fts` (virtual) | FTS5 search index | Tokenized `title`, `url` | Triggered by bookmark writes |
| `bookmark_trgm` (virtual) | Trigram fuzzy search | Tokenized via trigram | Catches typos |

### API contracts

All `/api/*` routes require `Authorization: Bearer <token>` (extension) or HTTP Basic (UI).

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/bookmarks/sync` | Bulk upsert from extension (initial + ongoing) |
| POST | `/api/bookmarks/:id` | Update one bookmark |
| DELETE | `/api/bookmarks/:id` | Delete one bookmark |
| POST | `/api/bookmarks/:id/move` | Move to another folder |
| GET | `/api/bookmarks` | List (paginated, filterable) |
| GET | `/api/bookmarks/:id` | Get one |
| GET | `/api/search?q=...&...` | Full-text + fuzzy search |
| GET | `/api/folders` | Tree |
| POST | `/api/folders` | Create |
| PATCH | `/api/folders/:id` | Rename |
| DELETE | `/api/folders/:id` | Delete (reparent children to root) |
| POST | `/api/tokens` | Generate API token (returns plaintext once) |
| GET | `/api/tokens` | List tokens (no plaintext shown) |
| DELETE | `/api/tokens/:id` | Revoke |

### UI surface (server-rendered HTML)

| Path | View |
|------|------|
| `/` | Recent activity feed (default landing) |
| `/bookmarks/:id` | Bookmark detail |
| `/folders/:id` | Folder contents |
| `/search?q=...` | Search results page |
| `/settings` | Password change, token management |

### Architectural decisions (already locked in ADRs)

- **Deployment**: Self-hosted LAN. No cloud. Server runs on the user's Ubuntu server. (ADR-001)
- **Chrome ingestion**: Extension only for ongoing. One-time bulk import deferred to v2. (ADR-002, ADR-008)
- **Categorization**: Folders (hierarchical, single-parent) + tags (flat, multi). Unified. (ADR-004)
- **Auth**: HTTP Basic password (app) + Bearer API token (extension). (ADR-007)
- **Search**: SQLite FTS5 + trigram. (ADR-Q13)
- **Main view**: Recent activity feed. (ADR-Q10)
- **Initial category seeding**: Mirror Chrome's folders verbatim. (ADR-Q11)
- **Data retention**: Forever (no purge job in v1). (ADR-Q14)
- **Tech stack**: Hono + better-sqlite3 + HTMX. (ADR-Q9)

## Testing Decisions

### What makes a good test

A good test exercises **external behavior** — the inputs and outputs of a module as a consumer would use them. It does not test implementation details (which SQLite query ran, which HTMX attribute was used). Tests that depend on implementation get rewritten when the implementation changes; tests on behavior survive.

### Unit tests (Vitest) — for the 5 deep modules

| Module | What to test |
|--------|--------------|
| `FolderTreeBuilder` | Empty input, single root, deep nesting, duplicates, re-parenting, reordering |
| `BookmarkDiffer` | No-op (same tree), pure add, pure delete, pure move, mixed ops, conflict between chrome_id and URL |
| `SearchQueryBuilder` | Plain query, query with quotes (escape), multi-token, filter combinations, empty result, injection attempt |
| `TokenValidator` | Valid token, invalid token, expired token, tampered token, timing-attack resistance (constant-time check) |
| `TagNormalizer` | Mixed case, whitespace, unicode, dedupe case-insensitive, slugify special chars |

### Integration tests (Vitest + Hono test client) — for thin orchestrators + APIs

- `SyncHandler` end-to-end against in-memory DB
- `SearchHandler` end-to-end against in-memory DB with seeded data
- `AuthMiddleware` rejects missing/invalid tokens, accepts valid
- API contract: each endpoint returns the documented shape for the documented inputs

### Manual / smoke tests

- Server boots cleanly with default config
- Extension syncs 100+ real bookmarks from a real Chrome profile
- Folder tree in dashboard matches Chrome's tree exactly
- Search returns expected results for hand-picked queries (including typos)
- Edit / move / tag flows work end-to-end
- Token revoke immediately cuts off the extension

### Prior art

- cozy-ledger uses Vitest for similar unit-test patterns on its small modules.
- e2e/ in pi-foundations has a Playwright + Page Object Model setup that we can copy when E2E tests are needed (deferred to v2).

### What's NOT tested in v1

- **Visual regression** — no snapshot tests
- **Performance benchmarks** — only the smoke-test latency checks
- **E2E browser tests** — Playwright in v2 once UI surface stabilizes

## Out of Scope

- **Write-back to Chrome** (changes in dashboard don't push to Chrome). v2. (ADR-008)
- **Chrome browsing history** (no import, no display). v2. (ADR-008)
- **YouTube saves** (no YouTube Data API integration). v3. (ADR-008)
- **YouTube history** (no Takeout import). v3. (ADR-008)
- **Bulk operations** (multi-select / batch move / batch tag). Defer to v1.5 if needed.
- **Multi-user / sharing**. Only one user, ever. (ADR-007)
- **Mobile-optimized UI**. Works on mobile but desktop-first for v1.
- **Dark mode**. Not in v1.
- **Backup automation**. SQLite file lives on the server; user backs up the server. (ADR-001)
- **Telemetry / analytics**. None.
- **Internationalization**. English UI only in v1.

## Further Notes

- The Chrome extension lives alongside the server in the same project (no separate workspace unless it grows).
- v1 ships when all 7 acceptance criteria (below) pass.
- v2 (write-back + history) and v3 (YouTube) get their own PRDs after v1 is in use.
- Schema changes after v1 go through numbered migrations in a `migrations/` location. v1 starts with a single initial migration.

### Acceptance Criteria (for "v1 is done")

These map directly to the issue tracker tickets that `to-issues` will create.

1. **Server boots and authenticates** — server starts via single command; HTTP Basic auth gates the dashboard; wrong password returns 401; correct password loads the page.
2. **API token generation works** — user can generate token from settings; token shown once; bcrypt-hashed in storage; token can be revoked; valid token authenticates API calls.
3. **Extension installs and connects** — extension loads unpacked; options page accepts token + server URL; saved options validate against server; invalid token shows clear error.
4. **Folder tree seeds from Chrome** — first sync receives full tree; server creates folders recursively; server creates bookmarks linked to folders; dashboard sidebar reflects tree within 5 seconds.
5. **Recent activity feed works** — landing page shows bookmarks reverse-chronological; loads in <500ms with 1,000 bookmarks; each item shows title, URL, folder, date added, tags; click opens detail.
6. **Categorize (folders + tags) works** — inline title edit; folder picker for move; tag autocomplete + create-on-the-fly; tag remove via ×; folder create + rename from sidebar.
7. **Search works** — search box always visible in header; results stream on type (debounced 150ms); matches title + URL + tags; typos tolerated via trigram; filter by folder + tag + date range; matched snippet highlighted; <200ms response against 1,000 bookmarks.

### References

- [ADR-001](../40-decisions/001-deployment-self-hosted.md)
- [ADR-002](../40-decisions/002-chrome-ingestion-extension.md)
- [ADR-004](../40-decisions/004-categorization-folders-tags.md)
- [ADR-007](../40-decisions/007-auth-password-and-token.md)
- [ADR-008](../40-decisions/008-mvp-scope.md)
- [ADR-Q9](../CONTEXT.md#open-questions) — tech stack (in CONTEXT.md until promoted to ADR)
- [ADR-Q10](../CONTEXT.md#open-questions) — main view
- [ADR-Q11](../CONTEXT.md#open-questions) — initial category seeding
- [ADR-Q13](../CONTEXT.md#open-questions) — search backend
- [ADR-Q14](../CONTEXT.md#open-questions) — data retention