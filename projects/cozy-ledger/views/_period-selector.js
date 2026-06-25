// =====================================================================
// views/_period-selector.js — Shared period selector (ISSUE-014)
// =====================================================================
// Self-contained UI component for picking a time period. Mounts on the
// dashboard and the Trends view (ISSUE-015 and ISSUE-016 wire those
// mounts; this file just exposes `PeriodSelector.render(viewKey)`).
//
// The component reads `Router.period` once at render time and writes
// back through `Router.setPeriodPreset`, `Router.setPeriodRange`, and
// `Router.resetPeriod`. State changes that should reflect on the
// selector (preset pill active class, date input values) require the
// parent view to re-render — same pattern as the rest of the app.
//
// Visual structure:
//
//   ┌─ Periode ──────────────────────────────────────────────────┐
//   │  [1m][3m][6m][1y][2y][Alles]  Van [📅] Tot [📅]  Standaard │
//   └────────────────────────────────────────────────────────────┘
//
// Pillar files in the implementation:
//   * presets: the order in the pill group is the order in the array
//   * `custom` preset → no pill is `.active` (this is the
//     "off-pill" state, intentional per spec)
//   * date inputs use the same debounce pattern as Trends' balance
//     input (350 ms on `input`, immediate on `change`/`blur`/Enter)
// =====================================================================

const PeriodSelector = (() => {
  // The six presets shown as pills. `custom` is never a pill \u2014 it's
  // the implicit state when the user has typed a manual range.
  const PRESETS = ['1m', '3m', '6m', '1y', '2y', 'all'];

  // One debounce timer per input. Shared between `input` and the
  // commit handlers so blur/change can cancel a pending debounce.
  let _debounceTimer = null;

  function clearDebounce() {
    if (_debounceTimer != null) {
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
    }
  }

  // Pull `from` / `to` out of the two date inputs and forward to
  // Router. Router.setPeriodRange is a no-op for invalid input (wrong
  // shape, `from > to`, future `to`), so we don't need to re-validate
  // here.
  function commitRange(fromInput, toInput) {
    const from = fromInput.value;
    const to = toInput.value;
    if (!from || !to) return;
    Router.setPeriodRange({ from, to });
  }

  function onDateInput(fromInput, toInput) {
    clearDebounce();
    _debounceTimer = setTimeout(() => {
      _debounceTimer = null;
      commitRange(fromInput, toInput);
    }, 350);
  }

  function onDateChange(e, fromInput, toInput) {
    clearDebounce();
    commitRange(fromInput, toInput);
  }

  function onDateKeydown(e, fromInput, toInput) {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearDebounce();
      commitRange(fromInput, toInput);
    }
  }

  // Build one pill. `active` is a boolean \u2014 when preset === 'custom'
  // we pass `false` to every pill so no pill shows the active style.
  function pill(preset, active) {
    return el('button', {
      type: 'button',
      class: 'period-pill' + (active ? ' active' : ''),
      'data-preset': preset,
      onclick: () => Router.setPeriodPreset(preset),
    }, t('period.preset.' + preset));
  }

  function render(viewKey) {
    const period = Router.period || { preset: '1m', from: '', to: '' };
    const isCustom = period.preset === 'custom';

    const pills = el('div', { class: 'period-pills', role: 'group' },
      ...PRESETS.map(p => pill(p, !isCustom && period.preset === p)),
    );

    const fromInput = el('input', {
      type: 'date',
      class: 'period-date-input',
      id: 'period-from',
      value: period.from || '',
      'aria-label': t('period.from'),
    });
    const toInput = el('input', {
      type: 'date',
      class: 'period-date-input',
      id: 'period-to',
      value: period.to || '',
      'aria-label': t('period.to'),
    });

    // `input` fires on every keystroke \u2014 debounced.
    fromInput.addEventListener('input', () => onDateInput(fromInput, toInput));
    toInput.addEventListener('input',   () => onDateInput(fromInput, toInput));
    // `change` fires on commit (date picker close, blur after edit).
    fromInput.addEventListener('change', (e) => onDateChange(e, fromInput, toInput));
    toInput.addEventListener('change',  (e) => onDateChange(e, fromInput, toInput));
    fromInput.addEventListener('blur',  () => { clearDebounce(); commitRange(fromInput, toInput); });
    toInput.addEventListener('blur',    () => { clearDebounce(); commitRange(fromInput, toInput); });
    fromInput.addEventListener('keydown', (e) => onDateKeydown(e, fromInput, toInput));
    toInput.addEventListener('keydown',   (e) => onDateKeydown(e, fromInput, toInput));

    const dateGroup = el('div', { class: 'period-dates' },
      el('label', { for: 'period-from' }, t('period.from')),
      fromInput,
      el('label', { for: 'period-to' }, t('period.to')),
      toInput,
    );

    const resetLink = el('button', {
      type: 'button',
      class: 'period-reset',
      onclick: () => Router.resetPeriod(viewKey || 'dashboard'),
    }, t('period.reset'));

    return el('div', { class: 'period-selector', 'data-view': viewKey || 'dashboard' },
      el('span', { class: 'period-label' }, t('period.label')),
      pills,
      dateGroup,
      resetLink,
    );
  }

  return { render, PRESETS };
})();
window.PeriodSelector = PeriodSelector;