# ISSUE-017 — Goals end-to-end

## Parent

[PRD] Savings — Goals & Envelopes — `docs/PRD/PRD-005-savings-goals-and-envelopes.md`

## Why

The household has concrete savings targets (solar panels, future trips, big purchases) that currently live outside the app. A goal is the simplest primitive — pure accumulation toward a target, with no transaction plumbing — and getting it end-to-end (data → page → modal → CRUD → sidebar nav) gives the user a tangible win and validates the data model before we tackle envelopes.

## What to build

1. **Data model in `data.js`**.

   Add the seed shape to the existing `Store.load()` defaults:

   ```js
   state.goals = state.goals || [];   // idempotent migration
   ```

   Seed: `[]` on first load — no goals are created automatically.

2. **Store methods** (extend the existing `Store` in `data.js`):

   - `Store.addGoal(state, partial)` — validates `name` and `target > 0`, generates `id` + `createdAt` + `updatedAt`, defaults `funded = 0`, `targetDate = null`, `notes = ''`, `fundingHistory = []`. Dispatches `store:changed`.
   - `Store.updateGoal(state, id, patch)` — applies patch to an existing goal, refreshes `updatedAt`. Refuses to change `id`, `funded`, `fundingHistory` here (those go through `fundGoal`).
   - `Store.deleteGoal(state, id)` — removes the goal, dispatches `store:changed`.
   - `Store.fundGoal(state, id, { date, amount })` — validates `amount > 0`, appends `{ date, amount }` to `fundingHistory`, increments `funded`, refreshes `updatedAt`.

3. **Pure helper in `selectors.js`**:

   - `Selectors.goalProgress(goal)` → `{ funded, target, percent, remaining }`. `percent = funded / target * 100` (can exceed 100). `remaining = Math.max(0, target - funded)`.

4. **New view `views/goals.js`**.

   Exposes `Goals.render()` returning a `view-goals` element with:

   - A card-head containing the page title (`t('goals.title')`) and an "Add" button (`t('goals.add')`).
   - A list card. Each row: name, `€funded / €target` label, a progress bar coloured green when `< 100%`, deep-green when `== 100%`, sage-red when `> 100%`. Right side: `Fund` (opens inline form with amount + date inputs), `Edit` (opens the goal modal pre-filled), `Delete` (confirms then calls `Store.deleteGoal`).
   - Empty state when `state.goals.length === 0`: title + message + primary "Add" button.

5. **Add/Edit modal** (reuse the existing `openTransactionModal` / category-modal pattern).

   Fields:
   - `name` (text, required)
   - `target` (number, required, `> 0`)
   - `targetDate` (date input, optional)
   - `notes` (textarea, optional)

   Save calls `Store.addGoal` or `Store.updateGoal`. Cancel closes the modal without persisting. Validation errors render inline with Dutch messages.

6. **Sidebar nav**.

   Add a `navItem(...)` in `app.js` for `Doelen` with the route `'goals'`. Register the route in the `titles` map of `renderView()` so `t('goals.title')` resolves.

7. **Script loading order** in `index.html`.

   Add `<script src="views/goals.js"></script>` after the other `views/*.js` tags (it depends on `Store`, `Selectors`, `ViewHelpers`, `Fmt`, `el`, `t` — all already loaded).

8. **i18n keys** (added to the Dutch table in `i18n.js`):

   ```
   'goals.nav':              'Doelen',
   'goals.title':            'Doelen',
   'goals.add':              'Doel toevoegen',
   'goals.edit':             'Bewerken',
   'goals.delete':           'Verwijderen',
   'goals.fund':             'Storten',
   'goals.empty.title':      'Nog geen doelen',
   'goals.empty.msg':        'Voeg je eerste spaardoel toe — bijvoorbeeld zonnepanelen of een reis.',
   'goals.form.name':        'Naam',
   'goals.form.target':      'Doelbedrag',
   'goals.form.targetDate':  'Streefdatum',
   'goals.form.notes':       'Notities',
   'goals.fund.amount':      'Bedrag',
   'goals.fund.date':        'Datum',
   'goals.fund.confirm':     'Storten',
   'goals.fund.cancel':      'Annuleren',
   'goals.card.funded':      '€{funded} van €{target}',
   'goals.card.remaining':   'Nog €{remaining} te gaan',
   'goals.card.reached':     'Doel bereikt 🎉',
   'goals.card.over':        '€{over} boven doel',
   'goals.delete.confirm':   'Weet je zeker dat je dit doel wilt verwijderen?',
   ```

9. **Tests**.

   - In `_test_selectors.js` (or a new `_test_goals.js`): `goalProgress` for `funded < target`, `funded == target`, `funded > target`. At least 3 assertions.
   - In `_test_boot.js`: state with one seeded goal renders the row with the correct progress percent; clicking Fund opens the inline form; submitting updates `funded` and appends to history; deleting removes the goal.

