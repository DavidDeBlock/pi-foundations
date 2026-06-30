# [PRD] Email mirror — Gmail read-only sync with local LLM access

**Labels**: `parent-prd`, `email`
**Date**: 2026-06-29
**Status**: Draft

## Problem Statement

The user has over 20 years of email split across Gmail and Outlook, and today there is no good way to:

- **See all mail in one chronological view.** Gmail and Outlook are both folder-first; the user's mental model is time-first ("what came in last week").
- **Search across both providers with one query.** "What did Sarah say about the launch" requires opening Gmail, searching, opening Outlook, searching, reconciling manually.
- **Tag mail across projects.** Gmail labels are single-axis (one label per thread, no nested meaning) and provider-scoped. A "Q4 launch" tag would need to be re-created in Outlook.
- **Reason over the email corpus with an LLM.** Today's options are (a) paste emails into a chat one at a time, or (b) grant a third-party AI service full read access to live mail. Neither is durable.
- **Keep email private.** Local-first mirror + local LLM means email content never leaves the user's network for AI analysis.

The dashboard should provide a local, read-only mirror of the user's Gmail (and later Outlook) with first-class LLM access — query, semantic search, summarize, answer questions — **without the dashboard or the LLM ever mutating live mail**. The mirror is one-way: Gmail/Outlook → dashboard, never the reverse.

## Solution

**Email mirror** — a slice of the existing dashboard that:

- **Pulls Gmail into the dashboard's SQLite** via a background sync worker (initial 90-day window, then incremental). Sync runs on-demand via a "Refresh" button AND on a 5–15 minute background poll.
- **Mirrors Gmail labels read-only** and **layers dashboard-only tags on top** for cross-provider organization. Tags are dashboard-private; they survive re-sync because they're keyed by Gmail's stable message ID.
- **Exposes the mirror to an LLM via a typed tool surface**: `query_emails`, `semantic_search_emails`, `get_email`, `get_thread`. The LLM has no tools that touch live Gmail — read-only is enforced by what's *absent* from the surface, not by runtime checks.
- **Surfaces LLM access** via a per-email **"Summarize this thread"** button on day one. A chat box follows in a later slice of the same PRD.
- **Runs the LLM via an OpenAI-compatible client.** Base URL + model + API key come from env vars, so the same code runs against cloud providers during development and a local llama.cpp server later — zero code change at swap time.
- **Preserves local actions across re-syncs.** "Delete" in the dashboard is soft-delete (`hidden_at` flag); sync uses UPSERT and never touches the local-state columns.

All data lives in the existing SQLite file on the user's Ubuntu server. No cloud, no third-party auth beyond OAuth with the user's own Gmail account.

## User Stories

### Setup & auth (Gmail only in v1, Outlook in a later slice)

1. As a user, I visit the dashboard's `/settings/email` page and click "Connect Gmail," so the OAuth flow is discoverable in one obvious place.
2. As a user, I am redirected to Google's consent screen with the **narrowest possible scope** (`gmail.readonly`), so I am not granting the dashboard the ability to delete, archive, label, or send mail.
3. As a user, after granting consent I land back on `/settings/email` and see "Gmail connected" with my Gmail address, so the round-trip is verified before sync starts.
4. As a user, the dashboard stores the OAuth refresh token securely (encrypted or bcrypt-protected), so I do not have to re-authorize every few hours when the access token expires.
5. As a user, I can disconnect Gmail from the same settings page, which revokes the token and stops future syncs, so I retain full control over the connection.

### Sync

6. As a user, the first sync pulls **the last 90 days of mail** (configurable), so I see useful recent history quickly without waiting hours for a full-history import.
7. As a user, the sync runs **idempotently** — re-running the same sync against the same DB state produces zero writes, so accidental re-triggers are harmless.
8. As a user, I see a sync progress indicator during the initial sync ("synced 1,247 / 8,300 messages"), so I know the system is working and how long it will take.
9. As a user, if sync fails mid-run (network drop, rate limit), it **resumes from the last successful page** on the next attempt, so I do not lose progress or re-process messages.
10. As a user, an automatic **background poll runs every 5–15 minutes** (configurable via env var), so new mail appears in the dashboard without me clicking anything.
11. As a user, I can also click a **"Refresh" button** to trigger an immediate sync, so I do not have to wait for the next background poll when I want fresh mail now.

