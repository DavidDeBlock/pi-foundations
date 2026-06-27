# ISSUE-025 — Slice E: Transactions stats strip

## Parent

[PRD] Category & Payee deep-dives — `docs/PRD/PRD-006-category-and-payee-deep-dives.md`

## Why

When the user filters the Transactions page by a single entity (one category, one group, one user, one source, or one payee), they currently see a list of transactions but no aggregate. Adding a small stats strip above the table — `Totaal / Aantal / Gemiddeld / Periode` — gives them the same "this is what I spent" insight in context, without leaving the page.

This slice is independent of the detail-view work (it doesn't depend on ISSUE-021-024) and can ship on its own.

## What to build

1. **Pure helper in `selectors.js`**: `Selectors.entityTransactionStats(state, txns, filter)` (or two helpers — one taking `txns` already filtered, one taking the filter and computing the filtered set itself; pick the cleaner signature and document it).

   Returns `{ total, count, avg, minDate, maxDate }`:
   - `total` = sum of `txn.amount` over the filtered set (use the existing `ViewHelpers.sum`).
   - `count` = `txns.length`.
   - `avg` = `total / count` (returns 0 when count is 0).
   - `minDate` / `maxDate` = earliest and latest `txn.date` in the set, formatted via `Fmt.date` (returns `null` when count is 0).
   - In-scope only.

2. **Visibility logic in `views/transactions.js`**:

   The stats strip renders only when **exactly one** of the following filters is set to a single value (not `'all'`):
   - `categoryId`
   - `groupId` (including the special `'__none__'` value, which counts as "set")
   - `userId` (paidByUserId)
   - `sourceId`
   - `payee`

   Filters `month`, `type`, `scope` are NOT counted — those are typically combined with one of the entity filters above.

   If the user has 0 or 2+ entity filters set, the strip is hidden (no point showing stats for "all").

3. **Stats strip UI**:

   Renders **above** the transactions table (between `renderFilters()` and `renderTable(list)` in `views/transactions.js`):

   ```
   ┌─ Totaal ─┐ ┌─ Aantal ─┐ ┌─ Gemiddeld ─┐ ┌─ Periode ─┐
   │  €640    │ │   23     │ │   €27,83    │ │ 1 jan – 25 jun │
   └──────────┘ └──────────┘ └─────────────┘ └──────────────┘
   ```

   Four small cells in a flex row, matching the existing `.summary-grid` aesthetic from the dashboard (smaller variant — same colors, narrower).

4. **i18n keys**:

   ```
   'txns.stats.total':     'Totaal'
   'txns.stats.count':     'Aantal'
   'txns.stats.avg':       'Gemiddeld'
   'txns.stats.period':    'Periode'
   'txns.stats.empty':     '— geen transacties —'
   ```

5. **CSS**:

   - `.txn-stats-strip` — flex row, gap, wraps on mobile.
   - `.txn-stats-cell` — small card, 4 cells.
   - Reuse `.summary` styles from the dashboard if appropriate.

6. **Tests in `_test_boot.js`**:

   - With state containing 5 transactions and a `categoryId` filter set to one value: stats strip renders with the right total/count/avg/period.
   - With all filters `'all'`: stats strip is hidden.
   - With 2 entity filters set: stats strip is hidden.
   - With 0 transactions matching the filter: stats strip renders with `—` placeholders (per `txns.stats.empty`).

## Acceptance criteria

- [ ] Stats strip appears above the transactions table when exactly one entity filter is set.
- [ ] Strip is hidden when 0 or 2+ entity filters are set.
- [ ] Each cell shows the correct value for `Totaal`, `Aantal`, `Gemiddeld`, `Periode`.
- [ ] Empty result renders `— geen transacties —` in each cell.
- [ ] All 5 new i18n keys resolve to Dutch strings.
- [ ] At least 4 new test assertions in `_test_boot.js`.
- [ ] `npm test` and `npm run lint` clean.

## Blocked by

None — this is standalone.

## Out of scope

- Multiple-currency handling (assume EUR only, like the rest of the app).
- A "what changed since last month" delta on the stats.
- Per-user drill-down (everything is scope-aware via existing helpers).
- A separate chart on the strip (numbers only).
- Persisting which filters the user wants shown in the strip.
- Changing the existing filter UI (the strip is purely additive).
- "Compare two filter combinations" side-by-side.