## Acceptance criteria

- [x] `state.goals` exists on `App._state`, defaults to `[]`, idempotent across reloads.
- [x] All four Store methods exist and pass `npm test`.
- [x] `Selectors.goalProgress` is exported and tested.
- [x] `views/goals.js` exists, exposes `Goals.render()` on `window`.
- [x] Sidebar shows a `Doelen` nav item; clicking it renders the goals page.
- [x] Add modal creates a goal; Edit modal updates; Delete confirms and removes.
- [x] Fund action appends to `fundingHistory` and increments `funded` correctly.
- [x] Progress bar colour: green `< 100%`, deep-green `== 100%`, sage-red `> 100%`.
- [x] All 22+ new i18n keys resolve to Dutch strings.
- [x] Empty state appears when `state.goals.length === 0`.
- [x] At least 6 new test assertions across `_test_selectors.js` and `_test_boot.js`.
- [x] `npm test` and `npm run lint` clean.

## Blocked by

None.

## Out of scope

- Envelopes (covered by ISSUE-018).
- Dashboard summary cards (covered by ISSUE-019).
- Linking a goal to a Source (deferred).
- Recurring contributions (deferred).
- Editing historical `fundingHistory` entries (append-only).
- Goal categories or grouping.
- Multi-user ownership.
- Notifications when a goal is reached.
## Implementation log

Captured during implementation.

### What was built

The Goals feature ships end-to-end: a typed `Goal` data model with
`funded` + append-only `fundingHistory`, four `Store.*` methods, a
pure `Selectors.goalProgress` helper, a new `views/goals.js` page
with progress bars + inline Fund form, an Add/Edit modal at
`modals/goal.js`, sidebar nav, 22 i18n keys, and 30 new test
assertions.

### Files changed

| File | Δ |
|---|---|
| `types.js` | **+** `Goal` + `GoalFunding` typedefs; added `goals?: Goal[]` to `State` |
| `data.js` | **+** migration that backfills `state.goals = []` and normalises existing entries (funded as number, fundingHistory as array); **+** 4 public methods: `addGoal`, `updateGoal`, `deleteGoal`, `fundGoal`. `addGoal` throws on invalid input (blank name / target ≤ 0); `updateGoal` refuses to mutate `id`/`funded`/`fundingHistory`; `fundGoal` validates amount > 0 and defaults `date` to today |
| `selectors.js` | **+** `Selectors.goalProgress(goal)` returning `{funded, target, percent, remaining}`; `percent` can exceed 100; `remaining` is clamped to 0; `target = 0` returns `percent = 0` (no division by zero); rounds percent to 2 decimals |
| `views/goals.js` | **NEW** — IIFE exposing `Goals.render()`. Renders a card with title + sub + add button; empty state when no goals; row per goal with progress bar, label, caption (reached / remaining / over), Storten/Edit/Delete buttons; inline Fund form with amount + date + validation. Three progress-bar states (`< 100%` sage, `== 100%` deep-sage, `> 100%` red) |
| `modals/goal.js` | **NEW** — Add / Edit modal via `Modal.create` (name, target, targetDate, notes); delete via `confirmAction` + `Store.deleteGoal`. Reuses the existing Modal helper (ISSUE-009) |
| `router.js` | **~** added `goals` to titles map and the dispatch chain; hides the topbar "Add transaction" button on the Goals view |
| `shell.js` | **~** added `navItem('goals', t('goals.nav'), Icons.target)` between payees and the backup section; added `goals` to `updateSidebarBadges` counts |
| `icons.js` | **+** `target` SVG (3 concentric circles) for the nav icon |
| `i18n.js` | **+** 22 new Dutch keys (nav, title, sub, add/edit/delete/fund, form fields, captions, error toasts, success toasts) |
| `styles.css` | **+** `.view-goals`, `.goal-list`, `.goal-row`, `.goal-bar` + `.goal-bar-fill` + `--full` / `--over` modifiers, `.goal-caption` + colour modifiers, `.goal-fund-form` (inline form layout with responsive collapse) |
| `index.html` | **~** `?v=20` → `?v=21` (34 → 36 script tags); added `views/goals.js` and `modals/goal.js` |
| `eslint.config.js` | **+** `Goals` to browser globals; **+** `caughtErrorsIgnorePattern: '^_'` to test-file no-unused-vars config |
| `globals.d.ts` | **+** `Goal` + `GoalFunding` interfaces; extended `State` (`goals?: Goal[]`); added 4 `Store` methods, `Selectors.goalProgress`, `Goals` view, `Modals.goal` / `Modals.goalDelete` |
| `_test_selectors.js` | **+** 6 tests: partial / exact / over / target=0 / null-undefined / rounding |
| `_test_boot.js` | **+** 16 tests: migration, `addGoal` happy + 2 validation paths, `updateGoal` patch + protected fields, `fundGoal` append + bump, `deleteGoal`, sidebar nav item, empty state, seeded row percent, bar-class flips, Fund button toggles inline form, Fund submit updates state, Add modal opens with all fields, `goalDelete` removes goal, all 22 i18n keys resolve |

