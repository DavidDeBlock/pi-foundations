// =====================================================================
// app.js — App state, router, screens, modals
// =====================================================================

const App = (() => {
  // ---- State --------------------------------------------------------
  let state = Store.load();
  let view = 'dashboard';           // current route
  let monthKey = Fmt.currentMonthKey(); // for month-scoped screens
  let txnFilters = { month: 'all', type: 'all', categoryId: 'all', userId: 'all', sourceId: 'all', scope: 'all', payee: 'all', groupId: 'all' };
  let balanceViewMode = 'sources';  // 'sources' (per-source lines) or 'networth' (single aggregate line)
  let trendRange = '1y';  // '1y' | '2y' | '3y' | 'all' — window for the trends charts

  // ---- Boot ---------------------------------------------------------
  function init() {
    renderShell();
    renderView();
    bindGlobal();
  }

  // ---- Shell (sidebar + topbar + main area) -------------------------
  function renderShell() {
    const root = $('#app');
    root.innerHTML = '';
    root.appendChild(renderSidebar());
    root.appendChild(el('main', { class: 'main', id: 'main' },
      renderTopbar(),
      el('div', { id: 'view' }),
      el('div', { class: 'toast', id: 'toast' }),
    ));
  }

  function renderSidebar() {
    const txCount = state.transactions.length;
    const back = el('div', { class: 'sidebar-backdrop', id: 'sb-back', onclick: closeSidebar });
    document.body.appendChild(back);

    const navItem = (id, label, icon, badge) =>
      el('button', { class: 'nav-item' + (view === id ? ' active' : ''), 'data-view': id, onclick: () => goTo(id) },
        el('span', { class: 'ni-icon', html: icon }),
        label,
        badge != null ? el('span', { class: 'ni-badge' }, String(badge)) : null,
      );

    return el('aside', { class: 'sidebar', id: 'sidebar' },
      el('div', { class: 'brand' },
        el('div', { class: 'brand-mark', html: Logo }),
        el('div', {},
          el('div', { class: 'brand-name' }, t('brand.name')),
          el('div', { class: 'brand-sub' }, t('brand.tagline')),
        ),
      ),
      el('nav', { class: 'nav' },
        el('div', { class: 'nav-label' }, t('sidebar.label.overview')),
        navItem('dashboard',   t('nav.dashboard'),    Icons.home),
        navItem('trends',      t('nav.trends'),       Icons.trend),
        navItem('transactions',t('nav.transactions'), Icons.list, txCount),
        el('div', { class: 'nav-label' }, t('sidebar.label.manage')),
        navItem('categories',  t('nav.categories'),   Icons.tags, state.categories.length),
        navItem('sources',     t('nav.sources'),      Icons.wallet, state.sources.length),
        navItem('users',       t('nav.users'),        Icons.users, state.users.length),
        navItem('payees',      t('nav.payees'),       Icons.store, distinctPayees().filter(p => p.noCategory > 0).length || null),
        el('div', { class: 'nav-label' }, t('sidebar.label.backup')),
        navItem('settings',    t('nav.settings'),     Icons.settings),
      ),
      el('div', { class: 'sidebar-foot' },
        el('strong', {}, t('sidebar.foot.title')),
        t('sidebar.foot.body')),
    );
  }

  function renderTopbar() {
    return el('div', { class: 'topbar' },
      el('div', {},
        el('button', { class: 'menu-btn', onclick: openSidebar, html: Icons.menu }),
        el('div', { class: 'page-title', id: 'page-title' }, ''),
        el('div', { class: 'page-sub', id: 'page-sub' }, ''),
      ),
      el('div', { class: 'flex center gap-8' },
        el('div', { class: 'month-picker', id: 'month-picker' }),
        el('div', { class: 'scope-pills', id: 'scope-pills' }),
        el('button', { class: 'btn btn-ghost', onclick: () => window.Modals.import(), id: 'import-btn', title: t('topbar.import.title') },
          el('span', { html: Icons.upload }), t('topbar.import')),
        el('button', { class: 'btn btn-primary', onclick: () => window.Modals.transaction(), id: 'add-txn-btn' },
          el('span', { html: Icons.plus }), t('topbar.add')),
      ),
    );
  }

  // Scope pills: Private / Shared / All. Writes through Store.setScope
  // and fires store:changed so every subscriber re-renders.
  function renderScopeSelector(host) {
    if (!host) return;
    host.innerHTML = '';
    const current = state.settings && state.settings.scope;
    const opts = [
      { id: 'private', label: t('scope.private.label'), title: t('scope.private.title') },
      { id: 'shared',  label: t('scope.shared.label'),  title: t('scope.shared.title') },
      { id: 'all',     label: t('scope.all.label'),     title: t('scope.all.title') },
    ];
    for (const o of opts) {
      const active = current === o.id;
      host.appendChild(el('button', {
        class: 'scope-pill' + (active ? ' active' : ''),
        'data-scope': o.id,
        title: o.title,
        onclick: () => setScope(o.id),
      }, o.label));
    }
  }

  function scopeTitle(id) {
    if (id === 'private') return t('scope.private.title');
    if (id === 'shared')  return t('scope.shared.title');
    return t('scope.all.title');
  }

  function setScope(id) {
    if (!window.SelectorScopes.includes(id)) return;
    if (state.settings && state.settings.scope === id) return;
    Store.setScope(state, id);
    window.dispatchEvent(new Event('store:changed'));
  }

  function bindGlobal() {
    // Re-render after any store change
    window.addEventListener('store:changed', () => {
      state = Store.load();
      renderShell();
      renderView();
    });
  }

  // ---- Routing ------------------------------------------------------
  function goTo(v) {
    view = v;
    closeSidebar();
    renderShell();
    renderView();
  }

  function renderView() {
    const main = $('#main');
    const view_ = $('#view');
    view_.innerHTML = '';

    // Update page title/sub
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

    // Month picker visibility: only relevant on dashboard/transactions
    const showMonth = (view === 'dashboard' || view === 'transactions');
    const mp = $('#month-picker');
    if (showMonth) renderMonthPicker(mp);
    else mp.innerHTML = '';

    // Scope pills live in the topbar; render on every view so the user
    // can change scope without first navigating somewhere specific.
    renderScopeSelector($('#scope-pills'));

    const at = $('#add-txn-btn');
    at.style.display = (view === 'categories' || view === 'sources' || view === 'users' || view === 'settings') ? 'none' : 'inline-flex';

    if (view === 'dashboard') view_.appendChild(renderDashboard());
    else if (view === 'trends') view_.appendChild(renderTrends());
    else if (view === 'transactions') view_.appendChild(renderTransactions());
    else if (view === 'categories') view_.appendChild(renderCategories());
    else if (view === 'sources') view_.appendChild(renderSources());
    else if (view === 'users') view_.appendChild(renderUsers());
    else if (view === 'payees') view_.appendChild(renderPayees());
    else if (view === 'settings') view_.appendChild(renderSettings());
  }

  // ---- Month picker -------------------------------------------------
  function renderMonthPicker(host) {
    host.innerHTML = '';
    const label = Fmt.monthLabel(monthKey);
    host.appendChild(el('button', { title: t('month.prev'), onclick: () => { monthKey = Fmt.shiftMonth(monthKey, -1); renderView(); }, html: Icons.chevLeft }));
    host.appendChild(el('div', { class: 'mp-label' }, label));
    host.appendChild(el('button', { title: t('month.next'), onclick: () => { monthKey = Fmt.shiftMonth(monthKey, 1); renderView(); }, html: Icons.chevRight }));
  }

  // ---- Sidebar (mobile) --------------------------------------------
  function openSidebar() { $('#sidebar').classList.add('open'); $('#sb-back').classList.add('show'); }
  function closeSidebar() { $('#sidebar').classList.remove('open'); $('#sb-back').classList.remove('show'); }

  // ===================================================================
  // SCREEN: DASHBOARD
  // ===================================================================
  function renderDashboard() {
    const inScopeTxns = Selectors.transactionsInScope(state);
    const txns = inScopeTxns.filter(t => Fmt.inMonth(t.date, monthKey));
    const totalIncome  = sum(txns.filter(t => t.type === 'income'),  'amount');
    const totalExpense = sum(txns.filter(t => t.type === 'expense'), 'amount');
    const balance = totalIncome - totalExpense;
    const privateExp = sum(txns.filter(t => t.type === 'expense' && t.scope === 'private'), 'amount');
    const sharedExp  = sum(txns.filter(t => t.type === 'expense' && t.scope === 'shared'),  'amount');

    const topCats = topCategories(txns, totalExpense);

    const recent = [...inScopeTxns]
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
      .filter(t => Fmt.inMonth(t.date, monthKey));

    const wrap = el('div', { class: 'view-dashboard' });

    // Summary cards
    const sCard = (cls, label, value, foot, icon, valClass = '') =>
      el('div', { class: 'summary ' + cls },
        el('div', { class: 's-label' }, label),
        el('div', { class: 's-value ' + valClass }, value),
        foot ? el('div', { class: 's-foot' }, foot) : null,
        el('div', { class: 's-icon', html: icon }),
      );

    const balanceClass = balance > 0 ? 'pos' : (balance < 0 ? 'neg' : 'zero');
    const byGroup = !!(state.settings && state.settings.dashboardByGroup);
    const sIncome  = sCard('income',  t('dashboard.card.income.label'),    Fmt.money(totalIncome),  t('dashboard.card.income.entries',  { n: countTxns(txns, 'income')  }), Icons.arrowDown);
    const sExpense = sCard('expense', t('dashboard.card.expense.label'),   Fmt.money(totalExpense), t('dashboard.card.expense.entries', { n: countTxns(txns, 'expense') }), Icons.arrowUp);
    const sBalance = sCard('balance', t('dashboard.card.balance.label'),   Fmt.money(balance),
      balance > 0 ? t('dashboard.card.balance.pos') : (balance < 0 ? t('dashboard.card.balance.neg') : t('dashboard.card.balance.zero')),
      Icons.piggy, balanceClass);
    const sShared  = sCard('shared',  t('dashboard.card.shared.label'),    `${Fmt.money(sharedExp)} / ${Fmt.money(privateExp)}`, t('dashboard.card.shared.foot'), Icons.globe);

    const summary = el('div', { class: 'summary-grid' }, sIncome, sExpense, sBalance, sShared);
    wrap.appendChild(summary);

    // Donut — given its own full-width row so it has visual room to breathe.
    // ISSUE-007: when the dashboardByGroup toggle is on, the donut
    // segments roll up at the group level rather than per category.
    const donutRows = byGroup
      ? topGroups(txns).map(({ grp, amount }) => ({ cat: { name: grp.name, color: grp.color, icon: grp.icon }, amount }))
      : topCats;
    const donutCard = el('div', { class: 'card donut-card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title', html: Icons.coffee }),
        t('dashboard.donut.title')),
      donutRows.length ? renderDonut(donutRows, totalExpense) : emptyState(t('dashboard.donut.empty.title'), t('dashboard.donut.empty.msg')),
    );
    wrap.appendChild(donutCard);

    // Recent — full width below the donut.
    const recentCard = el('div', { class: 'card recent-list' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title', html: Icons.list }),
        t('dashboard.recent.title'),
        el('button', { class: 'btn btn-ghost btn-sm', onclick: () => goTo('transactions') }, t('dashboard.recent.viewAll'))),
      recent.length
        ? renderTxnTable(recent, { compact: true })
        : emptyState(t('dashboard.recent.empty.title'), t('dashboard.recent.empty.msg')),
    );
    wrap.appendChild(recentCard);

    // Top categories — shared with the Trends view.
    wrap.appendChild(renderTopCategoriesCard(txns, totalExpense));

    return wrap;
  }

  // ---- Shared helpers used by both Dashboard and Trends --------------
  // Top 6 expense categories for a given (already month-scoped) transaction set.
  function topCategories(txns, totalExpense) {
    const expByCat = aggregateBy(txns.filter(t => t.type === 'expense'), 'categoryId');
    return Object.entries(expByCat)
      .map(([k, v]) => ({ cat: state.categories.find(c => c.id === k), amount: v }))
      .filter(x => x.cat)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 6);
  }

  // Top 6 expense groups (ISSUE-007). Aggregates the same transactions
  // by the groupId of each transaction's category. Categories without
  // a groupId collapse into a synthetic "__none__" group rendered with
  // a sand-coloured fallback so the chart stays meaningful.
  function topGroups(txns) {
    const exp = txns.filter(t => t.type === 'expense');
    const byGroup = new Map();
    const cats = state.categories || [];
    const groups = (state.groups || []).sort((a, b) => (a.order || 0) - (b.order || 0));
    const groupById = Object.create(null);
    for (const g of groups) groupById[g.id] = g;
    for (const t of exp) {
      const cat = cats.find(c => c.id === t.categoryId);
      const gid = cat && cat.groupId ? cat.groupId : '__none__';
      byGroup.set(gid, (byGroup.get(gid) || 0) + t.amount);
    }
    const rows = [...byGroup.entries()].map(([gid, amount]) => {
      const grp = groupById[gid] || { id: '__none__', name: t('grp.uncategorized'), color: '#a4926b', icon: '✦' };
      return { grp: { ...grp }, amount };
    });
    return rows.sort((a, b) => b.amount - a.amount).slice(0, 6);
  }

  // The "Top categories this month" card. Reused on both views.
  // ISSUE-007: when settings.dashboardByGroup is true, the card rolls
  // up at the group level instead. The toggle lives in the card head.
  function renderTopCategoriesCard(txns, totalExpense) {
    const byGroup = !!(state.settings && state.settings.dashboardByGroup);
    const onToggle = () => {
      Store.setDashboardByGroup(state, !byGroup);
      renderView();
    };
    const rows = byGroup ? topGroups(txns) : topCategories(txns, totalExpense);
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title', html: Icons.tags }),
        t('dashboard.top.title'),
        el('button', {
          class: 'btn btn-ghost btn-sm' + (byGroup ? ' toggle-on' : ''),
          onclick: onToggle,
          id: 'dashboard-bygroup-toggle',
          title: byGroup ? t('dashboard.byGroup.toggle') : t('dashboard.byGroup.toggle'),
        }, t('dashboard.byGroup.toggle')),
      ),
      rows.length
        ? (byGroup ? renderGroupList(rows, totalExpense) : renderCatList(rows, totalExpense))
        : emptyState(t('dashboard.top.empty.title'), t('dashboard.top.empty.msg')),
    );
  }

  // Grouped version of the category list — same shape, but rows hold
  // a `grp` (group) instead of a `cat`, and the swatch uses the group's
  // colour + icon.
  function renderGroupList(items, total) {
    const list = el('div', { class: 'cat-list' });
    items.forEach(({ grp, amount }) => {
      const pct = Fmt.pct(amount, total);
      const swatch = el('div', { class: 'cat-swatch', style: { background: grp.color } }, grp.icon || '✦');
      const bar = el('div', { class: 'cat-bar' },
        el('div', { class: 'cat-bar-fill', style: { width: pct + '%', background: grp.color } }),
      );
      list.appendChild(el('div', { class: 'cat-row' },
        swatch,
        el('div', { class: 'cat-name' }, grp.name),
        bar,
        el('div', { class: 'cat-amount' }, Fmt.money(amount)),
        el('div', { class: 'cat-pct' }, pct.toFixed(0) + '%'),
      ));
    });
    return list;
  }

  // ---- Trends view (ISSUE-004) ---------------------------------------
  function renderTrends() {
    const inScopeTxns = Selectors.transactionsInScope(state);

    // Top categories reflect the selected month (no separate picker on Trends).
    const monthTxns = inScopeTxns.filter(t => Fmt.inMonth(t.date, monthKey));
    const totalExpense = sum(monthTxns.filter(t => t.type === 'expense'), 'amount');

    const wrap = el('div', { class: 'view-trends' });

    // Balance over time — the centrepiece, with the per-source ↔ net-worth toggle.
    wrap.appendChild(renderBalanceFlow());

    // Top categories — full width.
    wrap.appendChild(renderTopCategoriesCard(monthTxns, totalExpense));

    return wrap;
  }

  function renderCatList(items, total) {
    const list = el('div', { class: 'cat-list' });
    items.forEach(({ cat, amount }) => {
      const pct = Fmt.pct(amount, total);
      const swatch = el('div', { class: 'cat-swatch', style: { background: cat.color } }, cat.icon || '✦');
      const bar = el('div', { class: 'cat-bar' },
        el('div', { class: 'cat-bar-fill', style: { width: pct + '%', background: cat.color } }),
      );
      list.appendChild(el('div', { class: 'cat-row' },
        swatch,
        el('div', { class: 'cat-name' }, cat.name),
        bar,
        el('div', { class: 'cat-amount' }, Fmt.money(amount)),
        el('div', { class: 'cat-pct' }, pct.toFixed(0) + '%'),
      ));
    });
    return list;
  }

  // ===================================================================
  // BALANCE FLOW CHART (ISSUE-002)
  // ===================================================================
  // Per-source step-line chart. The user types their current bank
  // balance for each source once, and we walk the source's transactions
  // backwards from that anchor to draw the line.
  function renderBalanceFlow() {
    const sources = Selectors.sourcesInScope(state);
    if (!sources.length) {
      return el('div', { class: 'card balance-card', id: 'balance-card' },
        el('div', { class: 'card-head' },
          el('div', { class: 'card-title', html: Icons.piggy }),
          t('trends.balance.heading'),
        ),
        el('div', { class: 'balance-empty' },
          t('trends.balance.empty')),
      );
    }

    // chartHost owns both SVGs (monthly flow + balance trajectory).
    const chartHost = el('div', { class: 'chart-wrap', id: 'balance-chart-wrap' });
    chartHost.appendChild(renderMonthlyFlowChart(sources, monthsForRange(trendRange)));
    chartHost.appendChild(renderBalanceTrajectoryChart(sources, monthsForRange(trendRange)));

    return el('div', { class: 'card balance-card', id: 'balance-card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title', html: Icons.piggy }),
        t('trends.balance.heading'),
        el('div', { class: 'card-sub' },
          t('trends.balance.sub')),
        renderViewToggle(),
      ),
      chartHost,
      el('div', { class: 'balance-inputs', id: 'balance-inputs' },
        ...sources.map(src => renderBalanceInput(src, chartHost)),
      ),
    );
  }

  // -- Per-source ↔ Net-worth toggle ---------------------------------
  function renderViewToggle() {
    return el('div', { class: 'view-toggle', id: 'balance-view-toggle' },
      el('button', {
        class: 'vt-pill' + (balanceViewMode === 'sources' ? ' active' : ''),
        'data-mode': 'sources',
        onclick: () => setBalanceViewMode('sources'),
      }, t('trends.toggle.sources')),
      el('button', {
        class: 'vt-pill' + (balanceViewMode === 'networth' ? ' active' : ''),
        'data-mode': 'networth',
        onclick: () => setBalanceViewMode('networth'),
      }, t('trends.toggle.networth')),
    );
  }
  function setBalanceViewMode(mode) {
    if (mode === balanceViewMode) return;
    if (mode !== 'sources' && mode !== 'networth') return;
    balanceViewMode = mode;
    renderView();
  }

  // Resolve the active range ('1y' | '2y' | '3y' | 'all') into a month
  // count. For 'all' we use the oldest in-scope transaction so the
  // chart naturally grows with the user's history. Capped at 240 months
  // (20 years) so the SVG can't blow up.
  function monthsForRange(range) {
    if (range === 'all') {
      const sources = Selectors.sourcesInScope(state);
      const inScope = new Set(sources.map(s => s.id));
      const txns = (state.transactions || []).filter(t => inScope.has(t.sourceId));
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
  function setTrendRange(range) {
    if (!['1y', '2y', '3y', 'all'].includes(range)) return;
    if (range === trendRange) return;
    trendRange = range;
    renderView();
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
          class: 'range-btn' + (trendRange === o.id ? ' active' : ''),
          'data-range': o.id,
        }, o.label);
        btn.addEventListener('click', () => setTrendRange(o.id));
        return btn;
      }),
    );
  }

  // -- Charts (heartbeat + trend) -----------------------------------
  // Two complementary visualizations replace the old step-line chart:
  //   • Heartbeat — daily net-flow bars. Reads as up/down/up/down
  //     rhythm (income vs expense days), the actual "heartbeat".
  //   • Trend — end-of-month balance points joined by a smooth line.
  //     Reads as the trajectory: where balance was N months ago and
  //     where it is now (rightmost = typed current balance).
  const CHART_W = 800;
  const HB_H = 200;
  const TR_H = 160;
  const CHART_M_HB = { top: 14, right: 16, bottom: 28, left: 56 };
  const CHART_M_TR = { top: 14, right: 16, bottom: 28, left: 56 };
  const NW_COLOR = '#3a3a3a'; // charcoal for net-worth trend line
  const POS_COLOR = '#5a7248'; // sage for income
  const NEG_COLOR = '#b85c4a'; // terra for expense

  function renderMonthlyFlowChart(sources, trendMonths) {
    const isNetWorth = balanceViewMode === 'networth';
    const months = Selectors.monthlyNetFlow(state, trendMonths);
    const innerW = CHART_W - CHART_M_HB.left - CHART_M_HB.right;
    const innerH = HB_H - CHART_M_HB.top - CHART_M_HB.bottom;

    const wrap = el('div', { class: 'chart-section' },
      el('div', { class: 'chart-section-head' },
        el('span', { class: 'chart-section-title' },
          t('trends.section.flow.title'),
          el('span', { class: 'chart-section-sub' },
            t('trends.section.flow.sub')),
        ),
        renderRangeButtons(),
      ),
    );

    // Even if no months have data, draw the empty grid so the card
    // doesn't collapse, but show a helpful message.
    const hasAnyActivity = months.some(m => m.income !== 0 || m.expense !== 0);
    if (!hasAnyActivity) {
      wrap.appendChild(el('div', { class: 'balance-empty' },
        t('trends.balance.noActivity')));
      return wrap;
    }

    // X axis is by month slot (12 evenly spaced).
    const N = months.length;
    const colW = innerW / N;

    // Y axis: max abs net across months (centered on 0).
    let maxAbs = 1;
    for (const m of months) maxAbs = Math.max(maxAbs, Math.abs(m.net));
    const yMax = maxAbs;
    const yMin = -maxAbs;

    const xToPx = (i) => CHART_M_HB.left + (i + 0.5) * colW;
    const yToPx = (val) => CHART_M_HB.top + (1 - (val - yMin) / (yMax - yMin)) * innerH;
    const zeroY = yToPx(0);

    const svg = el('svg', {
      class: 'balance-svg monthly-flow-svg',
      viewBox: `0 0 ${CHART_W} ${HB_H}`,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': 'Income vs expenses per month',
    });

    // Zero baseline
    svg.appendChild(el('line', {
      x1: CHART_M_HB.left, x2: CHART_W - CHART_M_HB.right,
      y1: zeroY, y2: zeroY, class: 'bc-zero',
    }));

    // Y ticks: top / 0 / bottom
    for (const v of [yMax, 0, yMin]) {
      svg.appendChild(el('text', {
        x: CHART_M_HB.left - 8, y: yToPx(v) + 4,
        'text-anchor': 'end', class: 'bc-axis',
      }, Fmt.moneyShort(v)));
    }

    // X labels: keep ~6–8 visible ticks regardless of how many months are
    // shown. For >12 months show one tick per quarter; for >36 months
    // show one per half-year so labels don't collide.
    const tickStep = N <= 6 ? 1
                   : N <= 12 ? 2
                   : N <= 24 ? 3
                   : N <= 48 ? 6
                   : 12;
    for (let i = 0; i < N; i += tickStep) {
      const m = months[i];
      svg.appendChild(el('text', {
        x: xToPx(i), y: HB_H - 8,
        'text-anchor': 'middle', class: 'bc-axis',
      }, Fmt.monthLabel(m.month)));
    }

    // Bars. Same in both modes: one bar per month, colour = sign of net
    // (green if net ≥ 0, red if net < 0). Per-source breakdown is shown
    // only on hover so the user reads the rhythm at a glance.
    const BAR_GAP = 4;
    const barWidth = Math.max(8, colW - BAR_GAP);

    months.forEach((m, i) => {
      const cx = xToPx(i);
      const v = m.net;
      const color = v >= 0 ? POS_COLOR : NEG_COLOR;
      if (v >= 0) {
        const top = yToPx(v);
        svg.appendChild(el('rect', {
          x: cx - barWidth / 2, y: top,
          width: barWidth, height: zeroY - top,
          fill: color, class: 'mf-bar',
          'data-month': m.month, 'data-value': v,
        }));
      } else {
        const bottom = yToPx(v);
        svg.appendChild(el('rect', {
          x: cx - barWidth / 2, y: zeroY,
          width: barWidth, height: bottom - zeroY,
          fill: color, class: 'mf-bar',
          'data-month': m.month, 'data-value': v,
        }));
      }
    });

    // Hover overlay + tooltip
    const tooltip = el('div', { class: 'bc-tooltip', id: 'mf-tooltip' });
    svg.appendChild(tooltip);
    const overlay = el('rect', {
      x: CHART_M_HB.left, y: CHART_M_HB.top,
      width: innerW, height: innerH,
      fill: 'transparent', class: 'bc-overlay',
    });
    svg.appendChild(overlay);

    overlay.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const scaleX = rect.width ? rect.width / CHART_W : 1;
      const px = (e.clientX - rect.left) / scaleX;
      const col = Math.max(0, Math.min(N - 1, Math.floor((px - CHART_M_HB.left) / colW)));
      const m = months[col];
      if (!m) { tooltip.style.display = 'none'; return; }
      const sign = m.net >= 0 ? '+' : '\u2212';
      const signClass = m.net >= 0 ? 'hb-pos' : 'hb-neg';
      const verb = m.net >= 0 ? t('trends.tooltip.saved') : t('trends.tooltip.spent');
      const inTxt = t('trends.tooltip.in');
      const outTxt = t('trends.tooltip.out');
      const detail = isNetWorth ? '' :
        Object.entries(m.perSource)
          .filter(([, v]) => v)
          .map(([id, v]) => {
            const src = sources.find(s => s.id === id);
            return `<span class="bc-tt-seg"><span class="bc-tt-dot" style="background:${colorForSource(src)}"></span>${escapeText(src.name)}: ${escapeText(Fmt.money(v))}</span>`;
          }).join('');
      tooltip.innerHTML =
        `<span class="bc-tt-name">${escapeText(Fmt.monthLabel(m.month))}</span>` +
        `<span class="bc-tt-date">${escapeText(Fmt.money(m.income))} ${escapeText(inTxt)} \u00b7 ${escapeText(Fmt.money(m.expense))} ${escapeText(outTxt)}</span>` +
        `<span class="bc-tt-bal ${signClass}">${escapeText(verb)} ${sign}${escapeText(Fmt.money(Math.abs(m.net)))}</span>` +
        (detail ? `<span class="bc-tt-detail">${detail}</span>` : '');
      tooltip.style.display = 'flex';
      tooltip.style.left = (xToPx(col) / CHART_W * 100) + '%';
      tooltip.style.top = '8%';
    });
    overlay.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });

    wrap.appendChild(svg);
    return wrap;
  }

  // (Removed local monthLabel helper — use Fmt.monthLabel for "June 2026".)

  function renderBalanceTrajectoryChart(sources, trendMonths) {
    const isNetWorth = balanceViewMode === 'networth';
    const innerW = CHART_W - CHART_M_TR.left - CHART_M_TR.right;
    const innerH = TR_H - CHART_M_TR.top - CHART_M_TR.bottom;

    const wrap = el('div', { class: 'chart-section' },
      el('div', { class: 'chart-section-head' },
        el('span', { class: 'chart-section-title' },
          isNetWorth ? t('trends.section.traj.title.nw') : t('trends.section.traj.title.src'),
          el('span', { class: 'chart-section-sub' },
            isNetWorth
              ? t('trends.section.traj.sub.nw')
              : t('trends.section.traj.sub.src')),
        ),
        renderRangeButtons(),
      ),
    );

    let series;
    if (isNetWorth) {
      const pts = Selectors.monthlyNetWorth(state, trendMonths);
      if (!pts.length) {
        wrap.appendChild(el('div', { class: 'balance-empty' },
          t('trends.balance.noSources')));
        return wrap;
      }
      series = [{ id: '__networth__', name: t('trends.toggle.networth'), color: NW_COLOR, points: pts, today: pts[pts.length - 1].balance }];
    } else {
      series = sources.map(src => {
        const points = Selectors.monthlyBalance(state, src.id, trendMonths);
        // "Flat" = every historical point equals today's typed balance.
        // That means no transactions on this source in the window — the
        // trajectory line would be a horizontal line sitting exactly on
        // top of the today reference, which is just visual noise. We
        // mark it so the renderer can skip the polyline for that case.
        const flat = points.length > 1
          && points.every(p => p.balance === points[0].balance);
        return {
          id: src.id, name: src.name,
          color: colorForSource(src),
          points, today: Number(src.balance) || 0, flat,
        };
      }).filter(s => s.points.length);
      if (!series.length) {
        wrap.appendChild(el('div', { class: 'balance-empty' },
          t('trends.balance.noTxns12')));
        return wrap;
      }
    }

    // X-axis uses the union of dates across all series so per-source
    // lines share a common axis. Y-axis is the union of balances AND
    // the today reference line, so the user can see whether each
    // line ever went above the value they typed.
    const allDates = new Set();
    for (const s of series) for (const p of s.points) allDates.add(p.date);
    const dates = [...allDates].sort();
    const fromMs = Date.parse(dates[0]);
    const toMs = Date.parse(dates[dates.length - 1]);
    const xSpan = Math.max(toMs - fromMs, 86400000);

    const ys = [];
    for (const s of series) for (const p of s.points) ys.push(p.balance);
    for (const s of series) ys.push(s.today); // include today reference in y-range
    let yMin = Math.min(...ys);
    let yMax = Math.max(...ys);
    if (yMin === yMax) { yMin -= 100; yMax += 100; }
    const yPad = (yMax - yMin) * 0.15;
    yMin -= yPad; yMax += yPad;

    const xToPx = (date) =>
      CHART_M_TR.left + ((Date.parse(date) - fromMs) / xSpan) * innerW;
    const yToPx = (bal) =>
      CHART_M_TR.top + (1 - (bal - yMin) / (yMax - yMin)) * innerH;

    const svg = el('svg', {
      class: 'balance-svg trajectory-svg',
      viewBox: `0 0 ${CHART_W} ${TR_H}`,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': 'Balance trajectory walking back from today',
    });

    // Y grid (5 slices)
    for (let i = 0; i <= 4; i++) {
      const v = yMin + (yMax - yMin) * (i / 4);
      const y = yToPx(v);
      svg.appendChild(el('line', {
        x1: CHART_M_TR.left, x2: CHART_W - CHART_M_TR.right,
        y1: y, y2: y, class: 'bc-grid',
      }));
      svg.appendChild(el('text', {
        x: CHART_M_TR.left - 8, y: y + 4,
        'text-anchor': 'end', class: 'bc-axis',
      }, Fmt.moneyShort(v)));
    }

    // X labels: first / middle / last
    const midIso = new Date((fromMs + toMs) / 2).toISOString().slice(0, 10);
    const xLabels = [
      { date: dates[0], anchor: 'start' },
      { date: midIso,   anchor: 'middle' },
      { date: dates[dates.length - 1], anchor: 'end' },
    ];
    for (const lbl of xLabels) {
      svg.appendChild(el('text', {
        x: xToPx(lbl.date), y: TR_H - 8,
        'text-anchor': lbl.anchor, class: 'bc-axis',
      }, Fmt.date(lbl.date)));
    }

    // "Today" reference line: a dashed horizontal at each series'
    // typed balance. The trajectory line being above it means "you had
    // more money then". The label "today" sits at the right edge.
    // For sources with no transactions (flat series) the reference is
    // drawn solid — it IS the trajectory.
    const todayX = CHART_W - CHART_M_TR.right - 4;
    for (const s of series) {
      const y = yToPx(s.today);
      const isFlat = !!s.flat;
      svg.appendChild(el('line', {
        x1: CHART_M_TR.left, x2: CHART_W - CHART_M_TR.right,
        y1: y, y2: y,
        class: 'bc-ref-today' + (isFlat ? ' bc-ref-flat' : ''),
        stroke: s.color,
        'stroke-dasharray': isFlat ? null : '3 4',
        'data-source': s.id,
      }));
      svg.appendChild(el('text', {
        x: todayX, y: y - 4,
        'text-anchor': 'end', class: 'bc-ref-label',
        fill: s.color,
      }, isFlat ? `${escapeText(s.name)} \u00b7 ${Fmt.moneyShort(s.today)}` : `${t('trends.balance.today')} ${Fmt.moneyShort(s.today)}`));
    }

    // Smooth polylines (straight segments connecting points; the
    // gentle curve is implicit because month-ends are evenly spaced).
    // Skip the polyline for flat series — the reference line above is
    // already the full trajectory for them.
    for (const s of series) {
      if (s.flat) continue;
      const pts = s.points.map(p => [xToPx(p.date), yToPx(p.balance)]);
      if (pts.length === 1) {
        svg.appendChild(el('circle', {
          cx: pts[0][0], cy: pts[0][1], r: 4,
          fill: s.color, class: 'tr-end',
          'data-source': s.id,
        }));
        continue;
      }
      svg.appendChild(el('polyline', {
        class: 'tr-line' + (isNetWorth ? ' tr-nw' : ''),
        stroke: s.color, fill: 'none',
        'stroke-width': isNetWorth ? 2.5 : 1.6,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        'data-source': s.id,
        points: pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '),
      }));
      const last = pts[pts.length - 1];
      svg.appendChild(el('circle', {
        cx: last[0], cy: last[1],
        r: isNetWorth ? 4 : 3,
        fill: s.color, class: 'tr-end',
        'data-source': s.id,
      }));
    }

    // Hover overlay + tooltip
    const tooltip = el('div', { class: 'bc-tooltip', id: 'tr-tooltip' });
    svg.appendChild(tooltip);
    const overlay = el('rect', {
      x: CHART_M_TR.left, y: CHART_M_TR.top,
      width: innerW, height: innerH,
      fill: 'transparent', class: 'bc-overlay',
    });
    svg.appendChild(overlay);

    overlay.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const scaleX = rect.width ? rect.width / CHART_W : 1;
      const px = (e.clientX - rect.left) / scaleX;
      const ms = fromMs + ((px - CHART_M_TR.left) / innerW) * xSpan;
      let best = null, bestDist = Infinity;
      for (const s of series) {
        for (const p of s.points) {
          const d = Math.abs(Date.parse(p.date) - ms);
          if (d < bestDist) { bestDist = d; best = { point: p, source: s }; }
        }
      }
      if (!best) { tooltip.style.display = 'none'; return; }
      tooltip.innerHTML =
        (isNetWorth
          ? `<span class="bc-tt-name">${escapeText(t('trends.toggle.networth'))}</span>`
          : `<span class="bc-tt-dot" style="background:${best.source.color}"></span>` +
            `<span class="bc-tt-name">${escapeText(best.source.name)}</span>`) +
        `<span class="bc-tt-date">${escapeText(Fmt.date(best.point.date))}</span>` +
        `<span class="bc-tt-bal">${escapeText(Fmt.money(best.point.balance))}</span>`;
      tooltip.style.display = 'flex';
      tooltip.style.left = (xToPx(best.point.date) / CHART_W * 100) + '%';
      tooltip.style.top = '8%';
    });
    overlay.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });

    wrap.appendChild(svg);
    return wrap;
  }

  // -- Per-source typed-balance row ----------------------------------
  let _balDebounce = null;
  function renderBalanceInput(src, chartHost) {
    const value = (Number(src.balance) || 0);
    return el('div', { class: 'balance-input-row', 'data-source': src.id },
      el('span', { class: 'balance-input-dot', style: { background: colorForSource(src) } }),
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
    if (!Number.isFinite(value)) return; // ignore garbage
    Store.updateSource(state, sourceId, { balance: value });
    // Re-render just the charts so the trend line picks up the new anchor.
    const sources = Selectors.sourcesInScope(state);
    chartHost.innerHTML = '';
    chartHost.appendChild(renderMonthlyFlowChart(sources, monthsForRange(trendRange)));
    chartHost.appendChild(renderBalanceTrajectoryChart(sources, monthsForRange(trendRange)));
    // Flash the "saved" hint beside the input.
    const saved = $('#saved-' + sourceId);
    if (saved) {
      saved.textContent = t('trends.balance.saved');
      saved.classList.add('show');
      setTimeout(() => {
        if (saved) { saved.textContent = ''; saved.classList.remove('show'); }
      }, 1500);
    }
  }

  // -- Source color picker -------------------------------------------
  const SHARED_PALETTE = ['#7a8b94', '#9a6b8a', '#c2714f', '#a4926b', '#8a6340'];
  function colorForSource(src) {
    if (src.ownerId) {
      const u = state.users.find(x => x.id === src.ownerId);
      if (u && u.color) return u.color;
    }
    // Shared sources: assign by position in the in-scope list so colors
    // stay stable across renders but still distinguish between them.
    const shared = Selectors.sourcesInScope(state).filter(s => s.ownerId == null);
    const idx = shared.findIndex(s => s.id === src.id);
    return SHARED_PALETTE[Math.max(0, idx) % SHARED_PALETTE.length];
  }

  function renderDonut(items, total) {
    const size = 140, cx = size / 2, cy = size / 2, r = 56, sw = 22;
    const C = 2 * Math.PI * r;
    let acc = 0;
    const segs = items.map(({ cat, amount }) => {
      const frac = total ? amount / total : 0;
      const len = frac * C;
      const dash = `${len} ${C - len}`;
      const off = -acc;
      acc += len;
      return { cat, amount, frac, dash, off };
    });
    const svg = `<svg viewBox="0 0 ${size} ${size}" class="donut">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--cream-deep)" stroke-width="${sw}"/>
      ${segs.map(s => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.cat.color}" stroke-width="${sw}" stroke-dasharray="${s.dash}" stroke-dashoffset="${s.off}" transform="rotate(-90 ${cx} ${cy})" stroke-linecap="butt"/>`).join('')}
    </svg>`;

    const wrap = el('div', { class: 'donut-wrap', style: { position: 'relative' } });
    wrap.innerHTML = `<div style="position:relative">${svg}
      <div class="donut-center">
        <div>
          <div class="dc-val">${Fmt.money(total)}</div>
          <div class="dc-lbl">${escapeText(t('dashboard.donut.center.total'))}</div>
        </div>
      </div>
    </div>`;
    const legend = el('div', { class: 'donut-legend' });
    items.forEach(({ cat, amount, frac }) => {
      legend.appendChild(el('div', { class: 'dl-row' },
        el('span', { class: 'dl-dot', style: { background: cat.color } }),
        el('span', { class: 'dl-name' }, cat.name),
        el('span', { class: 'dl-val' }, (frac * 100).toFixed(0) + '%'),
      ));
    });
    wrap.appendChild(legend);
    return wrap;
  }

  // ===================================================================
  // SCREEN: TRANSACTIONS
  // ===================================================================
  function renderTransactions() {
    const wrap = el('div', {});
    wrap.appendChild(renderFilters());
    const list = filteredTxns();
    if (!list.length) {
      wrap.appendChild(emptyState(t('txn.empty.title'), t('txn.empty.msg')));
      return wrap;
    }
    wrap.appendChild(renderTxnTable(list, { compact: false }));
    return wrap;
  }

  function renderFilters() {
    const f = el('div', { class: 'filters' });
    const cats = state.categories;
    const users = state.users;
    const sources = Selectors.sourcesInScope(state);
    const groups = state.groups || [];

    f.appendChild(field(t('filter.month'),
      el('select', { class: 'select', onchange: (e) => { txnFilters.month = e.target.value; renderView(); } },
        option('all', t('filter.month.all')),
        ...availableMonths().map(m => option(m, Fmt.monthLabel(m), txnFilters.month === m)),
      )));

    f.appendChild(field(t('filter.type'),
      el('select', { class: 'select', onchange: (e) => { txnFilters.type = e.target.value; renderView(); } },
        option('all', t('filter.type.all')),
        option('income',  t('filter.type.income'),  txnFilters.type === 'income'),
        option('expense', t('filter.type.expense'), txnFilters.type === 'expense'),
      )));

    f.appendChild(field(t('filter.category'),
      el('select', { class: 'select', onchange: (e) => { txnFilters.categoryId = e.target.value; renderView(); } },
        option('all', t('filter.category.all')),
        ...cats.map(c => option(c.id, c.name, txnFilters.categoryId === c.id)),
      )));

    // ISSUE-007: group filter, sourced from state.groups. Selecting a
    // group filters to transactions whose category's groupId matches;
    // selecting "Geen groep" shows transactions whose category has no
    // groupId (user-added, not yet assigned).
    f.appendChild(field(t('filter.group'),
      el('select', { class: 'select', onchange: (e) => { txnFilters.groupId = e.target.value; renderView(); } },
        option('all', t('filter.group.all')),
        ...groups.map(g => option(g.id, g.name, txnFilters.groupId === g.id)),
        option('__none__', t('filter.group.none')),
      )));

    f.appendChild(field(t('filter.user'),
      el('select', { class: 'select', onchange: (e) => { txnFilters.userId = e.target.value; renderView(); } },
        option('all', t('filter.user.all')),
        ...users.map(u => option(u.id, u.name, txnFilters.userId === u.id)),
      )));

    f.appendChild(field(t('filter.source'),
      el('select', { class: 'select', onchange: (e) => { txnFilters.sourceId = e.target.value; renderView(); } },
        option('all', t('filter.source.all')),
        ...sources.map(s => option(s.id, s.name, txnFilters.sourceId === s.id)),
      )));

    f.appendChild(field(t('filter.scope'),
      el('select', { class: 'select', onchange: (e) => { txnFilters.scope = e.target.value; renderView(); } },
        option('all', t('filter.scope.all')),
        option('private', t('filter.scope.priv'),   txnFilters.scope === 'private'),
        option('shared',  t('filter.scope.shared'), txnFilters.scope === 'shared'),
      )));

    const payees = distinctPayees();
    f.appendChild(field(t('filter.payee'),
      el('select', { class: 'select', onchange: (e) => { txnFilters.payee = e.target.value; renderView(); } },
        option('all', t('filter.payee.all')),
        ...payees.map(p => option(p.name, p.name + (p.noCategory ? ` (${p.noCategory} ✱)` : ''), txnFilters.payee === p.name)),
      )));

    f.appendChild(el('div', { style: { flex: 1 } }));
    f.appendChild(el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { txnFilters = { month: 'all', type: 'all', categoryId: 'all', userId: 'all', sourceId: 'all', scope: 'all', payee: 'all', groupId: 'all' }; renderView(); } }, t('filter.reset')));

    return f;
  }

  function field(label, child) {
    return el('div', { class: 'field' },
      el('label', {}, label),
      child,
    );
  }
  function option(value, label, selected = false) {
    return el('option', { value, selected }, label);
  }
  function availableMonths() {
    // Every year-month that actually has an in-scope transaction, plus the
    // current month (so the picker is usable on a fresh install). Newest first.
    const months = new Set([Fmt.currentMonthKey()]);
    for (const t of Selectors.transactionsInScope(state)) {
      if (t.date) months.add(Fmt.ymKey(t.date));
    }
    return [...months].sort().reverse();
  }
  // Strip the boilerplate off ING Belgium descriptions and return the merchant
  // or counterparty name. The regex set lives in csv.js so it stays next to
  // the rest of the ING-format domain knowledge; aliased here for ergonomics.
  const extractPayee = CSVImport.extractPayee;
  function distinctPayees() {
    const map = new Map();
    for (const t of Selectors.transactionsInScope(state)) {
      const name = extractPayee(t.description) || '—';
      if (!map.has(name)) {
        map.set(name, { name, count: 0, noCategory: 0, lastDate: null, lastCategoryId: null });
      }
      const p = map.get(name);
      p.count++;
      if (!t.categoryId) p.noCategory++;
      if (!p.lastDate || t.date > p.lastDate) {
        p.lastDate = t.date;
        p.lastCategoryId = t.categoryId || null;
      }
    }
    return [...map.values()];
  }
  // Apply the same category to every transaction whose extracted payee
  // matches `name`. Empty string clears the category. Operates only on
  // in-scope transactions so the bulk edit never crosses the scope the
  // user is currently looking at.
  //
  // ISSUE-005: also writes/clears `state.payeeCategories[name]` so that
  // future CSV imports of this payee come in pre-categorised. The mapping
  // is updated even when no in-scope transactions match, so users can
  // pre-seed a mapping for a payee that has no transactions yet.
  function bulkUpdatePayeeCategory(name, categoryId) {
    let count = 0;
    for (const t of Selectors.transactionsInScope(state)) {
      if (extractPayee(t.description) !== name) continue;
      Store.updateTransaction(state, t.id, { categoryId: categoryId });
      count++;
    }
    Store.setPayeeCategory(state, name, categoryId);
    if (count === 0) return;
    toast(t('toast.payeeSet', { n: count }));
    window.dispatchEvent(new Event('store:changed'));
  }

  function filteredTxns() {
    const f = txnFilters;
    // Pre-compute the groupId for each filter-relevant category once so
    // the inner loop is a Set lookup rather than a find() per row.
    const catsById = Object.create(null);
    for (const c of (state.categories || [])) catsById[c.id] = c;
    // Base set respects the active scope; txnFilters apply on top.
    return [...Selectors.transactionsInScope(state)]
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
      .filter(t => {
        if (f.month !== 'all' && !Fmt.inMonth(t.date, f.month)) return false;
        if (f.type !== 'all' && t.type !== f.type) return false;
        if (f.categoryId !== 'all' && t.categoryId !== f.categoryId) return false;
        if (f.userId !== 'all' && t.paidByUserId !== f.userId) return false;
        if (f.sourceId !== 'all' && t.sourceId !== f.sourceId) return false;
        if (f.scope !== 'all' && t.scope !== f.scope) return false;
        if (f.payee !== 'all' && extractPayee(t.description) !== f.payee) return false;
        if (f.groupId !== 'all' && f.groupId !== undefined) {
          const cat = catsById[t.categoryId];
          const catGroupId = cat ? cat.groupId : null;
          if (f.groupId === '__none__') {
            if (catGroupId) return false;
          } else {
            if (catGroupId !== f.groupId) return false;
          }
        }
        return true;
      });
  }

  function renderTxnTable(txns, { compact } = {}) {
    const tbl = el('table', { class: 'txn-table' });
    const thead = el('thead', null,
      el('tr', null,
        el('th', null, t('txn.th.date')),
        el('th', null, t('txn.th.desc')),
        el('th', null, t('txn.th.category')),
        el('th', null, t('txn.th.userSource')),
        el('th', null, t('txn.th.scope')),
        el('th', { class: 'right' }, t('txn.th.amount')),
        el('th', null, t('txn.th.actions')),
      ));
    const tb = el('tbody');
    tbl.appendChild(thead);
    tbl.appendChild(tb);
    txns.forEach(t => tb.appendChild(renderTxnRow(t, compact)));
    return tbl;
  }

  function renderTxnRow(txn, compact) {
    const cat = state.categories.find(c => c.id === txn.categoryId);
    const user = state.users.find(u => u.id === txn.paidByUserId);
    const source = state.sources.find(s => s.id === txn.sourceId);

    const tr = el('tr', {});
    tr.appendChild(el('td', { class: 'txn-date' }, Fmt.date(txn.date)));
    tr.appendChild(el('td', {},
      el('div', { class: 'txn-desc', title: txn.description || '' }, extractPayee(txn.description) || txn.description || (cat ? cat.name : '—')),
      txn.notes ? el('div', { class: 'cell-meta' }, txn.notes) : null,
    ));
    tr.appendChild(el('td', {},
      cat ? el('div', { class: 'cell-cat' },
        el('div', { class: 'cat-swatch', style: { background: cat.color } }, cat.icon || '✦'),
        el('span', {}, cat.name),
      ) : '—',
    ));
    tr.appendChild(el('td', {},
      el('div', { class: 'user-tag' },
        user ? el('span', { class: 'user-dot', style: { background: user.color } }) : null,
        user ? user.name : '—'),
      el('div', { class: 'cell-meta' }, source ? source.name : ''),
    ));
    tr.appendChild(el('td', {},
      el('span', { class: 'chip ' + txn.scope },
        el('span', { class: 'chip-dot' }), t('txn.scope.' + txn.scope)),
    ));
    tr.appendChild(el('td', { class: 'txn-amount ' + (txn.type === 'income' ? 'pos' : 'neg') },
      (txn.type === 'income' ? '+ ' : '− ') + Fmt.money(txn.amount)));
    tr.appendChild(el('td', { class: 'txn-actions' },
      el('div', { class: 'txn-row-actions' },
        el('button', { class: 'btn-icon', title: t('btn.edit'),   onclick: () => window.Modals.transaction(txn.id), html: Icons.edit }),
        el('button', { class: 'btn-icon btn-danger', title: t('btn.delete'), onclick: () => window.Modals.transactionDelete(txn.id), html: Icons.trash }),
      ),
    ));
    return tr;
  }

  // ===================================================================
  // SCREEN: CATEGORIES
  // ===================================================================
  function renderCategories() {
    const wrap = el('div', {});

    // ---- Groepen section (ISSUE-007) -------------------------------
    // Sits above the category lists so users see what grouping layer is
    // available without having to scroll. The card includes a per-group
    // Edit / Delete affordance that opens the group modal.
    const groups = state.groups || [];
    const groupsGrid = el('div', { class: 'entity-grid' });
    groups.forEach(g => groupsGrid.appendChild(renderGroupCard(g)));
    const groupsHead = el('div', { class: 'section-head' },
      el('div', { class: 'section-label' }, t('cat.section.manage')),
    );
    const addGrpBtn = el('button', { class: 'btn btn-sage', onclick: () => window.Modals.group() });
    addGrpBtn.innerHTML = `${Icons.plus} ${escapeText(t('grp.add'))}`;
    groupsHead.appendChild(addGrpBtn);
    const groupsCard = el('div', { class: 'card', style: { marginBottom: '24px' } },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' }, t('grp.section.title')),
        el('div', { class: 'muted', style: { fontSize: '.82rem' } }, t('grp.section.sub'))),
      groups.length ? groupsGrid : emptyState(t('grp.empty.title'), t('grp.empty.msg')),
    );
    wrap.appendChild(groupsHead);
    wrap.appendChild(groupsCard);

    // ---- Categories sections --------------------------------------
    // Expenses get a warm (terracotta) banner and roll up under their
    // group headers — there are many expense categories and a hierarchy
    // helps scanability. Income stays flat: only a handful of categories
    // (typically 1–2) and grouping would add noise without value.
    const expenses = state.categories.filter(c => c.type === 'expense');
    const incomes  = state.categories.filter(c => c.type === 'income');
    wrap.appendChild(renderExpenseSection(expenses));
    wrap.appendChild(renderIncomeSection(incomes));

    // Add-category button (kept below the lists for now)
    const addBtn = el('button', { class: 'btn btn-sage', onclick: () => window.Modals.category(), style: { marginTop: '16px' } });
    addBtn.innerHTML = `${Icons.plus} ${escapeText(t('cat.add'))}`;
    wrap.appendChild(addBtn);

    return wrap;
  }

  // ---- Expense categories: grouped by groupId under a warm banner --
  // Categories without a groupId land in an "Overige categorieën" bucket.
  function renderExpenseSection(cats) {
    const byGroup = new Map();
    for (const c of cats) {
      const key = c.groupId || '__none__';
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(c);
    }
    const groups = state.groups || [];
    const sortedGroups = [...groups].sort((a, b) => (a.order || 0) - (b.order || 0));
    const activeCount = cats.filter(c => c.active).length;

    const content = el('div', {});
    for (const g of sortedGroups) {
      const list = byGroup.get(g.id) || [];
      if (!list.length) continue; // skip groups with no expense categories in this section
      content.appendChild(renderExpenseGroupHead(g, list.length));
      const grid = el('div', { class: 'entity-grid' });
      list.forEach(c => grid.appendChild(renderCategoryCard(c)));
      content.appendChild(grid);
    }
    const ungrouped = byGroup.get('__none__') || [];
    if (ungrouped.length) {
      content.appendChild(renderExpenseGroupHead(null, ungrouped.length));
      const grid = el('div', { class: 'entity-grid' });
      ungrouped.forEach(c => grid.appendChild(renderCategoryCard(c)));
      content.appendChild(grid);
    }

    return el('div', { class: 'card cat-section cat-section--expense' },
      el('div', { class: 'cat-section-banner is-expense' },
        el('div', { class: 'cat-section-icon is-expense' }, '↑'),
        el('div', { style: { flex: '1', minWidth: '0' } },
          el('div', { class: 'cat-section-title' }, t('cat.section.expense.title')),
          el('div', { class: 'cat-section-sub muted' }, `${cats.length} ${t('cat.total')} · ${activeCount} ${t('cat.active')}`),
        ),
      ),
      cats.length ? content : emptyState(t('cat.section.expense.empty.title'), t('cat.section.expense.empty.msg')),
    );
  }

  // ---- Income categories: flat, no grouping, sage banner ----------
  function renderIncomeSection(cats) {
    const activeCount = cats.filter(c => c.active).length;
    const grid = el('div', { class: 'entity-grid' });
    cats.forEach(c => grid.appendChild(renderCategoryCard(c)));

    return el('div', { class: 'card cat-section cat-section--income' },
      el('div', { class: 'cat-section-banner is-income' },
        el('div', { class: 'cat-section-icon is-income' }, '↓'),
        el('div', { style: { flex: '1', minWidth: '0' } },
          el('div', { class: 'cat-section-title' }, t('cat.section.income.title')),
          el('div', { class: 'cat-section-sub muted' }, `${cats.length} ${t('cat.total')} · ${activeCount} ${t('cat.active')}`),
        ),
      ),
      cats.length ? grid : emptyState(t('cat.section.income.empty.title'), t('cat.section.income.empty.msg')),
    );
  }

  // A single group header inside the expense section. Tinted with the
  // group's color so it scans as a distinct band under the section banner.
  function renderExpenseGroupHead(g, count) {
    const head = el('div', { class: 'cat-group-head' });
    if (g) {
      head.appendChild(el('span', { class: 'cat-group-icon', style: { background: g.color } }, g.icon || '✦'));
      head.appendChild(el('span', { class: 'cat-group-name' }, g.name));
      head.dataset.groupId = g.id;
      head.style.borderLeftColor = g.color;
    } else {
      head.appendChild(el('span', { class: 'cat-group-icon cat-group-icon-none' }, '✦'));
      head.appendChild(el('span', { class: 'cat-group-name' }, t('grp.uncategorized')));
    }
    head.appendChild(el('span', { class: 'cat-group-count' }, String(count)));
    return head;
  }

  function renderCategoryCard(c) {
    return el('div', { class: 'entity' + (c.active ? '' : ' inactive'), style: { '--cat-color': c.color } },
      el('div', { class: 'cat-swatch', style: { background: c.color } }, c.icon || '✦'),
      el('div', { style: { flex: 1, minWidth: 0 } },
        el('div', { class: 'e-name', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, c.name),
        el('div', { class: 'e-meta' }, c.active ? c.type : t('cat.inactive')),
      ),
      el('div', { class: 'e-actions' },
        el('button', { class: 'btn-icon', title: t('btn.edit'),   onclick: () => window.Modals.category(c.id), html: Icons.edit }),
        el('button', { class: 'btn-icon btn-danger', title: t('btn.delete'), onclick: () => window.Modals.categoryDelete(c.id), html: Icons.trash }),
      ),
    );
  }

  // ---- Group card (ISSUE-007) -------------------------------------
  // Renders a single group in the Groepen grid. Shows the group's icon,
  // name, color swatch, and an Edit / Delete affordance.
  function renderGroupCard(g) {
    return el('div', { class: 'entity' },
      el('div', { class: 'cat-swatch', style: { background: g.color } }, g.icon || '✦'),
      el('div', { style: { flex: 1, minWidth: 0 } },
        el('div', { class: 'e-name', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, g.name),
        el('div', { class: 'e-meta' }, `${g.icon || '✦'} · ${t('grp.section.title')}`),
      ),
      el('div', { class: 'e-actions' },
        el('button', { class: 'btn-icon', title: t('btn.edit'),   onclick: () => window.Modals.group(g.id), html: Icons.edit }),
        el('button', { class: 'btn-icon btn-danger', title: t('btn.delete'), onclick: () => window.Modals.groupDelete(g.id), html: Icons.trash }),
      ),
    );
  }

  // ===================================================================
  // SCREEN: SOURCES
  // ===================================================================
  function renderSources() {
    const wrap = el('div', {});
    const head = el('div', { class: 'section-head' },
      el('div', { class: 'section-label' }, t('src.section.manage')),
    );
    const addBtn = el('button', { class: 'btn btn-sage', onclick: () => window.Modals.source() });
    addBtn.innerHTML = `${Icons.plus} ${escapeText(t('src.add'))}`;
    head.appendChild(addBtn);
    wrap.appendChild(head);

    const grid = el('div', { class: 'entity-grid' });
    state.sources.forEach(s => grid.appendChild(renderSourceCard(s)));
    wrap.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' }, t('src.card.title')),
        el('div', { class: 'muted', style: { fontSize: '.82rem' } }, `${state.sources.filter(s => s.active).length} ${t('cat.active')}`)),
      state.sources.length ? grid : emptyState(t('src.empty.title'), t('src.empty.msg')),
    ));
    return wrap;
  }
  function renderSourceCard(s) {
    const owner = s.ownerId ? state.users.find(u => u.id === s.ownerId) : null;
    const sharedTxt = s.ownerId ? '' : t('src.meta.shared');
    return el('div', { class: 'entity' + (s.active ? '' : ' inactive') },
      el('div', { class: 'cat-swatch', style: { background: 'var(--beige)', color: 'var(--wood-dark)' }, html: Icons.wallet }),
      el('div', { style: { flex: 1, minWidth: 0 } },
        el('div', { class: 'e-name', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, s.name),
        el('div', { class: 'e-meta' }, `${s.type}${owner ? ' · ' + owner.name : (sharedTxt ? ' · ' + sharedTxt : '')}${s.active ? '' : ' · ' + t('cat.inactive')}`),
      ),
      el('div', { class: 'e-actions' },
        el('button', { class: 'btn-icon', title: t('btn.edit'),   onclick: () => window.Modals.source(s.id), html: Icons.edit }),
        el('button', { class: 'btn-icon btn-danger', title: t('btn.delete'), onclick: () => window.Modals.sourceDelete(s.id), html: Icons.trash }),
      ),
    );
  }

  // ===================================================================
  // SCREEN: USERS
  // ===================================================================
  function renderUsers() {
    const wrap = el('div', {});
    const head = el('div', { class: 'section-head' },
      el('div', { class: 'section-label' }, t('usr.section.manage')),
    );
    const addBtn = el('button', { class: 'btn btn-sage', onclick: () => window.Modals.user() });
    addBtn.innerHTML = `${Icons.plus} ${escapeText(t('usr.add'))}`;
    head.appendChild(addBtn);
    wrap.appendChild(head);

    const grid = el('div', { class: 'entity-grid' });
    state.users.forEach(u => grid.appendChild(renderUserCard(u)));
    wrap.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' }, t('usr.card.title')),
        el('div', { class: 'muted', style: { fontSize: '.82rem' } }, `${state.users.filter(u => u.active).length} ${t('cat.active')}`)),
      state.users.length ? grid : emptyState(t('usr.empty.title'), t('usr.empty.msg')),
    ));
    return wrap;
  }
  function renderPayees() {
    const payees = distinctPayees();
    const needsCount = payees.filter(p => p.noCategory > 0).length;
    const wrap = el('div', {});

    // Summary header
    const summary = el('div', { class: 'summary-grid' },
      el('div', { class: 'summary income' },
        el('div', { class: 's-label' }, t('payee.card.distinct')),
        el('div', { class: 's-value' }, String(payees.length)),
        el('div', { class: 's-foot' }, t('payee.card.distinct.foot')),
        el('div', { class: 's-icon', html: Icons.store }),
      ),
      el('div', { class: 'summary ' + (needsCount > 0 ? 'expense' : 'income') },
        el('div', { class: 's-label' }, t('payee.card.needs')),
        el('div', { class: 's-value' }, String(needsCount)),
        el('div', { class: 's-foot' }, needsCount > 0 ? t('payee.card.needs.foot.has') : t('payee.card.needs.foot.none')),
        el('div', { class: 's-icon', html: Icons.tags }),
      ),
    );
    wrap.appendChild(summary);

    if (payees.length === 0) {
      wrap.appendChild(emptyState(t('payee.empty.title'), t('payee.empty.msg')));
      return wrap;
    }

    // Sort: needs-cat first, then by count desc
    payees.sort((a, b) => (b.noCategory - a.noCategory) || (b.count - a.count) || a.name.localeCompare(b.name));

    const tbl = el('table', { class: 'txn-table' });
    tbl.innerHTML = `
      <thead><tr>
        <th>${escapeText(t('payee.th.payee'))}</th>
        <th class="right">${escapeText(t('payee.th.count'))}</th>
        <th class="right">${escapeText(t('payee.th.needCat'))}</th>
        <th>${escapeText(t('payee.th.lastCat'))}</th>
        <th>${escapeText(t('payee.th.lastSeen'))}</th>
        <th>${escapeText(t('payee.th.bulk'))}</th>
      </tr></thead>
      <tbody></tbody>`;
    const tb = tbl.querySelector('tbody');
    // Group categories by type for nicer optgroups
    const catsByType = { expense: [], income: [] };
    for (const c of state.categories) {
      if (catsByType[c.type]) catsByType[c.type].push(c);
    }
    for (const p of payees) {
      const lastCat = p.lastCategoryId ? state.categories.find(c => c.id === p.lastCategoryId) : null;
      const tr = el('tr', { class: 'clickable', onclick: (e) => {
        if (e.target.closest('select, button, input')) return; // don't navigate when interacting with the select
        txnFilters.payee = p.name; goTo('transactions');
      } });
      tr.appendChild(el('td', { title: p.name }, p.name));
      tr.appendChild(el('td', { class: 'right tabnum' }, String(p.count)));
      tr.appendChild(el('td', { class: 'right tabnum' + (p.noCategory > 0 ? ' text-neg' : '') }, p.noCategory > 0 ? String(p.noCategory) : '—'));
      tr.appendChild(el('td', {},
        lastCat ? el('div', { class: 'cell-cat' },
          el('div', { class: 'cat-swatch', style: { background: lastCat.color } }, lastCat.icon || '✦'),
          el('span', {}, lastCat.name),
        ) : '—',
      ));
      tr.appendChild(el('td', { class: 'muted' }, p.lastDate ? Fmt.date(p.lastDate) : '—'));
      // Category bulk-assign dropdown
      const select = el('select', {
        class: 'select',
        title: t('applyAll.template', { n: p.count, name: p.name }),
        onchange: (e) => {
          const newCat = e.target.value;
          bulkUpdatePayeeCategory(p.name, newCat);
        },
      },
        option('', t('payee.bulk.pick'), !lastCat),
        catsByType.expense.length ? el('optgroup', { label: t('payee.opt.expense') }, ...catsByType.expense.map(c => option(c.id, c.name, lastCat && lastCat.id === c.id))) : null,
        catsByType.income.length ? el('optgroup', { label: t('payee.opt.income') }, ...catsByType.income.map(c => option(c.id, c.name, lastCat && lastCat.id === c.id))) : null,
      );
      tr.appendChild(el('td', {}, select));
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
    wrap.appendChild(tbl);

    return wrap;
  }
  function renderUserCard(u) {
    return el('div', { class: 'entity' + (u.active ? '' : ' inactive') },
      el('div', { class: 'cat-swatch', style: { background: u.color }, html: Icons.user }),
      el('div', { style: { flex: 1, minWidth: 0 } },
        el('div', { class: 'e-name', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, u.name),
        el('div', { class: 'e-meta' }, u.active ? t('cat.active') : t('cat.inactive')),
      ),
      el('div', { class: 'e-actions' },
        el('button', { class: 'btn-icon', title: t('btn.edit'),   onclick: () => window.Modals.user(u.id), html: Icons.edit }),
        el('button', { class: 'btn-icon btn-danger', title: t('btn.delete'), onclick: () => window.Modals.userDelete(u.id), html: Icons.trash }),
      ),
    );
  }

  // ===================================================================
  // SCREEN: SETTINGS (ISSUE-006 — backup / restore)
  // ===================================================================
  function renderSettings() {
    const wrap = el('div', { class: 'view-settings' });

    // Hidden file input is mounted on document.body so the click→file
    // picker flow works regardless of where the visible button sits.
    const fileInput = el('input', {
      type: 'file', accept: 'application/json,.json',
      class: 'sr-only-file',
      onchange: (e) => onImportFileSelected(e.target.files && e.target.files[0]),
    });

    const card = el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' },
          el('span', { html: Icons.settings }),
          ' ' + t('settings.backup.title')),
        el('div', { class: 'muted', style: { fontSize: '.82rem' } },
          t('settings.backup.sub')),
      ),
      el('div', { class: 'settings-actions' },
        el('div', { class: 'settings-row' },
          el('div', {},
            el('div', { class: 'settings-row-title' }, t('settings.export.json')),
            el('div', { class: 'hint' }, t('settings.export.json.hint')),
          ),
          el('button', { class: 'btn btn-primary', onclick: () => Backup.exportJSON(state), id: 'export-json-btn' },
            el('span', { html: Icons.download }), ' ' + t('settings.btn.exportJson')),
        ),
        el('div', { class: 'settings-row' },
          el('div', {},
            el('div', { class: 'settings-row-title' }, t('settings.export.csv')),
            el('div', { class: 'hint' }, t('settings.export.csv.hint')),
          ),
          el('button', { class: 'btn btn-sage', onclick: () => Backup.exportCSV(state), id: 'export-csv-btn' },
            el('span', { html: Icons.download }), ' ' + t('settings.btn.exportCsv')),
        ),
        el('div', { class: 'settings-row' },
          el('div', {},
            el('div', { class: 'settings-row-title' }, t('settings.import.json')),
            el('div', { class: 'hint' }, t('settings.import.json.hint')),
          ),
          el('button', { class: 'btn btn-ghost', onclick: () => fileInput.click(), id: 'import-json-btn' },
            el('span', { html: Icons.upload }), ' ' + t('settings.btn.importJson')),
        ),
        fileInput,
      ),
    );
    wrap.appendChild(card);
    return wrap;
  }

  // File picker → FileReader → parseAndValidate → dry-run modal.
  async function onImportFileSelected(file) {
    if (!file) return;
    const text = await Backup.readFileText(file);
    const result = Backup.parseAndValidate(text);
    if (!result.ok) {
      toast(result.error);
      return;
    }
    window.Modals.importConfirm(result.data);
  }

  // ===================================================================
  // HELPERS
  // ===================================================================
  function sum(arr, key) { return arr.reduce((acc, x) => acc + (Number(x[key]) || 0), 0); }
  function countTxns(arr, type) { return arr.filter(t => t.type === type).length; }
  function aggregateBy(arr, key) {
    return arr.reduce((acc, x) => { acc[x[key]] = (acc[x[key]] || 0) + x.amount; return acc; }, {});
  }
  function emptyState(title, msg) {
    return el('div', { class: 'empty' },
      el('div', { class: 'empty-ill', html: Deco.emptyHero }),
      el('h3', {}, title),
      el('p', {}, msg),
    );
  }
  function escapeAttr(s) { return String(s ?? '').replace(/"/g, '&quot;'); }
  function escapeText(s) { return String(s ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  return { init, get _state() { return state; }, bulkUpdatePayeeCategory };
})();
window.App = App;
