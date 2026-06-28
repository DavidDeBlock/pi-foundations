# 35-issues Index

Independently-grabbable issues for **Dashboard v1**, sliced vertically from [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md).

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

## Dependency graph

```
001 ── 002
 └─ 003 ──┬── 004 ── 005 ── 006
          ├── 007 ── 008
          └── 009
              └── 010 (waits for all)
```

## Slicing rationale

Each issue is a **tracer bullet** — a thin vertical slice that cuts through every layer end-to-end (schema, API, UI, tests). A completed slice is demoable or verifiable on its own. This makes issues independently grabbable: a builder can pick up 005 without first touching 007.