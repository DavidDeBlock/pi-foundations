# ISSUE-020 — Envelope multi-period comparison

## Parent

[PRD] Savings — Goals & Envelopes — `docs/PRD/PRD-005-savings-goals-and-envelopes.md`

## Why

The envelope detail row currently shows current-period progress (spent / cap / remaining) but nothing about the past. The user is actively inspecting their financials and needs to compare the current period against previous months/years to spot trends and understand whether they're spending more or less than usual. In the future this can simplify to "previous period only", but for now they want richer history.

## What to build

1. **Pure helper in `selectors.js`**: `Selectors.envelopeComparison(envelope, state, today = new Date())`.

   Returns:
   ```js
   {
     current: { periodLabel, from, to, spent },
     history: [
       { periodLabel, from, to, spent, delta, deltaPct, direction: 'up' | 'down' | 'same' }
     ]
   }
   ```

   - For `period = 'monthly'`: returns current + previous 6 months (7 entries total).
   - For `period = 'yearly'`: returns current + previous 3 years (4 entries total).
   - Each entry computes `delta = currentSpent - pastSpent`, `deltaPct = pastSpent > 0 ? (delta / pastSpent * 100) : (currentSpent > 0 ? 100 : 0)`.
   - `direction`: `'up'` if `delta > 0.005`, `'down'` if `delta < -0.005`, `'same'` otherwise (epsilon to avoid floating-point noise).
   - Periods with no in-scope transactions: `spent = 0`, `delta = currentSpent`, `deltaPct = currentSpent > 0 ? 100 : 0`, `direction` derived from delta.
   - Past periods where the envelope didn't exist yet (`envelope.createdAt > period.to`): **still compute the spend** (the envelope's links define a bucket that already had spending history) and set a flag `notYetExisted = true` so the UI can append a small `(schatting)` badge in the label. Numbers stay visible so the row is comparable from day one — this is the design change made after the first implementation, when the user reported that the panel was useless for new users who haven't been tagging transactions long enough.
   - In-scope only — uses `Selectors.transactionsInScope(state)`.

2. **Period label generator** (Dutch):

   - Monthly: `juni 2026`, `mei 2026`, `2 maanden geleden (apr 2026)`. Use the existing month-name list from `i18n.js` (`monthNames`).
   - Yearly: `2026`, `2025`, `2 jaar geleden (2024)`.
   - `current.periodLabel` for monthly: `Deze maand ({month year})`. For yearly: `Dit jaar ({year})`.

3. **UI in `views/envelopes.js`**: for each envelope row, below the progress bar and the existing caption, render a small chevron + label `Vergelijking` (Dutch).

   - Default state: **collapsed** (chevron points right, panel hidden).
   - On click: expand (chevron rotates, panel slides down).
   - Use a class toggle (`envelope-row expanded`) — don't rebuild the row.
   - Persist expanded/collapsed per-envelope in a transient `Router.envelopeCompareExpanded` Set so re-renders keep the state.

   Panel content (when expanded):
   ```
   ▼ Vergelijking
     Deze maand (juni 2026)              €640
     Vorige maand (mei 2026)             €510    +€130   +25%   ↑
     2 maanden geleden (apr 2026)        €580    +€60    +10%   ↑
     3 maanden geleden (mrt 2026)        €720    −€80    −11%   ↓
     4 maanden geleden (feb 2026)        €495    +€145   +29%   ↑
     5 maanden geleden (jan 2026)        €530    +€110   +21%   ↑
     6 maanden geleden (dec 2025)        €610    +€30    +5%    ↑
   ```

   Columns: period label, amount, delta (€), delta (%), arrow. Past periods before the envelope was created (`notYetExisted = true`) still render the full row — the computed spend, delta, percentage and arrow are all shown — but the label carries a small `(schatting)` badge so the user knows the value was retroactively attributed via the envelope's category/payee links.

