# [PRD] Savings — Goals & Envelopes

## Problem Statement

The Cozy Ledger today answers "where did my money go?" but not two questions the household actually asks:

1. **Saving toward something we don't have yet** — solar panels, a holiday, a new laptop. Right now there is no place to declare "we want €8,000 by summer 2027" and watch the funded amount grow over time. The user has to track that mentally or in a spreadsheet.
2. **Capping spending on things we already do** — restaurants, groceries, going out. The app shows historical spend per category, but it cannot say "we agreed to spend only €1,000 on restaurants this month, and we've already spent €640". Without a cap, overspending is only visible *after* the fact, when the month's summary rolls in.

The two questions look similar on the surface ("how much money is in this pot?") but pull in opposite directions: a goal is purely imaginary money being accumulated; an envelope is real money being drained by actual transactions. Conflating them in one primitive would force the model to carry a lot of optional fields per mode and would muddy the user's mental model.

## Solution

Introduce **two separate primitives** with their own pages, their own CRUD, and their own dashboard summary cards:

- **`Goals`** — pure accumulation. No transaction link, no category, no payee. The user names the goal, sets a target, optionally a target date, and clicks "Storten" (Fund) to add money. Funded amount grows over time. Progress = `funded / target`.
- **`Envelopes`** — cap on existing spend. The user names the envelope, sets a cap and a period (`monthly` | `yearly`), and links it to a *set* of categories and/or a *set* of payees. Any in-scope transaction matching the links drains the envelope. Progress = `spent / cap` for the current calendar period.

Both have a list page (sidebar item) and a summary card on the dashboard showing the top 3 by urgency.

## User Stories

1. As a user saving for solar panels, I want to create a Goal with a target amount and a target date, so that I can see how close I am and stay motivated.
2. As a user, I want to "stort" (fund) a goal with a dated amount, so that the funded total grows over time and the history shows when I added what.
3. As a user, I want to edit a goal's name, target, or target date without losing the funded amount.
4. As a user, I want to delete a goal when it's done or no longer relevant.
5. As a user who eats out often, I want to create an Envelope with a monthly cap of €1,000 linked to the `Restaurants` category, so that I can see at a glance how much I've spent and how much I have left.
6. As a user, I want to link an envelope to multiple categories *and* multiple payees, so that I can cap "all eating out" even when some of it is filed under different categories.
7. As a user, I want a yearly cap option, so that I can set a €12,000 yearly grocery limit without resetting every month.
8. As a user, I want the envelope's "spent" amount to update live as I log transactions, so that I see the latest number whenever I open the app.
9. As a user, I want a clear visual when I'm over budget (red bar + "€X over"), so that overspending is immediately obvious.
10. As a user, I want a summary card on the dashboard showing the top 3 goals and the top 3 envelopes by urgency, so that I can see what matters at a glance.
11. As a user, I want the dashboard summary cards to ignore the new period selector, because envelopes always mean "this calendar month" or "this calendar year" — not "the last 3 months rolling".
12. As a user, I want full CRUD on both, with sensible Dutch labels matching the rest of the app.

## Implementation Decisions

### Data model

Both stored in `App._state` as arrays, persisted via the existing `Store` methods, migrated to `[]` on first load (idempotent).

**Goal**
```js
{
  id, name,
  target,                          // EUR (positive number)
  funded: 0,                       // EUR; starts at 0
  targetDate: 'YYYY-MM-DD' | null, // optional
  notes: '',
  fundingHistory: [                // appended by fundGoal()
    { date: 'YYYY-MM-DD', amount } // latest last
  ],
  createdAt, updatedAt,
}
```

**Envelope**
```js
{
  id, name,
  cap,                              // EUR (positive number)
  period: 'monthly' | 'yearly',
  categoryIds: [],                  // ids from state.categories
  payeeIds: [],                     // ids from state.payees
  notes: '',
  createdAt, updatedAt,
}
```

No `ownerId` in v1 — goals and envelopes are shared by default. Adding per-user ownership is a future issue.

### Store extensions

New methods, each going through the existing `store:changed` event:

- `Store.addGoal(state, partial)`, `Store.updateGoal(state, id, patch)`, `Store.deleteGoal(state, id)`
- `Store.fundGoal(state, id, { date, amount })` — appends to `fundingHistory`, increases `funded` by `amount`, touches `updatedAt`
- `Store.addEnvelope(state, partial)`, `Store.updateEnvelope(state, id, patch)`, `Store.deleteEnvelope(state, id)`

All take and mutate `App._state` per the existing pattern. Migration in `Store.load()`: `state.goals = state.goals || []`, `state.envelopes = state.envelopes || []`. Idempotent across reloads.

### Pure helpers (`selectors.js`)

- `Selectors.goalProgress(goal)` → `{ funded, target, percent, remaining }`. `percent` is `0..100+`, `remaining = max(0, target - funded)`.
- `Selectors.currentPeriodFor(envelope, today = new Date())` → `{ from, to }` ISO dates:
  - `monthly`: `from = first of current month`, `to = today`
  - `yearly`: `from = currentYear-01-01`, `to = today`
