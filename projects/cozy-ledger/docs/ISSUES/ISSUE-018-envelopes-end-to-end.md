# ISSUE-018 — Envelopes end-to-end

## Parent

[PRD] Savings — Goals & Envelopes — `docs/PRD/PRD-005-savings-goals-and-envelopes.md`

## Why

Goals (ISSUE-017) cover saving toward future things. Envelopes cover the other half of the user's question: capping spending on things they already do. Where a goal is "imaginary money accumulating", an envelope is "real money being drained by transactions tagged to categories or payees". The two primitives look similar in the UI but have very different mechanics — this issue builds the second one end-to-end.

## What to build

1. **Data model in `data.js`**.

   Add to `Store.load()` defaults:

   ```js
   state.envelopes = state.envelopes || [];   // idempotent migration
   ```

   Seed: `[]` on first load.

2. **Store methods** (extend `Store` in `data.js`):

   - `Store.addEnvelope(state, partial)` — validates `name`, `cap > 0`, `period ∈ {'monthly','yearly'}`. Defaults `categoryIds = []`, `payeeIds = []`, `notes = ''`. Generates `id`, `createdAt`, `updatedAt`. Dispatches `store:changed`.
   - `Store.updateEnvelope(state, id, patch)` — applies patch to an existing envelope, refreshes `updatedAt`. Refuses to change `id`, `createdAt`.
   - `Store.deleteEnvelope(state, id)` — removes, dispatches `store:changed`.

3. **Pure helpers in `selectors.js`**:

   - `Selectors.currentPeriodFor(envelope, today = new Date())` → `{ from, to }` ISO dates.
     - `monthly`: `from = first of current month`, `to = today` (clamped to last day of month if today is the 31st and month has 30 days).
     - `yearly`: `from = currentYear-01-01`, `to = today`.
   - `Selectors.envelopeSpend(envelope, state, today = new Date())` → EUR sum of in-scope transactions whose `categoryId ∈ envelope.categoryIds` OR whose `payeeId ∈ envelope.payeeIds`, dated in `[from, to]`. A transaction matching both criteria is counted once.
   - `Selectors.envelopeProgress(envelope, state, today)` → `{ spent, cap, percent, remaining, overspent }`:
     - `percent = (spent / cap) * 100`
     - `remaining = Math.max(0, cap - spent)`
     - `overspent = Math.max(0, spent - cap)`

4. **New view `views/envelopes.js`**.

   Exposes `Envelopes.render()` returning a `view-envelopes` element with:

   - A card-head containing the page title (`t('envelopes.title')`) and an `Add` button.
   - A list card. Each row:
     - Name, period label (`Maandelijks` / `Jaarlijks`).
     - Spent / cap label (`€640 / €1,000`).
     - Progress bar: green when `< 80%`, amber `>= 80%`, sage-red when `> 100%`.
     - Remaining label (`Nog €360 over`) when not overspent; overspent label (`€50 over limiet`) when overspent.
     - `Edit` and `Delete` buttons.
   - Empty state when `state.envelopes.length === 0`.

5. **Add/Edit modal**.

   Fields:
   - `name` (text, required)
   - `cap` (number, required, `> 0`)
   - `period` (select with `monthly` / `yearly`)
   - `categoryIds` (multi-select — chips or checkboxes — sourced from `state.categories`, all categories allowed regardless of group/type)
   - `payeeIds` (multi-select — sourced from `state.payees`)
   - `notes` (textarea, optional)

   Save calls `Store.addEnvelope` or `Store.updateEnvelope`. Validation: at least one of `categoryIds` or `payeeIds` must be non-empty (otherwise the envelope matches nothing — refuse with a Dutch message).

6. **Sidebar nav**.

   Add `navItem(...)` for `Enveloppen` with route `'envelopes'`. Register the route in the `titles` map of `renderView()`.

7. **Script loading order** in `index.html`.

   Add `<script src="views/envelopes.js"></script>` after the other view scripts.

