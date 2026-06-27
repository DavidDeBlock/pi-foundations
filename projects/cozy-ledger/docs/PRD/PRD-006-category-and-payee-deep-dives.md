# [PRD] Category & Payee deep-dives

## Problem Statement

The dashboard's "Top categories" card surfaces the top 6 expense categories for the active period, but clicking a category does nothing — there is no way to drill in. The Transactions page lets you filter by category or payee but shows no aggregate stats above the filtered list. The Trends page has no category breakdown at all (removed in ISSUE-016). Payees have no discovery surface anywhere in the app.

The user has no canonical place to answer "how much have we spent on restaurants over time?" or "how much do we actually spend at Café Bombala?". Today the answer requires filtering the transactions list, summing mentally, and wishing for a chart.

## Solution

Introduce **three new routes** with a shared detail pattern:

- **`/categories`** — list page. Every category with totals (this month / this year, count, % of expenses), sorted by this-month total desc. Reachable from a new sidebar item "Categorieën".
- **`/category/:id`** — detail page. Header with totals, monthly trend chart (last 12 months), top payees in this category (with their totals), recent transactions table, "View all transactions" link, and a "Set envelope for this category" CTA.
- **`/payee/:id`** — same shape as the category detail, drill-down for a single payee. Top categories for the payee replace top payees.

The dashboard's top-categories card rows become clickable and navigate to `/category/:id`. Inside a category detail, the "top payees" rows are clickable and navigate to `/payee/:id`. The Transactions page gains a small stats strip above the table when a single-entity filter is active.

## User Stories

1. As a user, I want to click a category in the dashboard's top-categories card and see a detail page with totals + monthly trend + recent transactions.
2. As a user, I want to browse all categories with totals from a sidebar item, sorted by spending desc, so I can find which categories deserve attention.
3. As a user, I want both "this month" and "this year" totals on list and detail views, so I have both short and long-term context.
4. As a user, I want a monthly trend chart on the category detail page so I can see spending over time.
5. As a user, I want to see which payees drive spending in a category (top payees within a category), so I know where the money actually goes.
6. As a user, I want to click a payee name in the category detail's top-payees list and see the payee's detail page (totals + categories).
7. As a user, I want a payee detail page with the same shape: totals, monthly trend, top categories.
8. As a user, I want a stats strip on the Transactions page when I've filtered to a single category, group, source, user, or payee, so I see "Totaal / Aantal / Gemiddeld / Periode" above the table.

## Implementation Decisions

### Routes

- `categories` — list page (sidebar item `Categorieën`).
- `category/:id` — detail page.
- `payee/:id` — detail page.

The router currently stores `view` as a flat string. To support `category/abc123`, the cleanest approach is to encode the id into the view string (`view = 'category-abc123'`) and let `CategoryDetail.render` parse the id back out. No new router machinery needed.

### Shared detail component

The category and payee detail pages share most of their structure. Implementation:

- Two thin wrappers — `views/category-detail.js` and `views/payee-detail.js` — each parse their `:id`, fetch the entity, and delegate to a shared internal helper `_renderEntityDetail({ kind, id, entity, totals, trend, topList, recent })` exposed from a small `views/_entity-detail.js`. The wrappers handle route-specific chrome (e.g., the "Set envelope for this category" CTA on category detail only).

### Data model

No new state. Everything is derived from `state.transactions`, `state.categories`, `state.payees`, `state.groups`.

### Pure helpers (`selectors.js`)

- `Selectors.categoryTotals(state, categoryId, today = new Date())` → `{ thisMonth, thisYear, count, percentOfExpenses }`. `percentOfExpenses` = `thisMonth / totalExpenseThisMonth * 100`. In-scope only.
- `Selectors.categoryMonthlyTrend(state, categoryId, months)` → `[{ month: 'YYYY-MM', amount }]` ordered asc, length = `months.length`. Months with no transactions render with `amount = 0`.
- `Selectors.payeeTotals(state, payeeName, today)` → same shape as `categoryTotals` but scoped to `extractPayee(txn.description) === payeeName`.
- `Selectors.payeeMonthlyTrend(state, payeeName, months)` → same shape.
- `Selectors.topPayeesInCategory(state, categoryId, today, limit = 5)` → `[{ payeeName, total, count }]` sorted by `total` desc.
- `Selectors.topCategoriesForPayee(state, payeeName, today, limit = 5)` → `[{ category, total, count }]`.
- `Selectors.allCategoryTotals(state, today)` → `[{ category, thisMonth, thisYear, count, percentOfExpenses }]` sorted by `thisMonth` desc.
- `Selectors.entityTransactionStats(state, filter)` → `{ total, count, avg, minDate, maxDate }` for the Transactions stats strip. `filter` is the active `Router.txnFilters` object.

