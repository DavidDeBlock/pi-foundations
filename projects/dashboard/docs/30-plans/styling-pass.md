# Plan — Styling overhaul (daily.dev-inspired)

**Date**: 2026-06-28
**Status**: Approved (post-grill)
**Parent**: PRD-001 (v1 shipped)

## Context

v1 shipped with minimal, light-only styling — inline `<style>` blocks scattered across `activity-feed.ts`, `search.ts`, `settings-view.ts` (~50 lines each). The result is functional but uninspired: white background, list-with-dividers, basic tag chips. We want a daily.dev-inspired visual treatment for the bookmarks feed + sidebar + header, with both dark and light themes, manual toggle, and a clear design language.

This is a styling-only pass. No schema changes, no new features, no behavior changes.

## Decisions (locked)

| # | Decision | Value |
|---|----------|-------|
| 1 | Scope | Feed + sidebar + header (settings keeps minimal) |
| 2 | IP posture | Inspired by daily.dev, our own palette (no logo, no brand) |
| 3 | Theme | Both, manual toggle, dark by default |
| 4 | Cover image | Favicon for normal bookmarks, YouTube thumbnail for YouTube URLs |
| 5 | CSS organization | Single `static/styles.css` |
| 6 | Accent color | Teal/cyan (`#22D3EE` dark / `#0891B2` light) |
| 7 | Card anatomy | Source badge · title · folder · time · tags · action row (↗ Open · ✏ Edit · 📋 Copy) |
| 8 | Typography | Inter (self-hosted, ~30KB) + JetBrains Mono for URLs |
| 9 | Header layout | Two-section: brand left, search + theme toggle + logout right |
| 10 | Sidebar | Tree with folder icons + chevrons, 240px fixed width |
| 11 | Polish | Subtle motion (150ms hover, 200ms theme crossfade, no page transitions) |

## Implementation slices

Each slice is a vertical cut: CSS + HTML + JS together. Demoable on its own.

### Slice 1 — Design tokens + base styles
- Create `server/static/styles.css` (~200 lines)
- `@font-face` declarations for Inter Regular and SemiBold, JetBrains Mono Regular
- CSS reset, custom-property cascade (`:root` for light, `:root[data-theme="dark"]` for dark)
- Color tokens: `--bg`, `--surface`, `--border`, `--text`, `--muted`, `--accent`, `--accent-dim`, `--success`, `--danger`
- Typography: `body { font: 14px/1.5 'Inter', system-ui, sans-serif; }`, heading sizes
- Base layout: `.layout { display: grid; grid-template-columns: 240px 1fr; }`, `.header { position: sticky; top: 0; }`, `.sidebar { width: 240px; }`
- View modules (`activity-feed.ts`, `search.ts`, `settings-view.ts`) keep their existing inline styles for now — slice 1 is foundation only
- Tests: snapshot a sample page render, verify CSS is loaded (check `<link>` tag in HTML)
- **AC**: Page renders with Inter font, dark/light colors work via `data-theme` attribute, no visual breakage of existing pages

### Slice 2 — Theme toggle
- Create `server/static/theme.js` (~30 lines)
- On load: read `localStorage.getItem('theme')`, set `data-theme` on `<html>` accordingly (default: 'dark')
- Wire up the theme toggle button (in header, present after slice 5): click flips `data-theme`, persists to `localStorage`
- Crossfade: `html { transition: background-color 200ms ease, color 200ms ease; }`
- Placeholder toggle button in header for now (slice 5 wires it properly)
- Tests: jsdom test for the toggle handler
- **AC**: Theme toggle works in any browser, persists across reloads, no FOUC (flash of unstyled content) on page load

### Slice 3 — Card layout (daily.dev shape)
- Update `renderFeedItem` in `activity-feed.ts` to new markup:
  - `<article class="feed-item">` instead of `<li>`
  - `<header class="feed-item-header">`: source badge (URL domain) + favicon
  - `<h3 class="feed-item-title">`: title (linked)
  - `<div class="feed-item-meta">`: folder path · relative time · tags
  - `<div class="feed-item-actions">`: ↗ Open · ✏ Edit · 📋 Copy buttons
