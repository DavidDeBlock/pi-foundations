// =====================================================================
// views/transactions.js — Filterable transaction list
// =====================================================================
// Reads: App._state, Router.txnFilters, Router.monthKey
// Calls: Router.renderView, Router.goTo, window.Modals, ViewHelpers
// =====================================================================

const Transactions = (() => {
  const { field, option, emptyState } = ViewHelpers;
  const extractPayee = ViewHelpers.extractPayee;

  // -- Filter toolbar ------------------------------------------------
  function renderFilters() {
    const f = el('div', { class: 'filters' });
    const cats = App._state.categories;
    const users = App._state.users;
    const sources = Selectors.sourcesInScope(App._state);
    const groups = App._state.groups || [];

    f.appendChild(field(t('filter.month'),
      el('select', { class: 'select', onchange: (e) => { Router.setTxnFilter('month', e.target.value); } },
        option('all', t('filter.month.all')),
        ...availableMonths().map(m => option(m, Fmt.monthLabel(m), Router.txnFilters.month === m)),
      )));

    f.appendChild(field(t('filter.type'),
      el('select', { class: 'select', onchange: (e) => { Router.setTxnFilter('type', e.target.value); } },
        option('all', t('filter.type.all')),
        option('income',  t('filter.type.income'),  Router.txnFilters.type === 'income'),
        option('expense', t('filter.type.expense'), Router.txnFilters.type === 'expense'),
      )));

    f.appendChild(field(t('filter.category'),
      el('select', { class: 'select', onchange: (e) => { Router.setTxnFilter('categoryId', e.target.value); } },
        option('all', t('filter.category.all')),
        ...cats.map(c => option(c.id, c.name, Router.txnFilters.categoryId === c.id)),
      )));

    // ISSUE-007: group filter, sourced from state.groups.
    f.appendChild(field(t('filter.group'),
      el('select', { class: 'select', onchange: (e) => { Router.setTxnFilter('groupId', e.target.value); } },
        option('all', t('filter.group.all')),
        ...groups.map(g => option(g.id, g.name, Router.txnFilters.groupId === g.id)),
        option('__none__', t('filter.group.none')),
      )));

    f.appendChild(field(t('filter.user'),
      el('select', { class: 'select', onchange: (e) => { Router.setTxnFilter('userId', e.target.value); } },
        option('all', t('filter.user.all')),
        ...users.map(u => option(u.id, u.name, Router.txnFilters.userId === u.id)),
      )));

    f.appendChild(field(t('filter.source'),
      el('select', { class: 'select', onchange: (e) => { Router.setTxnFilter('sourceId', e.target.value); } },
        option('all', t('filter.source.all')),
        ...sources.map(s => option(s.id, s.name, Router.txnFilters.sourceId === s.id)),
      )));

    f.appendChild(field(t('filter.scope'),
      el('select', { class: 'select', onchange: (e) => { Router.setTxnFilter('scope', e.target.value); } },
        option('all', t('filter.scope.all')),
        option('private', t('filter.scope.priv'),   Router.txnFilters.scope === 'private'),
        option('shared',  t('filter.scope.shared'), Router.txnFilters.scope === 'shared'),
      )));

    const payees = ViewHelpers.distinctPayees();
    f.appendChild(field(t('filter.payee'),
      el('select', { class: 'select', onchange: (e) => { Router.setTxnFilter('payee', e.target.value); } },
        option('all', t('filter.payee.all')),
        ...payees.map(p => option(p.name, p.name + (p.noCategory ? ` (${p.noCategory} ✱)` : ''), Router.txnFilters.payee === p.name)),
      )));

    f.appendChild(el('div', { style: { flex: 1 } }));
    f.appendChild(el('button', { class: 'btn btn-ghost btn-sm', onclick: () => Router.resetTxnFilters() }, t('filter.reset')));

    return f;
  }

  // Every year-month that has an in-scope transaction, plus the
  // current month (so the picker is usable on a fresh install).
  function availableMonths() {
    const months = new Set([Fmt.currentMonthKey()]);
    for (const txn of Selectors.transactionsInScope(App._state)) {
      if (txn.date) months.add(Fmt.ymKey(txn.date));
    }
    return [...months].sort().reverse();
  }

  // -- Filter pipeline ----------------------------------------------
  function filteredTxns() {
    const f = Router.txnFilters;
    // Pre-compute the groupId for each filter-relevant category once
    // so the inner loop is a Set lookup rather than a find() per row.
    const catsById = Object.create(null);
    for (const c of (App._state.categories || [])) catsById[c.id] = c;
    return [...Selectors.transactionsInScope(App._state)]
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
      .filter(txn => {
        if (f.month !== 'all' && !Fmt.inMonth(txn.date, f.month)) return false;
        if (f.type !== 'all' && txn.type !== f.type) return false;
        if (f.categoryId !== 'all' && txn.categoryId !== f.categoryId) return false;
        if (f.userId !== 'all' && txn.paidByUserId !== f.userId) return false;
        if (f.sourceId !== 'all' && txn.sourceId !== f.sourceId) return false;
        if (f.scope !== 'all' && txn.scope !== f.scope) return false;
        if (f.payee !== 'all' && extractPayee(txn.description) !== f.payee) return false;
        if (f.groupId !== 'all' && f.groupId !== undefined) {
          const cat = catsById[txn.categoryId];
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

  // -- Table + row rendering ----------------------------------------
  function renderTable(txns, opts) {
    const compact = (opts || {}).compact;
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
    txns.forEach(txn => tb.appendChild(renderRow(txn, compact)));
    return tbl;
  }

  function renderRow(txn, _compact) {
    const cat = App._state.categories.find(c => c.id === txn.categoryId);
    const user = App._state.users.find(u => u.id === txn.paidByUserId);
    const source = App._state.sources.find(s => s.id === txn.sourceId);

    // ISSUE-024: the payee name in the description cell is now a
    // clickable button that drills into the payee detail view. We
    // resolve the slug up-front so tests can target the row by the
    // `data-payee-slug` attribute. If the description has no
    // extractable payee, fall back to a plain text span so the cell
    // still renders (no dead link).
    const payeeName = extractPayee(txn.description);
    const payeeCellContent = payeeName
      ? el('button', {
          class: 'payee-cell-link',
          type: 'button',
          'data-payee-slug': ViewHelpers.slugifyPayee(payeeName),
          onclick: () => Router.goTo('payee-' + ViewHelpers.slugifyPayee(payeeName)),
        }, payeeName)
      : el('span', {}, txn.description || (cat ? cat.name : '—'));

    const tr = el('tr', {});
    tr.appendChild(el('td', { class: 'txn-date' }, Fmt.date(txn.date)));
    tr.appendChild(el('td', {},
      el('div', { class: 'txn-desc', title: txn.description || '' }, payeeCellContent),
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

  // -- Stats strip (ISSUE-025) --------------------------------------
  // Visibility: the strip renders only when EXACTLY ONE entity
  // filter is set to a single value (not 'all'). `month`, `type`,
  // and `scope` are intentionally NOT counted — those are usually
  // combined with an entity filter and don't represent "one thing".
  // `groupId === '__none__'` is treated as set (it's a deliberate
  // "categories without a group" filter, not the wildcard).
  function activeEntityFilterCount(f) {
    let n = 0;
    if (f.categoryId !== 'all') n++;
    if (f.groupId !== 'all' && f.groupId !== undefined) n++;
    if (f.userId !== 'all') n++;
    if (f.sourceId !== 'all') n++;
    if (f.payee !== 'all') n++;
    return n;
  }

  // Compact period label for the strip: "15 jun – 25 jun" within the
  // same year, "1 jan 2025 – 25 jun 2026" across years. The full
  // `Fmt.date` always includes the year which is noisy for the
  // common case where both endpoints are in the current year.
  function periodLabel(minDate, maxDate) {
    if (!minDate || !maxDate) return null;
    const sameYear = minDate.slice(0, 4) === maxDate.slice(0, 4);
    // en-US locale gives 'Jun' which is fine, but for the strip
    // we want lowercase 'jun' so the label reads as a range, not
    // two date stamps.
    const fmt = (iso, dropYear) => {
      const dt = new Date(iso);
      const m = dt.toLocaleDateString('en-US', { month: 'short' }).toLowerCase();
      const d = String(dt.getDate());
      return dropYear ? `${d} ${m}` : `${d} ${m} ${dt.getFullYear()}`;
    };
    if (minDate === maxDate) return fmt(minDate, sameYear);
    return `${fmt(minDate, sameYear)} \u2013 ${fmt(maxDate, false)}`;
  }

  function renderStatsStrip(list) {
    // Run the visibility check on the live filter, not on `list`
    // — the user may have set a filter that matches zero txns, and
    // we still want the strip to render (with `—` placeholders).
    if (activeEntityFilterCount(Router.txnFilters) !== 1) return null;

    const stats = Selectors.entityTransactionStats(list);
    const isEmpty = stats.count === 0;
    // The em-dash per cell keeps the strip at a uniform height when
    // the filter matches nothing; the spec's `txns.stats.empty`
    // message is shown in the tooltip so users on hover get the full
    // "no transactions" hint without us bloating each cell with the
    // same long string.
    const emptyTitle = t('txns.stats.empty');
    return el('div', { class: 'txn-stats-strip' },
      el('div', { class: 'txn-stats-cell', title: isEmpty ? emptyTitle : null },
        el('div', { class: 'tss-label' }, t('txns.stats.total')),
        el('div', { class: 'tss-value' }, isEmpty ? '\u2014' : Fmt.money(stats.total)),
      ),
      el('div', { class: 'txn-stats-cell', title: isEmpty ? emptyTitle : null },
        el('div', { class: 'tss-label' }, t('txns.stats.count')),
        el('div', { class: 'tss-value' }, isEmpty ? '\u2014' : String(stats.count)),
      ),
      el('div', { class: 'txn-stats-cell', title: isEmpty ? emptyTitle : null },
        el('div', { class: 'tss-label' }, t('txns.stats.avg')),
        el('div', { class: 'tss-value' }, isEmpty ? '\u2014' : Fmt.money(stats.avg)),
      ),
      el('div', { class: 'txn-stats-cell', title: isEmpty ? emptyTitle : null },
        el('div', { class: 'tss-label' }, t('txns.stats.period')),
        el('div', { class: 'tss-value' }, isEmpty ? '\u2014' : periodLabel(stats.minDate, stats.maxDate)),
      ),
    );
  }

  // -- Top-level render ---------------------------------------------
  function render() {
    const wrap = el('div', {});
    wrap.appendChild(renderFilters());
    const list = filteredTxns();
    // Stats strip renders even when `list` is empty \u2014 the user
    // has set a filter, so they want to see what (if anything) it
    // matched. We just hide the table body in that case.
    const strip = renderStatsStrip(list);
    if (strip) wrap.appendChild(strip);
    if (!list.length) {
      // Show the empty placeholder alongside the strip so the user
      // knows "yes, your filter is applied \u2014 no rows match".
      wrap.appendChild(emptyState(t('txn.empty.title'), t('txn.empty.msg')));
      return wrap;
    }
    wrap.appendChild(renderTable(list, { compact: false }));
    return wrap;
  }

  return {
    render,
    renderTable,
  };
})();
window.Transactions = Transactions;
