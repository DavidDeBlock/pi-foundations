# ISSUE-014 — Period selector component

## Parent

[PRD] Unified period selector for Dashboard & Trends — `docs/PRD/PRD-004-unified-period-selector.md`

## Why

ISSUE-013 put the period state and pure helpers in place. Now we need a UI component that lets the user pick a preset or type a from-to range, and which becomes the single visual control on both the dashboard and the Trends view.

## What to build

1. **New file `views/_period-selector.js`**.

   Mirror the convention of `views/_helpers.js`: a small module exporting a single render function that returns a DOM element.

   ```js
   const PeriodSelector = (() => {
     function render(viewKey) { /* ... */ }
     return { render };
   })();
   window.PeriodSelector = PeriodSelector;
   ```

   `viewKey` is either `'dashboard'` or `'trends'` — used to look up the default preset for the "reset" link.

2. **Visual structure** (semantic, not pixel-perfect — adapt to the existing aesthetic).

   ```
   ┌─ Periode ────────────────────────────────────────────────────┐
   │  [1m] [3m] [6m] [1y] [2y] [Alles]   Van [📅] Tot [📅]   Standaard │
   └─────────────────────────────────────────────────────────────┘
   ```

   - A small label (`t('period.label')`) on the left.
   - Six preset buttons as a pill group. The active preset has an `.active` class. `custom` shows **no** pill as active (custom is the "off-pill" state).
   - Two native `<input type="date">` for `from` and `to`. Labels via `t('period.from')` / `t('period.to')`.
   - A small text link on the right that calls `Router.resetPeriod(viewKey)`, labelled `t('period.reset')`.

3. **Behaviour**.

   - Clicking a preset button calls `Router.setPeriodPreset(presetId)`.
   - Editing the `from` or `to` input calls `Router.setPeriodRange({ from, to })` on `change` and `blur` (avoid spamming on every keystroke). Use the same debounce pattern from `views/trends.js`'s `commitBalance` (350 ms) for `input`, commit immediately on `change` / `blur` / Enter.
   - The "Standaard" link calls `Router.resetPeriod(viewKey)`.
   - On render, the active pill and the date inputs reflect the current `Router.period`.

4. **i18n keys** (add to `i18n.js` in the Dutch table).

   ```
   'period.label':       'Periode',
   'period.preset.1m':   '1 maand',
   'period.preset.3m':   '3 maanden',
   'period.preset.6m':   '6 maanden',
   'period.preset.1y':   '1 jaar',
   'period.preset.2y':   '2 jaar',
   'period.preset.all':  'Alles',
   'period.from':        'Van',
   'period.to':          'Tot',
   'period.reset':       'Standaard',
   ```

5. **CSS**.

   Add a small block at the bottom of `styles.css` for `.period-selector`, `.period-pills`, `.period-pill`, `.period-pill.active`, `.period-date-input`, `.period-reset`. Keep the warm/cream aesthetic — soft borders, rounded corners, sage active state — matching the existing `.range-btn` styling already used on Trends. Reuse `.range-btn` styles where it makes sense; do not duplicate them.

6. **No view integration yet**. The component exists and works in isolation (it can be mounted anywhere with `el.appendChild(PeriodSelector.render('dashboard'))`); wiring the dashboard and Trends view to mount it happens in ISSUE-015 and ISSUE-016.

## Acceptance criteria

- [ ] `views/_period-selector.js` exists and exposes `PeriodSelector.render(viewKey)` on `window`.
- [ ] Loading order in `index.html` puts the new script after `views/dashboard.js` and after `views/trends.js` (it depends on `Router` only).
- [ ] Clicking each preset button calls `Router.setPeriodPreset(...)` and the active class moves to the clicked pill (no active class when `preset === 'custom'`).
- [ ] Editing the `from` or `to` input switches `preset` to `'custom'`, clears any active pill, and persists.
- [ ] The "Standaard" link returns to the view's default preset (`1m` for dashboard, `1y` for trends) and clears the inputs back to the preset's derived range.
- [ ] All ten new i18n keys exist in `i18n.js` and resolve to the Dutch strings above.
- [ ] Styles match the existing aesthetic (no broken layout when placed in a card-head).
- [ ] Manual smoke test (open in browser): the selector renders standalone, all interactions behave correctly.

## Blocked by

- ISSUE-013 (state and helpers must exist before the component can read/write them).

## Out of scope

- Mounting the selector on the dashboard or Trends view (ISSUE-015, ISSUE-016).
- Changing any other view.
- Removing `Router.trendRange` or `trends.range.*` i18n keys.
- Animation/transition on pill switch.
- Keyboard navigation between pills (Tab + arrow keys) — nice-to-have, not required.