- Add helper `getSourceFromUrl(url)` returning `{ domain, badgeLabel, isYouTube }`
- Add relative time formatter (small inline function, no library): "just now", "5m ago", "2h ago", "yesterday", "3d ago", "Jan 15"
- Add CSS for new card structure in `styles.css`
- **AC**: Cards render with source badge, title, meta, action row. Click opens URL in new tab. Edit button still triggers categorize.js. Copy button copies URL to clipboard.

### Slice 4 — Sidebar polish (folder icons + chevrons)
- Update `renderFolderSidebar` in `activity-feed.ts`:
  - Each folder: `<span class="folder-icon">📁</span>` + name + chevron (›/▼) if it has children
  - Active folder: `data-active="true"`, teal left border
  - "+ New folder" button at bottom (already exists, just styled)
- CSS in `styles.css`: `.sidebar-item { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.6rem; border-radius: 0.375rem; cursor: pointer; }`, hover state, active state, indentation for nested folders
- **AC**: Folder tree renders with icons + chevrons, active state visible, hover effect subtle, indentation matches hierarchy

### Slice 5 — Header layout (two-section)
- Update `activity-feed.ts` to render a sticky `<header class="site-header">`:
  - Left: `<a class="brand" href="/">⊞ Dashboard</a>`
  - Right: search form + theme toggle button + logout link
- Search form: `<form class="search-form" action="/search">` with input + submit button
- Theme toggle: `<button class="theme-toggle" data-theme-toggle>☀</button>` (icon swaps on toggle)
- Logout: clearing Basic auth isn't trivial; for v1, a link to `/api/logout` (server endpoint that returns 401 + new realm) — or just a small note "browser stores password; clear it to log out". Defer to a real logout flow.
- CSS in `styles.css`: `.site-header { position: sticky; top: 0; height: 56px; display: flex; justify-content: space-between; align-items: center; padding: 0 1.5rem; background: var(--surface); border-bottom: 1px solid var(--border); }`
- **AC**: Header sticks on scroll, brand left, search + toggle + logout right, dark/light theme reflects through header

### Slice 6 — Favicons + YouTube thumbnails
- Add helper `getCardThumbnail(url)`:
  - If YouTube: parse video ID, return `{ type: 'youtube', src: 'https://img.youtube.com/vi/<id>/hqdefault.jpg' }`
  - Otherwise: return `{ type: 'favicon', src: 'https://www.google.com/s2/favicons?domain=<host>&sz=64' }`
- Update `renderFeedItem` to include thumbnail in card header
- CSS for thumbnail: `<img class="feed-item-thumb">` styled as 32×32px for favicon, 80×45px for YouTube. `object-fit: cover`. `loading="lazy"`. Fallback: hidden if image errors (use `onerror="this.style.display='none'"` or `src` swap pattern)
- YouTube detection regex: `/^https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/`
- **AC**: Normal bookmarks show favicon. YouTube URLs show thumbnail. Missing favicon gracefully hides the image. Page load not blocked by image fetches (lazy loading).

### Slice 7 — Empty states + mobile responsive
- Empty state component: when feed has zero items, render:
  ```html
  <div class="empty-state">
    <div class="empty-icon">📭</div>
    <p class="empty-message">No bookmarks yet</p>
    <a class="empty-cta" href="/settings">View setup guide →</a>
  </div>
  ```
- Same component reused for empty search results, empty folder view, empty tag filter
- CSS for empty state: centered, large icon, 1-line message, CTA button
- Mobile responsive (media query `@media (max-width: 720px)`):
  - Sidebar becomes a slide-out drawer triggered by a hamburger button in the header
  - Feed takes full width
  - Cards stack as before but with smaller padding
  - Search box shrinks
- **AC**: Empty states render in all "no data" scenarios. Mobile (≤720px) collapses sidebar to drawer. Hamburger button visible only on mobile.

### Slice 8 — Card hover + transitions (polish)
- CSS additions in `styles.css`:
  - `.feed-item { transition: background-color 150ms ease, border-color 150ms ease; }`
  - `.feed-item:hover { background-color: var(--surface-hover); border-color: var(--accent-dim); }`
  - `.feed-item:hover .feed-item-title a { color: var(--accent); }`
  - `.action-button { transition: color 150ms ease, background-color 150ms ease; }`
  - `.action-button:hover { color: var(--accent); background-color: var(--accent-dim); }`
- Add `:focus-visible` outlines for keyboard navigation (teal accent ring)
- Theme crossfade: `html { transition: background-color 200ms ease, color 200ms ease; }`
- **AC**: Cards lift subtly on hover. Action buttons highlight on hover. Theme toggle crossfades smoothly. Keyboard focus visible everywhere.

