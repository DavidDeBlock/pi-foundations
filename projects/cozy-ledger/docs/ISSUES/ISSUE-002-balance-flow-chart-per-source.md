# ISSUE-002 — Balance flow chart (per-source view)

## Parent

[PRD] Scope-aware dashboard + balance flow chart — `docs/PRD/PRD-001-scope-and-balance-flow.md`

## What to build

A new full-width "Balance over time" card at the bottom of the dashboard. It draws one step-line per source currently in scope, anchored to a typed current bank balance that the user enters once per source.

Concretely:

- New selector `balanceSeries(state, sourceId)` returns `[{ date, balance }]`, walking the source's transactions backwards from the latest date and anchoring the latest point at `source.balance`.
- New `BalanceChart` SVG component (vanilla, no library) takes an array of `{ sourceId, points }` and renders one step line per source, using muted colors drawn from the design palette in `styles.css`.
- Time axis: left = oldest date across all in-scope series, right = today. Y axis: EUR, with a soft horizontal grid.
- Each source has an inline number input on the chart card for the typed current balance. Edits debounce-save into `source.balance`. After save, a small "✓ saved" indicator appears briefly.
- Tooltip on hover/tap shows date + balance for the nearest data point.
- The chart respects the active scope: `Private` shows only the user's sources, `Shared` shows only sources with `ownerId === null`, `All` shows everything.

## Acceptance criteria

- [ ] A new card titled "Balance over time" renders at the bottom of the dashboard, full width.
- [ ] When the active scope is `Private` and the user owns one source with transactions, the card shows exactly one step line for that source.
- [ ] When the active scope is `All`, the card shows one step line per source (in the seed: David private, Isabelle private, Joint, Cash, Savings).
- [ ] Each line's rightmost point equals `source.balance` for that source (within rounding).
- [ ] Walking one transaction-day backwards reduces the balance by that day's net flow (income − expense) — verified by an explicit test.
- [ ] A source with zero transactions renders as a flat line at `source.balance`.
- [ ] Typing a new value into a source's inline input updates that line's rightmost point within one second, persists across reloads, and shows a "✓ saved" indicator briefly.
- [ ] Tooltip on hover shows date + balance for the nearest data point on the nearest line.
- [ ] Lines are drawn as step-lines (horizontal segment between events, vertical jump at each transaction date) — no diagonal interpolation.
- [ ] The chart's leftmost data point equals the rightmost data point when the source has zero transactions, otherwise it equals `source.balance + sum(income − expense over all dates after the leftmost)`.
- [ ] New tests in `_test_selectors.js` cover `balanceSeries` for: a source with no transactions, a source with one transaction, a source with many transactions across many days, and the backwards-from-typed-balance property (at least 4 assertions).
- [ ] The dashboard's existing cards (summary, trend, donut, recent) and the existing monthly "Balance" card are unchanged.
- [ ] No new npm dependencies; no build step changes; existing tests still pass.

## Blocked by

- `ISSUE-001` (needs `settings.scope`, `Selectors.sourcesInScope` / `transactionsInScope`, and the dashboard scope plumbing).
