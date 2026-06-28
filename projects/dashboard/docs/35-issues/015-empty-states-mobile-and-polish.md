# 015 — Empty states + mobile responsive + hover/transitions polish

**Labels**: `v1`, `needs-triage`, `styling`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md), [30-plans/styling-pass.md](../30-plans/styling-pass.md)

## What to build

Three finishing touches bundled into one slice:

### 1. Empty states

A reusable empty-state component, rendered whenever the feed/search/folder has zero items:

```html
<div class="empty-state">
  <div class="empty-icon">📭</div>
  <p class="empty-message">No bookmarks yet</p>
  <a class="empty-cta" href="/settings">View setup guide →</a>
</div>
```

Used in:
- Feed with zero bookmarks → "No bookmarks yet — install the Chrome extension"
- Search with no results → "No bookmarks match '<query>'"
- Folder with zero bookmarks → "This folder is empty"
- Tag filter with zero matches → "No bookmarks tagged '<tag>'"

CSS:
- `.empty-state { display: flex; flex-direction: column; align-items: center; gap: 1rem; padding: 4rem 2rem; text-align: center; }`
- `.empty-icon { font-size: 3rem; opacity: 0.5; }`
- `.empty-message { color: var(--muted); }`
- `.empty-cta { padding: 0.5rem 1rem; background: var(--accent); color: var(--bg); border-radius: 0.375rem; text-decoration: none; font-weight: 500; }`

### 2. Mobile responsive (≤720px)

Add media query to `styles.css`:

```css
@media (max-width: 720px) {
  .site-header { padding: 0 1rem; }
  .layout { grid-template-columns: 1fr; }
  .sidebar {
    position: fixed;
    top: 56px; left: 0;
    width: 280px;
    height: calc(100vh - 56px);
    transform: translateX(-100%);
    transition: transform 200ms ease;
    background: var(--surface);
    z-index: 20;
  }
  .sidebar[data-open="true"] { transform: translateX(0); }
  .hamburger { display: block; }  /* hidden by default on desktop */
  .feed-item-thumb-youtube { width: 60px; height: 34px; }
  .feed-item-actions { gap: 0.25rem; }
}
```

Hamburger button: `<button class="hamburger" data-hamburger>☰</button>` in the header, hidden on desktop, visible on mobile. Click toggles `data-open` on the sidebar.

A tiny inline script (~10 lines) wires the hamburger click → sidebar toggle.

### 3. Hover + transitions polish

CSS additions:
- `.feed-item { transition: background-color 150ms ease, border-color 150ms ease; }`
- `.feed-item:hover { background-color: var(--surface-hover); border-color: var(--accent-dim); }`
- `.feed-item:hover .feed-item-title a { color: var(--accent); }`
- `.action-button { transition: color 150ms ease, background-color 150ms ease; }`
- `.action-button:hover { color: var(--accent); background-color: var(--accent-dim); }`
- `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 0.25rem; }` (keyboard accessibility)
- `html { transition: background-color 200ms ease, color 200ms ease; }` (theme crossfade, already in slice 1 but confirmed here)

## Acceptance criteria

- [ ] Empty states render in all four scenarios (no bookmarks, no search results, empty folder, empty tag filter)
- [ ] Mobile (≤720px) collapses sidebar to a slide-out drawer
- [ ] Hamburger button visible only on mobile, toggles sidebar
- [ ] Cards lift subtly on hover (~150ms transition)
- [ ] Action buttons highlight on hover
- [ ] Theme toggle crossfades smoothly
- [ ] Keyboard focus visible everywhere (teal accent ring)
- [ ] No regressions: existing tests pass, no functional behavior changes

## Blocked by

- 011 (design tokens + theme)
- 012 (card layout — needed for hover targets)
- 013 (sidebar + header — needed for mobile responsive)
- 014 (thumbnails — needed for mobile thumbnail sizing)