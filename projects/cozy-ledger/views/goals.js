// =====================================================================
// views/goals.js — Savings goals list (ISSUE-017)
// =====================================================================
// Reads: App._state, Selectors.goalProgress
// Calls: window.Modals.{goal,goalDelete}, Store.fundGoal
//
// A row per goal: name, "€X van €Y" label, progress bar (green when
// < 100%, deep-green when exactly 100%, sage-red when overfunded),
// remaining / reached / over message, and Fund / Edit / Delete
// actions. The Fund action opens an inline form with amount + date
// inputs so the user doesn't bounce through a modal for every
// deposit.
//
// Pure layout: no transaction plumbing yet (envelopes come next).
// =====================================================================

const Goals = (() => {
  // -- Progress bar colours -----------------------------------------
  // Three states, in spec order: < 100% (sage), == 100% (deep-sage,
  // solid), > 100% (neg). The CSS targets these via the `--fill`
  // custom property and class modifiers; we just set the right one.
  function barClass(percent) {
    if (percent > 100) return 'goal-bar-fill goal-bar-fill--over';
    if (percent === 100) return 'goal-bar-fill goal-bar-fill--full';
    return 'goal-bar-fill';
  }

  // -- Footer caption -----------------------------------------------
  // "Nog €X te gaan" / "Doel bereikt 🎉" / "€X boven doel"
  function renderCaption(progress) {
    if (progress.percent > 100) {
      const over = Math.round((progress.funded - progress.target) * 100) / 100;
      return el('div', { class: 'goal-caption goal-caption--over' },
        t('goals.card.over', { over: Fmt.money(over) }),
      );
    }
    if (progress.percent >= 100) {
      return el('div', { class: 'goal-caption goal-caption--reached' }, t('goals.card.reached'));
    }
    return el('div', { class: 'goal-caption' },
      t('goals.card.remaining', { remaining: Fmt.money(progress.remaining) }),
    );
  }

  // -- Inline fund form ---------------------------------------------
  // Toggled open by the row's "Storten" button. Submitting commits
  // via Store.fundGoal and re-renders; cancel collapses without
  // dispatching store:changed.
  function renderFundForm(goal) {
    const amountInput = el('input', {
      class: 'input amount-input', type: 'number', step: '0.01', min: '0.01',
      id: `g-fund-amt-${goal.id}`, placeholder: '0,00',
      value: '',
    });
    const dateInput = el('input', {
      class: 'input', type: 'date',
      id: `g-fund-date-${goal.id}`,
      value: Fmt.today(),
    });
    const errSpan = el('span', { class: 'goal-form-err', id: `g-fund-err-${goal.id}` });
    const cancelBtn = el('button', { type: 'button', class: 'btn btn-ghost', id: `g-fund-cancel-${goal.id}` }, t('goals.fund.cancel'));
    const confirmBtn = el('button', { type: 'button', class: 'btn btn-primary', id: `g-fund-ok-${goal.id}` }, t('goals.fund.confirm'));

    function submit() {
      errSpan.textContent = '';
      const amount = Number(amountInput.value);
      if (!isFinite(amount) || amount <= 0) {
        errSpan.textContent = t('goals.err.amountRequired');
        return;
      }
      Store.fundGoal(App._state, goal.id, { amount, date: dateInput.value || Fmt.today() });
      window.toast(t('goals.funded'));
      window.dispatchEvent(new Event('store:changed'));
      // Renderer rebuilds on store:changed — no manual close needed.
    }
    function cancel() {
      const host = document.getElementById(`g-fund-form-${goal.id}`);
      if (host) { host.innerHTML = ''; host.style.display = 'none'; }
    }
    cancelBtn.addEventListener('click', cancel);
    confirmBtn.addEventListener('click', submit);
    amountInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    dateInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    const form = el('div', { class: 'goal-fund-form-inner' },
      el('label', { for: `g-fund-amt-${goal.id}` }, t('goals.fund.amount')),
      el('div', { class: 'amount-wrap' }, el('span', { class: 'currency' }, '€'), amountInput),
      el('label', { for: `g-fund-date-${goal.id}` }, t('goals.fund.date')),
      dateInput,
      errSpan,
      el('div', { class: 'goal-fund-actions' }, cancelBtn, confirmBtn),
    );
    return el('div', { class: 'goal-fund-form', id: `g-fund-form-${goal.id}`, style: { display: 'none' } }, form);
  }

  // -- Goal row -----------------------------------------------------
  function renderGoalRow(goal) {
    const progress = Selectors.goalProgress(goal);
    const fillEl = el('div', { class: barClass(progress.percent), style: { width: Math.min(100, progress.percent) + '%' } });
    const fillHost = el('div', { class: 'goal-bar' }, fillEl);

    const labelText = t('goals.card.funded', { funded: Fmt.money(progress.funded), target: Fmt.money(progress.target) });

    const row = el('div', { class: 'goal-row', 'data-goal-id': goal.id },
      el('div', { class: 'goal-row-main' },
        el('div', { class: 'goal-row-head' },
          el('div', { class: 'goal-name' }, goal.name),
          el('div', { class: 'goal-funded-label' }, labelText),
        ),
        fillHost,
        renderCaption(progress),
      ),
      el('div', { class: 'goal-row-actions' },
        el('button', { class: 'btn btn-sage btn-sm', 'data-action': 'fund', onclick: () => toggleFundForm(goal.id) }, t('goals.fund')),
        el('button', { class: 'btn-icon', title: t('goals.edit'), onclick: () => window.Modals.goal(goal.id), html: Icons.edit }),
        el('button', { class: 'btn-icon btn-danger', title: t('goals.delete'), onclick: () => window.Modals.goalDelete(goal.id), html: Icons.trash }),
      ),
      renderFundForm(goal),
    );
    return row;
  }

  function toggleFundForm(goalId) {
    const host = document.getElementById(`g-fund-form-${goalId}`);
    if (!host) return;
    if (host.style.display === 'none' || !host.style.display) {
      host.style.display = '';
      const amt = document.getElementById(`g-fund-amt-${goalId}`);
      if (amt) setTimeout(() => amt.focus(), 50);
    } else {
      host.style.display = 'none';
      host.innerHTML = ''; // collapse any entered values
      // Re-create the form from the current row to avoid stale state.
      const row = document.querySelector(`.goal-row[data-goal-id="${goalId}"]`);
      if (row) {
        const newForm = renderFundForm({ id: goalId });
        row.appendChild(newForm);
      }
    }
  }

  // -- Empty state --------------------------------------------------
  // The card-head already carries an "Add" button (rendered above), so
  // the empty state only needs the title + message and a primary CTA
  // inside the body for clarity.
  function renderEmpty() {
    const cta = el('button', { class: 'btn btn-primary btn-lg', onclick: () => window.Modals.goal(), style: { marginTop: '16px' } },
      el('span', { html: Icons.plus }), t('goals.add'));
    return el('div', {},
      ViewHelpers.emptyState(t('goals.empty.title'), t('goals.empty.msg')),
      cta,
    );
  }

  // -- Top-level render ---------------------------------------------
  function render() {
    const goals = App._state.goals || [];

    const wrap = el('div', { class: 'view-goals' });

    // Card head with title + add button.
    const addBtn = el('button', { class: 'btn btn-primary', onclick: () => window.Modals.goal() },
      el('span', { html: Icons.plus }), t('goals.add'));

    const card = el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {},
          el('div', { class: 'card-title' }, t('goals.title')),
          el('div', { class: 'card-sub muted' }, t('goals.sub')),
        ),
        addBtn,
      ),
    );

    if (!goals.length) {
      card.appendChild(renderEmpty());
    } else {
      const list = el('div', { class: 'goal-list' });
      goals.forEach(g => list.appendChild(renderGoalRow(g)));
      card.appendChild(list);
    }

    wrap.appendChild(card);
    return wrap;
  }

  return { render };
})();
window.Goals = Goals;
