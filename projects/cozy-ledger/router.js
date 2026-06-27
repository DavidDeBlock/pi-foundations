// =====================================================================
// router.js — View state + dispatch
// =====================================================================
// Owns the route (current view, month, filters, trends settings) and
// rebuilds `#view` on every change. Shell updates are in-place.
// Each view is a `window.<Name>` module that exposes `render()`.
//
// ISSUE-016: the legacy `trendRange` / `setTrendRange` / `monthsForRange`
// API was removed — the Trends view now consumes the shared period state
// (`period` + `periodRange()`) like the dashboard.
// =====================================================================

const Router = (() => {
  let view = 'dashboard';
  let monthKey = Fmt.currentMonthKey();
  let txnFilters = { month: 'all', type: 'all', categoryId: 'all', userId: 'all', sourceId: 'all', scope: 'all', payee: 'all', groupId: 'all' };
  /** @type {'sources'|'networth'} */
  let balanceViewMode = 'sources';
  // ISSUE-020: which envelopes have their "Vergelijking" panel
  // expanded. Transient — never persisted to localStorage — because
  // the expanded/collapsed state is per-session UI, not a user
  // preference. The view reads this on every render so a `store:changed`
  // re-render keeps the user's open panels open.
  /** @type {Set<string>} */
  const envelopeCompareExpanded = new Set();

  // -- Period state (ISSUE-013 / PRD-004) ----------------------------
  // Shared "what time range am I looking at" state for the dashboard
  // and trends view. `preset` is one of the rolling windows from the
  // PRD table, or 'custom' when the user picked a manual range.
  // The view-default map keeps the per-view default (`1m` for
  // dashboard, `1y` for trends) in one place so ISSUE-014/015/016
  // can ask "what's my default?" without reaching into Router internals.
  const PERIOD_KEY = 'cozy.ledger.period';
  const periodDefaultsByView = { dashboard: '1m', trends: '1y' };
  /** @type {{ preset: '1m'|'3m'|'6m'|'1y'|'2y'|'all'|'custom', from: string, to: string }} */
  let period = { preset: '1m', from: Fmt.ymKey(new Date()) + '-01', to: Fmt.today() };

  function persistPeriod() {
    try {
      window.localStorage.setItem(PERIOD_KEY, JSON.stringify(period));
    } catch (_) { /* localStorage may be disabled; in-memory still works */ }
  }

  function isIsoDate(s) {
    if (typeof s !== 'string') return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T00:00:00');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }

  function isValidStoredPeriod(raw) {
    if (!raw || typeof raw !== 'object') return false;
    const validPresets = ['1m', '3m', '6m', '1y', '2y', 'all', 'custom'];
    if (!validPresets.includes(raw.preset)) return false;
    if (!isIsoDate(raw.from) || !isIsoDate(raw.to)) return false;
    if (raw.from > raw.to) return false;
    const todayIso = Fmt.today();
    if (raw.to > todayIso) return false;
    return true;
  }

  function defaultPeriodFor(viewKey) {
    const preset = periodDefaultsByView[viewKey] || periodDefaultsByView.dashboard;
    const range = Selectors.periodRangeForPreset(preset);
    return { preset, from: range.from, to: range.to };
  }

  function restorePeriod() {
    try {
      const raw = JSON.parse(window.localStorage.getItem(PERIOD_KEY) || 'null');
      if (isValidStoredPeriod(raw)) {
        period = { preset: raw.preset, from: raw.from, to: raw.to };
      } else {
        period = defaultPeriodFor('dashboard');
        persistPeriod();
      }
    } catch (_) {
      period = defaultPeriodFor('dashboard');
    }
  }

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

  // -- Period state (ISSUE-013 / PRD-004) ----------------------------
  // `periodRange()` returns the active {from, to} as ISO strings.
  // `setPeriodPreset(preset)` re-derives from/to rolling from today
  // (or, for 'all', from the earliest in-scope transaction) and
  // re-renders. `setPeriodRange({from, to})` switches the preset to
  // 'custom' and validates the range (`from <= to`, `to` not in the
  // future). `resetPeriod(viewKey)` returns the view to its default
  // preset (1m for dashboard, 1y for trends).
  function periodRange() { return { from: period.from, to: period.to }; }
  function defaultPresetFor(viewKey) {
    return periodDefaultsByView[viewKey] || periodDefaultsByView.dashboard;
  }
  function setPeriodPreset(preset) {
    let range;
    if (preset === 'all') range = Selectors.periodRangeForAll(App._state);
    else                  range = Selectors.periodRangeForPreset(preset);
    if (!range) return;
    period = { preset, from: range.from, to: range.to };
    persistPeriod();
    renderView();
  }
  function setPeriodRange(range) {
    if (!range || typeof range.from !== 'string' || typeof range.to !== 'string') return;
    if (!isIsoDate(range.from) || !isIsoDate(range.to)) return;
    if (range.from > range.to) return;
    const todayIso = Fmt.today();
    const to = range.to > todayIso ? todayIso : range.to;
    period = { preset: 'custom', from: range.from, to };
    persistPeriod();
    renderView();
  }
  function resetPeriod(viewKey) {
    period = defaultPeriodFor(viewKey);
    persistPeriod();
    renderView();
  }

  // Called once from App.init(). Pulls the persisted period out of
  // localStorage (if any), validates it, and falls back to the
  // dashboard default on any failure. Kept out of the IIFE body so
  // pure-function tests that load router.js without booting App
  // never touch localStorage.
  function boot() {
    restorePeriod();
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
      goals:        [t('goals.title'),             t('goals.sub')],
      envelopes:    [t('envelopes.title'),         ''],
      settings:     [t('page.settings.title'),     t('page.settings.sub')],
    };
    $('#page-title').innerHTML = titles[view][0];
    $('#page-sub').textContent = titles[view][1];

    // Topbar in-place updates.
    const at = $('#add-txn-btn');
    at.style.display = (view === 'categories' || view === 'sources' || view === 'users' || view === 'settings' || view === 'goals' || view === 'envelopes') ? 'none' : 'inline-flex';
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
    else if (view === 'goals')        viewEl.appendChild(Goals.render());
    else if (view === 'envelopes')    viewEl.appendChild(Envelopes.render());
    else if (view === 'settings')     viewEl.appendChild(Settings.render());
  }

  return {
    // Boot (called once from App.init())
    boot,
    // Render
    renderView,
    // Routing
    goTo,
    // State getters (read-only view from outside; mutators are explicit)
    get view() { return view; },
    get monthKey() { return monthKey; },
    get txnFilters() { return txnFilters; },
    get balanceViewMode() { return balanceViewMode; },
    get period() { return period; },
    // Period helpers (ISSUE-013)
    periodRange,
    setPeriodPreset,
    setPeriodRange,
    resetPeriod,
    defaultPresetFor,
    // Mutators
    shiftMonth,
    setTxnFilter,
    resetTxnFilters,
    setBalanceViewMode,
    // ISSUE-020: per-envelope expanded/collapsed state for the
    // "Vergelijking" panel. Exposed as a Set so callers can do
    // `has(id)` / `add(id)` / `delete(id)` without going through a
    // dedicated mutator. Not persisted (transient UI state).
    get envelopeCompareExpanded() { return envelopeCompareExpanded; },
  };
})();
window.Router = Router;
