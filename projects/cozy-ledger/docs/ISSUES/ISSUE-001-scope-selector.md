# ISSUE-001 — Scope selector + dashboard filtering + donut rearrangement

## Parent

[PRD] Scope-aware dashboard + balance flow chart — `docs/PRD/PRD-001-scope-and-balance-flow.md`

## What to build

End-to-end support for the `Private / Shared / All` scope selector on the dashboard.

Concretely:

- The `Store` accepts three new persisted fields: `settings.currentUserId` (defaulted to the first user on load), `settings.scope` (defaulted to `'private'` on load), and a `balance: number` field on every source (defaulted to `0` on load). Missing fields are filled in by an idempotent migration in `Store.load()`.
- A scope selector (three pills: `Private`, `Shared`, `All`) renders in the topbar area on the dashboard, with the active pill highlighted.
- Clicking a pill updates `settings.scope`, persists it, fires `store:changed`, and re-renders the dashboard.
- All dashboard aggregations (summary cards, 6-month trend, donut, recent list) read their data through the new `sourcesInScope` and `transactionsInScope` selectors.
- The transactions list page applies the same scope selector.
- The dashboard grid is rearranged so the spending-share donut spans a full-width row (or a noticeably wider column) so it gets visual room.
- The existing "Balance" card (income minus expense) is untouched.

A small `Selectors` module is introduced with `sourcesInScope(state)` and `transactionsInScope(state)` as the only functions needed for this slice. `balanceSeries` and `netWorthSeries` arrive with the next slice.

## Acceptance criteria

- [ ] Three pills (`Private`, `Shared`, `All`) render in the topbar area on the dashboard.
- [ ] Clicking a pill changes the active pill highlight and persists the choice across reloads.
- [ ] On first load, `Private` is selected by default.
- [ ] Switching to `Shared` shows only transactions on sources with `ownerId === null` in every dashboard aggregation (cards, trend, donut, recent).
- [ ] Switching to `All` shows every transaction regardless of source ownership.
- [ ] Switching to `Private` shows only transactions on sources with `ownerId === settings.currentUserId`.
- [ ] The transactions list page applies the same active scope.
- [ ] The month picker still filters the visible month inside the active scope.
- [ ] The donut has visibly more room than before (full-width row or wider column).
- [ ] The existing monthly "Balance" card continues to compute income − expense for the visible month and scope.
- [ ] Migration in `Store.load()` is idempotent: reloading after the migration runs does not change the stored state.
- [ ] New `_test_selectors.js` covers `sourcesInScope` and `transactionsInScope` for all three scopes plus the missing-fields default case (at least 6 assertions).
- [ ] `_test_boot.js` extended with at least three new assertions: scope selector mounts, balance chart card placeholder mounts (slot for next slice), and toggling scope updates `state.settings.scope`.

## Blocked by

None — can start immediately.
