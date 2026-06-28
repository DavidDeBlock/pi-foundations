// =====================================================================
// views/dashboard.js — Home: summary cards + donut + recent + top cats
// =====================================================================
// Reads: App._state, Router.view, Router.periodRange
// Calls: Router.goTo, Router.renderView, ViewHelpers.{sum,countTxns,
//        aggregateBy,emptyState,escapeText}, Store.setDashboardByGroup
// Period: every widget (summary cards, donut, recent, top cats) is
//         scoped to the active period (Router.periodRange()), not a
//         single month. See ISSUE-015.
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
    items.forEach(({ cat, amount }) => {
      // Compute frac the same way the SVG segments do — the items
      // array doesn't carry a `frac` field, so destructuring it here
      // would silently produce `NaN%` (pre-ISSUE-016 bug).
      const frac = total ? amount / total : 0;
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
  // Per ISSUE-022, category rows in the dashboard's top-categories
  // card are clickable and navigate to `category-{id}` (the drill-down
  // view delivered by ISSUE-021). We render each row as a real
  // `<button>` so we get keyboard support (Enter/Space) and proper
  // semantic markup for free. CSS resets the button defaults so it
  // looks like the plain `.cat-row` it replaced.
  //
  // Group-mode rows are NOT clickable in this slice — the group
  // drill-down is out of scope for ISSUE-022 (see the issue's "Out
  // of scope" section). Future contributor: don't extend this without
  // a new issue. Use `<div class="cat-row">` not a `<button>` so
  // screen readers don't announce an inert action target.
  function renderCatList(items, total) {
    const list = el('div', { class: 'cat-list' });
    items.forEach(({ cat, amount }) => {
      const pct = Fmt.pct(amount, total);
      const swatch = el('div', { class: 'cat-swatch', style: { background: cat.color } }, cat.icon || '✦');
      const bar = el('div', { class: 'cat-bar' },
        el('div', { class: 'cat-bar-fill', style: { width: pct + '%', background: cat.color } }),
      );
      list.appendChild(el('button', {
        class: 'cat-row clickable',
        type: 'button',
        onclick: () => Router.goTo('category-' + cat.id),
        // data-cat-id so tests can locate a specific row without
        // depending on visible-text brittleness.
        'data-cat-id': cat.id,
      },
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
      // Intentionally a plain div — group drill-down is out of scope
      // for ISSUE-022. See the comment above renderCatList.
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

  // -- Savings strip (ISSUE-019) ------------------------------------
  // Top-of-dashboard summary cards for Goals and Envelopes. They are
  // intentionally NOT period-aware: goals have no period concept, and
  // envelopes always evaluate against the *current* calendar month /
  // year (via Selectors.currentPeriodFor). Switching the period
  // selector above leaves these cards untouched. If you find yourself
  // wanting to gate them on Router.periodRange(), stop — the spec
  // says these always reflect "current state".
  const SAVINGS_CARD_LIMIT = 3;

  // Goal progress bar colour buckets (mirrors views/goals.js).
  function goalBarClass(percent) {
    if (percent > 100) return 'savings-row-bar-fill savings-row-bar-fill--over';
    if (percent >= 100) return 'savings-row-bar-fill savings-row-bar-fill--full';
    return 'savings-row-bar-fill';
  }
  function goalFoot(progress) {
    if (progress.percent > 100) {
      const over = Math.round((progress.funded - progress.target) * 100) / 100;
      return el('div', { class: 'savings-row-foot savings-row-foot--over' },
        t('goals.card.over', { over: Fmt.money(over) }));
    }
    if (progress.percent >= 100) {
      return el('div', { class: 'savings-row-foot' }, t('goals.card.reached'));
    }
    return el('div', { class: 'savings-row-foot' },
      t('goals.card.remaining', { remaining: Fmt.money(progress.remaining) }));
  }

  function renderGoalsSummaryCard() {
    const goals = App._state.goals || [];
    const wrap = el('div', { class: 'savings-card' });

    const headChildren = [
      el('div', { class: 'savings-card-title' }, t('dashboard.goals.title')),
    ];
    if (goals.length > SAVINGS_CARD_LIMIT) {
      headChildren.push(el('button', {
        class: 'savings-card-link',
        onclick: () => Router.goTo('goals'),
      }, t('dashboard.goals.viewAll') + ' (' + goals.length + ') \u2192'));
    }
    wrap.appendChild(el('div', { class: 'savings-card-head' }, headChildren));

    if (!goals.length) {
      wrap.appendChild(el('div', { class: 'savings-card-empty' }, t('dashboard.goals.empty')));
      wrap.appendChild(el('button', {
        class: 'savings-card-cta',
        onclick: () => Router.goTo('goals'),
      }, '+ ' + t('dashboard.addNew')));
      return wrap;
    }

    // Top N by % funded desc; ties broken by recency (createdAt).
    const sorted = [...goals].sort((a, b) => {
      const pa = Selectors.goalProgress(a).percent;
      const pb = Selectors.goalProgress(b).percent;
      if (pb !== pa) return pb - pa;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    }).slice(0, SAVINGS_CARD_LIMIT);

    sorted.forEach(g => {
      const progress = Selectors.goalProgress(g);
      const fill = el('div', {
        class: goalBarClass(progress.percent),
        style: { width: Math.min(100, progress.percent) + '%' },
      });
      const row = el('div', { class: 'savings-row', 'data-row-kind': 'goal', 'data-row-id': g.id },
        el('div', { class: 'savings-row-name' }, g.name),
        el('div', { class: 'savings-row-meta' },
          t('goals.card.funded', { funded: Fmt.money(progress.funded), target: Fmt.money(progress.target) })),
        el('div', { class: 'savings-row-bar' }, fill),
        goalFoot(progress),
      );
      wrap.appendChild(row);
    });

    return wrap;
  }

  // Envelope progress bar colour buckets (mirrors views/envelopes.js
  // but using the savings-strip variants). Warn at >= 80%, over at
  // > 100%; never use the "full" bucket — envelopes can't exceed
  // their cap without flipping to over.
  function envBarClass(percent) {
    if (percent > 100) return 'savings-row-bar-fill savings-row-bar-fill--over';
    if (percent >= 80) return 'savings-row-bar-fill savings-row-bar-fill--warn';
    return 'savings-row-bar-fill';
  }
  function envFoot(progress, envelope) {
    if (progress.overspent > 0) {
      return el('div', { class: 'savings-row-foot savings-row-foot--over' },
        t('dashboard.envelopes.overspent', { over: Fmt.money(progress.overspent) }));
    }
    const periodKey = envelope.period === 'yearly' ? 'envelopes.card.period.yearly' : 'envelopes.card.period.monthly';
    return el('div', { class: 'savings-row-foot' },
      t(periodKey) + ' \u2014 ' + t('envelopes.card.remaining', { remaining: Fmt.money(progress.remaining) }));
  }

  function renderEnvelopesSummaryCard() {
    const envelopes = App._state.envelopes || [];
    const wrap = el('div', { class: 'savings-card' });

    const headChildren = [
      el('div', { class: 'savings-card-title' }, t('dashboard.envelopes.title')),
    ];
    if (envelopes.length > SAVINGS_CARD_LIMIT) {
      headChildren.push(el('button', {
        class: 'savings-card-link',
        onclick: () => Router.goTo('envelopes'),
      }, t('dashboard.envelopes.viewAll') + ' (' + envelopes.length + ') \u2192'));
    }
    wrap.appendChild(el('div', { class: 'savings-card-head' }, headChildren));

    if (!envelopes.length) {
      wrap.appendChild(el('div', { class: 'savings-card-empty' }, t('dashboard.envelopes.empty')));
      wrap.appendChild(el('button', {
        class: 'savings-card-cta',
        onclick: () => Router.goTo('envelopes'),
      }, '+ ' + t('dashboard.addNew')));
      return wrap;
    }

    // Top N by % spent desc. Tie-break by most-recently createdAt so
    // newer envelopes surface before older ones with the same status.
    const sorted = [...envelopes].sort((a, b) => {
      const pa = Selectors.envelopeProgress(a, App._state).percent;
      const pb = Selectors.envelopeProgress(b, App._state).percent;
      if (pb !== pa) return pb - pa;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    }).slice(0, SAVINGS_CARD_LIMIT);

    sorted.forEach(e => {
      const progress = Selectors.envelopeProgress(e, App._state);
      const fill = el('div', {
        class: envBarClass(progress.percent),
        style: { width: Math.min(100, progress.percent) + '%' },
      });
      const row = el('div', { class: 'savings-row', 'data-row-kind': 'envelope', 'data-row-id': e.id },
        el('div', { class: 'savings-row-name' }, e.name),
        el('div', { class: 'savings-row-meta' },
          t('envelopes.card.spent', { spent: Fmt.money(progress.spent), cap: Fmt.money(progress.cap) })),
        el('div', { class: 'savings-row-bar' }, fill),
        envFoot(progress, e),
      );
      wrap.appendChild(row);
    });

    return wrap;
  }

  // -- Top-level render ---------------------------------------------
  function render() {
    const state = App._state;
    const range = Router.periodRange();
    const txns = Selectors.txnsInPeriod(state, range);
    const totalIncome  = ViewHelpers.sum(txns.filter(x => x.type === 'income'),  'amount');
    const totalExpense = ViewHelpers.sum(txns.filter(x => x.type === 'expense'), 'amount');
    const balance = totalIncome - totalExpense;
    const privateExp = ViewHelpers.sum(txns.filter(x => x.type === 'expense' && x.scope === 'private'), 'amount');
    const sharedExp  = ViewHelpers.sum(txns.filter(x => x.type === 'expense' && x.scope === 'shared'),  'amount');

    const topCats = topCategories(txns, totalExpense);

    // "Recent transactions" now means "all transactions in the period,
    // newest first" (ISSUE-015). The compact table renders fine even
    // when the period yields >20 rows. createdAt is treated as a tie-
    // breaker for same-day txns; legacy data may lack it.
    const recent = [...txns]
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));

    const wrap = el('div', { class: 'view-dashboard' });

    // Period selector (ISSUE-014) sits at the top of the dashboard,
    // full width. ISSUE-015 only mounts it here; the view itself
    // drives the re-mount on every render.
    wrap.appendChild(PeriodSelector.render('dashboard'));

    // Savings strip (ISSUE-019) — top-of-dashboard summary cards for
    // Goals and Envelopes. These always reflect current state and are
    // NOT period-aware; the period selector above has no effect on
    // them. See renderGoalsSummaryCard / renderEnvelopesSummaryCard
    // for the rationale.
    wrap.appendChild(el('div', { class: 'savings-strip' },
      renderGoalsSummaryCard(),
      renderEnvelopesSummaryCard(),
    ));

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
