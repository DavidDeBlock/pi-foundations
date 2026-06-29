# 019 — Activity feed: pagination on top AND bottom

**Labels**: `v1`, `needs-triage`, `styling`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md)

## What to build

Today the activity feed has pagination only at the **bottom**. With many bookmarks and the grid view from issue 018, the user has to scroll past all cards to reach the page navigation. Render the same pagination bar at both the **top** and **bottom** of the feed list, and hide both when there's only one page (no nav needed).

### 1. Render top pagination in `renderFeedMain`

In `server/src/activity-feed.ts` `renderFeedMain`, wrap the existing pagination render so it appears above AND below the feed list:

```ts
const paginationTop = renderPagination(feed, activeFolderId)
const paginationBottom = renderPagination(feed, activeFolderId)
return `
  <h2>Activity${headingSuffix}</h2>
  ${paginationTop}
  <div class="feed-list">${itemsHtml}</div>
  ${paginationBottom}
`
```

When the pagination is empty (single page — see below), both interpolations produce `""`, leaving the heading directly followed by the list. No visual artefact.

### 2. Hide pagination when there's only one page

Update `renderPagination` in `activity-feed.ts` to return an empty string when `totalPages <= 1`:

```ts
function renderPagination(feed: FeedPage, folderId?: string | null): string {
  if (feed.totalPages <= 1) return ''
  // existing logic — render prev/next + page indicator
}
```

Both top and bottom pick up this behaviour automatically because they call the same function.

The "Page 1 of 1" / disabled prev/next state is no longer rendered anywhere — when there's only one page, no pagination UI is shown at all. Cleaner empty-ish state for small bookmark sets.

### 3. Preserve folder filter in both paginations

The existing logic already passes `activeFolderId` into `renderPagination` and builds the `&folder=...` query string on prev/next links. Both top and bottom inherit this automatically since they share the same function call. No additional change needed.

### Out of scope

- Search results page — its single bottom pagination is unchanged. (If we want symmetry there too, that's a separate issue.)
- Sticky pagination — both paginations scroll with the page. A future "sticky bottom pagination" could be a follow-up if users complain.

## Acceptance criteria

- [ ] Activity feed renders a pagination bar above the feed list (between heading and cards)
- [ ] Activity feed renders a pagination bar below the feed list (existing position)
- [ ] Both pagination bars are visually identical (same prev/next links, same page indicator)
- [ ] When `totalItems <= perPage` (single page), neither pagination bar is rendered
- [ ] When paginating, the folder filter (`?folder=<id>`) is preserved in both top and bottom pagination links
- [ ] Clicking `← Newer` on either bar goes to the same URL
- [ ] Clicking `Older →` on either bar goes to the same URL
- [ ] Disabled state (`<span class="disabled">`) appears on both bars identically when on the first/last page
- [ ] Existing tests in `activity-feed.test.ts` updated:
  - "renders pagination links when there are multiple pages" — assert both top AND bottom
  - "disables pagination links on the first/last page" — assert both top AND bottom
  - "preserves the folder filter in pagination links" — assert both top AND bottom
  - New test: "hides both pagination bars when there is only one page"
- [ ] Existing tests pass

## Blocked by

None — independent of the other 016/017/018 issues. (Both 018 and 019 modify `renderFeedMain` but on different lines; doing them in sequence rather than in parallel avoids minor merge friction.)
