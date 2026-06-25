# ISSUE-016 — Trends period wiring + cleanup

## Parent

[PRD] Unified period selector for Dashboard & Trends — `docs/PRD/PRD-004-unified-period-selector.md`

## Why

The Trends view currently has its own range buttons (`1y / 2y / 3y / all`) hard-wired to two charts, plus a redundant "Top categories this month" card. Both inconsistencies with the new shared period concept go away in this issue. It also finishes the migration started in ISSUE-013 by deleting the now-unused `Router.trendRange` API and its i18n keys.

## What to build

1. **Mount `PeriodSelector` in the Trends header**.

   In `views/trends.js`'s `render()`, add `wrap.appendChild(PeriodSelector.render('trends'))` at the top, above the balance card. Same placement pattern as ISSUE-015.

2. **Remove the old `range-buttons` element**.

   Delete `renderRangeButtons()` and its usage. The old i18n keys (`trends.range.1y / 2y / 3y / all`) are no longer referenced and can be deleted from `i18n.js`.

3. **Switch the two charts to consume the new period**.

   - `buildMonthlyFlowChart(sources)` calls `Selectors.monthlyNetFlow(App._state, Selectors.monthsInPeriod(Router.periodRange()))` instead of `Selectors.monthlyNetFlow(App._state, Router.monthsForRange(Router.trendRange))`.
   - `buildTrajectoryChart(sources)` uses `Selectors.monthlyBalance(App._state, src.id, Selectors.monthsInPeriod(Router.periodRange()))` for the per-source series.
   - Drop the `rangeButtons` option passed to `MonthlyFlow.render` and `BalanceTrajectory.render`. If those components currently render a range toggle internally, remove that toggle from their templates too (the selector above the chart is now the single source of truth).

4. **Update the balance-input commit path**.

   In `commitBalance()` (currently in `views/trends.js`), the rebuild uses `Router.monthsForRange(Router.trendRange)`; replace with `Selectors.monthsInPeriod(Router.periodRange())`.

5. **Remove the top-categories card from Trends**.

   In `views/trends.js`'s `render()`, drop the `wrap.appendChild(Dashboard.renderTopCategoriesCard(monthTxns, totalExpense))` line. The card lives only on the dashboard now.

6. **Delete the old Router API**.

   In `router.js`, delete:
   - The `trendRange` variable.
   - `Router.setTrendRange(range)`.
   - `Router.monthsForRange(range)`.
   - `Router.get trendRange()` (if exposed).
   - `monthsForRange` from the public return object.

   Search the entire codebase for any remaining references (`grep -rn "trendRange\|monthsForRange\|setTrendRange"`); there should be none after this issue.

7. **Delete obsolete i18n keys**.

   Remove from `i18n.js`:
   - `'trends.range.1y'`
   - `'trends.range.2y'`
   - `'trends.range.3y'`
   - `'trends.range.all'`

   Also remove the dead `t('trends.range.*')` references inside `views/trends.js` and `charts/monthly-flow.js` / `charts/balance-trajectory.js`.

8. **Confirm `Router.monthKey` is unused**.

   Run `grep -rn "Router.monthKey\|Fmt.inMonth" views/ app.js charts/`. If `monthKey` is now only used inside `Selectors.periodRangeForPreset('1m', today)` (to derive the first of the current month), keep it as a Router internal helper but expose only what's still needed by callers. If nothing external uses it, delete it cleanly.

## Acceptance criteria

- [ ] On Trends load (preset = `1y`), the balance-trajectory and monthly-flow charts draw with one year of months.
- [ ] Switching presets on the Trends view re-renders both charts; the per-source lines and the net-worth line all redraw with the new x-range.
- [ ] The top-categories card no longer appears on the Trends view.
- [ ] The old `range-buttons` element (four pills `1y / 2y / 3y / all`) is gone from `views/trends.js`.
- [ ] `Router.trendRange`, `Router.setTrendRange`, `Router.monthsForRange` are deleted from `router.js` and produce no references in the codebase (`grep` returns nothing).
- [ ] The four `trends.range.*` i18n keys are removed from `i18n.js` and from any consumer.
- [ ] Typing a new balance for a source re-renders both charts (existing behaviour preserved).
- [ ] `npm test` and `npm run lint` remain green.
- [ ] Manual smoke test: dashboard and Trends each have the new selector, both react to preset changes, dashboard `1m` default + Trends `1y` default behave as described.

## Blocked by

- ISSUE-014 (selector must exist).
- ISSUE-015 (dashboard wiring, so we can verify nothing on the dashboard breaks when we delete the shared Router API).

## Out of scope

- The Transactions page and its filter bar (explicitly out of scope per the PRD).
- Redesigning the balance-trajectory or monthly-flow chart visual style.
- Removing the per-source / net-worth toggle on the balance-trajectory chart — that stays.
- Touching `Router.monthKey` deletion beyond confirming nothing depends on it (this issue only deletes it if it's provably unused).
- Removing the "balance inputs" row at the bottom of the balance card — that stays.