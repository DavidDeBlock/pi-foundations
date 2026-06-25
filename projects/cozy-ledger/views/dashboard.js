// =====================================================================
// views/dashboard.js — Home: summary cards + donut + recent + top cats
// =====================================================================
// Reads: App._state, Router.view/monthKey
// Calls: Router.goTo, Router.renderView, ViewHelpers.{sum,countTxns,
//        aggregateBy,emptyState,escapeText}, Store.setDashboardByGroup
// =====================================================================

const Dashboard = (() => {
  // -- Top categories + groups (shared with Trends) ------------------
  // Top 6 expense categories for a given (already month-scoped)
  // transaction set. Returns [{ cat, amount }, ...] sorted desc.
  function topCategories(txns, _totalExpense) {
    const expByCat = ViewHelpers.aggregateBy(txns.filter(t => t.type === 'expense'), 'categoryId');
    return Object.entries(expByCat)
      .map(([k, v]) => ({ cat: App._state.categories.find(c => c.id === k), amount: v }))
      .filter(x => x.cat)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 6);
  }

  // Top 6 expense groups (ISSUE-007). Categories without a groupId
  // collapse into a synthetic "__none__" group rendered with a
  // sand-coloured fallback so the chart stays meaningful.
  function topGroups(txns) {
    const exp = txns.filter(x => x.type === 'expense');
    const byGroup = new Map();
    const cats = App._state.categories || [];
    const groups = (App._state.groups || []).sort((a, b) => (a.order || 0) - (b.order || 0));
    const groupById = Object.create(null);
    for (const g of groups) groupById[g.id] = g;
    for (const x of exp) {
      const cat = cats.find(c => c.id === x.categoryId);
      const gid = cat && cat.groupId ? cat.groupId : '__none__';
      byGroup.set(gid, (byGroup.get(gid) || 0) + x.amount);
    }
    const rows = [...byGroup.entries()].map(([gid, amount]) => {
      const grp = groupById[gid] || { id: '__none__', name: t('grp.uncategorized'), color: '#a4926b', icon: '✦' };
      return { grp: { ...grp }, amount };
    });
    return rows.sort((a, b) => b.amount - a.amount).slice(0, 6);
  }

  // -- Donut ---------------------------------------------------------
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
          <div class="dc-lbl">${ViewHelpers.escapeText(t('dashboard.donut.center.total'))}</div>
        </div>
      </div>
    </div>`;
    const legend = el('div', { class: 'donut-legend' });
    items.forEach(({ cat, amount: _amount, frac }) => {
      legend.appendChild(el('div', { class: 'dl-row' },
        el('span', { class: 'dl-dot', style: { background: cat.color } }),
        el('span', { class: 'dl-name' }, cat.name),
        el('span', { class: 'dl-val' }, (frac * 100).toFixed(0) + '%'),
      ));
    });
    wrap.appendChild(legend);
    return wrap;
  }

  // -- Category / group row lists (shared with Trends) ---------------
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

  // -- Top categories card (shared with Trends) ---------------------
  // ISSUE-007: when settings.dashboardByGroup is true, the card
  // rolls up at the group level instead. The toggle lives in the
  // card head.
  function renderTopCategoriesCard(txns, totalExpense) {
    const byGroup = !!(App._state.settings && App._state.settings.dashboardByGroup);
    const onToggle = () => {
      Store.setDashboardByGroup(App._state, !byGroup);
      Router.renderView();
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
          title: t('dashboard.byGroup.toggle'),
        }, t('dashboard.byGroup.toggle')),
      ),
      rows.length
        ? (byGroup ? renderGroupList(rows, totalExpense) : renderCatList(rows, totalExpense))
        : ViewHelpers.emptyState(t('dashboard.top.empty.title'), t('dashboard.top.empty.msg')),
    );
  }

  // -- Top-level render ---------------------------------------------
  function render() {
    const state = App._state;
    const monthKey = Router.monthKey;
    const inScopeTxns = Selectors.transactionsInScope(state);
    const txns = inScopeTxns.filter(x => Fmt.inMonth(x.date, monthKey));
    const totalIncome  = ViewHelpers.sum(txns.filter(x => x.type === 'income'),  'amount');
    const totalExpense = ViewHelpers.sum(txns.filter(x => x.type === 'expense'), 'amount');
    const balance = totalIncome - totalExpense;
    const privateExp = ViewHelpers.sum(txns.filter(x => x.type === 'expense' && x.scope === 'private'), 'amount');
    const sharedExp  = ViewHelpers.sum(txns.filter(x => x.type === 'expense' && x.scope === 'shared'),  'amount');

    const topCats = topCategories(txns, totalExpense);

    const recent = [...inScopeTxns]
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
      .filter(x => Fmt.inMonth(x.date, monthKey));

    const wrap = el('div', { class: 'view-dashboard' });

    const sCard = (cls, label, value, foot, icon, valClass = '') =>
      el('div', { class: 'summary ' + cls },
        el('div', { class: 's-label' }, label),
        el('div', { class: 's-value ' + valClass }, value),
        foot ? el('div', { class: 's-foot' }, foot) : null,
        el('div', { class: 's-icon', html: icon }),
      );

    const balanceClass = balance > 0 ? 'pos' : (balance < 0 ? 'neg' : 'zero');
    const byGroup = !!(state.settings && state.settings.dashboardByGroup);
    const sIncome  = sCard('income',  t('dashboard.card.income.label'),    Fmt.money(totalIncome),  t('dashboard.card.income.entries',  { n: ViewHelpers.countTxns(txns, 'income')  }), Icons.arrowDown);
    const sExpense = sCard('expense', t('dashboard.card.expense.label'),   Fmt.money(totalExpense), t('dashboard.card.expense.entries', { n: ViewHelpers.countTxns(txns, 'expense') }), Icons.arrowUp);
    const sBalance = sCard('balance', t('dashboard.card.balance.label'),   Fmt.money(balance),
      balance > 0 ? t('dashboard.card.balance.pos') : (balance < 0 ? t('dashboard.card.balance.neg') : t('dashboard.card.balance.zero')),
      Icons.piggy, balanceClass);
    const sShared  = sCard('shared',  t('dashboard.card.shared.label'),    `${Fmt.money(sharedExp)} / ${Fmt.money(privateExp)}`, t('dashboard.card.shared.foot'), Icons.globe);

    const summary = el('div', { class: 'summary-grid' }, sIncome, sExpense, sBalance, sShared);
    wrap.appendChild(summary);

    // Donut — given its own full-width row so it has visual room.
    const donutRows = byGroup
      ? topGroups(txns).map(({ grp, amount }) => ({ cat: { name: grp.name, color: grp.color, icon: grp.icon }, amount }))
      : topCats;
    const donutCard = el('div', { class: 'card donut-card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title', html: Icons.coffee }),
        t('dashboard.donut.title')),
      donutRows.length ? renderDonut(donutRows, totalExpense) : ViewHelpers.emptyState(t('dashboard.donut.empty.title'), t('dashboard.donut.empty.msg')),
    );
    wrap.appendChild(donutCard);

    // Recent — full width below the donut.
    const recentCard = el('div', { class: 'card recent-list' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title', html: Icons.list }),
        t('dashboard.recent.title'),
        el('button', { class: 'btn btn-ghost btn-sm', onclick: () => Router.goTo('transactions') }, t('dashboard.recent.viewAll'))),
      recent.length
        ? Transactions.renderTable(recent, { compact: true })
        : ViewHelpers.emptyState(t('dashboard.recent.empty.title'), t('dashboard.recent.empty.msg')),
    );
    wrap.appendChild(recentCard);

    wrap.appendChild(renderTopCategoriesCard(txns, totalExpense));

    return wrap;
  }

  return {
    render,
    // Exposed for Trends so it can reuse the same card without going
    // through dashboard's full layout.
    renderTopCategoriesCard,
    renderCatList,
    renderGroupList,
  };
})();
window.Dashboard = Dashboard;
