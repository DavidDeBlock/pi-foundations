# 011 — Design tokens + base styles + theme toggle

**Labels**: `v1`, `needs-triage`, `styling`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md), [30-plans/styling-pass.md](../30-plans/styling-pass.md)

## What to build

The foundation for the styling overhaul. Three artifacts:

1. **`server/static/styles.css`** — A single centralized stylesheet with:
   - CSS reset (box-sizing, margin, padding)
   - `@font-face` declarations for Inter Regular + SemiBold, JetBrains Mono Regular
   - CSS custom properties cascade: `:root` (light defaults) + `:root[data-theme="dark"]` (dark overrides)
   - Color tokens: `--bg`, `--surface`, `--surface-hover`, `--border`, `--text`, `--muted`, `--accent`, `--accent-dim`, `--success`, `--danger`
   - Typography: `body { font: 14px/1.5 'Inter', system-ui, sans-serif; color: var(--text); }`
   - Base layout primitives: `.layout { display: grid; grid-template-columns: 240px 1fr; }`, `.site-header { position: sticky; top: 0; height: 56px; }`

2. **`server/static/fonts/`** — Inter Regular.woff2, Inter-SemiBold.woff2, JetBrainsMono-Regular.woff2 (download from official sources; ~30KB each)

3. **`server/static/theme.js`** — Theme toggle script (~30 lines):
   - Inline `<script>` in `<head>` reads `localStorage.getItem('theme')` and sets `data-theme` on `<html>` synchronously before stylesheet loads (prevents FOUC)
   - Click handler on `[data-theme-toggle]` flips `data-theme` and persists
   - `html { transition: background-color 200ms ease, color 200ms ease; }` for crossfade

View modules (`activity-feed.ts`, `search.ts`, `settings-view.ts`) **keep their existing inline styles for now** — slice 1 is foundation only. Removing the inline styles is part of slice 2.

## Acceptance criteria

- [ ] `server/static/styles.css` exists, ~200 lines, with all custom properties defined for both themes
- [ ] Font files downloaded and `@font-face` declarations present with `font-display: swap`
- [ ] View modules updated to include `<link rel="stylesheet" href="/static/styles.css">` and `<link rel="preload" as="font" ...>` for fonts
- [ ] `server/static/theme.js` exists with the toggle handler
- [ ] An inline `<script>` in each page's `<head>` sets `data-theme` synchronously (no FOUC)
- [ ] Theme toggle button exists somewhere visible (placeholder location OK; slice 5 wires it properly)
- [ ] Toggling theme persists across page reloads via localStorage
- [ ] No visual regressions on existing pages (existing inline styles still apply on top of the new base styles — temporary duplication)
- [ ] Test: jsdom test for theme.js verifying toggle handler updates `data-theme` and localStorage

## Blocked by

None — can start immediately.

## Design decisions to follow

From [30-plans/styling-pass.md](../30-plans/styling-pass.md):

- Theme: Both, manual toggle, dark by default
- Accent: Teal/cyan (`#22D3EE` dark / `#0891B2` light)
- Typography: Inter self-hosted (~30KB)
- CSS organization: Single `static/styles.css`