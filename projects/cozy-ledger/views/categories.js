// =====================================================================
// views/categories.js — Categories list page (ISSUE-023, Slice C of
// PRD-006). Read-only totals per category, sorted by this-month spend
// desc, every row drillable into the category detail view (ISSUE-021).
//
// The CRUD / group-management UI lives in views/categories-manage.js
// at the `categories-manage` route. From here we link to it via a
// "Beheer" button in the header so power-users aren't stuck.
// =====================================================================
// Reads: App._state
// Calls: Selectors.allCategoryTotals, Router.goTo
// =====================================================================

const Categories = (() => {
  // -- Header ---------------------------------------------------------
  // Two-line header: title + count, with a right-aligned button that
  // links to the management page. The button only renders when
  // `categories-manage` is wired (it's always wired in our app, but
  // we keep the link's presence cheap to gate if needed).
  function renderHeader(count) {
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title', html: Icons.tags }),
        el('div', { style: { flex: '1', minWidth: '0' } },
          el('div', { class: 'card-title-text' }, t('categories.title')),
          el('div', { class: 'muted', style: { fontSize: '.82rem' } },
            t('categories.count', { n: count })),
        ),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          onclick: () => Router.goTo('categories-manage'),
          title: t('categories.manage.title'),
        }, t('categories.manage.btn')),
      ),
    );
  }

  // -- Column header row --------------------------------------------
  // The "this-month" header carries a sort arrow so users know the list
  // is currently sorted by that column. Click-sort is out of scope for
  // ISSUE-023 — only the default sort ships.
  function renderColumnHead() {
    return el('div', { class: 'categories-list-row categories-list-row--head' },
      el('div', { class: 'categories-col col-name' }, t('categories.col.name')),
      el('div', { class: 'categories-col col-month' },
        t('categories.col.thisMonth'),
        el('span', { class: 'categories-sort-indicator', 'aria-hidden': 'true', title: t('categories.sort.thisMonth') }, ' ↓'),
      ),
      el('div', { class: 'categories-col col-year' }, t('categories.col.thisYear')),
      el('div', { class: 'categories-col col-count' }, t('categories.col.count')),
      el('div', { class: 'categories-col col-pct' }, t('categories.col.percent')),
    );
  }

  // -- One row per category ----------------------------------------
  // A real <button> for free keyboard support (Enter/Space) and
  // proper semantic markup; CSS resets native button styling to match
  // a plain row. data-cat-id lets tests target rows by id without
  // depending on visible text.
  function renderRow(row) {
    const cat = row.category;
    return el('button', {
      class: 'categories-list-row clickable',
      type: 'button',
      onclick: () => Router.goTo('category-' + cat.id),
      'data-cat-id': cat.id,
    },
      el('div', { class: 'categories-col col-name' },
        el('div', { class: 'cat-swatch', style: { background: cat.color } }, cat.icon || '✦'),
        el('div', { class: 'categories-name' }, cat.name),
      ),
      el('div', { class: 'categories-col col-month' }, Fmt.money(row.thisMonth)),
      el('div', { class: 'categories-col col-year' }, Fmt.money(row.thisYear)),
      el('div', { class: 'categories-col col-count' }, String(row.count)),
      el('div', { class: 'categories-col col-pct' }, row.percentOfExpenses.toFixed(0) + '%'),
    );
  }

  // -- List card -----------------------------------------------------
  function renderList(rows) {
    const card = el('div', { class: 'card', style: { marginTop: '16px' } },
      el('div', { class: 'card-head', style: { padding: '0 12px 8px 12px' } },
        // Reuse the column-head row as the card's first line so it
        // sits flush against the rows underneath.
        renderColumnHead(),
      ),
      el('div', { class: 'categories-list', 'data-testid': 'categories-list' },
        ...rows.map(renderRow),
      ),
    );
    return card;
  }

  // -- Top-level render ---------------------------------------------
  function render() {
    const rows = Selectors.allCategoryTotals(App._state);
    const wrap = el('div', {});

    wrap.appendChild(renderHeader(rows.length));

    if (rows.length === 0) {
      wrap.appendChild(el('div', { class: 'card', style: { marginTop: '16px' } },
        ViewHelpers.emptyState(t('categories.empty.title'), t('categories.empty.msg'))));
      return wrap;
    }

    wrap.appendChild(renderList(rows));
    return wrap;
  }

  return { render };
})();
window.Categories = Categories;