### Browse emails

12. As a user, the email compartment shows a **chronological list of emails** (most recent first), matching the existing dashboard's "time-first" model.
13. As a user, I can filter by **Gmail label** (Inbox, Sent, Starred, custom labels), so I can narrow focus the same way I would in Gmail.
14. As a user, I can filter by **unread / read**, so I can see what needs my attention.
15. As a user, I can filter by **sender** (autocomplete from history), so "Sarah's mail" is one click.
16. As a user, I can **click an email** to see its detail view — full plain-text body, headers, thread context — so I can read mail without leaving the dashboard.
17. As a user, I can **view a thread** (all messages in a conversation, chronological), so I can follow the back-and-forth without losing context.

### Categorize (dashboard-only)

18. As a user, I can **add dashboard-only tags** to an email (e.g. `#launch`, `#waiting-on-sarah`), so I can organize across providers and across projects in a way Gmail labels cannot.
19. As a user, I can **remove a dashboard tag** from an email, so tags can be cleaned up.
20. As a user, dashboard tags **survive re-syncs** — even after the background poll pulls the same email again, my tags are still there.
21. As a user, I can **filter the email list by dashboard tag**, so `#waiting-on-sarah` surfaces everything I owe a response to.

### Soft-delete (hide / unhide)

22. As a user, I can **hide an email** from my dashboard view, so I can clear visual noise without touching live Gmail.
23. As a user, hidden emails **stay hidden across re-syncs** — the sync UPSERT does not overwrite the `hidden_at` flag.
24. As a user, hidden emails are also **invisible to the LLM** — when I ask "what did Sarah say last week," the LLM does not see what I have marked hidden.
25. As a user, I can **unhide** an email from a "Hidden" view, so the action is reversible.
26. As a user, if an email is **deleted in Gmail itself**, the next sync removes it from the mirror — including any local tags and hidden flag, because there is nothing left to mirror.

### Search (no LLM)

27. As a user, I can **search emails by free-text** (subject + body + sender), with typo tolerance via FTS5 + trigram, matching the existing dashboard search experience.
28. As a user, I can **combine text search with filters** (sender, label, unread, date range), so I can narrow down precisely.
29. As a user, search results show the **matched snippet highlighted**, so I can see why each result matched.
30. As a user, search is **fast** (<200ms against 10,000 emails), so it feels instant.

### LLM access

31. As a user, when I open an email I see a **"Summarize this thread" button**, so I can get a 3-bullet summary, key dates, and action items without reading every message.
32. As a user, the summary **cites the messages it drew from** (sender + date), so I can verify and dig deeper.
33. As a user, the LLM **never sees live Gmail** — only the local mirror. The LLM's tool surface has no `send_email`, `delete_email`, `archive_email`, `label_email`, or any mutating tool.
34. As a user, when the LLM answers a question ("what did Sarah say about the launch last week?"), it **cites the specific emails** it used, so I can click through and verify.
35. As a user, the LLM does not see emails I have hidden — the tool queries filter `WHERE hidden_at IS NULL`.
36. As a user, I can configure the LLM **via env vars** (provider, base URL, model, API key), so swapping providers is a config change, not a code change.
37. As a user, when I later set up a local llama.cpp server, I change two env vars and restart — the same code that ran against OpenAI now runs locally, keeping email content on my network.
38. As a user, the LLM tool surface is **typed** (each tool has a documented JSON schema for arguments and return shape), so the model reliably calls the right tool with the right arguments.

### Resilience & operations

39. As a user, **Gmail API rate limits** (429 responses) trigger exponential backoff and resume, not a hard failure, so a busy sync does not abort on the first throttling.
40. As a user, **OAuth token expiry** is handled transparently — the refresh token is used to get a new access token without my involvement, so sync does not silently break.
41. As a user, the **sync state is observable**: I can see per-account "last sync at," "next sync at," and "messages synced" so I know the system is healthy.
42. As a user, **no email content leaves my network for LLM analysis** when using a local model — the OpenAI-compatible client talks to llama.cpp on localhost, so privacy is structural, not promised.

### Multi-provider (Outlook in a later slice of this PRD)

