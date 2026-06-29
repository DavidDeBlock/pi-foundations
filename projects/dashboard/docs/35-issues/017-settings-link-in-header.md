# 017 — Settings link in header (drop bottom nav + JSON link)

**Labels**: `v1`, `needs-triage`, `styling`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md)

## What to build

The Settings link currently sits in a `<nav>` at the bottom of `<main>` on the activity feed and search pages. The JSON link (pointing at `/api/folders`) is a developer/debug affordance and never belonged there. Move Settings to the sticky header so it's always one click away, and drop JSON entirely.

### 1. Add Settings link to `renderHeader`

In `server/src/view-shared.ts`, in the `.header-right` cluster of `renderHeader`, insert a Settings link **between the theme toggle and the Logout link**:

```html
<a class="settings-link" href="/settings" title="Settings">Settings</a>
```

It uses the same `.header-right` cluster as the existing controls, so it shows on every page (feed, search, settings, detail, 404).

### 2. Drop the JSON link

In `server/src/activity-feed.ts` `renderFeedPage`, delete the entire `<nav><a href="/settings">Settings</a> &middot; <a href="/api/folders">JSON</a></nav>` block at the bottom of `<main>`. The Settings link there is now redundant (it's in the header), and JSON is gone.

In `server/src/search.ts` `renderSearchPage`, delete the entire `<nav><a href="/">Activity</a> &middot; <a href="/settings">Settings</a></nav>` block at the bottom of `<main>`. The Settings link there is now redundant. The Activity link is also dropped — the brand in the header already links to `/`.

The `/api/folders` route itself stays (it's still used for testing and by the extension). We're only removing the UI link that exposed it.

### 3. CSS in `styles.css`

Add `.settings-link` styled identically to `.logout-link`:

```css
.settings-link {
  font-size: 0.85rem;
  color: var(--muted);
  text-decoration: none;
  padding: 0.4rem 0.6rem;
  border-radius: 0.375rem;
  transition: color 150ms ease, background-color 150ms ease;
}
.settings-link:hover {
  color: var(--text);
  background-color: var(--surface-hover);
}
```

## Acceptance criteria

- [ ] `renderHeader()` includes an `<a class="settings-link" href="/settings">` between theme toggle and logout
- [ ] Settings link is visible on every page that uses the shared header (feed, search, settings, detail, 404)
- [ ] No `<nav>` at the bottom of the activity feed page
- [ ] No `<nav>` at the bottom of the search results page
- [ ] No reference to `/api/folders` in any rendered HTML on the site
- [ ] `/api/folders` route still works when called directly (test in `folders.test.ts` continues to pass)
- [ ] Settings link styled like Logout (muted text, hover background)
- [ ] On the settings page itself, the Settings link is still clickable (no special "active" treatment needed; the page heading is the orientation)
- [ ] Tests in `view-shared.test.ts` assert the Settings link presence and position
- [ ] Existing tests in `activity-feed.test.ts` and `search.test.ts` updated to NOT expect the bottom nav
- [ ] Existing tests pass

## Blocked by

None — independent of the other 016/018/019 issues.
