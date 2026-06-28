# 012 — Card layout (daily.dev shape)

**Labels**: `v1`, `needs-triage`, `styling`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md), [30-plans/styling-pass.md](../30-plans/styling-pass.md)

## What to build

Restructure `renderFeedItem` in `server/src/activity-feed.ts` to emit daily.dev-shaped cards, and add the matching CSS in `server/static/styles.css`.

New card markup:
```
<article class="feed-item" data-bookmark-id="..." data-folder-path="...">
  <header class="feed-item-header">
    <span class="source-badge" data-source="github.com">github.com</span>
    <!-- thumbnail slot for slice 014 -->
    <div class="feed-item-thumb-slot"></div>
  </header>
  <h3 class="feed-item-title">
    <a href="..." target="_blank" rel="noopener">Title</a>
  </h3>
  <div class="feed-item-meta">
    <span class="folder-path">Tech > Backend</span>
    <span class="meta-sep">·</span>
    <time datetime="..." title="absolute datetime">2h ago</time>
    <span class="meta-sep">·</span>
    <div class="tags">...</div>
  </div>
  <div class="feed-item-actions">
    <button class="action-button" data-action="open" title="Open in new tab">↗</button>
    <button class="action-button" data-action="edit" title="Edit">✏</button>
    <button class="action-button" data-action="copy" title="Copy URL">📋</button>
  </div>
</article>
```

Helpers to add in `activity-feed.ts`:
- `getSourceFromUrl(url)` → `{ domain: string, badgeLabel: string, isYouTube: boolean }` (parses URL, returns hostname, strips leading `www.`)
- `formatRelativeTime(isoDatetime)` → string (returns "just now", "5m ago", "2h ago", "yesterday", "3d ago", "Jan 15", "Mar 2025")
- `actionButtonToClipboard(text)` (existing categorize.js already has this pattern; reuse)

CSS to add in `styles.css`:
- `.feed-item` (the card container: surface background, rounded corners, border, padding, transition)
- `.feed-item-header` (flex row with badge + thumb slot)
- `.source-badge` (small chip, teal accent border, uppercase, ~11px font)
- `.feed-item-title` (large, bold, accent on hover)
- `.feed-item-meta` (muted color, 13px)
- `.feed-item-actions` (icon row at bottom)
- `.action-button` (icon button, hover state, focus-visible outline)

The thumb slot stays empty in this slice — slice 014 fills it.

## Acceptance criteria

- [ ] `renderFeedItem` emits the new article-based markup
- [ ] Source badge shows the URL domain (e.g., "github.com")
- [ ] Time shown as relative (e.g., "2h ago"), with absolute datetime in `title` attribute for hover
- [ ] Action buttons present: ↗ Open · ✏ Edit · 📋 Copy
- [ ] Open button opens URL in new tab (existing behavior, just moved to a button)
- [ ] Edit button still triggers inline rename + folder/tag controls (works with categorize.js)
- [ ] Copy button copies URL to clipboard with brief visual confirmation
- [ ] `.feed-item` has the daily.dev card aesthetic: surface bg, rounded corners, subtle border
- [ ] No regressions: existing tests pass, no functional behavior changes

## Blocked by

- 011 (design tokens + theme) — provides the CSS custom properties