# ISSUE-019 — Dashboard savings summary cards

## Parent

[PRD] Savings — Goals & Envelopes — `docs/PRD/PRD-005-savings-goals-and-envelopes.md`

## Why

Once Goals (ISSUE-017) and Envelopes (ISSUE-018) have their own pages, the user still has to navigate away from the dashboard to see them. The dashboard is the natural "what's important today" surface — it should show the most urgent goals and envelopes at a glance, matching the existing pattern of summary cards and the top-categories card. This issue wires the two new collections into the dashboard with two summary cards.

## What to build

1. **Two new cards at the top of `views/dashboard.js`**.

   In `Dashboard.render()`, **before** the existing `.summary-grid`:

   ```js
   wrap.appendChild(renderGoalsSummaryCard());
   wrap.appendChild(renderEnvelopesSummaryCard());
   ```

   Both cards live in a small `.savings-strip` flex row so they sit side-by-side at desktop widths and stack at mobile.

2. **`renderGoalsSummaryCard()`**.

   - Heading: `Doelen` + a "view all" link to `goals` page (only shown when `state.goals.length > 3`).
   - Sorted: top 3 by `percent` descending (`Selectors.goalProgress(goal).percent`). When fewer than 3 goals exist, show all of them.
   - Each row: goal name, `€funded / €target` label, progress bar coloured per the goal's status (green < 100%, deep-green == 100%, sage-red > 100%).
   - Empty state: `t('dashboard.goals.empty')` with a small "+" link to the goals page (which opens the Add modal if available — otherwise navigates and the user clicks Add there).

3. **`renderEnvelopesSummaryCard()`**.

   - Heading: `Enveloppen` + a "view all" link to `envelopes` page (only shown when `state.envelopes.length > 3`).
   - Sorted: top 3 by `percent` descending (`Selectors.envelopeProgress(envelope, state).percent`). When fewer than 3 envelopes exist, show all of them.
   - Each row: envelope name, period label (`Deze maand` / `Dit jaar`), spent / cap, progress bar coloured per utilization (green < 80%, amber >= 80%, red > 100%). Overspent envelopes show `€X over limiet` instead of "remaining".
   - Empty state: `t('dashboard.envelopes.empty')` with a "+" link.

4. **Independence from the period selector**.

   These cards **do not** read `Router.periodRange()`. They always reflect "current state":
   - Goals: `% funded / target` (no period concept).
   - Envelopes: `spent / cap` for the current calendar month (if `period = 'monthly'`) or current calendar year (if `period = 'yearly'`), via `Selectors.currentPeriodFor(envelope)` and `Selectors.envelopeSpend(envelope, state)` from ISSUE-018.

   The selector already lives above the cards; document this in the PRD and in a code comment so a future contributor doesn't "fix" it by gating on the period.

5. **i18n keys**:

   ```
   'dashboard.goals.title':       'Doelen',
   'dashboard.goals.empty':       'Nog geen doelen — voeg er één toe.',
   'dashboard.goals.viewAll':     'Alle doelen',
   'dashboard.envelopes.title':   'Enveloppen',
   'dashboard.envelopes.empty':   'Nog geen enveloppen — stel een limiet in.',
   'dashboard.envelopes.viewAll': 'Alle enveloppen',
   'dashboard.envelopes.overspent': '€{over} over limiet',
   'dashboard.addNew':            'Toevoegen',
   ```

6. **CSS** (small additions in `styles.css`).

   - `.savings-strip` flex row, gap, wraps on small screens.
   - `.savings-card` matches existing `.card` aesthetic but is narrower (50% desktop, 100% mobile).
   - Reuse the existing `.progress-bar` / `.progress-fill` styling if it exists; otherwise add a small variant for these cards.

## Acceptance criteria

