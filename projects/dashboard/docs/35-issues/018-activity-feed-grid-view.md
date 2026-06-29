# 018 — Activity feed: responsive grid view

**Labels**: `v1`, `needs-triage`, `styling`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md)

## What to build

Change the activity feed from a single-column vertical list to a **responsive CSS Grid**: 1 column on phones, 2 columns on tablets, 3 columns on desktop. All the existing card elements (source badge, thumbnail, title, folder path, time, tags, action row, folder picker, delete) stay — the cards just get denser.

The search results page is **out of scope** for this issue — it has a different markup (snippet, score, vertical `<li>` list) that we don't refactor here.

### CSS changes in `styles.css`

#### `.feed-list` — switch to grid

Replace the current `display: flex; flex-direction: column;` with:

```css
.feed-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
  list-style: none;
  margin: 0;
  padding: 0;
}
```

`minmax(0, 1fr)` lets card content shrink instead of overflowing. `1rem` gap is consistent with the existing `.layout` gap.

Add responsive breakpoints (extend the existing `@media (max-width: 720px)` block for mobile; add a new one for tablet):

```css
@media (max-width: 1100px) and (min-width: 721px) {
  .feed-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 720px) {
  .feed-list {
    grid-template-columns: 1fr;
  }
}
```

Note: the existing 720px breakpoint already lives in `styles.css` and may need to be merged with the new tablet rule.

#### `.feed-item` — keep cards compact

Tighten card padding slightly so the grid doesn't feel cramped:

```css
.feed-item {
  padding: 0.75rem 1rem;
  /* rest unchanged */
}
```

The card height naturally equalises within a row because CSS Grid defaults to `align-items: stretch`. No fixed height needed — taller cards (with more tags) just make the whole row taller.

### Out of scope

- Search results page (`<li class="result">` list). Its layout stays as a vertical list.
- Settings page and detail page — already have their own layouts.
- No card content changes — same elements, same data attributes.
- No new visual elements (badges, icons) inside the card.

## Acceptance criteria

- [ ] Activity feed renders 3 columns on viewports >1100px wide
- [ ] Activity feed renders 2 columns between 721px and 1100px wide
- [ ] Activity feed renders 1 column on viewports ≤720px wide
- [ ] Cards in the same row stretch to the height of the tallest card in that row
- [ ] All card elements still visible: source badge, thumbnail (favicon or YouTube), title, folder path, time, tags, action row, folder picker, delete button, status
- [ ] Hover state (`.feed-item:hover`) still works on every card
- [ ] Title link hover color still works
- [ ] Source badge text (long domains) wraps within the card, doesn't overflow
- [ ] Tag chips wrap to a second line if the card is narrow — no horizontal overflow
- [ ] No regressions: existing tests pass, including `activity-feed.test.ts` card markup assertions
- [ ] Manual visual check at 1280px / 900px / 375px viewports

## Blocked by

None — independent of the other 016/017/019 issues. (Could be done in parallel with 019 since they touch different lines of `activity-feed.ts` and different CSS classes, but doing 019 first is fine too.)