4. **CSS additions** in `styles.css`:

   - `.envelope-compare-toggle` — small chevron + label, clickable, no border, full-row hit area.
   - `.envelope-compare-panel` — table layout inside the row. 4 columns: label, amount, delta, arrow.
   - `.envelope-compare-panel .delta-up` — red text + red `↑`.
   - `.envelope-compare-panel .delta-down` — green text + green `↓`.
   - `.envelope-compare-panel .delta-same` — neutral text + `—`.
   - `.envelope-compare-panel .ec-estimate-badge` — small inline chip next to the period label for past rows before `createdAt`. Reads `(schatting)`, muted text on cream background, italic.
   - Smooth height transition on `.envelope-compare-panel` (CSS `max-height` + `transition`).
   - Keep within the existing cream/sage aesthetic.

5. **No dashboard summary changes**. The comparison lives only on `views/envelopes.js` for now.

6. **i18n keys** added to `i18n.js`:

   ```
   'envelopes.compare.title':       'Vergelijking'
   'envelopes.compare.current':     'Deze {period} ({monthYear})'
   'envelopes.compare.previous':    'Vorige {period} ({monthYear})'
   'envelopes.compare.nMonthsAgo':  '{n} maanden geleden ({monthYear})'
   'envelopes.compare.nYearsAgo':   '{n} jaar geleden ({year})'
   'envelopes.compare.month':       'maand'
   'envelopes.compare.year':        'jaar'
   'envelopes.compare.up':          'hoger'
   'envelopes.compare.down':        'lager'
   'envelopes.compare.equal':       'gelijk'
   'envelopes.compare.empty':       'Geen eerdere periodes'
   'envelopes.compare.estimated':   'schatting'
   'envelopes.compare.current.yearly':     'Dit jaar ({year})'
   'envelopes.compare.previous.yearly':    'Vorig jaar ({year})'
   'envelopes.compare.nYearsAgo.yearly':   '{n} jaar geleden ({year})'
   ```

7. **Tests**:

   - In `_test_selectors.js` (or new `_test_envelope_comparison.js`):
     - `envelopeComparison` for a monthly envelope created today: returns 7 entries (current + 6 previous).
     - Yearly envelope: 4 entries.
     - Past period with no transactions: `spent = 0`, `deltaPct = 100`, `direction = 'up'`.
     - Past period before envelope creation (`envelope.createdAt > period.to`): `spent` is still a number (retroactively attributed), `delta`/`deltaPct`/`direction` are present, and `notYetExisted = true` so the UI can badge the row.
     - Current vs previous: delta/deltaPct correct, direction correct for up/down/same (test all three).
     - In-scope vs out-of-scope transactions counted correctly.
     - Yearly envelope: each entry's `from`/`to` spans Jan 1 → Dec 31 of that year.
   - In `_test_boot.js`: clicking the chevron expands the panel; clicking again collapses; expanded state persists across re-renders.

## Acceptance criteria

- [ ] `Selectors.envelopeComparison` is exported with the documented return shape.
- [ ] Monthly envelopes show 7 rows (current + 6 previous); yearly envelopes show 4 rows (current + 3 previous).
- [ ] Each row shows € delta and % delta with a directional arrow (red ↑ / green ↓ / neutral —).
- [ ] Past periods before envelope creation render the retroactively-computed spend, delta and direction AND carry a small Dutch `(schatting)` badge in the period label.
- [ ] Comparison panel is **collapsed by default**; clicking the chevron expands it; clicking again collapses it.
- [ ] Expanded state persists across re-renders for the same envelope.
- [ ] No dashboard summary card shows the comparison.
- [ ] All new i18n keys resolve to Dutch strings.
- [ ] At least 8 new test assertions across the test files.
- [ ] `npm test` and `npm run lint` clean.

## Blocked by

None — but should land after ISSUE-018 (envelope data + helpers) so the comparison can reuse `Selectors.currentPeriodFor` and `Selectors.envelopeSpend`.

## Out of scope

- Showing the comparison on the dashboard summary cards.
- A sparkline / mini-chart of historical spend (numeric table only for v1).
- A user-configurable depth (always 6 monthly / 3 yearly).
- Comparing yearly envelopes against previous years' cumulative monthly data — the comparison is always against the same period shape.
- Per-row comparison ("this envelope vs other envelopes over time").
- Comparing a monthly envelope against the same calendar month in previous years (only against previous N calendar months).
- Exporting comparison data to CSV.