- [x] Two new cards appear at the top of the dashboard, above the existing summary grid.
- [x] Goals card: shows up to 3 goals, sorted by `% funded` desc; shows "view all" when more than 3 exist; shows empty state when 0 exist.
- [x] Envelopes card: shows up to 3 envelopes, sorted by `% spent` desc; shows "view all" when more than 3 exist; shows empty state when 0 exist.
- [x] Period selector on the dashboard **does not** change the values in these cards. Switching presets leaves them stable.
- [x] Envelopes overspent show the red progress bar + `€X over limiet` label.
- [x] Cards stack vertically at mobile width, sit side-by-side at desktop.
- [x] All 8 new i18n keys resolve.
- [x] At least 3 new test assertions in `_test_boot.js` (shipped 7).
- [x] `npm test` and `npm run lint` clean.

## Implementation log

### Files changed

| File | Δ |
|---|---|
| `i18n.js` | **+** 8 new Dutch keys (`dashboard.goals.title`, `dashboard.goals.empty`, `dashboard.goals.viewAll`, `dashboard.envelopes.title`, `dashboard.envelopes.empty`, `dashboard.envelopes.viewAll`, `dashboard.envelopes.overspent`, `dashboard.addNew`) |
| `styles.css` | **+** `.savings-strip` flex row, `.savings-card` container, `.savings-row` grid, `.savings-row-bar` + `.savings-row-bar-fill` + `--warn` / `--full` / `--over` modifiers, `.savings-row-foot` + `--over` colour state, `.savings-card-empty`, `.savings-card-cta`, `.savings-card-link`; mobile `@media (max-width: 720px)` stacks the strip vertically |
| `views/dashboard.js` | **+** `renderGoalsSummaryCard()` + `renderEnvelopesSummaryCard()` + their `barClass` / `foot` helpers; mounted in `render()` inside a `.savings-strip` div **above** `.summary-grid`. Both helpers are period-independent on purpose; a comment near `render()` warns future contributors not to gate them on `Router.periodRange()` |
| `_test_boot.js` | **+** 7 tests: i18n keys resolve; strip mounts above summary-grid with two cards; goals card shows top-3 sorted by % desc (and the 4th is hidden); envelopes card shows top-3 sorted by % desc + bar-class flips (`--over` / `--warn`); period-selector change does NOT mutate the cards (snapshot before/after across all 7 presets incl. custom); both empty states render copy + CTA |

### Decisions / trade-offs

- **Spec deviation: dropped `€` from `dashboard.envelopes.overspent` template.** The spec wrote `'€{over} over limiet'`, but `Fmt.money()` already prefixes the value with `€`. With the spec wording the dashboard would render `€€125,00 over limiet`. The actual shipped key is `'{over} over limiet'` (no euro), matching the existing `envelopes.card.overspent` pattern. Captured here so the spec author can confirm.
- **`Selectors.currentPeriodFor(envelope)` is called inside `renderEnvelopesSummaryCard()`**, not at boot. This is the right call: the dashboard can be open all day, and the helper itself rolls forward on every call (`new Date()` defaults). A boot-time snapshot would lag.
- **Top 3 is `slice(0, 3)`** — same cap as the existing `topCategories` / `topGroups` helpers in the dashboard. Keeps the card heights predictable.
- **Sort tie-breaker is `createdAt` desc** — newer goals/envelopes surface first when two entries have the same `%`. This matches the "sorted by urgency" instruction in the spec while making the order deterministic.
- **View-all link uses `(N)` count** (`Alle doelen (4) →`) — gives the user a count of what's hidden without forcing them to navigate. At 3 items exactly the link does not appear; only when more than 3 exist.
- **Cards have no inline actions** (no edit / delete / fund buttons). The spec is explicit: "read-only summaries; full CRUD lives on the dedicated pages." A future contributor who wants to add an inline Fund button can, but the slice deliberately stops at summary.
- **Empty state has both copy AND a CTA link** — the link navigates to the goals / envelopes page (not to the Add modal directly). This is the safest choice because the user might want to look at the dedicated page first; clicking the "+ Doel toevoegen" button there is one tap. (A future enhancement could route the CTA directly to `Modals.goal()` / `Modals.envelope()` after the page nav.)
- **Bar width capped at 100%** even when overspent — same decision as the dedicated views. The colour change is the signal of overspending.

