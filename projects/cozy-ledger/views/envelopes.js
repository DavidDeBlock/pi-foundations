// =====================================================================
// views/envelopes.js — Spending caps (ISSUE-018)
// =====================================================================
// Reads: App._state, Selectors.envelopeProgress, ViewHelpers.distinctPayees
// Calls: window.Modals.{envelope,envelopeDelete}
//
// A row per envelope: name, period label, "€X van €Y" label,
// progress bar (green < 80%, amber 80–100%, sage-red > 100%),
// remaining / overspent caption, and Edit / Delete actions.
//
// Pure layout: this view only renders. The spend calculation lives
// in Selectors.envelopeProgress so it's testable in isolation.
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

    const row = el('div', { class: 'env-row', 'data-envelope-id': envelope.id },
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
      ),
      el('div', { class: 'env-row-actions' },
        el('button', { class: 'btn-icon', title: t('envelopes.edit'), onclick: () => window.Modals.envelope(envelope.id), html: Icons.edit }),
        el('button', { class: 'btn-icon btn-danger', title: t('envelopes.delete'), onclick: () => window.Modals.envelopeDelete(envelope.id), html: Icons.trash }),
      ),
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
