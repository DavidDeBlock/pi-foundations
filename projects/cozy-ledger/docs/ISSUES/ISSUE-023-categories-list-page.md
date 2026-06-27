# ISSUE-023 — Slice C: Categories list page

## Parent

[PRD] Category & Payee deep-dives — `docs/PRD/PRD-006-category-and-payee-deep-dives.md`

## Why

The category detail view (ISSUE-021) lets users drill in once they know which category to look at. But the dashboard only shows the top 6 — users with more than 6 categories have no way to discover which ones are worth inspecting. A dedicated list page with totals closes that loop: it's the canonical "where is my money going at a category level?" view.

## What to build

1. **Pure helper in `selectors.js`**: `Selectors.allCategoryTotals(state, today = new Date())`.

   Returns `[{ category, thisMonth, thisYear, count, percentOfExpenses }]`:
   - One entry per category in `state.categories`.
   - Sorted by `thisMonth` desc, ties broken by `thisYear` desc.
   - `percentOfExpenses` is the category's share of total expenses for the current month (in-scope only).
   - Categories with no in-scope transactions render with `thisMonth = 0`, `count = 0`, `percentOfExpenses = 0` (they still appear in the list — they're real categories).

2. **New view `views/categories.js`**:

   - Exposes `Categories.render()` returning a `view-categories` element.
   - Header card: title (`t('categories.title')`) + count of categories.
   - List card: table-like list, one row per category.
     - Columns: name (with color swatch + icon), this-month total, this-year total, count, % of expenses.
     - Each row clickable → `Router.goTo('category-{id}')`.
     - Sort indicator on the "thisMonth" column header (since it's the default sort).
   - Empty state when `state.categories.length === 0`.

3. **Sidebar nav**: add `navItem(...)` for `Categorieën` with route `categories`. Add to the `titles` map in `renderView()`.

4. **Script loading**: add `<script src="views/categories.js"></script>` after other view scripts in `index.html`.

5. **i18n keys**:

   ```
   'categories.nav':              'Categorieën'
   'categories.title':            'Categorieën'
   'categories.count':            '{n} categorieën'
   'categories.empty.title':      'Nog geen categorieën'
   'categories.empty.msg':        'Voeg categorieën toe om uitgaven te groeperen.'
   'categories.col.name':         'Categorie'
   'categories.col.thisMonth':    'Deze maand'
   'categories.col.thisYear':     'Dit jaar'
   'categories.col.count':        'Aantal'
   'categories.col.percent':      '% van uitgaven'
   'categories.sort.thisMonth':   'Sorteer op deze maand'
   ```

6. **CSS**:

   - `.categories-list` — table-like layout, 5 columns.
   - `.categories-list-row.clickable` — hover + focus styles, matching ISSUE-022's `.cat-row.clickable`.
   - Sort indicator: small arrow next to the "thisMonth" column header.

7. **Tests**:

   - In `_test_selectors.js` (or `_test_categories.js`):
     - `allCategoryTotals`: returns one entry per category, sorted by `thisMonth` desc.
     - Empty category renders with zeros but still appears.
     - Tie-break by `thisYear` desc works.
     - In-scope filter respected.
   - In `_test_boot.js`: route `categories` mounts the list; row click navigates to `category-{id}`; empty state appears when no categories.

## Acceptance criteria

- [ ] Route `categories` mounts the list view.
- [ ] Sidebar shows `Categorieën`; clicking it navigates to the list.
- [ ] One row per category, sorted by `thisMonth` desc.
- [ ] Each row shows: name + swatch + icon, this-month total, this-year total, count, % of expenses.
- [ ] Each row is clickable and navigates to `category-{id}`.
- [ ] Empty state appears when `state.categories.length === 0`.
- [ ] All 9+ new i18n keys resolve to Dutch strings.
- [ ] At least 6 new test assertions across the test files.
- [ ] `npm test` and `npm run lint` clean.

## Blocked by

- ISSUE-021 (the `category/:id` route must exist for row navigation to work).

## Out of scope

- Filtering or searching the list.
- Sorting by columns other than this-month.
- Pagination (assume < 100 categories; render all).
- Showing hidden / archived categories.
- A "create new category" CTA inline on this page (use the existing categories management page).
- Per-user drill-down.
- Click-sort (header click → toggle asc/desc) — single sort for v1.
- Export to CSV.
- Grouping categories in the list (groups are visible via swatch + name; no separate group section).