// =====================================================================
// views/trends.js — Trends: balance over time + monthly flow + top cats
// =====================================================================
// Reads: App._state, Router.balanceViewMode, Router.trendRange,
//        Router.monthKey
// Calls: Router.renderView, Router.setBalanceViewMode,
//        Router.setTrendRange, Selectors, Store.updateSource
//
// Chart rendering is delegated to:
//   charts/monthly-flow.js     — MonthlyFlow.render({...})
//   charts/balance-trajectory.js — BalanceTrajectory.render({...})
// This file is responsible only for the trends view's chrome:
// range toggle, balance-input row, mount points for the charts.
// =====================================================================

const Trends = (() => {
  // -- Per-source ↔ Net-worth toggle --------------------------------
  function renderViewToggle() {
    return el('div', { class: 'view-toggle', id: 'balance-view-toggle' },
      el('button', {
        class: 'vt-pill' + (Router.balanceViewMode === 'sources' ? ' active' : ''),
        'data-mode': 'sources',
        onclick: () => Router.setBalanceViewMode('sources'),
      }, t('trends.toggle.sources')),
      el('button', {
        class: 'vt-pill' + (Router.balanceViewMode === 'networth' ? ' active' : ''),
        'data-mode': 'networth',
        onclick: () => Router.setBalanceViewMode('networth'),
      }, t('trends.toggle.networth')),
    );
  }

  function renderRangeButtons() {
    const opts = [
      { id: '1y',  label: t('trends.range.1y')  },
      { id: '2y',  label: t('trends.range.2y')  },
      { id: '3y',  label: t('trends.range.3y')  },
      { id: 'all', label: t('trends.range.all') },
    ];
    return el('div', { class: 'range-buttons' },
      ...opts.map(o => {
        const btn = el('button', {
          type: 'button',
          class: 'range-btn' + (Router.trendRange === o.id ? ' active' : ''),
          'data-range': o.id,
        }, o.label);
        btn.addEventListener('click', () => Router.setTrendRange(o.id));
        return btn;
      }),
    );
  }

  // -- Per-source typed-balance row ---------------------------------
  let _balDebounce = null;
  function parseBalanceValue(s) {
    if (s == null || s === '') return 0;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }
  function onBalanceInput(e, chartHost) {
    clearTimeout(_balDebounce);
    const input = e.target;
    _balDebounce = setTimeout(() => commitBalance(input, chartHost), 350);
  }
  function onBalanceBlur(e, chartHost) {
    clearTimeout(_balDebounce);
    commitBalance(e.target, chartHost);
  }
  function commitBalance(input, chartHost) {
    if (!input) return;
    const sourceId = input.getAttribute('data-source-id');
    const value = parseBalanceValue(input.value);
    if (!Number.isFinite(value)) return;
    Store.updateSource(App._state, sourceId, { balance: value });
    const sources = Selectors.sourcesInScope(App._state);
    chartHost.innerHTML = '';
    chartHost.appendChild(MonthlyFlow.render({
      months: Selectors.monthlyNetFlow(App._state, Router.monthsForRange(Router.trendRange)),
      sources,
      isNetWorth: Router.balanceViewMode === 'networth',
      i18n: {
        title: t('trends.section.flow.title'),
        sub: t('trends.section.flow.sub'),
        empty: t('trends.balance.noActivity'),
        tooltipSaved: t('trends.tooltip.saved'),
        tooltipSpent: t('trends.tooltip.spent'),
        tooltipIn: t('trends.tooltip.in'),
        tooltipOut: t('trends.tooltip.out'),
      },
      rangeButtons: renderRangeButtons(),
    }));
    chartHost.appendChild(buildTrajectoryChart(sources));
    const saved = $('#saved-' + sourceId);
    if (saved) {
      saved.textContent = t('trends.balance.saved');
      saved.classList.add('show');
      setTimeout(() => {
        if (saved) { saved.textContent = ''; saved.classList.remove('show'); }
      }, 1500);
    }
  }

  function renderBalanceInput(src, chartHost) {
    const value = (Number(src.balance) || 0);
    return el('div', { class: 'balance-input-row', 'data-source': src.id },
      el('span', { class: 'balance-input-dot', style: { background: ChartHelpers.colorForSource(src) } }),
      el('label', { for: `bal-${src.id}`, class: 'balance-input-label' }, src.name),
      el('input', {
        type: 'number', step: '0.01',
        id: `bal-${src.id}`,
        class: 'balance-input', value: value.toFixed(2),
        'data-source-id': src.id,
        'data-prev-value': String(value),
        oninput: (e) => onBalanceInput(e, chartHost),
        onblur:  (e) => onBalanceBlur(e, chartHost),
        onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
      }),
      el('span', { class: 'balance-saved', id: `saved-${src.id}` }),
    );
  }

  // -- Monthly flow chart -------------------------------------------
  function buildMonthlyFlowChart(sources) {
    return MonthlyFlow.render({
      months: Selectors.monthlyNetFlow(App._state, Router.monthsForRange(Router.trendRange)),
      sources,
      isNetWorth: Router.balanceViewMode === 'networth',
      i18n: {
        title: t('trends.section.flow.title'),
        sub: t('trends.section.flow.sub'),
        empty: t('trends.balance.noActivity'),
        tooltipSaved: t('trends.tooltip.saved'),
        tooltipSpent: t('trends.tooltip.spent'),
        tooltipIn: t('trends.tooltip.in'),
        tooltipOut: t('trends.tooltip.out'),
      },
      rangeButtons: renderRangeButtons(),
    });
  }

  // -- Balance trajectory chart -------------------------------------
  function buildTrajectoryChart(sources) {
    const isNetWorth = Router.balanceViewMode === 'networth';
    const trendMonths = Router.monthsForRange(Router.trendRange);
    let series;
    if (isNetWorth) {
      const pts = Selectors.monthlyNetWorth(App._state, trendMonths);
      series = pts.length
        ? [{ id: '__networth__', name: t('trends.toggle.networth'), points: pts, today: pts[pts.length - 1].balance }]
        : [];
    } else {
      series = sources.map(src => {
        const points = Selectors.monthlyBalance(App._state, src.id, trendMonths);
        const flat = points.length > 1
          && points.every(p => p.balance === points[0].balance);
        return { id: src.id, name: src.name, points, today: Number(src.balance) || 0, flat };
      }).filter(s => s.points.length);
    }
    return BalanceTrajectory.render({
      series,
      isNetWorth,
      i18n: {
        titleSrc: t('trends.section.traj.title.src'),
        titleNw: t('trends.section.traj.title.nw'),
        subSrc: t('trends.section.traj.sub.src'),
        subNw: t('trends.section.traj.sub.nw'),
        emptySources: t('trends.balance.noSources'),
        emptyTxns12: t('trends.balance.noTxns12'),
        networthName: t('trends.toggle.networth'),
        todayLabel: t('trends.balance.today'),
      },
      rangeButtons: renderRangeButtons(),
    });
  }

  // -- Balance flow card --------------------------------------------
  function renderBalanceFlow() {
    const sources = Selectors.sourcesInScope(App._state);
    if (!sources.length) {
      return el('div', { class: 'card balance-card', id: 'balance-card' },
        el('div', { class: 'card-head' },
          el('div', { class: 'card-title', html: Icons.piggy }),
          t('trends.balance.heading'),
        ),
        el('div', { class: 'balance-empty' }, t('trends.balance.empty')),
      );
    }

    const chartHost = el('div', { class: 'chart-wrap', id: 'balance-chart-wrap' });
    chartHost.appendChild(buildMonthlyFlowChart(sources));
    chartHost.appendChild(buildTrajectoryChart(sources));

    return el('div', { class: 'card balance-card', id: 'balance-card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title', html: Icons.piggy }),
        t('trends.balance.heading'),
        el('div', { class: 'card-sub' }, t('trends.balance.sub')),
        renderViewToggle(),
      ),
      chartHost,
      el('div', { class: 'balance-inputs', id: 'balance-inputs' },
        ...sources.map(src => renderBalanceInput(src, chartHost)),
      ),
    );
  }

  // -- Top-level render ---------------------------------------------
  function render() {
    const inScopeTxns = Selectors.transactionsInScope(App._state);
    const monthTxns = inScopeTxns.filter(x => Fmt.inMonth(x.date, Router.monthKey));
    const totalExpense = ViewHelpers.sum(monthTxns.filter(x => x.type === 'expense'), 'amount');

    const wrap = el('div', { class: 'view-trends' });
    wrap.appendChild(renderBalanceFlow());
    wrap.appendChild(Dashboard.renderTopCategoriesCard(monthTxns, totalExpense));
    return wrap;
  }

  return { render };
})();
window.Trends = Trends;
