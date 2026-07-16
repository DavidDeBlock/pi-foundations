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

## v3.0 — YouTube subscriptions + new-video detection (PRD-003)

From PRD: [PRD-003](../35-prds/PRD-003-youtube-v3-subscriptions.md)

| # | Title | Type | Blocked by |
|---|-------|------|------------|
| [YT-001](./YT-001-youtube-oauth-client-and-settings.md) | YouTube OAuth + YouTubeOAuthClient + /settings/youtube connect | AFK (manual smoke) | — |
| [YT-002](./YT-002-subscriptions-schema-fetcher-sync.md) | subscriptions schema + SubscriptionsFetcher + SubscriptionsSync + daily scheduler | AFK | YT-001 |
| [YT-003](./YT-003-subscriptions-api-and-ui.md) | Subscriptions API + SubscriptionsView UI | AFK | YT-002 |
| [YT-004](./YT-004-videos-schema-rss-poller.md) | videos + video_tags schema + RssFeedFetcher + VideoIngest + RssPoller (15-min job) | AFK | YT-002 |
| [YT-005](./YT-005-videos-api-and-ui.md) | Videos API + NewVideosView + VideoDetailView | AFK | YT-004 |
| [YT-006](./YT-006-youtube-e2e-smoke-and-docs.md) | Tracer-bullet E2E + smoke test + docs | AFK (manual smoke) | YT-003, YT-005 |
| [YT-007](./YT-007-youtube-ai-insight-cards.md) | MiniMax YouTube AI Insight Cards | AFK | YT-005 |

## v3.1 — YouTube canonical library + playlists + history + backfill (PRD-004)

From PRD: [PRD-004](../35-prds/PRD-004-youtube-library-history-playlists-backfill.md)

| # | Title | Type | Blocked by |
|---|-------|------|------------|
| [YT-008](./YT-008-canonical-youtube-library-foundation.md) | Canonical YouTube library foundation | AFK (migration rehearsal) | YT-005 |
| [YT-009](./YT-009-subscription-recent-video-backfill.md) | Subscription recent-video backfill | AFK (manual smoke) | YT-008 |
| [YT-010](./YT-010-youtube-playlists-ingestion-sync-api.md) | YouTube playlists ingestion, sync, and API | AFK (manual smoke) | YT-008 |
| [YT-011](./YT-011-playlists-ui-library-integration.md) | Playlists UI and library integration | AFK | YT-010 |
| [YT-012](./YT-012-takeout-watch-history-import.md) | Google Takeout watch-history import | AFK (manual smoke) | YT-008 |
| [YT-013](./YT-013-watch-history-ui-watched-state.md) | Watch History UI and watched-state integration | AFK | YT-012 |
| [YT-014](./YT-014-youtube-library-e2e-migration-docs.md) | YouTube library E2E, migration rehearsal, and docs | AFK (manual smoke) | YT-009, YT-011, YT-013 |

## v3.2 — YouTube discovery controls + focus player (PRD-005)

From PRD: [PRD-005](../35-prds/PRD-005-youtube-discovery-tags-and-focus-player.md)

| # | Title | Type | Blocked by |
|---|-------|------|------------|
| [YT-015](./YT-015-subscription-tags-effective-video-tags.md) | Subscription tags and effective video-tag filtering | AFK | YT-003, YT-005, YT-008 |
| [YT-016](./YT-016-new-videos-sort-date-range.md) | New Videos sorting and published-date range | AFK | YT-005, YT-013 |
| [YT-017](./YT-017-youtube-focus-player.md) | Embedded and pop-out YouTube focus player | AFK (manual smoke) | YT-005 |

## v3.3 — YouTube configurable AI summaries + web research (PRD-006)

From PRD: [PRD-006](../35-prds/PRD-006-youtube-ai-summary-profiles-web-research.md)