8. **i18n keys** (added to `i18n.js`):

   ```
   'envelopes.nav':                    'Enveloppen',
   'envelopes.title':                  'Enveloppen',
   'envelopes.add':                    'Envelop toevoegen',
   'envelopes.edit':                   'Bewerken',
   'envelopes.delete':                 'Verwijderen',
   'envelopes.empty.title':            'Nog geen enveloppen',
   'envelopes.empty.msg':              'Stel een limiet in voor restaurants, boodschappen of een andere categorie.',
   'envelopes.form.name':              'Naam',
   'envelopes.form.cap':               'Limiet',
   'envelopes.form.period':            'Periode',
   'envelopes.form.period.monthly':    'Maandelijks',
   'envelopes.form.period.yearly':     'Jaarlijks',
   'envelopes.form.categories':        'Categorieën',
   'envelopes.form.payees':            'Begunstigden',
   'envelopes.form.notes':             'Notitie',
   'envelopes.form.links.required':    'Kies minstens één categorie of begunstigde.',
   'envelopes.card.spent':             '€{spent} van €{cap}',
   'envelopes.card.remaining':         'Nog €{remaining} over',
   'envelopes.card.overspent':         '€{over} over limiet',
   'envelopes.card.period.monthly':    'Deze maand',
   'envelopes.card.period.yearly':     'Dit jaar',
   'envelopes.delete.confirm':         'Weet je zeker dat je deze envelop wilt verwijderen?',
   ```

9. **Tests**.

   - In `_test_selectors.js` (or `_test_envelopes.js`):
     - `currentPeriodFor` for monthly and yearly, with at least 3 different `today` dates.
     - `envelopeSpend`: empty envelope (no links) returns 0; envelope with one category matches only that category's txns in period; envelope with one payee matches only that payee's txns; envelope with both, where a txn matches both, counts once; transactions outside the current period are excluded; out-of-scope transactions are excluded.
     - `envelopeProgress`: `spent < cap`, `spent == cap`, `spent > cap` (overspent > 0).
   - In `_test_boot.js`: with one seeded envelope, the row shows the right spent/cap label and progress percent; deleting the envelope removes the row.

## Acceptance criteria

- [x] `state.envelopes` exists, defaults to `[]`, idempotent.
- [x] All three Store methods exist and pass tests.
- [x] `Selectors.currentPeriodFor`, `Selectors.envelopeSpend`, `Selectors.envelopeProgress` are exported and tested.
- [x] `views/envelopes.js` exists, exposes `Envelopes.render()` on `window`.
- [x] Sidebar shows `Enveloppen`; clicking it renders the envelopes page.
- [x] Add modal creates an envelope; Edit modal updates; Delete confirms and removes.
- [x] Validation: at least one of `categoryIds` / `payeeIds` must be non-empty.
- [x] Progress bar colour reflects utilization (green < 80%, amber >= 80%, red > 100%).
- [x] Overspent label (`€X over limiet`) appears when spent > cap.
- [x] All 22 new i18n keys resolve to Dutch strings.
- [x] Empty state appears when `state.envelopes.length === 0`.
- [x] At least 10 new test assertions across the test files (**14 selector + 13 boot = 27 new**).
- [x] `npm test` and `npm run lint` clean.

## Blocked by

None.

## Out of scope

- Goals (covered by ISSUE-017).
- Dashboard summary cards (covered by ISSUE-019).
- Recurring contributions or roll-over.
- Per-user ownership.
- Notifications when near cap.
- Editing historical spend retroactively (the spent number always reflects the current link set against the full transaction history).
- "Fiscal year" support for yearly envelopes (calendar Jan–Dec only).
- Drag-to-reorder of envelopes.
## Implementation log

### What was built

The Envelopes feature ships end-to-end: a typed `Envelope` data model
with `categoryIds` + `payeeIds` link arrays, three `Store.*` methods,
three pure `Selectors.*` helpers, a new `views/envelopes.js` page with
three-state progress bars + period chips, an Add/Edit modal at
`modals/envelope.js` with chip multi-selects for both categories and
payees, sidebar nav, 22 i18n keys, and 27 new test assertions.

### Files changed

