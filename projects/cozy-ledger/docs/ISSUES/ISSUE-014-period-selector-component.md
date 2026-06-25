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

- [x] `views/_period-selector.js` exists and exposes `PeriodSelector.render(viewKey)` on `window`.
- [x] Loading order in `index.html` puts the new script after `views/dashboard.js` and after `views/trends.js` (it depends on `Router` only).
- [x] Clicking each preset button calls `Router.setPeriodPreset(...)` and the active class moves to the clicked pill (no active class when `preset === 'custom'`).
- [x] Editing the `from` or `to` input switches `preset` to `'custom'`, clears any active pill, and persists.
- [x] The "Standaard" link returns to the view's default preset (`1m` for dashboard, `1y` for trends) and clears the inputs back to the preset's derived range.
- [x] All ten new i18n keys exist in `i18n.js` and resolve to the Dutch strings above.
- [x] Styles match the existing aesthetic (no broken layout when placed in a card-head).
- [x] Manual smoke test (open in browser): the selector renders standalone, all interactions behave correctly.

## Implementation log

Captured during implementation.

### What was built

A new self-contained UI component (`views/_period-selector.js`) that exposes `PeriodSelector.render(viewKey)`. It reads `Router.period` to derive initial state and writes back through `Router.setPeriodPreset`, `Router.setPeriodRange`, and `Router.resetPeriod`. Mounting into the dashboard and Trends view is left for ISSUE-015 and ISSUE-016.

### File layout

| File | Δ |
|---|---|
| `views/_period-selector.js` | **new** — the component (IIFE exposing `{ render, PRESETS }`) |
| `i18n.js` | **+** 10 keys: `period.label`, `period.preset.{1m,3m,6m,1y,2y,all}`, `period.from`, `period.to`, `period.reset` |
| `styles.css` | **+** `.period-selector`, `.period-label`, `.period-pills`, `.period-pill`, `.period-pill.active`, `.period-dates`, `.period-date-input`, `.period-reset` |
| `index.html` | **~** new script tag after `views/trends.js`; `?v=17` → `?v=18` |
| `_test_boot.js` | **+** 11 new tests in an ISSUE-014 section; added `views/_period-selector.js` to scripts array; extended `matchesPartHelper` to support compound selectors (e.g. `.period-pill.active`) |
| `globals.d.ts` | **+** `Window.PeriodSelector` augmentation |
| `eslint.config.js` | **+** `PeriodSelector` in globals |

### Component shape

```
PeriodSelector.render(viewKey) → HTMLElement
  .period-selector[data-view="dashboard"]
    .period-label               ← "Periode"
    .period-pills               ← pill group
      button.period-pill[data-preset="1m|3m|6m|1y|2y|all"]
      .active                   ← only when preset !== 'custom'
    .period-dates
      label[for="period-from"]  ← "Van"
      input#period-from[type="date"]
      label[for="period-to"]    ← "Tot"
      input#period-to[type="date"]
    .period-reset               ← "Standaard" link
```

### Behaviour notes

- **Preset pills** — the click handler delegates to `Router.setPeriodPreset(preset)`, which re-renders the view. The parent view (mounted in ISSUE-015/016) is responsible for re-mounting the selector so the active class reflects the new state. Until then, callers must re-mount after every state change.
- **Date inputs** — same debounce pattern as `views/trends.js`'s balance input: 350 ms on `input`, immediate on `change` / `blur` / Enter. The `change` handler is what actually calls `Router.setPeriodRange({ from, to })`; `input` only schedules a deferred commit.
- **Custom = no active pill** — when `preset === 'custom'`, all six pills render with no `.active` class. This is the "off-pill" state the spec calls out.
- **Reset** — calls `Router.resetPeriod(viewKey)` so the "Standaard" link respects the view's default (`1m` for dashboard, `1y` for trends). Without a `viewKey`, it defaults to `'dashboard'`.
- **No auto-mount** — the component does not insert itself into the DOM. ISSUE-015 wires dashboard, ISSUE-016 wires trends. A test (`selector does not mount automatically`) guards against accidental early mounting in future refactors.

### CSS aesthetic

- Reuses the existing cream + paper-edge palette + sage active state (same as `.range-btn` / `.range-buttons` already used by Trends).
- `.period-pill` mirrors `.range-btn` exactly so the two selector styles match.
- `.period-selector` is `display: flex` with `flex-wrap: wrap`; it lays out inline on wide screens and stacks the date inputs + reset link on narrower screens.
- `.period-reset` uses `margin-left: auto` so it floats to the right edge when there's room; otherwise it wraps naturally to a new line.

### Test results

| Suite | Before | After |
|---|---|---|
| `_test_csv.js` | 21 | 21 |
| `_test_selectors.js` | 73 | 73 |
| `_test_period.js` | 34 | 34 |
| `_test_boot.js` | 76 | **87** (+11) |
| **total** | 204 | **215** |

Lint: 0 errors, 11 pre-existing warnings (none introduced).

### Stub harness enhancement

The component uses compound selectors like `.period-pill.active`. The existing `_test_boot.js` `matchesPartHelper` only supported a single token per space-separated part. Extended to split a part on `[.#[` boundaries and require each sub-token to match the same node — so `.period-pill.active`, `.scope-pill.active`, and any future compound selectors work in tests too.

### Real-browser verification

```
Initial:           active=1m, from=2026-06-01, to=2026-06-25
After click 6m:    active=6m, period={preset:6m, from:2026-01-01, to:2026-06-25}
After click 1y:    active=1y, from=2025-07-01, to=2026-06-25
After reset:       active=1m, from=2026-06-01, to=2026-06-25
After date edit:   active=NONE, from=2025-08-01, to=2025-12-15, preset=custom
i18n:              label=Periode, 1m=1 maand, all=Alles, from=Van, to=Tot, reset=Standaard
Errors:            none
```

Visual screenshot at `/tmp/issue014-selector.png` shows the selector inline next to the dashboard header with the correct cream + sage aesthetic.

### Decisions / trade-offs

- **No re-render hook on `store:changed`** — the component is mounted by its parent view, which already re-renders on state changes. Adding a self-update path would duplicate that work and risk drift between the parent's view of the world and the selector's.
- **`from` and `to` inputs are validated only by `Router.setPeriodRange`** — if the user types a from-date after the to-date, the call is silently ignored (per ISSUE-013 spec). The selector doesn't show its own error state; the parent view can if needed.
- **Date inputs use the native browser picker** — keeps the component simple and locale-correct for free. No custom calendar UI was requested.
- **Reset link is a `<button>`, not an `<a>`** — to match the rest of the app (sidebar nav is also `<button>`) and to avoid an href that's a no-op.

### Known follow-ups (out of scope)

- ISSUE-015 will mount this in `views/dashboard.js`.
- ISSUE-016 will mount this in `views/trends.js` and replace the existing `.range-buttons` element.
- The `PeriodSelector` could later publish a "self-update on `store:changed`" hook if we want to keep it mounted across state changes without re-mounting.

## Blocked by

- ISSUE-013 (state and helpers must exist before the component can read/write them).

## Out of scope

- Mounting the selector on the dashboard or Trends view (ISSUE-015, ISSUE-016).
- Changing any other view.
- Removing `Router.trendRange` or `trends.range.*` i18n keys.
- Animation/transition on pill switch.
- Keyboard navigation between pills (Tab + arrow keys) — nice-to-have, not required.