## Acceptance criteria (overall pass)

The styling overhaul is "done" when:

- [ ] All 7 v1 pages (feed, detail, search, search results, settings, token created, error) use `static/styles.css` (no inline `<style>` blocks remain in view modules)
- [ ] Dark and light themes both work, toggle persists in localStorage, no FOUC
- [ ] Feed cards show: source badge, favicon or YouTube thumbnail, title, folder, relative time, tags, action row
- [ ] Sidebar shows folder tree with icons + chevrons + active state
- [ ] Header sticks on scroll, brand left, search + theme toggle + logout right
- [ ] Mobile (≤720px) collapses sidebar to drawer
- [ ] Subtle motion on hover (~150ms), theme crossfade (~200ms)
- [ ] No regressions: all existing tests pass, no functional changes to behavior

## Out of scope

- **Settings page styling overhaul** (out of slice 1 scope per decision #1; minimal styling stays)
- **Drag-and-drop folder reordering** (separate feature, not styling)
- **Reading-list / saved-for-later with full-page reader view** (separate feature)
- **Image lightbox on YouTube thumbnails** (clicking YouTube link opens in new tab; no lightbox)
- **Animated skeletons during load** (no async loading yet; full-page render)
- **Accessibility audit** beyond basic focus-visible outlines (defer to a focused a11y pass)
- **i18n** (English only; same as v1)

## Risks

| Risk | Mitigation |
|------|-----------|
| Favicon service (`google.com/s2/favicons`) changes or rate-limits | Graceful degradation (image hidden on error); service is widely used and stable |
| YouTube thumbnail 404s for removed videos | Same fallback pattern; thumbnail hidden on error |
| Inter font download blocks first paint | `<link rel="preload" as="font" type="font/woff2" crossorigin>`; `font-display: swap` so text uses fallback until Inter loads |
| Theme toggle FOUC on page load | Theme is set in inline `<script>` in `<head>` BEFORE stylesheet loads — reads localStorage and sets `data-theme` synchronously |
| Card hover lift feels too jumpy | 150ms is a tested sweet spot; reduce to 100ms if needed |
| Sidebar at 240px too narrow for deep folder paths | Add horizontal scroll if content overflows, or wrap text (folder names rarely exceed 30 chars) |

## File map (changes only)

```
server/static/
├── styles.css                 ← NEW (~500 lines after all slices)
├── theme.js                   ← NEW (~30 lines, slice 2)
├── fonts/
│   ├── Inter-Regular.woff2    ← NEW (downloaded)
│   ├── Inter-SemiBold.woff2   ← NEW (downloaded)
│   └── JetBrainsMono-Regular.woff2  ← NEW (downloaded)
└── (existing: categorize.js, search.js — unchanged)

server/src/
├── activity-feed.ts           ← MODIFIED (slices 3, 4, 5, 6, 7)
├── search.ts                  ← MODIFIED (slice 1 — remove inline styles)
├── settings-view.ts           ← MODIFIED (slice 1 — remove inline styles)
└── static-handler.ts          ← UNCHANGED (already serves /static/*)

server/migrations/             ← UNCHANGED
server/data/                  ← UNCHANGED (only styling, no schema)
extension/                    ← UNCHANGED (extension doesn't render UI)
```

## Estimated effort

Each slice is roughly **half a day to a full day** of focused work for a builder agent:
- Slices 1, 3, 5, 8: heavier (CSS + markup + JS)
- Slices 2, 4, 6, 7: lighter (mostly CSS additions)

Total: **~5 days** of builder work, plus review.

## Recommended execution order

1. Slice 1 (foundation) — non-negotiable, everything else depends on it
2. Slice 2 (theme toggle) — small, makes everything testable in both themes
3. Slice 5 (header) — sets the layout skeleton
4. Slice 4 (sidebar) — second column
5. Slice 3 (card layout) — the main content
6. Slice 6 (thumbnails) — visual polish
7. Slice 8 (hover/transitions) — final polish
8. Slice 7 (empty states + mobile) — can be parallelized or last

Slices 1-2 can be one issue. Slices 3-6 are each their own issue. Slice 7 is one issue. Slice 8 is one issue.

Suggested issue breakdown: **5 issues** total (1+2, 3, 4+5, 6, 7+8).