43. As a user, the architecture supports **multiple email providers** behind a shared `EmailClient` interface, so adding Outlook is a new client implementation, not a redesign.
44. As a user, when Outlook support lands, **the same LLM tools work across providers** — `query_emails({ from: 'sarah@...' })` returns Sarah's mail whether it lives in Gmail or Outlook.

## Implementation Decisions

### Tech stack

- **Email APIs**: Google Gmail API (REST) for Gmail; Microsoft Graph for Outlook (later slice). Both wrapped behind a shared `EmailClient` interface.
- **OAuth**: Google OAuth 2.0 with `gmail.readonly` scope. Stored as refresh token + encrypted access token. Auto-refresh on 401.
- **DB**: Existing `better-sqlite3` SQLite. New migrations for email tables.
- **Search**: SQLite FTS5 + trigram (already in use for bookmarks). Reused for emails.
- **LLM client**: One `OpenAiCompatibleClient` class. POSTs to `{baseUrl}/chat/completions` with OpenAI's JSON shape. Works against OpenAI, Anthropic-via-shim, llama.cpp server, LM Studio, vLLM, OpenRouter.
- **UI**: Server-rendered HTML consistent with existing dashboard patterns (no client framework, ~30 lines of vanilla JS where needed).

### Modules

**Deep modules** (encapsulate complex logic; unit-tested in isolation):

| Module | Purpose | Interface (sketch) |
|--------|---------|---------------------|
| `GmailClient` | OAuth + Gmail REST API. Returns typed `RawEmail[]`. | `listMessages({ since, pageToken }) → { messages, nextPageToken }` · `getMessage(id) → RawEmail` · `getThread(id) → RawEmail[]` |
| `OutlookClient` (later) | OAuth + Microsoft Graph. Same interface as `GmailClient`. | Same shape, different transport |
| `EmailSyncWorker` | Orchestrates fetching + UPSERTing + cursor persistence. | `sync({ accountId }) → { added, updated, removed, cursor }` |
| `EmailDiffer` | Diffs incoming emails from API against DB state. | `diff(incoming, dbState) → { upserts, removes }` |
| `EmailQueryBuilder` | Builds SQL for the `query_emails` LLM tool. | `build({ from, to, since, until, label, unread, limit }) → { sql, params }` |
| `EmailSearcher` | Wraps FTS5 query over emails. | `search({ query, filters }) → EmailSummary[]` |
| `EmailRetriever` | `get_email`, `get_thread` — fetches full body for LLM context. | `getById(id) → EmailDetail` · `getThread(threadId) → EmailDetail[]` |
| `LlmClient` (OpenAI-compatible) | Wraps `/v1/chat/completions` with tool calling. | `chat({ messages, tools }) → { content, toolCalls }` |
| `ToolRegistry` | Exposes typed email tools to the LLM (JSON schemas). | `getToolSchemas() → ToolSchema[]` · `execute(name, args) → result` |
| `PromptBuilder` | System prompt for "summarize this thread" + chat persona. | `summarizeThread(thread) → messages[]` · `chatSystem() → string` |

**Thin orchestrators** (compose deep modules; integration-tested):

- `EmailSyncHandler` — wires `GmailClient` + `EmailSyncWorker` + `EmailDiffer` to the sync route
- `EmailChatHandler` — runs the LLM tool-calling loop (`while (toolCall) { execute(toolCall); appendResult(); chat() }`)
- `SummarizeEmailHandler` — single-shot: `getThread + PromptBuilder + LlmClient`

**External-facing modules** (HTTP boundaries; API-tested):

- `EmailOAuthAPI` — start OAuth flow, handle callback, store tokens
- `EmailSyncAPI` — `POST /api/email/sync` (manual refresh trigger)
- `EmailAPI` — `GET /api/email`, `GET /api/email/:id`, `GET /api/email/thread/:threadId`, `GET /api/email/search`
- `EmailTagsAPI` — `POST /api/email/:id/tags`, `DELETE /api/email/:id/tags/:tag`, `GET /api/email/tags`
- `EmailVisibilityAPI` — `POST /api/email/:id/hide`, `POST /api/email/:id/unhide`
- `EmailLlmAPI` — `POST /api/email/:id/summarize` (one-shot), `POST /api/email/chat` (multi-turn, later slice)
- `EmailSettingsAPI` — list connected accounts, disconnect

