// =====================================================================
// app.js — App state, router, screens, modals
// =====================================================================

const App = (() => {
  // ---- State --------------------------------------------------------
  let state = Store.load();
  let view = 'dashboard';           // current route
  let monthKey = Fmt.currentMonthKey(); // for month-scoped screens
  let txnFilters = { month: 'all', type: 'all', categoryId: 'all', userId: 'all', sourceId: 'all', scope: 'all', payee: 'all' };
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
          el('div', { class: 'brand-name' }, 'Cozy Ledger'),
          el('div', { class: 'brand-sub' }, 'Our household notebook'),
        ),
      ),
      el('nav', { class: 'nav' },
        el('div', { class: 'nav-label' }, 'Overview'),
        navItem('dashboard',   'Dashboard',     Icons.home),
        navItem('trends',      'Trends',        Icons.trend),
        navItem('transactions','Transactions',  Icons.list, txCount),
        el('div', { class: 'nav-label' }, 'Manage'),
        navItem('categories',  'Categories',    Icons.tags, state.categories.length),
        navItem('sources',     'Sources',       Icons.wallet, state.sources.length),
        navItem('users',       'Users',         Icons.users, state.users.length),
        navItem('payees',      'Payees',        Icons.store, distinctPayees().filter(p => p.noCategory > 0).length || null),
      ),
      el('div', { class: 'sidebar-foot' },
        el('strong', {}, 'Phase 1'),
        'Manual tracking. Phase 2 will add recurring items, budgets, CSV import/export and a monthly PDF report.'),
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
        el('button', { class: 'btn btn-ghost', onclick: openImportModal, id: 'import-btn', title: 'Import ING Belgium CSV' },
          el('span', { html: Icons.upload }), 'Import'),
        el('button', { class: 'btn btn-primary', onclick: openAddTransaction, id: 'add-txn-btn' },
          el('span', { html: Icons.plus }), 'Add transaction'),
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
      { id: 'private', label: 'Private' },
      { id: 'shared',  label: 'Shared' },
      { id: 'all',     label: 'All' },
    ];
    for (const o of opts) {
      const active = current === o.id;
      host.appendChild(el('button', {
        class: 'scope-pill' + (active ? ' active' : ''),
        'data-scope': o.id,
        title: scopeTitle(o.id),
        onclick: () => setScope(o.id),
      }, o.label));
    }
  }

  function scopeTitle(id) {
    if (id === 'private') return 'Your own accounts only';
    if (id === 'shared')  return 'Household / shared accounts only';
    return 'Every account';
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
      dashboard:    ['Cozy <em>overview</em>',     'Where the money went this month.'],
      trends:       ['Money <em>trends</em>',       'Multi-month view: balance, income vs expenses, top categories.'],
      transactions: ['All <em>transactions</em>',  'Filter, search, edit and review everything.'],
      categories:   ['<em>Categories</em>',        'Give every euro a clear home.'],
      sources:      ['Sources & <em>wallets</em>', 'Bank accounts, cash and savings.'],
      users:        ['<em>Users</em>',             'The people sharing this notebook.'],
      payees:       ['<em>Payees</em>',            'Everyone you have paid — sort by what still needs a category.'],
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
    at.style.display = (view === 'categories' || view === 'sources' || view === 'users') ? 'none' : 'inline-flex';

    if (view === 'dashboard') view_.appendChild(renderDashboard());
    else if (view === 'trends') view_.appendChild(renderTrends());
    else if (view === 'transactions') view_.appendChild(renderTransactions());
    else if (view === 'categories') view_.appendChild(renderCategories());
    else if (view === 'sources') view_.appendChild(renderSources());
    else if (view === 'users') view_.appendChild(renderUsers());
    else if (view === 'payees') view_.appendChild(renderPayees());
  }

  // ---- Month picker -------------------------------------------------
  function renderMonthPicker(host) {
    host.innerHTML = '';
    const label = Fmt.monthLabel(monthKey);
    host.appendChild(el('button', { title: 'Previous month', onclick: () => { monthKey = Fmt.shiftMonth(monthKey, -1); renderView(); }, html: Icons.chevLeft }));
    host.appendChild(el('div', { class: 'mp-label' }, label));
    host.appendChild(el('button', { title: 'Next month', onclick: () => { monthKey = Fmt.shiftMonth(monthKey, 1); renderView(); }, html: Icons.chevRight }));
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
    const sIncome  = sCard('income',  'Income',     Fmt.money(totalIncome),  `${countTxns(txns, 'income')} entries`, Icons.arrowDown);
    const sExpense = sCard('expense', 'Expenses',   Fmt.money(totalExpense), `${countTxns(txns, 'expense')} entries`, Icons.arrowUp);
    const sBalance = sCard('balance', 'Balance',    Fmt.money(balance),      balance > 0 ? 'You saved this month' : (balance < 0 ? 'You spent more than earned' : 'Break even this month'), Icons.piggy, balanceClass);
    const sShared  = sCard('shared',  'Shared / Private', `${Fmt.money(sharedExp)} / ${Fmt.money(privateExp)}`, 'Shared vs private expenses', Icons.globe);

    const summary = el('div', { class: 'summary-grid' }, sIncome, sExpense, sBalance, sShared);
    wrap.appendChild(summary);

    // Donut — given its own full-width row so it has visual room to breathe.
    const donutCard = el('div', { class: 'card donut-card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title', html: Icons.coffee }),
        'Spending share'),
      topCats.length ? renderDonut(topCats, totalExpense) : emptyState('Nothing to plot yet', 'Log a few expenses to see the picture.'),
    );
    wrap.appendChild(donutCard);

    // Recent — full width below the donut.
    const recentCard = el('div', { class: 'card recent-list' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title', html: Icons.list }),
        'Recent transactions',
        el('button', { class: 'btn btn-ghost btn-sm', onclick: () => goTo('transactions') }, 'View all →')),
      recent.length
        ? renderTxnTable(recent, { compact: true })
        : emptyState('No transactions this month', 'Tap the + button to add your first one.'),
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

  // The "Top categories this month" card. Reused on both views.
  function renderTopCategoriesCard(txns, totalExpense) {
    const topCats = topCategories(txns, totalExpense);
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title', html: Icons.tags }),
        'Top categories this month'),
      topCats.length
        ? renderCatList(topCats, totalExpense)
        : emptyState('No expenses yet', 'Once you log one, it shows up here.'),
    );
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
          'Balance over time',
        ),
        el('div', { class: 'balance-empty' },
          'No sources in the current scope. Switch scope or add a source to begin.'),
      );
    }

    // chartHost owns both SVGs (monthly flow + balance trajectory).
    const chartHost = el('div', { class: 'chart-wrap', id: 'balance-chart-wrap' });
    chartHost.appendChild(renderMonthlyFlowChart(sources, monthsForRange(trendRange)));
    chartHost.appendChild(renderBalanceTrajectoryChart(sources, monthsForRange(trendRange)));

    return el('div', { class: 'card balance-card', id: 'balance-card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title', html: Icons.piggy }),
        'Balance over time',
        el('div', { class: 'card-sub' },
          'Type your current bank balance for each account. History walks backwards from there.'),
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
      }, 'Per source'),
      el('button', {
        class: 'vt-pill' + (balanceViewMode === 'networth' ? ' active' : ''),
        'data-mode': 'networth',
        onclick: () => setBalanceViewMode('networth'),
      }, 'Net worth'),
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
      { id: '1y',  label: '1 year' },
      { id: '2y',  label: '2 years' },
      { id: '3y',  label: '3 years' },
      { id: 'all', label: 'All' },
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
          'Income vs expenses by month',
          el('span', { class: 'chart-section-sub' },
            'green = saved that month, red = spent more than earned'),
        ),
        renderRangeButtons(),
      ),
    );

    // Even if no months have data, draw the empty grid so the card
    // doesn't collapse, but show a helpful message.
    const hasAnyActivity = months.some(m => m.income !== 0 || m.expense !== 0);
    if (!hasAnyActivity) {
      wrap.appendChild(el('div', { class: 'balance-empty' },
        'No transactions yet. Once you log a few, you’ll see which months saved (green) vs spent (red).'));
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
      const verb = m.net >= 0 ? 'saved' : 'spent';
      const detail = isNetWorth ? '' :
        Object.entries(m.perSource)
          .filter(([, v]) => v)
          .map(([id, v]) => {
            const src = sources.find(s => s.id === id);
            return `<span class="bc-tt-seg"><span class="bc-tt-dot" style="background:${colorForSource(src)}"></span>${escapeText(src.name)}: ${escapeText(Fmt.money(v))}</span>`;
          }).join('');
      tooltip.innerHTML =
        `<span class="bc-tt-name">${escapeText(Fmt.monthLabel(m.month))}</span>` +
        `<span class="bc-tt-date">${escapeText(Fmt.money(m.income))} in \u00b7 ${escapeText(Fmt.money(m.expense))} out</span>` +
        `<span class="bc-tt-bal ${signClass}">${verb} ${sign}${escapeText(Fmt.money(Math.abs(m.net)))}</span>` +
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
          isNetWorth ? 'Net worth trajectory' : 'Balance trajectory per source',
          el('span', { class: 'chart-section-sub' },
            isNetWorth
              ? 'walks back from the total of your typed balances \u2014 see if you had more in the past'
              : 'walks back from each source\u2019s typed balance \u2014 line above today\u2019s value = had more'),
        ),
        renderRangeButtons(),
      ),
    );

    let series;
    if (isNetWorth) {
      const pts = Selectors.monthlyNetWorth(state, trendMonths);
      if (!pts.length) {
        wrap.appendChild(el('div', { class: 'balance-empty' },
          'No sources to chart. Add or enable a source to see your balance trajectory.'));
        return wrap;
      }
      series = [{ id: '__networth__', name: 'Net worth', color: NW_COLOR, points: pts, today: pts[pts.length - 1].balance }];
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
          'No transactions in the last 12 months. Log some to see your balance trajectory.'));
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
      }, Fmt.date(lbl.date, { short: true })));
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
      }, isFlat ? `${escapeText(s.name)} \u00b7 ${Fmt.moneyShort(s.today)}` : `today ${Fmt.moneyShort(s.today)}`));
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
          ? `<span class="bc-tt-name">Net worth</span>`
          : `<span class="bc-tt-dot" style="background:${best.source.color}"></span>` +
            `<span class="bc-tt-name">${escapeText(best.source.name)}</span>`) +
        `<span class="bc-tt-date">${escapeText(Fmt.date(best.point.date, { short: true }))}</span>` +
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
      saved.textContent = '✓ saved';
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
          <div class="dc-lbl">Total</div>
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
      wrap.appendChild(emptyState('Nothing matches your filters', 'Try clearing some or adding a new transaction.'));
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

    f.appendChild(field('Month',
      el('select', { class: 'select', onchange: (e) => { txnFilters.month = e.target.value; renderView(); } },
        option('all', 'All months'),
        ...availableMonths().map(m => option(m, Fmt.monthLabel(m), txnFilters.month === m)),
      )));

    f.appendChild(field('Type',
      el('select', { class: 'select', onchange: (e) => { txnFilters.type = e.target.value; renderView(); } },
        option('all', 'All types'),
        option('income', 'Income', txnFilters.type === 'income'),
        option('expense', 'Expense', txnFilters.type === 'expense'),
      )));

    f.appendChild(field('Category',
      el('select', { class: 'select', onchange: (e) => { txnFilters.categoryId = e.target.value; renderView(); } },
        option('all', 'All categories'),
        ...cats.map(c => option(c.id, c.name, txnFilters.categoryId === c.id)),
      )));

    f.appendChild(field('User',
      el('select', { class: 'select', onchange: (e) => { txnFilters.userId = e.target.value; renderView(); } },
        option('all', 'All users'),
        ...users.map(u => option(u.id, u.name, txnFilters.userId === u.id)),
      )));

    f.appendChild(field('Source',
      el('select', { class: 'select', onchange: (e) => { txnFilters.sourceId = e.target.value; renderView(); } },
        option('all', 'All sources'),
        ...sources.map(s => option(s.id, s.name, txnFilters.sourceId === s.id)),
      )));

    f.appendChild(field('Scope',
      el('select', { class: 'select', onchange: (e) => { txnFilters.scope = e.target.value; renderView(); } },
        option('all', 'All scopes'),
        option('private', 'Private', txnFilters.scope === 'private'),
        option('shared', 'Shared', txnFilters.scope === 'shared'),
      )));

    const payees = distinctPayees();
    f.appendChild(field('Payee',
      el('select', { class: 'select', onchange: (e) => { txnFilters.payee = e.target.value; renderView(); } },
        option('all', 'All payees'),
        ...payees.map(p => option(p.name, p.name + (p.noCategory ? ` (${p.noCategory} ✱)` : ''), txnFilters.payee === p.name)),
      )));

    f.appendChild(el('div', { style: { flex: 1 } }));
    f.appendChild(el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { txnFilters = { month: 'all', type: 'all', categoryId: 'all', userId: 'all', sourceId: 'all', scope: 'all', payee: 'all' }; renderView(); } }, 'Reset'));

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
  function bulkUpdatePayeeCategory(name, categoryId) {
    let count = 0;
    for (const t of Selectors.transactionsInScope(state)) {
      if (extractPayee(t.description) !== name) continue;
      Store.updateTransaction(state, t.id, { categoryId: categoryId });
      count++;
    }
    if (count === 0) return;
    const label = categoryId ? (state.categories.find(c => c.id === categoryId)?.name || 'category') : 'no category';
    toast(`Set "${name}" → ${label} on ${count} transaction${count === 1 ? '' : 's'}`);
    window.dispatchEvent(new Event('store:changed'));
  }

  function filteredTxns() {
    const f = txnFilters;
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
        return true;
      });
  }

  function renderTxnTable(txns, { compact } = {}) {
    const tbl = el('table', { class: 'txn-table' });
    const thead = el('thead', null,
      el('tr', null,
        el('th', null, 'Date'),
        el('th', null, 'Description'),
        el('th', null, 'Category'),
        el('th', null, 'User / Source'),
        el('th', null, 'Scope'),
        el('th', { class: 'right' }, 'Amount'),
        el('th', null, ''),
      ));
    const tb = el('tbody');
    tbl.appendChild(thead);
    tbl.appendChild(tb);
    txns.forEach(t => tb.appendChild(renderTxnRow(t, compact)));
    return tbl;
  }

  function renderTxnRow(t, compact) {
    const cat = state.categories.find(c => c.id === t.categoryId);
    const user = state.users.find(u => u.id === t.paidByUserId);
    const source = state.sources.find(s => s.id === t.sourceId);

    const tr = el('tr', {});
    tr.appendChild(el('td', { class: 'txn-date' }, Fmt.date(t.date, { short: !compact })));
    tr.appendChild(el('td', {},
      el('div', { class: 'txn-desc', title: t.description || '' }, extractPayee(t.description) || t.description || (cat ? cat.name : '—')),
      t.notes ? el('div', { class: 'cell-meta' }, t.notes) : null,
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
      el('span', { class: 'chip ' + t.scope },
        el('span', { class: 'chip-dot' }), t.scope[0].toUpperCase() + t.scope.slice(1)),
    ));
    tr.appendChild(el('td', { class: 'txn-amount ' + (t.type === 'income' ? 'pos' : 'neg') },
      (t.type === 'income' ? '+ ' : '− ') + Fmt.money(t.amount)));
    tr.appendChild(el('td', { class: 'txn-actions' },
      el('div', { class: 'txn-row-actions' },
        el('button', { class: 'btn-icon', title: 'Edit', onclick: () => openEditTransaction(t.id), html: Icons.edit }),
        el('button', { class: 'btn-icon btn-danger', title: 'Delete', onclick: () => deleteTransaction(t.id), html: Icons.trash }),
      ),
    ));
    return tr;
  }

  // ===================================================================
  // SCREEN: CATEGORIES
  // ===================================================================
  function renderCategories() {
    const wrap = el('div', {});
    const head = el('div', { class: 'section-head' },
      el('div', { class: 'section-label' }, 'Manage'),
    );
    const addBtn = el('button', { class: 'btn btn-sage', onclick: () => openCategoryModal() });
    addBtn.innerHTML = `${Icons.plus} Add category`;
    head.appendChild(addBtn);
    wrap.appendChild(head);

    const expenses = state.categories.filter(c => c.type === 'expense');
    const incomes = state.categories.filter(c => c.type === 'income');
    wrap.appendChild(renderCatSection('Expense categories', expenses, 'expense'));
    wrap.appendChild(renderCatSection('Income categories', incomes, 'income'));
    return wrap;
  }
  function renderCatSection(title, cats, type) {
    const grid = el('div', { class: 'entity-grid' });
    cats.forEach(c => grid.appendChild(renderCategoryCard(c)));
    const sec = el('div', { class: 'card', style: { marginBottom: '16px' } },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' }, title),
        el('div', { class: 'muted', style: { fontSize: '.82rem' } }, `${cats.filter(c => c.active).length} active`)),
      cats.length ? grid : emptyState(`No ${type} categories yet`, 'Add one to start tagging transactions.'),
    );
    return sec;
  }
  function renderCategoryCard(c) {
    return el('div', { class: 'entity' + (c.active ? '' : ' inactive') },
      el('div', { class: 'cat-swatch', style: { background: c.color } }, c.icon || '✦'),
      el('div', { style: { flex: 1, minWidth: 0 } },
        el('div', { class: 'e-name', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, c.name),
        el('div', { class: 'e-meta' }, c.active ? c.type : 'inactive'),
      ),
      el('div', { class: 'e-actions' },
        el('button', { class: 'btn-icon', title: 'Edit', onclick: () => openCategoryModal(c.id), html: Icons.edit }),
        el('button', { class: 'btn-icon btn-danger', title: 'Delete', onclick: () => deleteCategory(c.id), html: Icons.trash }),
      ),
    );
  }

  // ===================================================================
  // SCREEN: SOURCES
  // ===================================================================
  function renderSources() {
    const wrap = el('div', {});
    const head = el('div', { class: 'section-head' },
      el('div', { class: 'section-label' }, 'Manage'),
    );
    const addBtn = el('button', { class: 'btn btn-sage', onclick: () => openSourceModal() });
    addBtn.innerHTML = `${Icons.plus} Add source`;
    head.appendChild(addBtn);
    wrap.appendChild(head);

    const grid = el('div', { class: 'entity-grid' });
    state.sources.forEach(s => grid.appendChild(renderSourceCard(s)));
    wrap.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' }, 'Wallets & accounts'),
        el('div', { class: 'muted', style: { fontSize: '.82rem' } }, `${state.sources.filter(s => s.active).length} active`)),
      state.sources.length ? grid : emptyState('No sources yet', 'Add a bank account, cash or savings to start.'),
    ));
    return wrap;
  }
  function renderSourceCard(s) {
    const owner = s.ownerId ? state.users.find(u => u.id === s.ownerId) : null;
    return el('div', { class: 'entity' + (s.active ? '' : ' inactive') },
      el('div', { class: 'cat-swatch', style: { background: 'var(--beige)', color: 'var(--wood-dark)' }, html: Icons.wallet }),
      el('div', { style: { flex: 1, minWidth: 0 } },
        el('div', { class: 'e-name', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, s.name),
        el('div', { class: 'e-meta' }, `${s.type}${owner ? ' · ' + owner.name : ''}${s.active ? '' : ' · inactive'}`),
      ),
      el('div', { class: 'e-actions' },
        el('button', { class: 'btn-icon', title: 'Edit', onclick: () => openSourceModal(s.id), html: Icons.edit }),
        el('button', { class: 'btn-icon btn-danger', title: 'Delete', onclick: () => deleteSource(s.id), html: Icons.trash }),
      ),
    );
  }

  // ===================================================================
  // SCREEN: USERS
  // ===================================================================
  function renderUsers() {
    const wrap = el('div', {});
    const head = el('div', { class: 'section-head' },
      el('div', { class: 'section-label' }, 'Manage'),
    );
    const addBtn = el('button', { class: 'btn btn-sage', onclick: () => openUserModal() });
    addBtn.innerHTML = `${Icons.plus} Add user`;
    head.appendChild(addBtn);
    wrap.appendChild(head);

    const grid = el('div', { class: 'entity-grid' });
    state.users.forEach(u => grid.appendChild(renderUserCard(u)));
    wrap.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' }, 'People in this notebook'),
        el('div', { class: 'muted', style: { fontSize: '.82rem' } }, `${state.users.filter(u => u.active).length} active`)),
      state.users.length ? grid : emptyState('No users yet', 'Add at least one person to start logging transactions.'),
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
        el('div', { class: 's-label' }, 'Distinct payees'),
        el('div', { class: 's-value' }, String(payees.length)),
        el('div', { class: 's-foot' }, 'After extracting merchant names from descriptions'),
        el('div', { class: 's-icon', html: Icons.store }),
      ),
      el('div', { class: 'summary ' + (needsCount > 0 ? 'expense' : 'income') },
        el('div', { class: 's-label' }, 'Need categorization'),
        el('div', { class: 's-value' }, String(needsCount)),
        el('div', { class: 's-foot' }, needsCount > 0 ? 'Click a payee below to see their transactions' : 'All payees are categorized'),
        el('div', { class: 's-icon', html: Icons.tags }),
      ),
    );
    wrap.appendChild(summary);

    if (payees.length === 0) {
      wrap.appendChild(emptyState('No payees yet', 'Import a statement or add a transaction to get started.'));
      return wrap;
    }

    // Sort: needs-cat first, then by count desc
    payees.sort((a, b) => (b.noCategory - a.noCategory) || (b.count - a.count) || a.name.localeCompare(b.name));

    const tbl = el('table', { class: 'txn-table' });
    tbl.innerHTML = `
      <thead><tr>
        <th>Payee</th>
        <th class="right">Transactions</th>
        <th class="right">Need category</th>
        <th>Last category</th>
        <th>Last seen</th>
        <th>Set category for all</th>
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
      tr.appendChild(el('td', { class: 'muted' }, p.lastDate ? Fmt.date(p.lastDate, { short: true }) : '—'));
      // Category bulk-assign dropdown
      const select = el('select', {
        class: 'select',
        title: `Sets the category for all ${p.count} transaction${p.count === 1 ? '' : 's'} of "${p.name}"`,
        onchange: (e) => {
          const newCat = e.target.value;
          bulkUpdatePayeeCategory(p.name, newCat);
        },
      },
        option('', '— pick —', !lastCat),
        catsByType.expense.length ? el('optgroup', { label: 'Expense' }, ...catsByType.expense.map(c => option(c.id, c.name, lastCat && lastCat.id === c.id))) : null,
        catsByType.income.length ? el('optgroup', { label: 'Income' }, ...catsByType.income.map(c => option(c.id, c.name, lastCat && lastCat.id === c.id))) : null,
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
        el('div', { class: 'e-meta' }, u.active ? 'active' : 'inactive'),
      ),
      el('div', { class: 'e-actions' },
        el('button', { class: 'btn-icon', title: 'Edit', onclick: () => openUserModal(u.id), html: Icons.edit }),
        el('button', { class: 'btn-icon btn-danger', title: 'Delete', onclick: () => deleteUser(u.id), html: Icons.trash }),
      ),
    );
  }

  // ===================================================================
  // MODALS
  // ===================================================================
  function openModal(content) {
    const back = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === back) closeModal(); } });
    back.appendChild(content);
    document.body.appendChild(back);
    // Focus first input
    setTimeout(() => content.querySelector('input, select, textarea, button')?.focus(), 50);
    return back;
  }
  function closeModal() {
    $$('.modal-backdrop').forEach(b => b.remove());
  }

  // --- Add / edit transaction ---------------------------------------
  function openAddTransaction() { openTransactionModal(null); }
  function openEditTransaction(id) { openTransactionModal(id); }

  function openTransactionModal(id) {
    const isEdit = !!id;
    const editing = isEdit ? state.transactions.find(t => t.id === id) : null;
    const t = editing || { type: 'expense', amount: 0, date: Fmt.today(), description: '', categoryId: '', paidByUserId: state.users[0]?.id || '', sourceId: state.sources[0]?.id || '', scope: 'private', notes: '' };

    let cur = { ...t };

    const modal = el('div', { class: 'modal' });
    modal.innerHTML = `
      <div class="modal-head">
        <div class="modal-title">${isEdit ? 'Edit transaction' : 'Add a transaction'}</div>
        <button class="btn-icon" id="m-close" aria-label="Close">${Icons.close}</button>
      </div>
      <div class="modal-body">
        <div class="form-field">
          <label>Type</label>
          <div class="tabs" id="type-tabs">
            <button data-t="expense" class="${cur.type === 'expense' ? 'active expense' : ''}">Expense</button>
            <button data-t="income"  class="${cur.type === 'income'  ? 'active income'  : ''}">Income</button>
          </div>
        </div>
        <div class="form-field">
          <label>Amount</label>
          <div class="amount-wrap">
            <span class="currency">€</span>
            <input class="input amount-input" type="number" min="0" step="0.01" id="f-amount" value="${cur.amount || ''}" placeholder="0.00"/>
          </div>
        </div>
        <div class="form-row">
          <div class="form-field">
            <label>Date</label>
            <input class="input" type="date" id="f-date" value="${cur.date}"/>
          </div>
          <div class="form-field">
            <label>Category</label>
            <select class="select" id="f-cat"></select>
          </div>
        </div>
        <div class="form-field">
          <label>Description</label>
          <input class="input" type="text" id="f-desc" placeholder="e.g. Weekly groceries" value="${escapeAttr(cur.description || '')}"/>
        </div>
        <div class="form-row">
          <div class="form-field">
            <label>Paid by</label>
            <select class="select" id="f-user"></select>
          </div>
          <div class="form-field">
            <label>Source</label>
            <select class="select" id="f-source"></select>
          </div>
        </div>
        <div class="form-field">
          <label>Scope</label>
          <div class="scope-pick" id="f-scope">
            <button data-s="private" class="${cur.scope === 'private' ? 'active' : ''}">${Icons.user} Private</button>
            <button data-s="shared"  class="${cur.scope === 'shared'  ? 'active' : ''}">${Icons.globe} Shared</button>
          </div>
        </div>
        <div class="form-field">
          <label>Notes (optional)</label>
          <textarea class="textarea" id="f-notes" placeholder="Anything worth remembering">${escapeText(cur.notes || '')}</textarea>
        </div>
      </div>
      <div class="modal-foot">
        ${isEdit ? `<button class="btn btn-danger" id="m-delete">${Icons.trash} Delete</button>` : ''}
        <div style="flex:1"></div>
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-primary" id="m-save">${isEdit ? 'Save changes' : 'Add transaction'}</button>
      </div>
    `;

    // Populate selects
    const catSel = modal.querySelector('#f-cat');
    state.categories.filter(c => c.type === cur.type).forEach(c => {
      catSel.appendChild(option(c.id, c.name, c.id === cur.categoryId));
    });
    if (!catSel.value && state.categories.filter(c => c.type === cur.type)[0]) {
      catSel.value = state.categories.filter(c => c.type === cur.type)[0].id;
    }
    // Keep JS state in sync with the auto-selected category
    if (catSel.value) cur.categoryId = catSel.value;

    const userSel = modal.querySelector('#f-user');
    state.users.filter(u => u.active).forEach(u => {
      userSel.appendChild(option(u.id, u.name, u.id === cur.paidByUserId));
    });
    const srcSel = modal.querySelector('#f-source');
    state.sources.filter(s => s.active).forEach(s => {
      srcSel.appendChild(option(s.id, s.name, s.id === cur.sourceId));
    });

    // Bindings
    modal.querySelector('#m-close').onclick = closeModal;
    modal.querySelector('#m-cancel').onclick = closeModal;
    if (isEdit) modal.querySelector('#m-delete').onclick = () => { closeModal(); deleteTransaction(id); };

    modal.querySelectorAll('#type-tabs button').forEach(b => {
      b.onclick = () => {
        cur.type = b.dataset.t;
        // Re-populate categories for the new type
        const sel = modal.querySelector('#f-cat');
        sel.innerHTML = '';
        state.categories.filter(c => c.type === cur.type).forEach(c => sel.appendChild(option(c.id, c.name)));
        if (sel.options.length) {
          sel.value = sel.options[0].value;
          // Keep JS state in sync (setting .value programmatically does not fire 'change')
          cur.categoryId = sel.value;
        } else {
          cur.categoryId = '';
        }
        modal.querySelectorAll('#type-tabs button').forEach(x => x.className = '');
        b.className = 'active ' + cur.type;
      };
    });
    modal.querySelectorAll('#f-scope button').forEach(b => {
      b.onclick = () => {
        cur.scope = b.dataset.s;
        modal.querySelectorAll('#f-scope button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      };
    });
    modal.querySelector('#f-amount').oninput = e => cur.amount = parseFloat(e.target.value) || 0;
    modal.querySelector('#f-date').oninput = e => cur.date = e.target.value;
    modal.querySelector('#f-desc').oninput = e => cur.description = e.target.value;
    modal.querySelector('#f-cat').onchange = e => cur.categoryId = e.target.value;
    modal.querySelector('#f-user').onchange = e => cur.paidByUserId = e.target.value;
    modal.querySelector('#f-source').onchange = e => cur.sourceId = e.target.value;
    modal.querySelector('#f-notes').oninput = e => cur.notes = e.target.value;

    modal.querySelector('#m-save').onclick = () => {
      if (!cur.amount || cur.amount <= 0) return toast('Please enter a positive amount.');
      if (!cur.date) return toast('Please pick a date.');
      if (!cur.categoryId) return toast('Please pick a category.');
      if (!cur.paidByUserId) return toast('Please pick who paid.');
      if (!cur.sourceId) return toast('Please pick a source.');
      if (isEdit) {
        Store.updateTransaction(state, id, cur);
        toast('Transaction updated');
      } else {
        Store.addTransaction(state, cur);
        toast('Transaction added');
      }
      closeModal();
      window.dispatchEvent(new Event('store:changed'));
    };

    openModal(modal);
  }

  function deleteTransaction(id) {
    if (!confirmAction('Delete this transaction? This cannot be undone.')) return;
    Store.deleteTransaction(state, id);
    toast('Transaction deleted');
    window.dispatchEvent(new Event('store:changed'));
  }

  // --- Import from CSV (ING Belgium statements) ----------------------
  function openImportModal() {
    let parsedRows = []; // [{ row, classification, key, selected, skip, dupe, categoryId }]
    const defaults = {
      userId: state.users[0]?.id || '',
      sourceId: state.sources[0]?.id || '',
      scope: 'private',
    };

    const modal = el('div', { class: 'modal modal-wide' });
    modal.innerHTML = `
      <div class="modal-head">
        <div class="modal-title">Import from CSV</div>
        <button class="btn-icon" id="m-close" aria-label="Close">${Icons.close}</button>
      </div>
      <div class="modal-body">
        <div class="form-field">
          <label>CSV file (ING Belgium format)</label>
          <input class="input" type="file" id="imp-file" accept=".csv,text/csv"/>
          <div class="hint">Pick a statement file. Header row is required.</div>
        </div>
        <div class="form-row">
          <div class="form-field">
            <label>Paid by (default)</label>
            <select class="select" id="imp-user"></select>
          </div>
          <div class="form-field">
            <label>Source (default)</label>
            <select class="select" id="imp-source"></select>
          </div>
        </div>
        <div class="form-field">
          <label>Scope (default)</label>
          <div class="scope-pick" id="imp-scope">
            <button data-s="private" class="active">${Icons.user} Private</button>
            <button data-s="shared">${Icons.globe} Shared</button>
          </div>
        </div>
        <div id="imp-summary" class="imp-summary"></div>
        <div id="imp-preview" class="imp-preview"></div>
      </div>
      <div class="modal-foot">
        <div style="flex:1"></div>
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-primary" id="m-import" disabled>Import 0 transactions</button>
      </div>
    `;

    // Populate user / source selects with active entries
    const userSel = modal.querySelector('#imp-user');
    state.users.filter(u => u.active).forEach(u => userSel.appendChild(option(u.id, u.name, u.id === defaults.userId)));
    const srcSel = modal.querySelector('#imp-source');
    state.sources.filter(s => s.active).forEach(s => srcSel.appendChild(option(s.id, s.name, s.id === defaults.sourceId)));

    // Existing dedup keys come from any previously-imported transactions
    const existingKeys = new Set(
      state.transactions.map(t => t.importedKey).filter(Boolean)
    );

    function rebuildPreview() {
      const summary = modal.querySelector('#imp-summary');
      const preview = modal.querySelector('#imp-preview');
      const btn = modal.querySelector('#m-import');

      if (parsedRows.length === 0) {
        summary.innerHTML = '';
        preview.innerHTML = '';
        btn.disabled = true;
        btn.textContent = 'Import 0 transactions';
        return;
      }

      const selCount = parsedRows.filter(r => r.selected && !r.skip && !r.dupe).length;
      const dupeCount = parsedRows.filter(r => r.dupe).length;
      const skipCount = parsedRows.filter(r => r.skip).length;

      summary.innerHTML = `
        <span class="pill pill-pos">${selCount} to import</span>
        <span class="pill">${dupeCount} duplicates skipped</span>
        <span class="pill">${skipCount} info / zero skipped</span>
      `;

      const table = el('table', { class: 'imp-table' });
      table.appendChild(el('thead', {}, el('tr', {},
        el('th', { style: { width: '32px' } }),
        el('th', {}, 'Date'),
        el('th', {}, 'Description'),
        el('th', { class: 'right' }, 'Amount'),
        el('th', {}, 'Type'),
        el('th', {}, 'Category'),
      )));
      const tbody = el('tbody');
      for (const item of parsedRows) {
        const tr = el('tr', { class: (item.skip || item.dupe) ? 'muted' : '' });

        const cb = el('input', { type: 'checkbox', disabled: item.skip || item.dupe });
        cb.checked = !!item.selected;
        cb.onchange = () => { item.selected = cb.checked; rebuildPreview(); };
        tr.appendChild(el('td', {}, cb));

        tr.appendChild(el('td', {}, Fmt.date(item.row.boekingsdatum, { short: true })));
        tr.appendChild(el('td', { class: 'desc', title: item.row.detail || '' }, item.row.omschrijving || '—'));
        const sign = item.classification?.type === 'expense' ? '−' : '+';
        tr.appendChild(el('td', { class: 'right amt' }, sign + Fmt.money(Math.abs(item.row.bedrag))));
        tr.appendChild(el('td', {}, item.classification ? (item.classification.type === 'income' ? '⬇ Income' : '⬆ Expense') : (item.skip ? '— skip —' : '—')));

        const catSel = el('select', { class: 'select', disabled: item.skip || item.dupe });
        const cats = state.categories.filter(c => c.type === (item.classification?.type || 'expense'));
        cats.forEach(c => catSel.appendChild(option(c.id, c.name, c.id === item.categoryId)));
        catSel.onchange = () => { item.categoryId = catSel.value; };
        tr.appendChild(el('td', {}, catSel));

        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      preview.innerHTML = '';
      preview.appendChild(table);

      btn.disabled = selCount === 0;
      btn.textContent = `Import ${selCount} transaction${selCount === 1 ? '' : 's'}`;
    }

    // Default bindings
    modal.querySelector('#imp-user').onchange = e => { defaults.userId = e.target.value; };
    modal.querySelector('#imp-source').onchange = e => { defaults.sourceId = e.target.value; };
    modal.querySelectorAll('#imp-scope button').forEach(b => {
      b.onclick = () => {
        defaults.scope = b.dataset.s;
        modal.querySelectorAll('#imp-scope button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      };
    });

    // File → parse → diff
    modal.querySelector('#imp-file').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      let text;
      try {
        text = await file.text();
      } catch (err) {
        toast('Could not read file.');
        return;
      }
      const rows = CSVImport.parseIngStatement(text);
      if (rows.length === 0) {
        toast('No rows found — is this an ING Belgium CSV?');
        parsedRows = [];
        rebuildPreview();
        return;
      }
      const seen = new Set(existingKeys);
      parsedRows = rows.map(row => {
        const cls = CSVImport.classifyRow(row);
        if (cls.skip) return { row, classification: cls, skip: true, dupe: false, selected: false, key: null };
        const key = CSVImport.makeDedupKey(row);
        const dupe = seen.has(key);
        if (!dupe) seen.add(key);
        const suggested = CSVImport.suggestedCategoryFor(cls.categoryHint, cls.type, state);
        return {
          row, classification: cls, key,
          skip: false, dupe, selected: !dupe,
          categoryId: suggested?.id || '',
        };
      });
      rebuildPreview();
    };

    modal.querySelector('#m-close').onclick = closeModal;
    modal.querySelector('#m-cancel').onclick = closeModal;
    modal.querySelector('#m-import').onclick = () => {
      const toImport = parsedRows.filter(r => r.selected && !r.skip && !r.dupe);
      let count = 0;
      for (const item of toImport) {
        const txn = CSVImport.mapRowToTxn(item.row, item.classification, defaults, item.categoryId);
        txn.importedKey = item.key; // marker so future imports can dedup
        Store.addTransaction(state, txn);
        count++;
      }
      if (count > 0) {
        toast(`Imported ${count} transaction${count === 1 ? '' : 's'}`);
        window.dispatchEvent(new Event('store:changed'));
      }
      closeModal();
    };

    openModal(modal);
  }

  // --- Category modal ------------------------------------------------
  function openCategoryModal(id) {
    const editing = id ? state.categories.find(c => c.id === id) : null;
    let cur = editing ? { ...editing } : { name: '', type: 'expense', color: '#5a7248', icon: '✦', active: true };

    const modal = el('div', { class: 'modal' });
    modal.innerHTML = `
      <div class="modal-head">
        <div class="modal-title">${editing ? 'Edit category' : 'New category'}</div>
        <button class="btn-icon" id="m-close">${Icons.close}</button>
      </div>
      <div class="modal-body">
        <div class="form-field">
          <label>Type</label>
          <div class="tabs" id="type-tabs">
            <button data-t="expense" class="${cur.type === 'expense' ? 'active expense' : ''}">Expense</button>
            <button data-t="income"  class="${cur.type === 'income'  ? 'active income'  : ''}">Income</button>
          </div>
        </div>
        <div class="form-field">
          <label>Name</label>
          <input class="input" type="text" id="f-name" placeholder="e.g. Groceries" value="${escapeAttr(cur.name)}"/>
        </div>
        <div class="form-row">
          <div class="form-field">
            <label>Color</label>
            <div class="color-picker">
              <input type="color" id="f-color" value="${cur.color}"/>
              <input class="input" type="text" id="f-color-text" value="${cur.color}" style="flex:1"/>
            </div>
          </div>
          <div class="form-field">
            <label>Icon</label>
            <input class="input" type="text" id="f-icon" maxlength="2" value="${escapeAttr(cur.icon || '✦')}"/>
          </div>
        </div>
        <div class="form-field">
          <label>Quick icons</label>
          <div class="icon-grid" id="f-icons"></div>
        </div>
        <div class="form-field flex center" style="flex-direction:row; gap:10px;">
          <div class="toggle ${cur.active ? 'on' : ''}" id="f-active"></div>
          <div>
            <div style="font-weight:600;">${cur.active ? 'Active' : 'Inactive'}</div>
            <div class="muted" style="font-size:.8rem;">Inactive categories are hidden in dropdowns.</div>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <div style="flex:1"></div>
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-primary" id="m-save">${editing ? 'Save changes' : 'Add category'}</button>
      </div>
    `;

    const iconGrid = modal.querySelector('#f-icons');
    CategoryIcons.forEach(ic => {
      const b = el('button', { class: ic === cur.icon ? 'active' : '' }, ic);
      b.onclick = () => {
        cur.icon = ic;
        modal.querySelector('#f-icon').value = ic;
        iconGrid.querySelectorAll('button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      };
      iconGrid.appendChild(b);
    });

    modal.querySelector('#m-close').onclick = closeModal;
    modal.querySelector('#m-cancel').onclick = closeModal;
    modal.querySelectorAll('#type-tabs button').forEach(b => {
      b.onclick = () => {
        cur.type = b.dataset.t;
        modal.querySelectorAll('#type-tabs button').forEach(x => x.className = '');
        b.className = 'active ' + cur.type;
      };
    });
    modal.querySelector('#f-name').oninput = e => cur.name = e.target.value;
    modal.querySelector('#f-color').oninput = e => { cur.color = e.target.value; modal.querySelector('#f-color-text').value = e.target.value; };
    modal.querySelector('#f-color-text').oninput = e => { cur.color = e.target.value; modal.querySelector('#f-color').value = e.target.value; };
    modal.querySelector('#f-icon').oninput = e => cur.icon = e.target.value;
    modal.querySelector('#f-active').onclick = () => {
      cur.active = !cur.active;
      const t = modal.querySelector('#f-active');
      t.classList.toggle('on', cur.active);
      t.nextElementSibling.firstElementChild.textContent = cur.active ? 'Active' : 'Inactive';
    };
    modal.querySelector('#m-save').onclick = () => {
      if (!cur.name.trim()) return toast('Please enter a name.');
      if (editing) { Store.updateCategory(state, editing.id, cur); toast('Category updated'); }
      else         { Store.addCategory(state, cur); toast('Category added'); }
      closeModal();
      window.dispatchEvent(new Event('store:changed'));
    };

    openModal(modal);
  }

  function deleteCategory(id) {
    const cat = state.categories.find(c => c.id === id);
    const used = state.transactions.some(t => t.categoryId === id);
    if (used) return toast('Cannot delete: this category is used by transactions.');
    if (!confirmAction(`Delete category "${cat.name}"?`)) return;
    Store.deleteCategory(state, id);
    toast('Category deleted');
    window.dispatchEvent(new Event('store:changed'));
  }

  // --- Source modal --------------------------------------------------
  function openSourceModal(id) {
    const editing = id ? state.sources.find(s => s.id === id) : null;
    let cur = editing ? { ...editing } : { name: '', type: 'bank', ownerId: '', active: true };

    const modal = el('div', { class: 'modal' });
    modal.innerHTML = `
      <div class="modal-head">
        <div class="modal-title">${editing ? 'Edit source' : 'New source'}</div>
        <button class="btn-icon" id="m-close">${Icons.close}</button>
      </div>
      <div class="modal-body">
        <div class="form-field">
          <label>Name</label>
          <input class="input" type="text" id="f-name" placeholder="e.g. Joint account" value="${escapeAttr(cur.name)}"/>
        </div>
        <div class="form-row">
          <div class="form-field">
            <label>Type</label>
            <select class="select" id="f-type">
              <option value="bank"     ${cur.type==='bank'?'selected':''}>Bank account</option>
              <option value="cash"     ${cur.type==='cash'?'selected':''}>Cash</option>
              <option value="savings"  ${cur.type==='savings'?'selected':''}>Savings</option>
              <option value="other"    ${cur.type==='other'?'selected':''}>Other</option>
            </select>
          </div>
          <div class="form-field">
            <label>Owner (optional)</label>
            <select class="select" id="f-owner">
              <option value="">— Shared / none —</option>
              ${state.users.map(u => `<option value="${u.id}" ${cur.ownerId===u.id?'selected':''}>${escapeText(u.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-field flex center" style="flex-direction:row; gap:10px;">
          <div class="toggle ${cur.active ? 'on' : ''}" id="f-active"></div>
          <div>
            <div style="font-weight:600;">${cur.active ? 'Active' : 'Inactive'}</div>
            <div class="muted" style="font-size:.8rem;">Inactive sources are hidden in dropdowns.</div>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <div style="flex:1"></div>
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-primary" id="m-save">${editing ? 'Save changes' : 'Add source'}</button>
      </div>
    `;
    modal.querySelector('#m-close').onclick = closeModal;
    modal.querySelector('#m-cancel').onclick = closeModal;
    modal.querySelector('#f-name').oninput = e => cur.name = e.target.value;
    modal.querySelector('#f-type').onchange = e => cur.type = e.target.value;
    modal.querySelector('#f-owner').onchange = e => cur.ownerId = e.target.value || null;
    modal.querySelector('#f-active').onclick = () => {
      cur.active = !cur.active;
      const t = modal.querySelector('#f-active');
      t.classList.toggle('on', cur.active);
      t.nextElementSibling.firstElementChild.textContent = cur.active ? 'Active' : 'Inactive';
    };
    modal.querySelector('#m-save').onclick = () => {
      if (!cur.name.trim()) return toast('Please enter a name.');
      if (editing) { Store.updateSource(state, editing.id, cur); toast('Source updated'); }
      else         { Store.addSource(state, cur); toast('Source added'); }
      closeModal();
      window.dispatchEvent(new Event('store:changed'));
    };
    openModal(modal);
  }
  function deleteSource(id) {
    const s = state.sources.find(x => x.id === id);
    const used = state.transactions.some(t => t.sourceId === id);
    if (used) return toast('Cannot delete: this source is used by transactions.');
    if (!confirmAction(`Delete source "${s.name}"?`)) return;
    Store.deleteSource(state, id);
    toast('Source deleted');
    window.dispatchEvent(new Event('store:changed'));
  }

  // --- User modal ----------------------------------------------------
  function openUserModal(id) {
    const editing = id ? state.users.find(u => u.id === id) : null;
    let cur = editing ? { ...editing } : { name: '', color: '#5a7248', active: true };

    const modal = el('div', { class: 'modal' });
    modal.innerHTML = `
      <div class="modal-head">
        <div class="modal-title">${editing ? 'Edit user' : 'New user'}</div>
        <button class="btn-icon" id="m-close">${Icons.close}</button>
      </div>
      <div class="modal-body">
        <div class="form-field">
          <label>Name</label>
          <input class="input" type="text" id="f-name" placeholder="e.g. David" value="${escapeAttr(cur.name)}"/>
        </div>
        <div class="form-field">
          <label>Display color</label>
          <div class="color-picker">
            <input type="color" id="f-color" value="${cur.color}"/>
            <input class="input" type="text" id="f-color-text" value="${cur.color}" style="flex:1"/>
          </div>
        </div>
        <div class="form-field flex center" style="flex-direction:row; gap:10px;">
          <div class="toggle ${cur.active ? 'on' : ''}" id="f-active"></div>
          <div>
            <div style="font-weight:600;">${cur.active ? 'Active' : 'Inactive'}</div>
            <div class="muted" style="font-size:.8rem;">Inactive users are hidden in dropdowns.</div>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <div style="flex:1"></div>
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-primary" id="m-save">${editing ? 'Save changes' : 'Add user'}</button>
      </div>
    `;
    modal.querySelector('#m-close').onclick = closeModal;
    modal.querySelector('#m-cancel').onclick = closeModal;
    modal.querySelector('#f-name').oninput = e => cur.name = e.target.value;
    modal.querySelector('#f-color').oninput = e => { cur.color = e.target.value; modal.querySelector('#f-color-text').value = e.target.value; };
    modal.querySelector('#f-color-text').oninput = e => { cur.color = e.target.value; modal.querySelector('#f-color').value = e.target.value; };
    modal.querySelector('#f-active').onclick = () => {
      cur.active = !cur.active;
      const t = modal.querySelector('#f-active');
      t.classList.toggle('on', cur.active);
      t.nextElementSibling.firstElementChild.textContent = cur.active ? 'Active' : 'Inactive';
    };
    modal.querySelector('#m-save').onclick = () => {
      if (!cur.name.trim()) return toast('Please enter a name.');
      if (editing) { Store.updateUser(state, editing.id, cur); toast('User updated'); }
      else         { Store.addUser(state, cur); toast('User added'); }
      closeModal();
      window.dispatchEvent(new Event('store:changed'));
    };
    openModal(modal);
  }
  function deleteUser(id) {
    const u = state.users.find(x => x.id === id);
    const used = state.transactions.some(t => t.paidByUserId === id);
    if (used) return toast('Cannot delete: this user is used by transactions.');
    if (!confirmAction(`Delete user "${u.name}"?`)) return;
    Store.deleteUser(state, id);
    toast('User deleted');
    window.dispatchEvent(new Event('store:changed'));
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

  return { init, get _state() { return state; } };
})();
window.App = App;
