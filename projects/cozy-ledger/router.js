// =====================================================================
// router.js — View state + dispatch
// =====================================================================
// Owns the route (current view, month, filters, trends settings) and
// rebuilds `#view` on every change. Shell updates are in-place.
// Each view is a `window.<Name>` module that exposes `render()`.
// =====================================================================

const Router = (() => {
  let view = 'dashboard';
  let monthKey = Fmt.currentMonthKey();
  let txnFilters = { month: 'all', type: 'all', categoryId: 'all', userId: 'all', sourceId: 'all', scope: 'all', payee: 'all', groupId: 'all' };
  let balanceViewMode = 'sources'; // 'sources' | 'networth'
  let trendRange = '1y';           // '1y' | '2y' | '3y' | 'all'

  // -- Routing -------------------------------------------------------
  function goTo(v) {
    view = v;
    Shell.closeSidebar();
    renderView();
  }

  function setBalanceViewMode(mode) {
    if (mode === balanceViewMode) return;
    if (mode !== 'sources' && mode !== 'networth') return;
    balanceViewMode = mode;
    renderView();
  }

  function setTrendRange(range) {
    if (!['1y', '2y', '3y', 'all'].includes(range)) return;
    if (range === trendRange) return;
    trendRange = range;
    renderView();
  }

  // Resolve the active range ('1y' | '2y' | '3y' | 'all') into a
  // month count. For 'all' we use the oldest in-scope transaction so
  // the chart naturally grows with the user's history. Capped at 240
  // months (20 years) so the SVG can't blow up.
  function monthsForRange(range) {
    if (range === 'all') {
      const sources = Selectors.sourcesInScope(App._state);
      const inScope = new Set(sources.map(s => s.id));
      const txns = (App._state.transactions || []).filter(t => inScope.has(t.sourceId));
      if (!txns.length) return 12;
      const oldest = txns.reduce((m, t) => t.date < m ? t.date : m, txns[0].date);
      const oldestDate = new Date(oldest);
      const now = new Date();
      const n = (now.getFullYear() - oldestDate.getFullYear()) * 12
              + (now.getMonth() - oldestDate.getMonth()) + 1;
      return Math.max(12, Math.min(240, n));
    }
    return { '1y': 12, '2y': 24, '3y': 36 }[range] || 12;
  }

  // -- Month picker --------------------------------------------------
  function shiftMonth(delta) {
    monthKey = Fmt.shiftMonth(monthKey, delta);
    renderView();
  }

  // -- Transaction filters ------------------------------------------
  function setTxnFilter(key, value) {
    txnFilters[key] = value;
    renderView();
  }

  function resetTxnFilters() {
    txnFilters = { month: 'all', type: 'all', categoryId: 'all', userId: 'all', sourceId: 'all', scope: 'all', payee: 'all', groupId: 'all' };
    renderView();
  }

  // -- Render -------------------------------------------------------
  // Rebuilds `#view` (the only subtree that gets torn down) and
  // triggers in-place shell updates for badges, active class, scope
  // pills, and the month picker label.
  function renderView() {
    const viewEl = $('#view');
    viewEl.innerHTML = '';

    // Page title/sub — in place.
    const titles = {
      dashboard:    [t('page.dashboard.title'),    t('page.dashboard.sub')],
      trends:       [t('page.trends.title'),       t('page.trends.sub')],
      transactions: [t('page.transactions.title'), t('page.transactions.sub')],
      categories:   [t('page.categories.title'),   t('page.categories.sub')],
      sources:      [t('page.sources.title'),      t('page.sources.sub')],
      users:        [t('page.users.title'),        t('page.users.sub')],
      payees:       [t('page.payees.title'),       t('page.payees.sub')],
      settings:     [t('page.settings.title'),     t('page.settings.sub')],
    };
    $('#page-title').innerHTML = titles[view][0];
    $('#page-sub').textContent = titles[view][1];

    // Topbar in-place updates.
    const at = $('#add-txn-btn');
    at.style.display = (view === 'categories' || view === 'sources' || view === 'users' || view === 'settings') ? 'none' : 'inline-flex';
    Shell.ensureMonthPicker();
    Shell.updateScopePills();

    // Sidebar in-place updates.
    Shell.updateSidebarBadges();
    Shell.updateSidebarActiveClass();

    // Mount the active view subtree.
    if (view === 'dashboard')    viewEl.appendChild(Dashboard.render());
    else if (view === 'trends')       viewEl.appendChild(Trends.render());
    else if (view === 'transactions') viewEl.appendChild(Transactions.render());
    else if (view === 'categories')   viewEl.appendChild(Categories.render());
    else if (view === 'sources')      viewEl.appendChild(Sources.render());
    else if (view === 'users')        viewEl.appendChild(Users.render());
    else if (view === 'payees')       viewEl.appendChild(Payees.render());
    else if (view === 'settings')     viewEl.appendChild(Settings.render());
  }

  return {
    // Render
    renderView,
    // Routing
    goTo,
    // State getters (read-only view from outside; mutators are explicit)
    get view() { return view; },
    get monthKey() { return monthKey; },
    get txnFilters() { return txnFilters; },
    get balanceViewMode() { return balanceViewMode; },
    get trendRange() { return trendRange; },
    // Mutators
    shiftMonth,
    setTxnFilter,
    resetTxnFilters,
    setBalanceViewMode,
    setTrendRange,
    monthsForRange,
  };
})();
window.Router = Router;