| # | Title | Type | Blocked by |
|---|-------|------|------------|
| [YT-018](./YT-018-versioned-ai-summary-profiles.md) | Versioned AI summary profiles and bilingual output | AFK | YT-007 |
| [YT-019](./YT-019-ai-research-settings-prompt-studio.md) | AI & Research settings and Prompt Studio | AFK | YT-018 |
| [YT-020](./YT-020-serper-web-research-citations.md) | Serper web research and source citations | AFK (external API smoke) | YT-018, YT-019 |
| [YT-021](./YT-021-subscription-auto-summary-policies.md) | Subscription automatic summary policies and usage limits | AFK (scheduler/provider smoke) | YT-018, YT-019, YT-020 |

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
| [030](./030-email-sync-incremental-since.md) | Incremental sync: pick up where we left off (`since = lastSyncAt − 60s`) | AFK | 021, 026 |

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
                           └── 026 ──┤         └── 029
                                └── 030
```

Notes on parallelism:
- 024, 025, 026 all branch from 023 and can run in any order. They modify different files (no merge conflicts expected) and don't depend on each other.
- 028 and 029 both branch from 027 and are independent of each other.

## v3.0 (YouTube) dependency graph

```
YT-001 ── YT-002 ──┬── YT-003
                   └── YT-004 ── YT-005
                              └── YT-006 (waits for all)
```

Notes on parallelism:
- YT-003 (subscriptions UI) and YT-004 (RSS poller + videos schema) both branch from YT-002 and can run in **parallel**. They touch different tables (`subscriptions` vs `videos`/`video_tags`), different modules (`SubscriptionsAPI`/`SubscriptionsView` vs `RssFeedFetcher`/`VideoIngest`/`RssPoller`), and have no merge friction.
- YT-005 depends on YT-004 because the videos UI needs videos in DB to render.
- YT-006 is the final integration slice and waits for both UI slices (YT-003 + YT-005) so the full smoke test is meaningful.
- YT-001 is the natural starting point (no blockers) but also the slice with the most real-world uncertainty (Google Cloud Console OAuth setup is a manual step).

## v3.1 (YouTube library) dependency graph

```text
YT-008 ──┬── YT-009 ───────────────┐
         ├── YT-010 ── YT-011 ─────┼── YT-014
         └── YT-012 ── YT-013 ─────┘
```

Notes on parallelism:
- YT-008 is the required canonical-data foundation because the current video schema only accepts subscribed channels.
- After YT-008, backfill (YT-009), playlist ingestion (YT-010), and history import (YT-012) can be implemented independently.
- YT-011 and YT-013 are UI integrations over their respective ingestion slices.
- YT-014 is the release gate and waits for every user-visible branch.

## v3.2 (YouTube discovery + player) dependency graph

```text
YT-003 + YT-005 + YT-008 ── YT-015 ── YT-016
             YT-005 ────────────────── YT-017
```

Notes on parallelism:
- YT-015 and YT-017 can proceed independently.
- YT-015 and YT-016 both touch the canonical video query and filter bar, so they
  should land sequentially even though their product behavior is independent.
- YT-017 is isolated to video detail, player routing, CSP, and browser behavior.

## v3.3 (YouTube configurable AI summaries) dependency graph

```text
YT-007 ── YT-018 ── YT-019 ── YT-020 ── YT-021
```

Notes on sequencing:
- YT-018 replaces the single-summary foundation with versioned runs, profiles,
  long-transcript handling, and English/Dutch/Both output.
- YT-019 owns non-secret settings and prompt management. YT-020 builds on those
  settings with bounded Serper research and persisted citations.
- YT-021 lands last because subscription automation must resolve and snapshot
  the profile, language, research, and usage-limit behavior from earlier slices.

## Slicing rationale

Each issue is a **tracer bullet** — a thin vertical slice that cuts through every layer end-to-end (schema, API, UI, tests). A completed slice is demoable or verifiable on its own. This makes issues independently grabbable: a builder can pick up 005 without first touching 007.

For the styling pass, the same principle applies: each issue delivers CSS + HTML + JS together so the visual change is verifiable in isolation before the next layer lands.

For the email mirror, the same principle applies with one refinement: 024/025/026 are intentionally designed to be **parallelizable** because each touches a different surface (visibility state, tag metadata, background scheduler) and none depend on each other. A builder with capacity can pick up two of them in parallel without merge friction.
