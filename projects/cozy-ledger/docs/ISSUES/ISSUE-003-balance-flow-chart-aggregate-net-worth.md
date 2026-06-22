# ISSUE-003 — Balance flow chart (net-worth aggregate view)

## Parent

[PRD] Scope-aware dashboard + balance flow chart — `docs/PRD/PRD-001-scope-and-balance-flow.md`

## What to build

Extend the balance flow chart with a toggle between "Per source" and "Net worth" views. Net worth view shows a single heavier step line that is the day-by-date sum of every source's balance in the active scope.

Concretely:

- New selector `netWorthSeries(state)` aligns each in-scope source's balance series by date and sums them into one combined `[{ date, balance }]` series. Dates that are missing from a source are backfilled with the source's last known balance before that date, so the sum is well-defined on every date.
- A toggle (two pills: `Per source`, `Net worth`) sits on the chart card. Default = `Per source`.
- In `Per source` mode: one line per source, thin stroke, muted colors (matches ISSUE-002).
- In `Net worth` mode: one heavier line, slightly more saturated, with a soft filled area underneath.
- The inline typed-balance inputs remain visible in both modes, so the user can still update a source's anchor.
- Tooltip behavior is unchanged.

## Acceptance criteria

- [ ] A toggle renders on the balance flow card with two states: `Per source` and `Net worth`.
- [ ] Default mode is `Per source` and the choice persists across reloads.
- [ ] Switching to `Net worth` replaces the multi-line view with a single heavier line whose values are the date-by-date sum of all source balances in the active scope.
- [ ] The net-worth line's rightmost point equals the sum of `source.balance` across every in-scope source.
- [ ] Inline typed-balance inputs remain visible and editable in both modes; editing a source's balance updates the net-worth line within one second.
- [ ] Tooltip continues to show date + balance for the nearest data point in either mode.
- [ ] When the active scope changes, the net-worth line is recomputed for the new in-scope sources.
- [ ] New tests in `_test_selectors.js` cover `netWorthSeries` for: empty scope (returns `[]`), single-source scope (equals that source's series), multi-source scope with non-overlapping date ranges (backfill with previous known balance), and the sum-anchors-to-typed-balances property (at least 4 assertions).
- [ ] No new npm dependencies; no build step changes; existing tests still pass.

## Blocked by

- `ISSUE-002` (builds on the per-source view, the `BalanceChart` component, and `balanceSeries`).