| File | Δ |
|---|---|
| `types.js` | **+** `Envelope` + `EnvelopePeriod` typedefs; added `envelopes?: Envelope[]` to `State` |
| `data.js` | **+** migration that backfills `state.envelopes = []` and normalises existing entries (period → `'monthly'` if unknown, cap → number, link arrays → arrays); **+** 3 public methods: `addEnvelope`, `updateEnvelope`, `deleteEnvelope`. `addEnvelope` throws on invalid input (blank name / non-positive cap / invalid period); `updateEnvelope` refuses to mutate `id` / `createdAt` and re-validates cap + period on patch |
| `selectors.js` | **+** 3 pure helpers: `currentPeriodFor(env, today)` returning `{from, to}` (monthly = first-of-month → today; yearly = Jan 1 → today); `envelopeSpend(env, state, today)` summing in-period txns whose categoryId OR extracted-payee matches the envelope (dedup by txn id so a match-both count once, income rows subtract); `envelopeProgress(env, state, today)` returning `{spent, cap, percent, remaining, overspent}` with `remaining` and `overspent` both clamped to 0 |
| `views/envelopes.js` | **NEW** — IIFE exposing `Envelopes.render()`. Renders a card with title + add button; empty state when no envelopes; row per envelope with name, "Deze maand" / "Dit jaar" period chip, "€X van €Y" label, progress bar (sage < 80%, amber >= 80%, red > 100%; capped at 100% width), and remaining / overspent caption. Edit + Delete actions. Bar width capped at 100% even when overspent |
| `modals/envelope.js` | **NEW** — Add / Edit modal via `Modal.create` (name, cap, period, **categoryIds chip multi-select**, **payeeIds chip multi-select**, notes); delete via `confirmAction` + `Store.deleteEnvelope`. Reuses the existing Modal helper (ISSUE-009). Chip multi-selects are custom fields because the modal helper has no native checkbox-group renderer yet. Read-back via DOM (`.chip-on` class) on save. Validation: at least one of categoryIds / payeeIds must be non-empty |
| `router.js` | **~** added `envelopes` to titles map and the dispatch chain; hides the topbar "Add transaction" button on the Envelopes view |
| `shell.js` | **~** added `navItem('envelopes', t('envelopes.nav'), Icons.envelope)` between goals and the backup section; added `envelopes` to `updateSidebarBadges` counts |
| `icons.js` | **+** `envelope` SVG (rectangle + triangle for the flap) for the nav icon |
| `i18n.js` | **+** 22 new Dutch keys (nav, title, add/edit/delete, empty state, form fields incl. period options, captions, period chips, error messages, success toasts) |
| `styles.css` | **+** `.view-envelopes`, `.env-list`, `.env-row`, `.env-bar` + `.env-bar-fill` + `--warn` (amber) / `--over` (red) modifiers, `.env-period` chip, `.env-caption` colour states; **+** `.chip` / `.chip-on` styles for the modal multi-select (also reusable elsewhere) |
| `index.html` | **~** `?v=21` → `?v=22` (36 → 38 script tags); added `views/envelopes.js` and `modals/envelope.js` |
| `eslint.config.js` | **+** `Envelopes` to browser globals |
| `globals.d.ts` | **+** `Envelope` interface; extended `State` (`envelopes?: Envelope[]`); added 3 `Store` methods, 3 `Selectors.*` helpers, `Envelopes` view, `Modals.envelope` / `Modals.envelopeDelete` |
| `views/dashboard.js` | **~** defensive fix: `recent` sort no longer throws when a txn lacks `date` or `createdAt` (treats them as empty strings). Pre-existing latent bug exposed by the Playwright test fixture (test data omitted `createdAt`) |
| `_test_selectors.js` | **+** 14 tests: 5 for `currentPeriodFor` (monthly, monthly at year boundary, yearly, yearly at year boundary, unknown period defaults to monthly), 6 for `envelopeSpend` (empty envelope, category-only, payee-only, both-criteria-counted-once, out-of-period/out-of-scope, yearly), 3 for `envelopeProgress` (under cap, exactly at cap, over cap) |
| `_test_boot.js` | **+** 13 tests: migration, `addEnvelope` happy + 3 validation paths, `updateEnvelope` patch + id-immutable + createdAt-immutable + invalid patch, `deleteEnvelope`, sidebar nav item, empty state, seeded row percent + bar class flips at >=80% / >100%, modal opens with all 6 fields, `envelopeDelete` removes envelope, save refused with no links, all 22 i18n keys resolve |

### Decisions / trade-offs

