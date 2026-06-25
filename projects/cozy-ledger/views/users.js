// =====================================================================
// views/users.js — Household member management
// =====================================================================
// Reads: App._state
// Calls: window.Modals.{user,userDelete}, ViewHelpers.emptyState
// =====================================================================

const Users = (() => {
  function renderUserCard(u) {
    return el('div', { class: 'entity' + (u.active ? '' : ' inactive') },
      el('div', { class: 'cat-swatch', style: { background: u.color }, html: Icons.user }),
      el('div', { style: { flex: 1, minWidth: 0 } },
        el('div', { class: 'e-name', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, u.name),
        el('div', { class: 'e-meta' }, u.active ? t('cat.active') : t('cat.inactive')),
      ),
      el('div', { class: 'e-actions' },
        el('button', { class: 'btn-icon', title: t('btn.edit'),   onclick: () => window.Modals.user(u.id), html: Icons.edit }),
        el('button', { class: 'btn-icon btn-danger', title: t('btn.delete'), onclick: () => window.Modals.userDelete(u.id), html: Icons.trash }),
      ),
    );
  }

  function render() {
    const wrap = el('div', {});
    const head = el('div', { class: 'section-head' },
      el('div', { class: 'section-label' }, t('usr.section.manage')),
    );
    const addBtn = el('button', { class: 'btn btn-sage', onclick: () => window.Modals.user() });
    addBtn.innerHTML = `${Icons.plus} ${ViewHelpers.escapeText(t('usr.add'))}`;
    head.appendChild(addBtn);
    wrap.appendChild(head);

    const grid = el('div', { class: 'entity-grid' });
    App._state.users.forEach(u => grid.appendChild(renderUserCard(u)));
    wrap.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' }, t('usr.card.title')),
        el('div', { class: 'muted', style: { fontSize: '.82rem' } }, `${App._state.users.filter(u => u.active).length} ${t('cat.active')}`)),
      App._state.users.length ? grid : ViewHelpers.emptyState(t('usr.empty.title'), t('usr.empty.msg')),
    ));
    return wrap;
  }

  return { render };
})();
window.Users = Users;
