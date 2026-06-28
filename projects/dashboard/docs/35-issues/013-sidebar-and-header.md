# 013 — Sidebar polish + header layout

**Labels**: `v1`, `needs-triage`, `styling`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md), [30-plans/styling-pass.md](../30-plans/styling-pass.md)

## What to build

Two layout changes that frame the whole page:

### Sidebar polish (slice 4 from plan)

Update `renderFolderSidebar` in `server/src/activity-feed.ts`:

- Each folder: `<div class="sidebar-item" data-folder-id="...">` containing:
  - `<span class="sidebar-icon">📁</span>`
  - `<span class="sidebar-name">Name</span>`
  - `<span class="sidebar-chevron">›</span>` if folder has children (rotates to ▼ when expanded)
- Active folder: `data-active="true"`, 3px teal accent on the left edge
- Indentation: nested folders get `padding-left: calc(var(--depth) * 1rem + 0.5rem)`
- Existing "+ New folder" button styled to match

CSS in `styles.css`:
- `.sidebar { width: 240px; position: sticky; top: 56px; height: calc(100vh - 56px); overflow-y: auto; padding: 1rem; border-right: 1px solid var(--border); }`
- `.sidebar-item { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.6rem; border-radius: 0.375rem; cursor: pointer; border-left: 3px solid transparent; }`
- `.sidebar-item:hover { background: var(--surface-hover); }`
- `.sidebar-item[data-active="true"] { background: var(--accent-dim); border-left-color: var(--accent); }`

### Header layout (slice 5 from plan)

Restructure the top of `activity-feed.ts` to render a sticky `<header class="site-header">`:

- Left: `<a class="brand" href="/">⊞ Dashboard</a>` (small icon + wordmark)
- Right: cluster of `<form class="search-form">` + `<button class="theme-toggle" data-theme-toggle>☀</button>` + logout link

The existing search form (currently below the `<h1>`) moves into the header. The existing `<h1>Dashboard</h1>` and `<p class="user">` blocks are removed — the brand in the header replaces them.

CSS in `styles.css`:
- `.site-header { position: sticky; top: 0; height: 56px; display: flex; justify-content: space-between; align-items: center; padding: 0 1.5rem; background: var(--surface); border-bottom: 1px solid var(--border); z-index: 10; }`
- `.brand { font-weight: 600; font-size: 1rem; color: var(--text); text-decoration: none; display: flex; align-items: center; gap: 0.5rem; }`
- `.header-right { display: flex; align-items: center; gap: 0.75rem; }`
- `.search-form input[type=search]` (refined: rounded, surface background, focus ring)
- `.theme-toggle { width: 36px; height: 36px; border: 1px solid var(--border); border-radius: 0.375rem; background: var(--surface); cursor: pointer; }`

## Acceptance criteria

- [ ] Header is sticky, 56px tall, brand left, search + theme toggle + logout right
- [ ] Sidebar is sticky (240px wide), folder tree renders with icons + chevrons
- [ ] Active folder has teal left border + dim background
- [ ] Hover states on sidebar items
- [ ] Existing search functionality unchanged (still goes to `/search?q=...`)
- [ ] Theme toggle button works (theme.js from slice 1 already handles the click)
- [ ] Existing tests pass

## Blocked by

- 011 (design tokens + theme) — provides the CSS custom properties