- `Selectors.envelopeSpend(envelope, state, today = new Date())` → EUR sum of in-scope transactions whose `categoryId ∈ envelope.categoryIds` OR whose `payeeId ∈ envelope.payeeIds`, dated in `[from, to]`. A transaction matching both criteria is counted once.
- `Selectors.envelopeProgress(envelope, state, today)` → `{ spent, cap, percent, remaining, overspent }`. `overspent = max(0, spent - cap)`. `percent = (spent / cap) * 100`.

### UI shape

- Two new sidebar nav items: `Doelen`, `Enveloppen`. Each renders a list card via the existing modal-helper pattern.
- Add/Edit modals follow the existing category / source modal style (name + fields + save/cancel). The envelope modal has two multi-selects (categories and payees) — chips or checkboxes, drawn from existing collections.
- A small `Fund` action on each goal row (inline amount + date input + confirm).
- Delete always confirms with a Dutch message naming the entity.
- Dashboard: two new cards above the summary grid — `Doelen` (top 3 by `% funded` desc) and `Enveloppen` (top 3 by `% spent` desc). Each row: name + progress bar + `€X / €Y` + remaining/overspent label. "View all" link to the page if more than 3.
- Unaffected by the period selector — they always reflect "current state".

### i18n

All new keys in Dutch, mirroring the rest of the app. Major keys:

- `goals.nav`, `goals.title`, `goals.add`, `goals.edit`, `goals.delete`, `goals.fund`, `goals.empty.title`, `goals.empty.msg`
- `goals.form.name`, `goals.form.target`, `goals.form.targetDate`, `goals.form.notes`, `goals.fund.amount`, `goals.fund.date`, `goals.fund.confirm`, `goals.card.funded`, `goals.delete.confirm`
- `envelopes.nav`, `envelopes.title`, `envelopes.add`, `envelopes.edit`, `envelopes.delete`, `envelopes.empty.title`, `envelopes.empty.msg`
- `envelopes.form.name`, `envelopes.form.cap`, `envelopes.form.period`, `envelopes.form.period.monthly`, `envelopes.form.period.yearly`, `envelopes.form.categories`, `envelopes.form.payees`, `envelopes.form.notes`
- `envelopes.card.spent`, `envelopes.card.remaining`, `envelopes.card.overspent`, `envelopes.delete.confirm`
- `dashboard.goals.title`, `dashboard.goals.empty`, `dashboard.goals.viewAll`
- `dashboard.envelopes.title`, `dashboard.envelopes.empty`, `dashboard.envelopes.viewAll`, `dashboard.envelopes.overspent`

### What goes away

Nothing. This is purely additive.

## Testing Decisions

- **Pure helpers** (`Selectors.goalProgress`, `Selectors.envelopeSpend`, `Selectors.envelopeProgress`, `Selectors.currentPeriodFor`) tested at the function level in `_test_selectors.js` (or a new `_test_savings.js`). Cases:
  - Goal with `funded < target`, `funded == target`, `funded > target` (percent ≥ 100, remaining = 0).
  - Envelope match by category only, by payee only, by both (counted once).
  - Envelope spend respects scope (in-scope transactions only).
  - Envelope calendar-period reset: monthly spans the 1st → today; yearly spans Jan 1 → today.
  - Empty envelope (no links, no spend): `spent = 0`, `overspent = 0`.
- **Store**: add/update/delete round-trips; `fundGoal` appends to history and updates `funded`; migration is idempotent.
- **Boot smoke** (`_test_boot.js`): new sidebar nav items present; clicking each mounts the list card; opening the Add modal mounts the form fields; submitting persists state and re-renders.
- **Out of test scope**: pixel-perfect progress bar colours, modal animations.

## Children

- `ISSUE-017` — Goals end-to-end (data + page + CRUD + dashboard card not yet)
- `ISSUE-018` — Envelopes end-to-end (data + page + CRUD + dashboard card not yet)
- `ISSUE-019` — Dashboard savings summary cards

## Out of Scope

- Linking a Goal to a Source (`savings` source balance → goal funded). Pure counter for v1.
- Recurring contributions ("save €100/month automatically"). Goals are funded manually only.
- Roll-over of unspent monthly envelope cap into the next month.
- Per-user / per-scope ownership of goals or envelopes.
- Notifications or alerts when a goal is reached or an envelope is near its cap.
- Editing historical `fundingHistory` entries (append-only).
- A "fiscal year" preset for yearly envelopes (calendar Jan–Dec only).
- Re-counting historical spend when envelope links change — the spend number always reflects the *current* link set against the *full* transaction history within the current period. No time travel.
- Importing/exporting goals or envelopes (covered separately by ISSUE-006's export work).
- Drag-to-reorder of goals or envelopes.