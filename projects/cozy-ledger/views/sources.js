// =====================================================================
// views/sources.js — Bank account / wallet management
// =====================================================================
// Reads: App._state
// Calls: window.Modals.{source,sourceDelete}, ViewHelpers.emptyState
// =====================================================================

const Sources = (() => {
  function renderSourceCard(s) {
    const owner = s.ownerId ? App._state.users.find(u => u.id === s.ownerId) : null;
    const sharedTxt = s.ownerId ? '' : t('src.meta.shared');
    return el('div', { class: 'entity' + (s.active ? '' : ' inactive') },
      el('div', { class: 'cat-swatch', style: { background: 'var(--beige)', color: 'var(--wood-dark)' }, html: Icons.wallet }),
      el('div', { style: { flex: 1, minWidth: 0 } },
        el('div', { class: 'e-name', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, s.name),
        el('div', { class: 'e-meta' }, `${s.type}${owner ? ' · ' + owner.name : (sharedTxt ? ' · ' + sharedTxt : '')}${s.active ? '' : ' · ' + t('cat.inactive')}`),
      ),
      el('div', { class: 'e-actions' },
        el('button', { class: 'btn-icon', title: t('btn.edit'),   onclick: () => window.Modals.source(s.id), html: Icons.edit }),
        el('button', { class: 'btn-icon btn-danger', title: t('btn.delete'), onclick: () => window.Modals.sourceDelete(s.id), html: Icons.trash }),
      ),
    );
  }

  function render() {
    const wrap = el('div', {});
    const head = el('div', { class: 'section-head' },
      el('div', { class: 'section-label' }, t('src.section.manage')),
    );
    const addBtn = el('button', { class: 'btn btn-sage', onclick: () => window.Modals.source() });
    addBtn.innerHTML = `${Icons.plus} ${ViewHelpers.escapeText(t('src.add'))}`;
    head.appendChild(addBtn);
    wrap.appendChild(head);

    const grid = el('div', { class: 'entity-grid' });
    App._state.sources.forEach(s => grid.appendChild(renderSourceCard(s)));
    wrap.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' }, t('src.card.title')),
        el('div', { class: 'muted', style: { fontSize: '.82rem' } }, `${App._state.sources.filter(s => s.active).length} ${t('cat.active')}`)),
      App._state.sources.length ? grid : ViewHelpers.emptyState(t('src.empty.title'), t('src.empty.msg')),
    ));
    return wrap;
  }

  return { render };
})();
window.Sources = Sources;
