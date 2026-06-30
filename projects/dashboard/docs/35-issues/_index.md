# 35-issues Index

Independently-grabbable issues for the **Dashboard** project, sliced vertically from [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md) and [PRD-002](../35-prds/PRD-002-email-mirror.md).

## v1 — Initial build (shipped)

| # | Title | Type | Blocked by |
|---|-------|------|------------|
| [001](./001-server-skeleton-auth.md) | Server skeleton + HTTP Basic auth | AFK | — |
| [002](./002-api-tokens.md) | API token generation + management | AFK | 001 |
| [003](./003-schema-and-folder-read.md) | Schema migrations + folder read API | AFK | 001 |
| [004](./004-extension-and-sync-api.md) | Extension skeleton + bulk sync API | AFK | 003 |
| [005](./005-folder-tree-builder.md) | FolderTreeBuilder + first sync E2E | AFK | 003, 004 |
| [006](./006-bookmark-differ.md) | BookmarkDiffer + ongoing sync (event listener) | AFK | 005 |
| [007](./007-activity-feed-ui.md) | Activity feed landing + bookmark detail | AFK | 003 |
| [008](./008-categorize-ui.md) | TagNormalizer + categorize UI (folders + tags) | AFK | 007 |
| [009](./009-search.md) | SearchQueryBuilder + search UI (FTS5 + trigram) | AFK | 003 |
| [010](./010-smoke-and-docs.md) | Smoke test, README, deployment docs | AFK | 001–009 |

## Styling pass — daily.dev-inspired visual overhaul

From plan: [30-plans/styling-pass.md](../30-plans/styling-pass.md)

| # | Title | Type | Blocked by |
|---|-------|------|------------|
| [011](./011-design-tokens-and-theme.md) | Design tokens + base styles + theme toggle | AFK | — |
| [012](./012-card-layout.md) | Card layout (daily.dev shape) | AFK | 011 |
| [013](./013-sidebar-and-header.md) | Sidebar polish + header layout | AFK | 011 |
| [014](./014-thumbnails.md) | Favicons + YouTube thumbnails | AFK | 012 |
| [015](./015-empty-states-mobile-and-polish.md) | Empty states + mobile responsive + hover/transitions polish | AFK | 011, 012, 013, 014 |

## Post-v1 UI adjustments

Small visual / layout adjustments after v1 was used in anger. Each is independently grabbable.

| # | Title | Type | Blocked by |
|---|-------|------|------------|
| [016](./016-sidebar-chevron-collapse.md) | Sidebar chevron collapse (client-side folder tree) | AFK | — |
| [017](./017-settings-link-in-header.md) | Settings link in header (drop bottom nav + JSON link) | AFK | — |
| [018](./018-activity-feed-grid-view.md) | Activity feed: responsive grid view (1/2/3 cols) | AFK | — |
| [019](./019-feed-pagination-top-and-bottom.md) | Activity feed: pagination on top AND bottom | AFK | — |

## v4 — Email mirror (PRD-002)

From PRD: [PRD-002](../35-prds/PRD-002-email-mirror.md)

| # | Title | Type | Blocked by |
|---|-------|------|------------|
| [020](./020-email-schema-oauth-gmail-client.md) | Email schema + Gmail OAuth + GmailClient + /settings/email | AFK | — |
| [021](./021-email-sync-worker-differ-initial-sync.md) | EmailSyncWorker + Differ + manual refresh + 90-day initial sync | AFK | 020 |
| [022](./022-email-read-api-querybuilder-searcher-retriever.md) | EmailQueryBuilder + Searcher + Retriever + read API | AFK | 021 |
| [023](./023-email-ui-inbox-detail-thread-sidebar.md) | Email UI: /email inbox + /email/:id detail + /email/thread + filters + sidebar | AFK | 022 |
| [024](./024-email-soft-delete-hide-unhide-hidden-view.md) | Soft-delete: hidden_at + hide/unhide endpoints + /email/hidden view | AFK | 023 |
| [025](./025-email-dashboard-tags-crud-autocomplete-filter.md) | Dashboard tags: tag CRUD + autocomplete + filter + chips | AFK | 023 |
| [026](./026-email-background-poll-sync-observability.md) | Background poll scheduler + sync state observability | AFK | 022 |
| [027](./027-llm-client-tool-registry-summarize-button.md) | LlmClient + ToolRegistry + "Summarize this thread" button | AFK | 024, 025, 026 |
| [028](./028-llm-chat-box-multi-turn-memory.md) | LLM chat box + multi-turn conversation memory | AFK | 027 |
| [029](./029-outlook-client-multi-provider.md) | Outlook (Microsoft Graph) client + multi-provider UI | AFK | 027 |

## v1 dependency graph

```
001 ── 002
 └─ 003 ──┬── 004 ── 005 ── 006
          ├── 007 ── 008
          └── 009
              └── 010 (waits for all)
```

## Styling-pass dependency graph

```
011 ──┬── 012 ── 014
      └── 013
              └── 015 (waits for 011, 012, 013, 014)
```

## Post-v1 adjustments dependency graph

```
016  017  018  019     (all independent; 018 + 019 ideally done in sequence
                        to avoid minor merge friction in renderFeedMain)
```

## v4 (email mirror) dependency graph

```
020 ── 021 ── 022 ── 023 ──┬── 024 ──┐
                           ├── 025 ──┼── 027 ──┬── 028
                           └── 026 ──┘         └── 029
```

Notes on parallelism:
- 024, 025, 026 all branch from 023 and can run in any order. They modify different files (no merge conflicts expected) and don't depend on each other.
- 028 and 029 both branch from 027 and are independent of each other.

## Slicing rationale

Each issue is a **tracer bullet** — a thin vertical slice that cuts through every layer end-to-end (schema, API, UI, tests). A completed slice is demoable or verifiable on its own. This makes issues independently grabbable: a builder can pick up 005 without first touching 007.

For the styling pass, the same principle applies: each issue delivers CSS + HTML + JS together so the visual change is verifiable in isolation before the next layer lands.

For the email mirror, the same principle applies with one refinement: 024/025/026 are intentionally designed to be **parallelizable** because each touches a different surface (visibility state, tag metadata, background scheduler) and none depend on each other. A builder with capacity can pick up two of them in parallel without merge friction.