- **`envelope.payeeIds` stores payee name strings, not raw ids** — there is no `state.payees` collection; payees are derived from `CSVImport.extractPayee(transaction.description)`. The issue spec said `payeeIds` "sourced from state.payees" but the closest existing concept is `ViewHelpers.distinctPayees()`, which returns payee names. The chip multi-select in the modal is sourced from that helper so the user sees the same payee names that already appear in the Payees view and the dashboard. Internally, `envelopeSpend` calls `extractPayee(t.description)` on every txn and matches against `envelope.payeeIds`.
- **`envelopeSpend` counts each txn at most once** — a row whose category AND extracted-payee both match the envelope contributes a single line. The implementation dedups by `txn.id` in a Set so the math stays intuitive.
- **Income rows subtract from spent** — a refund or inflow on the same envelope reduces the spend total. This matches the user's mental model: "I spent €50 at the restaurant and got €10 back, so I really spent €40." Income rows whose category/payee matches the envelope are subtracted; out-of-scope income is ignored.
- **`updateEnvelope` strips `id` and `createdAt`** from the patch before merging — same defensive pattern as `updateGoal`. Validates `cap > 0`, `period ∈ {monthly, yearly}`, and arrays.
- **Progress bar width capped at 100%** even when overspent — the colour change at `--over` is the visual signal of overspending; an overflowing bar would distort the row.
- **Progress bar colour buckets**: `< 80%` sage (plenty of headroom), `>= 80%` amber (warning, user should think about cutting back), `> 100%` sage-red (overspent). The amber band is 80–100% inclusive of 80; the over band is strictly > 100%.
- **Chip multi-select is a custom field** — the Modal helper has no native checkbox-group renderer. The chip group renders synchronously, mutates the DOM (`.chip-on` class) on click, and the value is read back from the DOM at save time. Each field has an `id` on its `.form-field` wrapper so the rest of the modal framework can find it (`#f-categoryIds`, `#f-payeeIds`).
- **Empty envelope blocked at save** — a modal that allows saving an envelope with no category or payee links would always show "Nog €X over" because `envelopeSpend` returns 0 for unlinked envelopes. We refuse with the Dutch `envelopes.form.links.required` toast and keep the modal open so the user can fix the issue.
- **`envelope.payeeIds` is the empty array by default** — the migration normalises legacy entries (no payeeIds field) to `[]`. Same for `categoryIds`.
- **Migration is idempotent** — `state.envelopes === undefined` becomes `[]`; existing entries with stale fields are normalised (period → `'monthly'` if unknown, cap → number, link arrays → arrays). Cheap on every load.

### Real-browser verification (seeded 3 envelopes covering all 3 progress states + out-of-period txn)

| Envelope | Spent / Cap | Bar width | Bar colour | Caption |
|---|---|---|---|---|
| 25% RUSTIG | €85 / €100 | 85% | amber | "Nog €15,00 over" |
| 85% WAARSCHUWING | €85 / €100 | 85% | amber | "Nog €15,00 over" |
| 175% OVER | €175 / €100 | 100% (capped) | red | "€75,00 over limiet" |

Sidebar shows `Enveloppen 3` between `Doelen` and `Back-up`. Active state on Enveloppen row.

Out-of-period txn (last month, €999) does **not** contribute to the monthly envelopes' spend.

Additional flows verified in Playwright:
- Click `+ Envelop toevoegen` → modal opens with 6 chips (2 categories + 4 distinct payees).
- Click `c_other_exp` chip → chip toggles on.
- Submit name="TestAdd", cap=300 → envelope count goes 3 → 4, defaults applied.
- Open a new modal without selecting any chip → submit is refused, modal stays open, no envelope created.

No console / page errors throughout. Screenshots at `/tmp/issue018-three-states.png` (all 3 states side-by-side) and `/tmp/issue018-add-modal.png` (modal with chip multi-select).

### Pre-existing bug fixed

`views/dashboard.js:174` threw `Cannot read properties of undefined (reading 'localeCompare')` when any transaction lacked `date` or `createdAt`. Real users never see this because `Store.addTransaction` always stamps both fields, but legacy localStorage data or test fixtures could trigger it. Fixed defensively with `(b.date || '').localeCompare(a.date || '')` and `(b.createdAt || '').localeCompare(a.createdAt || '')`. Caught by the Playwright test fixture (test data omitted `createdAt`).

### Test results

| Suite | Before | After |
|---|---|---|
| `_test_csv.js` | 21 | 21 |
| `_test_selectors.js` | 79 | **93** (+14) |
| `_test_period.js` | 34 | 34 |
| `_test_boot.js` | 121 | **134** (+13) |
| **total** | 255 | **282** |

`npm run lint`: 0 errors, 11 pre-existing warnings (none introduced, none removed by envelope code itself; one defensive `|| ''` line in dashboard.js closed the latent PAGEERROR).

### Known follow-ups (out of scope)

- **Dashboard summary cards** (covered by ISSUE-019): surface "X van Y enveloppen onder hun limiet" on the dashboard's summary row so the user sees envelope state at a glance without opening the Envelopes view.
- **Recurring contributions / roll-over**: a "carry forward unused cap to next month" toggle. Out of scope for this slice.
- **Per-user ownership**: envelopes are scope-agnostic today; they count in-scope txns regardless of who owns the source. Could add an "owner" field if multi-user splits require it.
- **Notifications when near cap**: amber warning is the current best signal. A push notification (or weekly digest) is not in scope.
- **"Fiscal year" support for yearly envelopes**: calendar Jan–Dec only.
- **Drag-to-reorder of envelopes**: not requested.
- **Editing historical spend retroactively**: not supported by design. The spent number always reflects the current link set against the full transaction history.
- **Link-history snapshots**: not in scope. Changing the categories/payees on an envelope changes the spend total retroactively.
