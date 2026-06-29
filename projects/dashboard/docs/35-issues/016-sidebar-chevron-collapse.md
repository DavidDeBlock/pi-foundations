# 016 — Sidebar chevron collapse (client-side folder tree)

**Labels**: `v1`, `needs-triage`, `styling`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md)

## What to build

The sidebar folder tree is currently always server-expanded — every descendant is rendered as `<li>` and shown. We want the user to be able to **click the chevron on a folder to collapse its descendants**, with the tree visible top-level at all times.

### 1. Markup change in `renderFolderTree`

In `server/src/activity-feed.ts`, split the chevron out of the `<a class="folder-label">` link so it can be a separate click target. Today the anchor wraps `[icon] [name] [chevron]` and clicking anywhere navigates. After this issue:

- The `<a class="folder-label">` keeps wrapping `[icon] [name]` and still navigates on click.
- The chevron becomes a sibling button: `<button type="button" class="sidebar-chevron" data-toggle-folder aria-expanded="true" aria-label="Collapse">›</button>` placed immediately after the `<a>`.

`<button>` (not `<a>`) because the click must not navigate. Inside the same `<li class="sidebar-item">`, so the descendant `<ul>` is still a sibling of the link + chevron, not a child of either.

The chevron should only be emitted when `hasChildren` is true (no button on leaf folders).

### 2. CSS in `styles.css`

Replace the existing rotation rule with one driven by `data-collapsed`:

```css
.sidebar-chevron {
  /* existing styles kept */
  transform: rotate(90deg); /* ▼ (expanded) */
  transition: transform 150ms ease, opacity 150ms ease;
}
.sidebar-item[data-collapsed="true"] > .sidebar-chevron {
  transform: rotate(0deg); /* › (collapsed) */
}
.sidebar-item[data-collapsed="true"] > ul {
  display: none;
}
```

`.sidebar-chevron` gets `cursor: pointer; padding: 0 0.25rem;` so the click target feels like a button.

### 3. Click handler in `categorize.js`

In `wireSidebar`, add a delegated handler for `[data-toggle-folder]`:

- On click: `e.preventDefault(); e.stopPropagation();`
- Find the parent `<li class="sidebar-item">`.
- Toggle `data-collapsed`: if currently `"true"`, remove it (or set to `"false"`); otherwise set to `"true"`.
- Update `aria-expanded` on the chevron button accordingly.
- Update the `aria-label` text (Collapse / Expand) for screen readers.

### Out of scope

- No server-side state. Collapsed state resets on full page reload. URL params not used.
- No "collapse all" / "expand all" actions.
- No persistence across page loads. (If reload-friction becomes real, a future issue can add URL state.)

## Acceptance criteria

- [ ] Folder with children renders `<button class="sidebar-chevron" data-toggle-folder>` as a sibling of the folder link, not inside it
- [ ] Clicking the chevron toggles `data-collapsed` on the parent `<li>` and hides/shows the child `<ul>`
- [ ] When collapsed, the chevron rotates from ▼ to › via CSS transition
- [ ] Clicking the chevron does NOT navigate to the filtered feed (event propagation stopped)
- [ ] Clicking the folder name still navigates to `/?folder=<id>` (current behavior unchanged)
- [ ] Leaf folders (no children) do not render a chevron button
- [ ] `aria-expanded` and `aria-label` on the chevron reflect current state
- [ ] Collapse state resets on full page reload
- [ ] Hover styles on the chevron (existing hover already styles `.sidebar-chevron` on the row)
- [ ] Tests in `activity-feed.test.ts` updated to assert the chevron is now a `<button>` not a `<span>`
- [ ] Existing tests pass

## Blocked by

None — independent of the other 017/018/019 issues.
