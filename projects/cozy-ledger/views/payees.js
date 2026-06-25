// =====================================================================
// views/payees.js — Payee roster with bulk category assignment
// =====================================================================
// Reads: App._state
// Calls: Router.{goTo,setTxnFilter}, ViewHelpers.{bulkUpdatePayeeCategory,
//        distinctPayees,emptyState,escapeText,option}
// =====================================================================

const Payees = (() => {
  function render() {
    const payees = ViewHelpers.distinctPayees();
    const needsCount = payees.filter(p => p.noCategory > 0).length;
    const wrap = el('div', {});

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
      wrap.appendChild(ViewHelpers.emptyState(t('payee.empty.title'), t('payee.empty.msg')));
      return wrap;
    }

    // Sort: needs-cat first, then by count desc, then name asc.
    payees.sort((a, b) => (b.noCategory - a.noCategory) || (b.count - a.count) || a.name.localeCompare(b.name));

    const tbl = el('table', { class: 'txn-table' });
    tbl.innerHTML = `
      <thead><tr>
        <th>${ViewHelpers.escapeText(t('payee.th.payee'))}</th>
        <th class="right">${ViewHelpers.escapeText(t('payee.th.count'))}</th>
        <th class="right">${ViewHelpers.escapeText(t('payee.th.needCat'))}</th>
        <th>${ViewHelpers.escapeText(t('payee.th.lastCat'))}</th>
        <th>${ViewHelpers.escapeText(t('payee.th.lastSeen'))}</th>
        <th>${ViewHelpers.escapeText(t('payee.th.bulk'))}</th>
      </tr></thead>
      <tbody></tbody>`;
    const tb = tbl.querySelector('tbody');
    const catsByType = { expense: [], income: [] };
    for (const c of App._state.categories) {
      if (catsByType[c.type]) catsByType[c.type].push(c);
    }
    for (const p of payees) {
      const lastCat = p.lastCategoryId ? App._state.categories.find(c => c.id === p.lastCategoryId) : null;
      const tr = el('tr', { class: 'clickable', onclick: (e) => {
        if (e.target.closest('select, button, input')) return;
        Router.setTxnFilter('payee', p.name);
        Router.goTo('transactions');
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
      const select = el('select', {
        class: 'select',
        title: t('applyAll.template', { n: p.count, name: p.name }),
        onchange: (e) => {
          ViewHelpers.bulkUpdatePayeeCategory(p.name, e.target.value);
        },
      },
        ViewHelpers.option('', t('payee.bulk.pick'), !lastCat),
        catsByType.expense.length ? el('optgroup', { label: t('payee.opt.expense') }, ...catsByType.expense.map(c => ViewHelpers.option(c.id, c.name, lastCat && lastCat.id === c.id))) : null,
        catsByType.income.length ? el('optgroup', { label: t('payee.opt.income') }, ...catsByType.income.map(c => ViewHelpers.option(c.id, c.name, lastCat && lastCat.id === c.id))) : null,
      );
      tr.appendChild(el('td', {}, select));
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
    wrap.appendChild(tbl);

    return wrap;
  }

  return { render };
})();
window.Payees = Payees;