### UI

- **List page (`/categories`)**: table-like list, one row per category. Columns: name (with color swatch + icon), this-month total, this-year total, count, % of expenses. Empty state when no categories. Click a row → detail.
- **Detail page** (`/category/:id` and `/payee/:id`):
  - Header: entity name, color swatch, this-month total (big), this-year total, count.
  - This-month progress bar (this-month total / this-year total, capped at 100%).
  - Monthly trend chart — small SVG, 12 months, monthly bars. Reuse the existing chart style from `charts/monthly-flow.js` (or extract a tiny shared helper if cleaner).
  - Top related entities (top payees for category, top categories for payee): 5 rows with name + total + count.
  - Recent transactions table (last 25 filtered transactions) using `Transactions.renderTable({ compact: true })`.
  - "View all transactions" link → `/transactions` with the entity filter pre-applied.
  - Category detail only: "Set envelope for this category" CTA → `/envelopes` route + open the envelope modal pre-filled with this category in `categoryIds`.
  - Back button → previous route (fall back to `/categories` if there's no history).
- **Transactions stats strip**: 4 small cells above the table — `Totaal`, `Aantal`, `Gemiddeld`, `Periode (van — tot)`. Only renders when exactly one of `categoryId / groupId / userId / sourceId / payee` is set to a single value (not `all`). All-`all` filters hide it.

### Routing

- Add `categories`, `category/:id`, `payee/:id` to the `titles` map in `renderView()`.
- Sidebar: a new `navItem(...)` for `Categorieën` with route `categories`.
- A small utility `Router.parseDetailRoute(view)` returns `{ kind, id }` or `null` so each detail view knows whether to render.

### i18n

Major keys (full list in each child issue):

```
'categories.nav', 'categories.title', 'categories.empty.title',
'categories.col.thisMonth', 'categories.col.thisYear', 'categories.col.count', 'categories.col.percent',
'categoryDetail.title', 'categoryDetail.thisMonth', 'categoryDetail.thisYear',
'categoryDetail.trend', 'categoryDetail.topPayees', 'categoryDetail.recent',
'categoryDetail.viewAll', 'categoryDetail.setEnvelope', 'categoryDetail.back',
'payeeDetail.title', 'payeeDetail.thisMonth', 'payeeDetail.thisYear',
'payeeDetail.trend', 'payeeDetail.topCategories', 'payeeDetail.recent',
'payeeDetail.viewAll', 'payeeDetail.back',
'txns.stats.total', 'txns.stats.count', 'txns.stats.avg', 'txns.stats.period', 'txns.stats.empty'
```

### What goes away

Nothing. This is purely additive.

## Testing Decisions

- **Pure helpers** in `_test_selectors.js` (or new `_test_categories.js`):
  - `categoryTotals` for empty category, single-txn category, multi-month category.
  - `categoryMonthlyTrend` returns ordered list, fills 0 for empty months.
  - `topPayeesInCategory` returns right payees sorted by total desc.
  - `topCategoriesForPayee` returns right categories sorted by total desc.
  - `allCategoryTotals` sorted by `thisMonth` desc.
  - `entityTransactionStats` for empty filter result, single txn, multi txn.
- **Boot smoke** (`_test_boot.js`):
  - Navigate to `/categories` → list renders.
  - Click a category row → detail renders with header, trend, top payees, recent.
  - Click a payee row in top-payees → payee detail renders.
  - On `/transactions` with a single-entity filter → stats strip appears.

## Children

- `ISSUE-021` — Slice A: Category detail view (data + view + route + helpers)
- `ISSUE-022` — Slice B: Dashboard top-categories clickable
- `ISSUE-023` — Slice C: Categories list page
- `ISSUE-024` — Slice D: Payee detail view
- `ISSUE-025` — Slice E (optional): Transactions stats strip

## Out of Scope

- Editing categories or payees from the detail pages (use existing category/payee management).
- "Notes" or "tags" on categories/payees.
- Per-user drill-down (everything is scope-aware via the existing `Selectors.transactionsInScope`).
- Comparing two categories side-by-side.
- Budget / forecast lines on the detail page.
- Yearly trend chart (monthly only for v1).
- Drill-down into a specific month from the trend chart (click a month → filtered transactions for that month).
- Sharing or exporting category/payee reports.
- "Set envelope for this payee" CTA (the payee detail mirrors category detail but the envelope CTA is category-only for v1).