### Decisions / trade-offs

- **`funded` and `fundingHistory` are write-only through `fundGoal`** — `updateGoal` strips them from its patch and returns the original unchanged. The test `Store.updateGoal patches fields and stamps updatedAt` verifies that `funded` doesn't change when `updateGoal` is called.
- **`fundGoal` defaults `date` to today** if the caller omits it. The inline Fund form in `views/goals.js` always supplies a date (pre-filled with `Fmt.today()`), but the Store method is permissive for callers that pass only an amount.
- **Progress bar width capped at 100%** even when `percent > 100` — the `--over` modifier switches the colour to red so the user sees they exceeded the target, but the bar doesn't overflow its container.
- **Caption text uses `{funded}` not `€{funded}`** — `Fmt.money()` returns `"€1.250,00"` already with the euro sign, so the i18n template must not duplicate it. Initially written as `€{funded} …`, caught in real-browser verification when labels showed `€€1.250,00`. Fixed by dropping the `€` from the templates.
- **Inline Fund form, not modal** — the spec called for an inline form to avoid bouncing through a modal for every deposit. The Fund button toggles a `.goal-fund-form` div inside each row; the form has its own amount + date inputs and a submit/cancel pair.
- **Delete confirmation in a separate `confirmAction` call** — the spec said "confirms then calls `Store.deleteGoal`". The category modal pattern was reused: `window.confirmAction(t('goals.delete.confirm'))` then `Store.deleteGoal(...)` + `dispatchEvent('store:changed')`. The test stub returns `true` for `window.confirm` so the assertion is deterministic.
- **Goal nav placement** — between "Beheren" (sources / categories / users / payees) and "Back-up" (settings). Visually a sub-section under manage; the icon (`target`) reads well at small sizes.
- **Idempotent migration** — the migration normalises both `goals === undefined` (old saves) and `goals` entries with missing/odd fields (older saves that might pre-date `notes` or `targetDate`). Each normalisation is a no-op for already-valid data.
- **`fundGoal` uses local `round2`** — the IIFE-private helper for cents-rounded totals. `Selectors` exports the same `round2` but is not visible inside `data.js`'s IIFE, so we duplicate the one-liner. Trivial cost, keeps the Store symmetric.

### Real-browser verification (seeded 3 goals: partial, exact, over)

| Goal | Funded / Target | Bar width | Bar colour | Caption |
|---|---|---|---|---|
| Zonnepanelen | €1.250 / €5.000 | 25% | sage | "Nog €3.750,00 te gaan" |
| Reis Italië | €2.000 / €2.000 | 100% | deep-sage | "Doel bereikt 🎉" |
| Nieuwe laptop | €2.100 / €1.500 | 100% (capped) | red | "€600,00 boven doel" |

Sidebar shows `Doelen 3` (count badge). Active state on Goals row.

Additional flows verified in Playwright:
- Click Storten → inline form appears with amount + date inputs.
- Submit amount=500, date=2026-06-20 → `funded` updates to 1750, `fundingHistory` grows by 1 entry, row re-renders.
- Open Add modal → all 4 fields render (`#f-name`, `#f-target`, `#f-targetDate`, `#f-notes`).
- Submit new goal (name="Nieuwe auto", target=15000) → goal count goes 3 → 4, defaults applied (funded=0, fundingHistory=[]).

No console / page errors throughout. Screenshot at `/tmp/issue017-final.png`.

### Test results

| Suite | Before | After |
|---|---|---|
| `_test_csv.js` | 21 | 21 |
| `_test_selectors.js` | 73 | **79** (+6) |
| `_test_period.js` | 34 | 34 |
| `_test_boot.js` | 105 | **121** (+16) |
| **total** | 233 | **255** |

`npm run lint`: 0 errors, 11 pre-existing warnings (none introduced).

### Known follow-ups (out of scope)

- **Envelopes** (covered by ISSUE-018): budgeted spending categories with rollover. The `Goal` data model is intentionally simpler than what envelopes will need (no per-period rollover, no transactions link).
- **Dashboard summary cards** (covered by ISSUE-019): surface total funded + total target on the dashboard's summary row.
- **Linking a goal to a Source**: a "from" dropdown on the Fund action would let users auto-deduct from a bank balance. Out of scope for this slice.
- **Recurring contributions / auto-funding**: deferred.
- **Editing `fundingHistory` entries**: append-only by design. Corrections would require a delete-and-redo flow.
- **Goal categories / grouping**: not requested.
- **Multi-user ownership**: not requested.
- **Notifications when a goal is reached**: not requested.
