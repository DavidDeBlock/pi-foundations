// =====================================================================
// views/envelopes.js — Spending caps (ISSUE-018) + multi-period
// comparison panel (ISSUE-020)
// =====================================================================
// Reads: App._state, Selectors.envelopeProgress, Selectors.envelopeComparison,
//        Router.envelopeCompareExpanded, ViewHelpers.distinctPayees
// Calls: window.Modals.{envelope,envelopeDelete}
//
// A row per envelope: name, period label, "€X van €Y" label,
// progress bar (green < 80%, amber 80–100%, sage-red > 100%),
// remaining / overspent caption, and Edit / Delete actions.
//
// Below the caption sits a "Vergelijking" toggle (ISSUE-020). When
// expanded, a table of past periods slides down: the current period
// on top, then up to 6 previous months or 3 previous years. Each past
// row shows amount + Δ€ + Δ% + a directional arrow. The expanded/
// collapsed state is held on Router.envelopeCompareExpanded (a Set of
// envelope IDs) so re-renders preserve the user's open panels.
//
// Pure layout: this view only renders. Spend math lives in
// Selectors.envelopeProgress / Selectors.envelopeComparison.
// =====================================================================

const Envelopes = (() => {
  // -- Progress bar colour modifier --------------------------------
  // Three buckets: < 80% (sage, plenty of headroom), >= 80% (amber,
  // warning), > 100% (sage-red, overspent). The amber threshold lives
  // at 80% per the issue spec — past that the user should start
  // thinking about cutting back.
  function barClass(percent) {
    if (percent > 100) return 'env-bar-fill env-bar-fill--over';
    if (percent >= 80) return 'env-bar-fill env-bar-fill--warn';
    return 'env-bar-fill';
  }

  // -- Footer caption -----------------------------------------------
  // "Nog €X over" / "Doel bereikt" (not used in spec, but kept for
  // sanity when spent === cap exactly) / "€X over limiet".
  // We use the spec wording for the two non-zero cases; at exactly
  // 100% we show "Nog €0 over" so the user can see the boundary.
  function renderCaption(progress) {
    if (progress.overspent > 0) {
      return el('div', { class: 'env-caption env-caption--over' },
        t('envelopes.card.overspent', { over: Fmt.money(progress.overspent) }),
      );
    }
    return el('div', { class: 'env-caption' },
      t('envelopes.card.remaining', { remaining: Fmt.money(progress.remaining) }),
    );
  }

  // -- Period label -------------------------------------------------
  // "Deze maand" / "Dit jaar" — switched by envelope.period.
  function renderPeriodLabel(envelope) {
    const key = envelope.period === 'yearly' ? 'envelopes.card.period.yearly' : 'envelopes.card.period.monthly';
    return el('span', { class: 'env-period' }, t(key));
  }

  // -- Comparison panel cells (ISSUE-020) ---------------------------
  // Each past row gets a red/green arrow + the matching delta class.
  // `direction` is one of 'up' / 'down' / 'same'; 'up' means
  // "spent more than before" (red), 'down' means "spent less" (green).
  function directionArrow(direction) {
    if (direction === 'up') return '\u2191';   // ↑
    if (direction === 'down') return '\u2193'; // ↓
    return '\u2014';                            // —
  }
  function directionClass(direction) {
    if (direction === 'up') return 'delta-up';
    if (direction === 'down') return 'delta-down';
    return 'delta-same';
  }

  // -- Comparison panel (ISSUE-020) --------------------------------
  // Builds the 5-column history table for one envelope. The current
  // row goes on top with no delta/arrow cells; past rows below it
  // carry the Δ and arrow. Rows where the envelope didn't yet exist
  // render dashes in the data cells and a muted "(envelop bestond nog
  // niet)" suffix on the label.
  function renderComparisonPanel(envelope) {
    const data = Selectors.envelopeComparison(envelope, App._state);
    if (!data) return el('div', { class: 'envelope-compare-panel' });

    const rows = [];
    // Header row (kept tight: 5 columns to align with the body rows).
    rows.push(el('tr', { class: 'ec-head' },
      el('th', { class: 'col-label' }, ''),
      el('th', { class: 'col-amount' }, ''),
      el('th', { class: 'col-delta' }, ''),
      el('th', { class: 'col-pct' }, ''),
      el('th', { class: 'col-arrow' }, ''),
    ));

    // Current row: no delta/arrow — just label + amount.
    rows.push(el('tr', { class: 'ec-current' },
      el('td', { class: 'col-label' }, data.current.periodLabel),
      el('td', { class: 'col-amount' }, Fmt.money(data.current.spent)),
      el('td', { class: 'col-delta' }, ''),
      el('td', { class: 'col-pct' }, ''),
      el('td', { class: 'col-arrow' }, ''),
    ));

    for (const entry of data.history) {
      const cls = directionClass(entry.direction);
      // For past periods before the envelope was created we still
      // render the actual spend (retroactively attributed via the
      // envelope's category/payee links) but append a small
      // "schatting" badge so the user knows the value is an estimate.
      const labelCell = entry.notYetExisted
        ? el('td', { class: 'col-label' },
            entry.periodLabel + ' ',
            el('span', { class: 'ec-estimate-badge',
                         title: t('envelopes.compare.estimated') },
              '(' + t('envelopes.compare.estimated') + ')'))
        : el('td', { class: 'col-label' }, entry.periodLabel);
      rows.push(el('tr', { class: 'ec-past' + (entry.notYetExisted ? ' ec-estimate' : '') },
        labelCell,
        el('td', { class: 'col-amount' }, Fmt.money(entry.spent)),
        // Fmt.money uses an em-dash convention when signed: positive
        // gets a leading '+' so the column reads +€130 / −€80 / €0.
        el('td', { class: 'col-delta ' + cls },
          Fmt.money(entry.delta, { signed: true })),
        el('td', { class: 'col-pct ' + cls },
          // Round to integer for the percent column to keep the panel
          // visually compact. The selector already returns 2-decimal
          // values; we only re-format for display here.
          (entry.deltaPct > 0 ? '+' : (entry.deltaPct < 0 ? '\u2212' : '')) +
          Math.abs(Math.round(entry.deltaPct)) + '%'),
        el('td', { class: 'col-arrow ' + cls }, directionArrow(entry.direction)),
      ));
    }

    return el('div', { class: 'envelope-compare-panel' },
      el('table', { class: 'ec-table' },
        el('tbody', {}, ...rows),
      ),
    );
  }

  // -- Goal row -----------------------------------------------------
  function renderEnvelopeRow(envelope) {
    const progress = Selectors.envelopeProgress(envelope, App._state);
    // Cap the bar width at 100% so the colour change at > 100% is the
    // only signal of overspending; an overflowing bar would distort
    // the row.
    const fillEl = el('div', {
      class: barClass(progress.percent),
      style: { width: Math.min(100, progress.percent) + '%' },
    });
    const fillHost = el('div', { class: 'env-bar' }, fillEl);

    const labelText = t('envelopes.card.spent', {
      spent: Fmt.money(progress.spent),
      cap: Fmt.money(progress.cap),
    });

    // Pre-compute the expanded state so the row opens with the right
    // class on the very first render (e.g. after the user just clicked
    // the chevron). The toggle handler mutates the same Set in place.
    const expanded = Router.envelopeCompareExpanded.has(envelope.id);

    const comparePanel = renderComparisonPanel(envelope);

    // Chevron toggle. Clicking it flips the membership in the Router
    // Set and toggles the .expanded class on the row — no re-render,
    // so the panel slides via CSS without losing scroll position.
    const toggleChevron = el('span', { class: 'chevron' }, '\u25B6'); // ▶
    const toggle = el('button', {
      class: 'envelope-compare-toggle',
      type: 'button',
      // aria-expanded reflects the live state so screen readers pick
      // up the toggle without us having to wire a separate handler.
      'aria-expanded': expanded ? 'true' : 'false',
      onclick: (ev) => {
        const row = ev.currentTarget.closest('.env-row');
        const set = Router.envelopeCompareExpanded;
        if (set.has(envelope.id)) {
          set.delete(envelope.id);
          if (row) row.classList.remove('expanded');
          ev.currentTarget.setAttribute('aria-expanded', 'false');
        } else {
          set.add(envelope.id);
          if (row) row.classList.add('expanded');
          ev.currentTarget.setAttribute('aria-expanded', 'true');
        }
      },
    }, toggleChevron, el('span', { class: 'ec-label' }, t('envelopes.compare.title')));

    const row = el('div', {
      class: 'env-row' + (expanded ? ' expanded' : ''),
      'data-envelope-id': envelope.id,
    },
      el('div', { class: 'env-row-main' },
        el('div', { class: 'env-row-head' },
          el('div', { class: 'env-name' }, envelope.name),
          renderPeriodLabel(envelope),
        ),
        el('div', { class: 'env-row-sub' },
          el('div', { class: 'env-spent-label' }, labelText),
        ),
        fillHost,
        renderCaption(progress),
        toggle,
      ),
      el('div', { class: 'env-row-actions' },
        el('button', { class: 'btn-icon', title: t('envelopes.edit'), onclick: () => window.Modals.envelope(envelope.id), html: Icons.edit }),
        el('button', { class: 'btn-icon btn-danger', title: t('envelopes.delete'), onclick: () => window.Modals.envelopeDelete(envelope.id), html: Icons.trash }),
      ),
      // Spans both grid columns (CSS grid-area: panel) so the table
      // reads full-width regardless of where the actions cell lands.
      comparePanel,
    );
    return row;
  }

  // -- Empty state --------------------------------------------------
  function renderEmpty() {
    const cta = el('button', {
      class: 'btn btn-primary btn-lg',
      style: { marginTop: '16px' },
      onclick: () => window.Modals.envelope(),
    }, el('span', { html: Icons.plus }), t('envelopes.add'));
    return el('div', {},
      ViewHelpers.emptyState(t('envelopes.empty.title'), t('envelopes.empty.msg')),
      cta,
    );
  }

  // -- Top-level render ---------------------------------------------
  function render() {
    const envelopes = App._state.envelopes || [];

    const wrap = el('div', { class: 'view-envelopes' });

    // ISSUE-021: consume a one-shot pre-fill payload that the
    // category detail CTA set just before navigating here. We open
    // the modal after the view paints (setTimeout 0) so the user
    // briefly sees the envelopes page behind the modal — otherwise
    // the modal would mount before `#view` is attached and could
    // anchor to the wrong scroll position. Clearing the slot is the
    // view's responsibility: leaving it set would re-open the modal
    // on every re-render (e.g. after a save fires `store:changed`).
    if (Router.pendingEnvelopeInit) {
      const init = Router.pendingEnvelopeInit;
      Router.pendingEnvelopeInit = null;
      setTimeout(() => window.Modals.envelope(null, init), 0);
    }

    const addBtn = el('button', {
      class: 'btn btn-primary',
      onclick: () => window.Modals.envelope(),
    }, el('span', { html: Icons.plus }), t('envelopes.add'));

    const card = el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {},
          el('div', { class: 'card-title' }, t('envelopes.title')),
        ),
        addBtn,
      ),
    );

    if (!envelopes.length) {
      card.appendChild(renderEmpty());
    } else {
      const list = el('div', { class: 'env-list' });
      envelopes.forEach(e => list.appendChild(renderEnvelopeRow(e)));
      card.appendChild(list);
    }

    wrap.appendChild(card);
    return wrap;
  }

  return { render };
})();
window.Envelopes = Envelopes;
