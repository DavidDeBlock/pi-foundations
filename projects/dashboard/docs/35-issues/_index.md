# 35-issues Index

Independently-grabbable issues for **Dashboard v1**, sliced vertically from [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md).

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

## Slicing rationale

Each issue is a **tracer bullet** — a thin vertical slice that cuts through every layer end-to-end (schema, API, UI, tests). A completed slice is demoable or verifiable on its own. This makes issues independently grabbable: a builder can pick up 005 without first touching 007.

For the styling pass, the same principle applies: each issue delivers CSS + HTML + JS together so the visual change is verifiable in isolation before the next layer lands.