**UI modules** (server-rendered HTML, production routes from day one — no preview phase):

- `EmailInboxView` — chronological list at `/email` with filters (provider, label, unread, sender, dashboard tags)
- `EmailDetailView` — single email at `/email/:id` with thread context + actions (hide, tag, summarize)
- `EmailThreadView` — full thread at `/email/thread/:threadId`, chronological
- `EmailHiddenView` — list of hidden emails at `/email/hidden` (for unhide)
- `EmailFiltersBar` — provider / label / unread / sender / dashboard-tag filters
- `EmailLlmPanel` — "Summarize this thread" button (and chat input, later slice) embedded in detail view
- `EmailSettingsView` — connect/disconnect Gmail, configure sync window, at `/settings/email`

**Storage modules** (extend existing `Database` wrapper):

- `EmailSchema` — new migrations for email tables
- `SyncStateStore` — read/write sync cursor + last-sync timestamp per account

### Schema

| Table | Purpose | Key fields | Notable |
|-------|---------|-----------|---------|
| `email_accounts` | One row per connected Gmail account | `id`, `provider` ('gmail'), `email_address`, `access_token_enc`, `refresh_token_enc`, `token_expires_at`, `connected_at`, `last_sync_at`, `history_id` | Tokens encrypted at rest; refresh on expiry |
| `emails` | The mirror — one row per Gmail message | `id` (Gmail message ID, stable), `thread_id`, `account_id`, `subject`, `sender`, `sender_email`, `to_addrs` (JSON), `cc_addrs` (JSON), `received_at`, `snippet`, `body_plain` (TEXT), `is_unread`, `labels` (JSON), `synced_at` | Primary key is Gmail's stable ID → UPSERT is safe |
| `email_tags` | Dashboard-only tags | `email_id`, `tag` (composite PK) | Sync never touches this table; tags are pure user data |
| `email_fts` (virtual) | FTS5 search index | Tokenized `subject` + `body_plain` + `sender` + `sender_email` | Triggered by email writes |
| `email_trgm` (virtual) | Trigram fuzzy search | Tokenized same fields | Catches typos |
| `sync_state` | Cursor + last-sync timestamp per account | `account_id`, `provider`, `last_history_id`, `last_sync_at`, `last_page_token`, `in_progress` | Resume on failure; prevents re-processing |

**Local-state columns** (sync UPSERT must NOT touch):
- `hidden_at` — soft-delete flag; NULL = visible, non-NULL = hidden
- (No "pinned" or other local-state columns in v1; add when needed)

### UI routes (production from day one — no preview phase)

Email lives in the production nav from slice 4 onwards. The sidebar gets an "Email" entry that links to `/email`. The existing hardcoded email fixture in `/preview/v2` is **removed** once slice 4 lands, because email is now a real route, not a preview tab.

| Path | View |
|------|------|
| `/email` | Inbox — chronological list with filters |
| `/email/:id` | Email detail — full body, thread context, actions |
| `/email/thread/:threadId` | Full thread, chronological |
| `/email/hidden` | Hidden emails (for unhide) |
| `/settings/email` | Connect/disconnect Gmail, sync window config |

### API contracts

All `/api/email/*` routes require standard dashboard auth (HTTP Basic for UI, Bearer token for service callers).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/email/oauth/start` | Begin Gmail OAuth flow; redirect to Google |
| GET | `/api/email/oauth/callback` | Handle Google redirect; store tokens |
| DELETE | `/api/email/accounts/:id` | Disconnect account; revoke token |
| POST | `/api/email/sync` | Trigger manual sync (optional `account_id` query param) |
| GET | `/api/email` | List emails with filters (`?label=&unread=&from=&since=&until=&tag=&limit=&cursor=`) |
| GET | `/api/email/search?q=...` | FTS5 + trigram search |
| GET | `/api/email/:id` | Get one email (full body) |
| GET | `/api/email/thread/:threadId` | Get full thread |
| POST | `/api/email/:id/hide` | Soft-delete: set `hidden_at = now()` |
| POST | `/api/email/:id/unhide` | Clear `hidden_at` |
| GET | `/api/email/hidden` | List hidden emails (for unhide view) |
| POST | `/api/email/:id/tags` | Add a dashboard tag |
| DELETE | `/api/email/:id/tags/:tag` | Remove a dashboard tag |
| GET | `/api/email/tags` | List all dashboard tags (with counts) |
| POST | `/api/email/:id/summarize` | One-shot LLM: summarize this thread |
| POST | `/api/email/chat` | (Later slice) Multi-turn LLM chat over emails |

### LLM tool surface

The LLM has exactly four tools, all read-only:

```text
query_emails({ from?, to?, subject_contains?, label?, unread?, since?, until?, limit? })
  → EmailSummary[]   // id, thread_id, sender, subject, received_at, snippet, is_unread, labels

