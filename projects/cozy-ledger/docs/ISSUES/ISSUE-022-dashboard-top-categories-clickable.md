# ISSUE-022 — Slice B: Dashboard top-categories clickable

## Parent

[PRD] Category & Payee deep-dives — `docs/PRD/PRD-006-category-and-payee-deep-dives.md`

## Why

ISSUE-021 delivers the category detail view and route, but nothing navigates to it yet. The dashboard's top-categories card is the most natural entry point — users see "Restaurants €640" and want to click straight in. This slice wires the click.

## What to build

1. **Make each row in `renderTopCategoriesCard` clickable** (`views/dashboard.js`).

   - Convert the row to a `button` (or attach a click handler) that calls `Router.goTo('category-' + cat.id)`.
   - Cursor: pointer on hover.
   - Subtle background highlight on hover (cream-deep), matching existing card hover styles.
   - Keep keyboard accessibility: the click target must be a real `button` or have `role="button"` + `tabindex="0"` + Enter/Space handlers.
   - Don't break the existing "Toon per groep" toggle — the toggle button is in the card-head and is a separate hit area. Clicking the toggle must NOT trigger the row navigation.

2. **Group-mode rows** are also clickable but navigate to `/group/:id` instead — actually no, group drill-down is **out of scope** for this slice. Group-mode rows are not clickable for v1; clicking them does nothing (or shows a tooltip "Groep-detail komt later"). Document this clearly in a code comment so a future contributor doesn't extend it without an issue.

3. **Empty payee row** in the top-payees section: also out of scope. Only the category list rows are clickable.

4. **No new helpers, no new selectors, no new i18n keys** — this is purely a wiring slice.

5. **CSS additions**:

   - `.cat-row.clickable` — cursor: pointer + hover background.
   - `.cat-row.clickable:focus-visible` — outline matching the existing focus style (sage-2px).

6. **Tests in `_test_boot.js`**:

   - Boot with a state containing 3 expense categories; render the dashboard; assert that 3 clickable rows exist.
   - Click the first row; assert the view switches to `category-{id}`.
   - With `dashboardByGroup = true`, assert no clickable rows (or that the rows are explicitly non-clickable).

## Acceptance criteria

- [ ] Each top-categories row in the dashboard is clickable and navigates to `category-{id}`.
- [ ] Hover state shows a subtle background highlight.
- [ ] Keyboard-accessible: Tab to row, press Enter/Space to navigate.
- [ ] Clicking the "Toon per groep" toggle does NOT trigger row navigation.
- [ ] Group-mode rows are not clickable (with a brief explanation in a code comment).
- [ ] At least 3 new test assertions in `_test_boot.js`.
- [ ] `npm test` and `npm run lint` clean.

## Blocked by

- ISSUE-021 (the `category/:id` route and `Router.goTo('category-{id}')` must exist).

## Out of scope

- Group-mode click drill-down (a future issue).
- The Categories list page (ISSUE-023).
- The payee detail view (ISSUE-024).
- The Transactions stats strip (ISSUE-025).
- Adding new i18n keys.
- Animating the row on click.
- A "right-click for actions menu" pattern.