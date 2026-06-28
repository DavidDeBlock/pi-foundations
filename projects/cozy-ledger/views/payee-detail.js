// =====================================================================
// views/payee-detail.js — Drill-down for one payee (ISSUE-024)
//
// Mirrors views/category-detail.js: parse the `:id` (which is the
// payee-name slug passed by the router), resolve the canonical name
// via ViewHelpers.unsplitPayeeSlug, fetch the four pre-computed
// pieces via the new payee selectors, and hand them to
// EntityDetail.render with `kind: 'payee'`.
//
// Payees are not first-class entities (they're extracted from the
// free-text CSV `description` field), so there's no state.payees
// lookup; the not-found check is "no in-scope transaction extracts
// to this name", not "the entity doesn't exist".
//
// No envelope CTA — the PRD restricts that to categories for v1.
// =====================================================================

const PayeeDetail = (() => {
  // Set the txn filter and navigate, identical pattern to the
  // category view so the back/forth between the two detail pages
  // feels consistent.
  function viewAllTransactions(payeeName) {
    Router.setTxnFilter('payee', payeeName);
    Router.goTo('transactions');
  }

  function render({ payeeSlug } = {}) {
    // The router hands us the raw slug; resolve it back to a name
    // by scanning distinctPayees() for a slugify match. unsplit-
    // PayeeSlug falls back to the raw slug when nothing matches,
    // which makes the not-found path render a sensible empty state
    // instead of throwing.
    const payeeName = ViewHelpers.unsplitPayeeSlug(payeeSlug);

    // Build a state-like proxy from the four selectors. The recent
    // list is the most authoritative "this payee exists" check —
    // if it's empty AND the totals are zero, the slug genuinely
    // doesn't resolve to any in-scope activity.
    const state = App._state;
    const recent = Selectors.recentTransactionsForPayee(state, payeeName);
    const totals = Selectors.payeeTotals(state, payeeName);

    if (!recent.length && totals.thisYear === 0 && totals.count === 0) {
      return el('div', { class: 'entity-detail' },
        ViewHelpers.emptyState(
          t('payeeDetail.notFound'),
          t('entityDetail.notFoundHint', { id: payeeName || payeeSlug || '' }),
        ),
        el('div', { class: 'entity-detail-actions' },
          el('button', { class: 'btn btn-ghost', onclick: () => Router.goTo('payees') },
            '\u2190 ' + t('payeeDetail.back')),
        ),
      );
    }

    const trend = Selectors.payeeMonthlyTrend(state, payeeName);
    const topCategories = Selectors.topCategoriesForPayee(state, payeeName);

    // Patch the page title/sub from the entity name. Mirrors
    // CategoryDetail's pattern exactly. textContent (not innerHTML)
    // because the payee name is plain text and the test stub doesn't
    // parse innerHTML assignments.
    const pageTitle = document.querySelector('#page-title');
    const pageSub = document.querySelector('#page-sub');
    if (pageTitle) pageTitle.textContent = t('payeeDetail.title', { name: payeeName });
    if (pageSub) pageSub.textContent = '';

    // Build the row shape that EntityDetail.renderTopList expects.
    // We use `category` (not `payeeName`) so the renderer takes the
    // category branch in `r.category ? r.category.name : r.payeeName`,
    // and we attach an onRowClick so the rows are clickable buttons
    // that navigate to the matching category detail view (ISSUE-024
    // acceptance: top-categories rows are clickable).
    return EntityDetail.render({
      kind: 'payee',
      entity: payeeName,
      totals,
      trend,
      topList: {
        title: t('payeeDetail.topCategories'),
        rows: topCategories.map(r => ({
          category: r.category,
          total: r.total,
          count: r.count,
        })),
        onRowClick: (row) => Router.goTo('category-' + row.category.id),
      },
      recent,
      viewAllHref: () => viewAllTransactions(payeeName),
      backHref: () => Router.goTo('payees'),
      // No `extraActions` — per the PRD, "Set envelope for this
      // payee" is a v2 follow-up, not v1.
    });
  }

  return { render };
})();
window.PayeeDetail = PayeeDetail;