semantic_search_emails({ query, top_k? })
  → EmailSummary[]   // v1: FTS5; v2: embeddings if needed

get_email({ id })
  → EmailDetail      // full plain-text body, headers, recipient list

get_thread({ thread_id })
  → EmailDetail[]    // all messages in thread, chronological
```

The LLM **does not have** tools for: `send_email`, `delete_email`, `archive_email`, `label_email`, `apply_tag`, `set_hidden`. The constraint is enforced by absence — the LLM cannot call what is not defined.

### Architectural decisions (newly locked in this PRD)

| Decision | Value | Reference |
|----------|-------|-----------|
| Email ingestion strategy | One-way mirror; OAuth `gmail.readonly`; no modify/send scopes | ADR-009 (to be written) |
| Email categorization | Mirror Gmail labels read-only; dashboard-only tags layered on top | ADR-010 (to be written) |
| LLM integration | OpenAI-compatible client; cloud during dev, local (llama.cpp) later; zero code change at swap | ADR-011 (to be written) |
| Sync trigger | Manual refresh button + background poll (5–15 min); same worker | ADR-012 (to be written) |
| Sync window | 90 days initial (configurable); extendable later via "load more" | ADR-013 (to be written) |
| Soft-delete semantics | `hidden_at` flag; sync UPSERT never overwrites; LLM queries filter `hidden_at IS NULL` | ADR-014 (to be written) |

Existing ADRs that still apply:
- **ADR-001** (deployment): no change — runs on the existing Ubuntu server.
- **ADR-005** (dashboard DB is source of truth): applies to the mirror — dashboard DB is authoritative for local-state columns (`hidden_at`, dashboard tags).
- **ADR-007** (auth): dashboard's password + bearer-token auth unchanged; OAuth tokens for Gmail are stored separately in `email_accounts`.
- **ADR-008** (MVP scope): this PRD extends v1 scope to include email; subsequent slices within this PRD add chat, then digest.

## Testing Decisions

### What makes a good test

A good test exercises **external behavior** — inputs and outputs of a module as a consumer would use them. It does not test implementation details (which SQL query ran, which HTTP header was set). Tests that depend on implementation get rewritten when the implementation changes; tests on behavior survive.

### Unit tests (Vitest) — for the deep modules

| Module | What to test |
|--------|--------------|
| `GmailClient` | Mocked HTTP responses: list returns paginated messages, get returns full message, 401 triggers refresh, 429 triggers backoff |
| `EmailSyncWorker` | Empty inbox, partial state, large inbox with pagination, failure mid-sync (resumes from cursor), UPSERT preserves `hidden_at` and dashboard tags |
| `EmailDiffer` | No-op (no changes), pure adds, pure updates, pure removes (deleted in Gmail), mixed |
| `EmailQueryBuilder` | Empty filters, all filters, date range, sender substring, label exact match, pagination cursor, SQL injection attempt |
| `EmailSearcher` | Plain query, query with quotes, multi-token, typo tolerance (trigram), filter combinations, empty result |
| `EmailRetriever` | Get by id, get thread (ordered), missing id, partial match (some thread messages not yet synced) |
| `LlmClient` | Mocked HTTP: simple chat, tool calling loop, streaming chunks, error responses, base URL config, model param passthrough |
| `ToolRegistry` | Schema correctness, argument validation, tool execution returns documented shape |
| `PromptBuilder` | Stable output structure for summarize, includes citation, includes thread context |

### Integration tests (Vitest + Hono test client + in-memory SQLite)

- `EmailSyncHandler` end-to-end with a mocked `GmailClient` returning fixture messages
- `EmailChatHandler` tool-calling loop: LLM calls `query_emails`, gets results, calls `get_email`, returns final answer
- OAuth callback handler stores encrypted tokens
- All API endpoints return the documented shape for documented inputs

### Mock strategy for Gmail API

- Record/replay fixtures from a real Gmail account (one-time setup, committed to repo as JSON)
- Tests replay the fixtures through a mock `GmailClient` so tests do not hit the network
- A separate smoke test (manual, not CI) hits a real Gmail account to verify the OAuth flow + sync against the live API

### Manual / smoke tests

- OAuth flow round-trip works against a real Gmail account
- Initial 90-day sync completes in <5 minutes for a 5,000-email inbox
- Background poll picks up a new email within 15 minutes of arrival
- "Summarize this thread" returns a coherent 3-bullet summary with citations
- Hiding an email, waiting for a re-sync, then unhiding preserves both the hide and the latest Gmail state
- Adding a dashboard tag survives 5 background polls
- Disconnecting Gmail stops syncs and removes the account row

### Prior art

- `bookmark-differ.ts` test suite — same pattern for diff-then-apply
- `sync.ts` orchestrator tests — same pattern for thin orchestrator over a differ
- `search.test.ts` — same FTS5 + trigram pattern, reusable for emails

### What's NOT tested in v1

- **Visual regression** — no snapshot tests
- **Performance benchmarks** — only smoke-test latency checks
- **E2E browser tests** — defer to a later slice; the existing Playwright setup in `e2e/` can be extended when the UI surface stabilizes
- **Multi-account OAuth** — single Gmail account in v1; multi-account in a later slice
- **Outlook (Microsoft Graph)** — not built in v1

## Out of Scope

- **Sending emails** — no `gmail.send` scope, no compose UI. Deferred indefinitely.
- **Mutating Gmail in any way** — no archive, no label, no mark-read, no delete. The dashboard's only writes to Gmail-adjacent state are local (`hidden_at`, dashboard tags). Gmail is sacred.
- **Outlook (Microsoft Graph)** — v1 of this PRD is Gmail only. Outlook is a same-PRD follow-on slice or a separate PRD. The architecture (`EmailClient` interface) supports it; the implementation is deferred.
- **HTML body rendering** — v1 stores plain-text body only. Rich HTML display (with images, tables, formatting) is a future polish slice.
- **Attachments** — v1 does not sync attachments. They live in Gmail; the dashboard shows "this email has 2 attachments" but does not download them.
- **Multi-account Gmail** (multiple Gmail addresses connected simultaneously) — single account in v1.
- **Real-time push notifications** (Google Pub/Sub + webhook) — polling covers the latency need for personal use. Push would require a public webhook endpoint, which the LAN server does not have.
- **Auto-categorization by AI** — explicitly out per existing project scope (CONTEXT.md). The LLM has read tools only; it cannot tag or categorize on its own. Future opt-in via an `apply_tag` tool.
- **Email composition drafts** — no draft storage, no draft sync. Drafts live in Gmail.
- **Calendar integration** — calendar invites that arrive via email are shown as emails, not parsed into a calendar.
- **Spam filtering** — the mirror reflects Gmail's spam labeling faithfully; no additional filtering is applied.
- **Conversation threading across providers** — Gmail threads stay Gmail threads; Outlook threads stay Outlook threads. No cross-provider thread reconciliation.
- **Daily digest background job** — mentioned in grilling as an optional third entry point; not in this PRD. Add later if the summarize button and chat leave a gap.

## Further Notes

- **Slice order within this PRD** (rough, will be refined in `to-issues`):
  1. Schema migrations + OAuth flow + `GmailClient` + `email_accounts` table
  2. `EmailSyncWorker` + `EmailDiffer` + manual refresh endpoint + initial 90-day sync
  3. `EmailQueryBuilder` + `EmailSearcher` + `EmailRetriever` + read API endpoints
  4. UI: inbox view, detail view, thread view, filters — **production routes (`/email`, `/email/:id`, `/email/thread/:threadId`) from day one**. Sidebar gains an "Email" entry. The hardcoded email fixture in `/preview/v2` is removed in this slice.
  5. Soft-delete: `hidden_at`, hide/unhide endpoints, hidden view (`/email/hidden`)
  6. Dashboard tags: tag CRUD endpoints, tag filter, tag chips in UI
  7. Background poll scheduler + sync state observability
  8. `LlmClient` + `ToolRegistry` + `PromptBuilder` + "Summarize this thread" button
  9. (Same PRD, later slice) Chat box + multi-turn conversation memory
  10. (Same PRD, later slice) Outlook client + multi-provider UI

- **The `/preview/v2` email fixture is removed in slice 4**, since email moves to production routes. The other compartment tabs in `/preview/v2` (bookmarks, YouTube saves, YouTube history, projects) are unaffected by this PRD.

- **Two ADRs to promote to disk before build starts**: the locked decisions from the grilling session should be written as ADRs 009–014 (or whatever the next numbers are) so future issues can reference them by number, not by PRD section.

- **v1 ships when acceptance criteria 1–7 below pass.** Slices 9 and 10 ship under the same PRD but are not part of the v1 acceptance criteria.

- **Privacy is structural, not promised.** The LLM cannot mutate Gmail because no mutating tool exists. Local models cannot leak email content because the HTTP request stays on `localhost`. Both guarantees come from the architecture, not from configuration.

### Acceptance Criteria (for "Email mirror v1 is done")

These map directly to the issues that `to-issues` will create.

1. **OAuth flow works end-to-end.** User clicks "Connect Gmail," is redirected to Google's consent screen with `gmail.readonly` only, lands back on the dashboard with a connected account, and sees "Gmail connected" with their email address. Token refresh on 401 is transparent.

2. **Initial sync pulls last 90 days.** First sync completes within 5 minutes for a 5,000-email inbox. Sync progress is visible. On failure, the next sync resumes from the last successful page (no re-processing of already-synced messages).

3. **Background poll keeps the mirror fresh.** With `EMAIL_SYNC_INTERVAL_MIN=10`, a new email arriving in Gmail appears in the dashboard within 15 minutes without any user action. Manual "Refresh" button triggers an immediate sync.

4. **Inbox view renders real data.** `/preview/v2` email compartment (or its replacement route) shows chronological emails with working filters: provider (Gmail only in v1), label (Inbox / Sent / Starred / custom), unread, sender, dashboard tag. Each row links to detail view.

5. **Read API is complete and fast.** `GET /api/email` with filters returns paginated results in <200ms. `GET /api/email/:id` returns full plain-text body. `GET /api/email/thread/:threadId` returns the thread in chronological order.

6. **Soft-delete and dashboard tags persist across re-syncs.** Hiding an email and waiting through at least one background poll keeps it hidden. Adding a dashboard tag and waiting through at least one background poll keeps the tag. Syncing never overwrites `hidden_at` or `email_tags`.

7. **LLM summarize button works.** Clicking "Summarize this thread" on an email returns a 3-bullet summary with sender + date citations, generated by the configured LLM provider. The LLM only has the four read-only tools; no mutating tool exists. With `LLM_BASE_URL` pointed at OpenAI, calls succeed; with it pointed at a local llama.cpp server, calls also succeed without code changes.

### Slice 8 acceptance (added in this PRD, not part of v1 closure)

8. **LLM tool surface is typed and documented.** Each of the four tools has a JSON schema, a description, and tested argument validation. The LLM reliably calls the right tool with the right arguments (verified by integration tests).

### Future slice acceptance (deferred, listed for traceability)

9. **Chat box works.** Multi-turn conversation over the email corpus, with conversation memory persisted across requests.
10. **Outlook support lands.** New `OutlookClient` implementation; same `EmailClient` interface; same LLM tools work across both providers; UI shows a provider filter.

### References

- [ADR-001](../40-decisions/001-deployment-self-hosted.md) — deployment
- [ADR-005](../40-decisions/005-youtube-source-of-truth.md) — dashboard DB is source of truth
- [ADR-007](../40-decisions/007-auth-password-and-token.md) — auth
- [ADR-008](../40-decisions/008-mvp-scope.md) — MVP scope
- Grilling conversation: locked decisions table from `discovery` session 2026-06-29