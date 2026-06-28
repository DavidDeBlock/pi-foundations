// =====================================================================
// views/category-detail.js — Drill-down for one category (ISSUE-021)
// =====================================================================
// Reads: App._state
// Calls: Selectors.categoryTotals / categoryMonthlyTrend /
//        topPayeesInCategory / recentTransactionsForCategory,
//        EntityDetail.render, Router.goTo, Router.setTxnFilter,
//        Router.pendingEnvelopeInit setter, window.Modals.envelope
//
// Slice A of PRD-006. The view owns:
//   1. Resolve the `:id` from the route (passed in by Router).
//   2. Fetch the category from state; show the not-found empty state
//      when the id no longer matches anything.
//   3. Run the four selectors above (in-scope, current month/year).
//   4. Hand the pre-computed pieces to EntityDetail.render with a
//      `kind: 'category'` flag so the shared chrome knows which
//      swatch/title to draw.
//   5. Provide the route-specific CTA: "Envelop instellen voor deze
//      categorie" — sets Router.pendingEnvelopeInit and routes to the
//      envelopes page, where the modal opens pre-filled.
//   6. Wire the "View all transactions" link: set the txn filter
//      to this category and goTo('transactions').
//
// Back button: history.back() if there is one, otherwise the
// categories list. The payee detail (ISSUE-024) mirrors this shape;
// the shared EntityDetail renderer keeps the two wrappers small.
// =====================================================================

const CategoryDetail = (() => {
  // Set the txn filter and navigate. Setting before goTo so the
  // transactions view reads the fresh filter from Router.txnFilters
  // on its first render (Router.renderView() runs synchronously).
  function viewAllTransactions(categoryId) {
    Router.setTxnFilter('categoryId', categoryId);
    Router.goTo('transactions');
  }

  // Pre-fill payload consumed by views/envelopes.js render(). We
  // don't pass `name` here — the user can name the envelope freely;
  // pre-naming it from the category name would be presumptuous and
  // could collide with envelopes they already have for that
  // category.
  function gotoEnvelopesWithPrefill(categoryId) {
    Router.pendingEnvelopeInit = { categoryIds: [categoryId] };
    Router.goTo('envelopes');
  }

  function render({ categoryId } = {}) {
    const state = App._state;
    const category = (state.categories || []).find(c => c && c.id === categoryId);

    // Not found: render a small empty card so the user can navigate
    // back. We don't re-route automatically — the back button is
    // explicit so a stale deep-link doesn't bounce them around.
    if (!category) {
      return el('div', { class: 'entity-detail' },
        ViewHelpers.emptyState(
          t('categoryDetail.notFound'),
          t('entityDetail.notFoundHint', { id: categoryId || '' }),
        ),
        el('div', { class: 'entity-detail-actions' },
          el('button', { class: 'btn btn-ghost', onclick: () => Router.goTo('categories') },
            '\u2190 ' + t('categoryDetail.back')),
        ),
      );
    }

    // Compute the four pre-computed pieces. Selectors handle
    // scope (in-scope only), date windows (current month / current
    // year), and defensive fallbacks for empty data.
    const totals = Selectors.categoryTotals(state, categoryId);
    const trend = Selectors.categoryMonthlyTrend(state, categoryId);
    const topPayees = Selectors.topPayeesInCategory(state, categoryId);
    const recent = Selectors.recentTransactionsForCategory(state, categoryId);

    // ISSUE-024: top-payee rows in the category detail are now
    // clickable \u2014 clicking a payee navigates to that payee's detail
    // view. We slugify here so the data attribute matches the
    // router's `payee-{slug}` convention. (The click handler itself
    // closes over the live payeeName, so the slug is purely cosmetic
    // for test targeting.)
    const onPayeeClick = (row) => Router.goTo(
      'payee-' + ViewHelpers.slugifyPayee(row.payeeName));

    // Patch the page title/sub from the entity name. Router's title
    // map doesn't know about detail views (they're parameterised by
    // id), so we mutate the title elements directly here. Kept
    // idempotent so re-renders from store:changed don't pile up.
    // Use textContent (not innerHTML) — the entity name is plain text
    // and we don't need markup; this also plays nicely with the
    // test stub which doesn't parse innerHTML assignments.
    const pageTitle = document.querySelector('#page-title');
    const pageSub = document.querySelector('#page-sub');
    if (pageTitle) pageTitle.textContent = t('categoryDetail.title', { name: category.name });
    if (pageSub) pageSub.textContent = '';

    // Extra CTA: "Set envelope for this category". Passes an
    // onClick that sets the pending init and routes — the envelopes
    // view reads the init on its next render and opens the modal.
    const setEnvelopeBtn = el('button', {
      class: 'btn btn-primary',
      onclick: () => gotoEnvelopesWithPrefill(categoryId),
    }, '\u2728 ' + t('categoryDetail.setEnvelope'));

    return EntityDetail.render({
      kind: 'category',
      entity: category,
      totals,
      trend,
      topList: {
        title: t('categoryDetail.topPayees'),
        rows: topPayees,
        onRowClick: onPayeeClick,
      },
      recent,
      viewAllHref: () => viewAllTransactions(categoryId),
      backHref: () => Router.goTo('categories'),
      extraActions: [setEnvelopeBtn],
    });
  }

  return { render };
})();
window.CategoryDetail = CategoryDetail;