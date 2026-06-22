# ISSUE-004 — Dashboard refactor: Trends tab + net-worth view

## Parent

[PRD] Scope-aware dashboard + balance flow chart — `docs/PRD/PRD-001-scope-and-balance-flow.md`

## Why

The dashboard accumulated every visualisation we built. After ISSUE-002
the "Balance over time" card sat on the same view as the 6-month
income/expenses bar chart, the spending-share donut, the recent
transactions list, the top-categories card, and four summary cards. The
multi-month charts (balance, income/expenses) are the new centre of
gravity — they belong on their own page.

## What to build

1. **New "Trends" route.** Reachable from the sidebar. Hosts everything
   that visualises more than one month: the balance over time chart, the
   6-month income vs expenses bar chart, and the top-categories card.
2. **Simplified "Dashboard" (current default view).** 4 summary cards,
   spending-share donut, recent transactions, and top categories. The
   bar chart and balance flow card are removed.
3. **Net-worth view (ISSUE-003).** Built into the balance over time
   card as a "Per source ↔ Net worth" toggle. Aggregates per-day
   balances across all in-scope sources into a single step line.
4. **Top categories** renders on both views, using a shared helper.

## Acceptance criteria

- [ ] A new "Trends" nav item appears in the sidebar.
- [ ] Clicking Trends shows three cards in this order: Balance over
      time (with a "Per source / Net worth" toggle), Income vs
      expenses — last 6 months, Top categories this month.
- [ ] Clicking Dashboard (default) shows: 4 summary cards, Spending
      share donut, Recent transactions, Top categories this month.
- [ ] The default month picker is hidden on the Trends view.
- [ ] The scope selector (Private / Shared / All) is visible on both
      views and filters each view's content.
- [ ] Balance over time has a "Per source / Net worth" toggle. The
      selected mode is sticky across scope changes within the session.
- [ ] In "Net worth" mode, exactly one step line is drawn. Its
      rightmost point equals the sum of `source.balance` across all
      in-scope sources. Its leftmost point equals the sum of balances
      at the oldest date in the chart's x-range.
- [ ] In "Per source" mode, the chart behaves exactly as it did after
      ISSUE-002 (one line per source, flat lines for sources without
      transactions).
- [ ] Top categories on the Trends view reflects the same month filter
      as the dashboard (no separate month picker).
- [ ] New selector `netWorthSeries(state)` has tests in
      `_test_selectors.js`: empty sources, all sources with no tx, two
      sources with tx on different days, rightmost = sum of typed
      balances.
- [ ] New boot test in `_test_boot.js`: clicking the Trends nav item
      mounts the balance flow card with the toggle; switching the
      toggle changes the line count from N to 1.
- [ ] All existing tests still pass.

## Out of scope

- The "Viewing as" UI (still hardcoded to `u_david`).
- Per-month selector on the Trends view.
- Yearly summary or longer-range aggregations.
