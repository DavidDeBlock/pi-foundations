// =====================================================================
// views/_helpers.js — Helpers shared across view files
// =====================================================================
// Small, focused utilities used by more than one view:
//   - sum, countTxns, aggregateBy       (numeric reductions)
//   - emptyState                         (placeholder card)
//   - escapeText, escapeAttr             (HTML safety)
//   - field, option                      (form-row builders for filters)
//   - extractPayee, distinctPayees       (payee grouping; used by
//                                         Transactions + Payees views)
//   - bulkUpdatePayeeCategory            (called by Transactions filter
//                                         toolbar, Payees bulk-assign,
//                                         and the transaction modal's
//                                         "apply to all" checkbox)
// =====================================================================

const ViewHelpers = (() => {
  function sum(arr, key) {
    return arr.reduce((acc, x) => acc + (Number(x[key]) || 0), 0);
  }
  function countTxns(arr, type) {
    return arr.filter(x => x.type === type).length;
  }
  function aggregateBy(arr, key) {
    return arr.reduce((acc, x) => {
      acc[x[key]] = (acc[x[key]] || 0) + x.amount;
      return acc;
    }, {});
  }
  function emptyState(title, msg) {
    return el('div', { class: 'empty' },
      el('div', { class: 'empty-ill', html: Deco.emptyHero }),
      el('h3', {}, title),
      el('p', {}, msg),
    );
  }
  function escapeAttr(s) {
    return String(s ?? '').replace(/"/g, '&quot;');
  }
  function escapeText(s) {
    return String(s ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

  // Strip the boilerplate off ING Belgium descriptions and return the
  // merchant / counterparty name. The regex set lives in csv.js so it
  // stays next to the rest of the ING-format domain knowledge.
  const extractPayee = CSVImport.extractPayee;

  // Distinct payees across the in-scope transactions, with a count,
  // a "missing-category" count, and the most recent date + category.
  function distinctPayees() {
    const s = App._state;
    const map = new Map();
    for (const txn of Selectors.transactionsInScope(s)) {
      const name = extractPayee(txn.description) || '—';
      if (!map.has(name)) {
        map.set(name, { name, count: 0, noCategory: 0, lastDate: null, lastCategoryId: null });
      }
      const p = map.get(name);
      p.count++;
      if (!txn.categoryId) p.noCategory++;
      if (!p.lastDate || txn.date > p.lastDate) {
        p.lastDate = txn.date;
        p.lastCategoryId = txn.categoryId || null;
      }
    }
    return [...map.values()];
  }

  // Apply the same category to every in-scope transaction whose
  // extracted payee matches `name`. Empty string clears the category.
  //
  // ISSUE-005: also writes/clears `state.payeeCategories[name]` so
  // future CSV imports of this payee come in pre-categorised. The
  // mapping is updated even when no in-scope transactions match, so
  // users can pre-seed a mapping for a payee that has no transactions
  // yet.
  function bulkUpdatePayeeCategory(name, categoryId) {
    const s = App._state;
    let count = 0;
    for (const txn of Selectors.transactionsInScope(s)) {
      if (extractPayee(txn.description) !== name) continue;
      Store.updateTransaction(s, txn.id, { categoryId: categoryId });
      count++;
    }
    Store.setPayeeCategory(s, name, categoryId);
    if (count === 0) return;
    toast(t('toast.payeeSet', { n: count }));
    window.dispatchEvent(new Event('store:changed'));
  }

  return {
    sum,
    countTxns,
    aggregateBy,
    emptyState,
    escapeAttr,
    escapeText,
    field,
    option,
    extractPayee,
    distinctPayees,
    bulkUpdatePayeeCategory,
  };
})();
window.ViewHelpers = ViewHelpers;
