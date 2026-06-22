// =====================================================================
// app.js — App state, router, screens, modals
// =====================================================================

const App = (() => {
  // ---- State --------------------------------------------------------
  let state = Store.load();
  let view = 'dashboard';           // current route
  let monthKey = Fmt.currentMonthKey(); // for month-scoped screens
  let txnFilters = { month: 'all', type: 'all', categoryId: 'all', userId: 'all', sourceId: 'all', scope: 'all', payee: 'all' };

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
      el('button', { class: 'nav-item' + (view === id ? ' active' : ''), onclick: () => goTo(id) },
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
        el('button', { class: 'btn btn-ghost', onclick: openImportModal, id: 'import-btn', title: 'Import ING Belgium CSV' },
          el('span', { html: Icons.upload }), 'Import'),
        el('button', { class: 'btn btn-primary', onclick: openAddTransaction, id: 'add-txn-btn' },
          el('span', { html: Icons.plus }), 'Add transaction'),
      ),
    );
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
    const at = $('#add-txn-btn');
    at.style.display = (view === 'categories' || view === 'sources' || view === 'users') ? 'none' : 'inline-flex';

    if (view === 'dashboard') view_.appendChild(renderDashboard());
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
    const txns = state.transactions.filter(t => Fmt.inMonth(t.date, monthKey));
    const totalIncome  = sum(txns.filter(t => t.type === 'income'),  'amount');
    const totalExpense = sum(txns.filter(t => t.type === 'expense'), 'amount');
    const balance = totalIncome - totalExpense;
    const privateExp = sum(txns.filter(t => t.type === 'expense' && t.scope === 'private'), 'amount');
    const sharedExp  = sum(txns.filter(t => t.type === 'expense' && t.scope === 'shared'),  'amount');

    // Category breakdown (expense)
    const expByCat = aggregateBy(txns.filter(t => t.type === 'expense'), 'categoryId');
    const topCats = Object.entries(expByCat)
      .map(([k, v]) => ({ cat: state.categories.find(c => c.id === k), amount: v }))
      .filter(x => x.cat)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 6);

    // Monthly trend (last 6 months ending at the selected month, so the
    // chart follows the topbar month filter).
    const months = [];
    for (let i = 5; i >= 0; i--) months.push(Fmt.shiftMonth(monthKey, -i));
    const trend = months.map(m => {
      const mTx = state.transactions.filter(t => Fmt.ymKey(t.date) === m);
      return {
        m,
        income: sum(mTx.filter(t => t.type === 'income'), 'amount'),
        expense: sum(mTx.filter(t => t.type === 'expense'), 'amount'),
      };
    });

    const recent = Store.listTransactions(state)
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

    // Trend + breakdown
    const trendCard = el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title', html: Icons.receipt }),
        'Income vs expenses — last 6 months'),
      renderBarChart(trend),
    );
    const breakCard = el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title', html: Icons.tags }),
        'Top categories this month'),
      topCats.length
        ? renderCatList(topCats, totalExpense)
        : emptyState('No expenses yet', 'Once you log one, it shows up here.'),
    );
    wrap.appendChild(el('div', { class: 'dash-grid' }, trendCard, breakCard));

    // Donut + recent
    const donutCard = el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title', html: Icons.coffee }),
        'Spending share'),
      topCats.length ? renderDonut(topCats, totalExpense) : emptyState('Nothing to plot yet', 'Log a few expenses to see the picture.'),
    );
    const recentCard = el('div', { class: 'card recent-list' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title', html: Icons.list }),
        'Recent transactions',
        el('button', { class: 'btn btn-ghost btn-sm', onclick: () => goTo('transactions') }, 'View all →')),
      recent.length
        ? renderTxnTable(recent, { compact: true })
        : emptyState('No transactions this month', 'Tap the + button to add your first one.'),
    );
    wrap.appendChild(el('div', { class: 'dash-grid-2' }, donutCard, recentCard));

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

  function renderBarChart(data) {
    const max = Math.max(1, ...data.map(d => Math.max(d.income, d.expense)));
    const wrap = el('div', {});
    const chart = el('div', { class: 'bar-chart' });
    data.forEach(d => {
      const hInc = (d.income / max) * 100;
      const hExp = (d.expense / max) * 100;
      chart.appendChild(el('div', { class: 'bar-col' },
        el('div', { class: 'bar-pair' },
          el('div', { class: 'bar income', style: { height: hInc + '%' }, title: Fmt.money(d.income) }),
          el('div', { class: 'bar expense', style: { height: hExp + '%' }, title: Fmt.money(d.expense) }),
        ),
        el('div', { class: 'bar-label' }, Fmt.monthLabel(d.m).split(' ')[0].slice(0, 3)),
      ));
    });
    wrap.appendChild(chart);
    wrap.appendChild(el('div', { class: 'chart-legend' },
      el('div', {}, el('span', { class: 'legend-dot', style: { background: 'var(--sage)' } }), 'Income'),
      el('div', {}, el('span', { class: 'legend-dot', style: { background: 'var(--terra)' } }), 'Expenses'),
    ));
    return wrap;
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
    const sources = state.sources;

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
    // Every year-month that actually has a transaction, plus the current
    // month (so the picker is usable on a fresh install). Newest first.
    const months = new Set([Fmt.currentMonthKey()]);
    for (const t of state.transactions) {
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
    for (const t of state.transactions) {
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

  function filteredTxns() {
    const f = txnFilters;
    return Store.listTransactions(state).filter(t => {
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
    tbl.innerHTML = `
      <thead><tr>
        <th>Date</th>
        <th>Description</th>
        <th>Category</th>
        <th>User / Source</th>
        <th>Scope</th>
        <th class="right">Amount</th>
        <th></th>
      </tr></thead>
      <tbody></tbody>`;
    const tb = tbl.querySelector('tbody');
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
      </tr></thead>
      <tbody></tbody>`;
    const tb = tbl.querySelector('tbody');
    for (const p of payees) {
      const lastCat = p.lastCategoryId ? state.categories.find(c => c.id === p.lastCategoryId) : null;
      const tr = el('tr', { class: 'clickable', onclick: () => { txnFilters.payee = p.name; goTo('transactions'); } });
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

  return { init };
})();
window.App = App;
