// =====================================================================
// views/categories-manage.js — Group management + categorised entity
// grids (formerly the body of views/categories.js).
//
// Re-homed in ISSUE-023: the `categories` route now points at the
// drill-down list view (views/categories.js — read-only totals per
// category). The CRUD UI here moved to a sibling route `categories-manage`
// so users can still add / edit / delete categories and groups.
// =====================================================================
// Reads: App._state
// Calls: window.Modals.{category,categoryDelete,group,groupDelete},
//        ViewHelpers.emptyState/escapeText
// =====================================================================

const CategoriesManage = (() => {
  function renderGroupCard(g) {
    return el('div', { class: 'entity' },
      el('div', { class: 'cat-swatch', style: { background: g.color } }, g.icon || '✦'),
      el('div', { style: { flex: 1, minWidth: 0 } },
        el('div', { class: 'e-name', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, g.name),
        el('div', { class: 'e-meta' }, `${g.icon || '✦'} · ${t('grp.section.title')}`),
      ),
      el('div', { class: 'e-actions' },
        el('button', { class: 'btn-icon', title: t('btn.edit'),   onclick: () => window.Modals.group(g.id), html: Icons.edit }),
        el('button', { class: 'btn-icon btn-danger', title: t('btn.delete'), onclick: () => window.Modals.groupDelete(g.id), html: Icons.trash }),
      ),
    );
  }

  function renderCategoryCard(c) {
    return el('div', { class: 'entity' + (c.active ? '' : ' inactive'), style: { '--cat-color': c.color } },
      el('div', { class: 'cat-swatch', style: { background: c.color } }, c.icon || '✦'),
      el('div', { style: { flex: 1, minWidth: 0 } },
        el('div', { class: 'e-name', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, c.name),
        el('div', { class: 'e-meta' }, c.active ? c.type : t('cat.inactive')),
      ),
      el('div', { class: 'e-actions' },
        el('button', { class: 'btn-icon', title: t('btn.edit'),   onclick: () => window.Modals.category(c.id), html: Icons.edit }),
        el('button', { class: 'btn-icon btn-danger', title: t('btn.delete'), onclick: () => window.Modals.categoryDelete(c.id), html: Icons.trash }),
      ),
    );
  }

  // A single group header inside the expense section. Tinted with the
  // group's color so it scans as a distinct band under the section banner.
  function renderExpenseGroupHead(g, count) {
    const head = el('div', { class: 'cat-group-head' });
    if (g) {
      head.appendChild(el('span', { class: 'cat-group-icon', style: { background: g.color } }, g.icon || '✦'));
      head.appendChild(el('span', { class: 'cat-group-name' }, g.name));
      head.dataset.groupId = g.id;
      head.style.borderLeftColor = g.color;
    } else {
      head.appendChild(el('span', { class: 'cat-group-icon cat-group-icon-none' }, '✦'));
      head.appendChild(el('span', { class: 'cat-group-name' }, t('grp.uncategorized')));
    }
    head.appendChild(el('span', { class: 'cat-group-count' }, String(count)));
    return head;
  }

  // Expenses get a warm (terracotta) banner and roll up under their
  // group headers — there are many expense categories and a hierarchy
  // helps scanability. Income stays flat: only a handful of categories
  // (typically 1–2) and grouping would add noise without value.
  function renderExpenseSection(cats) {
    const byGroup = new Map();
    for (const c of cats) {
      const key = c.groupId || '__none__';
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(c);
    }
    const groups = App._state.groups || [];
    const sortedGroups = [...groups].sort((a, b) => (a.order || 0) - (b.order || 0));
    const activeCount = cats.filter(c => c.active).length;

    const content = el('div', {});
    for (const g of sortedGroups) {
      const list = byGroup.get(g.id) || [];
      if (!list.length) continue;
      content.appendChild(renderExpenseGroupHead(g, list.length));
      const grid = el('div', { class: 'entity-grid' });
      list.forEach(c => grid.appendChild(renderCategoryCard(c)));
      content.appendChild(grid);
    }
    const ungrouped = byGroup.get('__none__') || [];
    if (ungrouped.length) {
      content.appendChild(renderExpenseGroupHead(null, ungrouped.length));
      const grid = el('div', { class: 'entity-grid' });
      ungrouped.forEach(c => grid.appendChild(renderCategoryCard(c)));
      content.appendChild(grid);
    }

    return el('div', { class: 'card cat-section cat-section--expense' },
      el('div', { class: 'cat-section-banner is-expense' },
        el('div', { class: 'cat-section-icon is-expense' }, '↑'),
        el('div', { style: { flex: '1', minWidth: '0' } },
          el('div', { class: 'cat-section-title' }, t('cat.section.expense.title')),
          el('div', { class: 'cat-section-sub muted' }, `${cats.length} ${t('cat.total')} · ${activeCount} ${t('cat.active')}`),
        ),
      ),
      cats.length ? content : ViewHelpers.emptyState(t('cat.section.expense.empty.title'), t('cat.section.expense.empty.msg')),
    );
  }

  // Income categories: flat, no grouping, sage banner.
  function renderIncomeSection(cats) {
    const activeCount = cats.filter(c => c.active).length;
    const grid = el('div', { class: 'entity-grid' });
    cats.forEach(c => grid.appendChild(renderCategoryCard(c)));

    return el('div', { class: 'card cat-section cat-section--income' },
      el('div', { class: 'cat-section-banner is-income' },
        el('div', { class: 'cat-section-icon is-income' }, '↓'),
        el('div', { style: { flex: '1', minWidth: '0' } },
          el('div', { class: 'cat-section-title' }, t('cat.section.income.title')),
          el('div', { class: 'cat-section-sub muted' }, `${cats.length} ${t('cat.total')} · ${activeCount} ${t('cat.active')}`),
        ),
      ),
      cats.length ? grid : ViewHelpers.emptyState(t('cat.section.income.empty.title'), t('cat.section.income.empty.msg')),
    );
  }

  // -- Top-level render ---------------------------------------------
  function render() {
    const wrap = el('div', {});

    // Groepen section sits above the category lists so users see what
    // grouping layer is available without having to scroll.
    const groups = App._state.groups || [];
    const groupsGrid = el('div', { class: 'entity-grid' });
    groups.forEach(g => groupsGrid.appendChild(renderGroupCard(g)));

    const groupsHead = el('div', { class: 'section-head' },
      el('div', { class: 'section-label' }, t('cat.section.manage')),
    );
    const addGrpBtn = el('button', { class: 'btn btn-sage', onclick: () => window.Modals.group() });
    addGrpBtn.innerHTML = `${Icons.plus} ${ViewHelpers.escapeText(t('grp.add'))}`;
    groupsHead.appendChild(addGrpBtn);
    const groupsCard = el('div', { class: 'card', style: { marginBottom: '24px' } },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' }, t('grp.section.title')),
        el('div', { class: 'muted', style: { fontSize: '.82rem' } }, t('grp.section.sub'))),
      groups.length ? groupsGrid : ViewHelpers.emptyState(t('grp.empty.title'), t('grp.empty.msg')),
    );
    wrap.appendChild(groupsHead);
    wrap.appendChild(groupsCard);

    const expenses = App._state.categories.filter(c => c.type === 'expense');
    const incomes  = App._state.categories.filter(c => c.type === 'income');
    wrap.appendChild(renderExpenseSection(expenses));
    wrap.appendChild(renderIncomeSection(incomes));

    const addBtn = el('button', { class: 'btn btn-sage', onclick: () => window.Modals.category(), style: { marginTop: '16px' } });
    addBtn.innerHTML = `${Icons.plus} ${ViewHelpers.escapeText(t('cat.add'))}`;
    wrap.appendChild(addBtn);

    return wrap;
  }

  return { render };
})();
window.CategoriesManage = CategoriesManage;