### Pre-existing bug exposed & fixed (real-browser run only)

While seeding 4 goals, the first boot hit a `Cannot read properties of undefined (reading 'localeCompare')` error at `views/dashboard.js:174`. Root cause: the `recent` sort assumed every txn has `date` and `createdAt`, but legacy data and test fixtures can omit them. Fixed defensively in ISSUE-018 (`(b.date || '').localeCompare(a.date || '')`). This slice inherits that fix.

### Real-browser verification (Playwright)

Seeded with 4 goals (25% / 100% / 140% / 50%) and 4 envelopes (50% / 50% / 350% / 10%) at desktop (1280px) and mobile (420px).

**Desktop** (screenshot at `/tmp/issue019-dashboard.png`):

- Goals card (top-left of strip): top 3 = Nieuwe laptop (140%, red bar, "€600,00 boven doel"), Reis Italië (100%, deep-green, "Doel bereikt 🎉"), Cadeau oma (50%, sage, "Nog €100,00 te gaan"). `Zonnepanelen` (25%) hidden below the cut. `Alle doelen (4) →` link in top-right.
- Envelopes card (top-right of strip): top 3 = OVER 200% (350%, red, "€125,00 over limiet"), 25% RUSTIG (50%, sage, "Deze maand — Nog €50,00 over"), WAARSCHUWING 85% (50%, sage, "Deze maand — Nog €50,00 over"). `HIDDEN` (10%) hidden below the cut. `Alle enveloppen (4) →` link in top-right.
- Strip sits above the existing summary-grid (Inkomsten / Uitgaven / Saldo / Gedeeld-Privé), above the donut, above recent transactions, above the top-categories card.
- **Period selector change (1m → 1y → custom)** leaves both cards' names + values + bar widths identical. Snapshot equality verified.

**Mobile** (screenshot at `/tmp/issue019-mobile.png`):

- Cards stack vertically (`getBoundingClientRect().top` of card 2 > `bottom` of card 1).
- Each card takes full width.
- Layout order preserved (Doelen above Enveloppen).

**Empty state**: verified via stub test (Playwright couldn't easily test this with `addInitScript` re-seeding on every navigation).

**View-all navigation**: clicking `Alle doelen (4) →` on the goals card routes to `Router.view === 'goals'` ✓.

**No console / page errors** throughout.

### Test results

| Suite | Before | After |
|---|---|---|
| `_test_csv.js` | 21 | 21 |
| `_test_selectors.js` | 93 | 93 |
| `_test_period.js` | 34 | 34 |
| `_test_boot.js` | 134 | **141** (+7) |
| **total** | 282 | **289** |

`npm run lint`: 0 errors, 11 pre-existing warnings (none introduced).

### Known follow-ups (out of scope)

- **Quick-action buttons** in the cards (e.g., `+€100` next to a goal, `+€25` next to an envelope). Out of scope for this slice.
- **History sparkline** for each row (last 6 months of % funded / % spent). Useful but the spec is explicit on read-only summary.
- **Per-card period picker** ("show envelopes for Q3 2025 instead"). Out of scope.
- **Combine goals + envelopes into one card with tabs**. Out of scope.
- **Drag-to-reorder**. Out of scope (the spec says "matches page order — sorted by urgency instead", which the current sort satisfies).

## Blocked by

- ISSUE-017 (Goals data + view + helpers must exist).
- ISSUE-018 (Envelopes data + view + helpers must exist).

## Out of scope

- Interactive actions on the cards (e.g., quick "add funds" inline) — these are read-only summaries; full CRUD lives on the dedicated pages.
- Per-card period picker ("show envelopes for Q3 2025 instead").
- Showing historical periods (e.g., "last month's envelope status").
- Editing envelope or goal links from the dashboard cards.
- Combining goals + envelopes into one card with tabs.
- Reordering goals or envelopes on the dashboard (matches page order — sorted by urgency instead).