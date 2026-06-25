// modals/category.js — Add / edit / delete a category (ISSUE-009)
(function () {
  const { Store, Modal, CategoryIcons } = window;
  const t = window.t;

  function open(id) {
    const state = window.App._state;
    const editing = id ? state.categories.find(c => c.id === id) : null;
    // ISSUE-007: new categories start with groupId = null.
    const initial = editing || { name: '', type: 'expense', color: '#5a7248', icon: '✦', active: true, groupId: null };
    const sortedGroups = [...(state.groups || [])].sort((a, b) => (a.order || 0) - (b.order || 0));

    Modal.create({
      title: t(editing ? 'modal.cat.edit' : 'modal.cat.add'),
      saveLabel: t(editing ? 'btn.saveChanges' : 'btn.add'),
      fields: [
        { id: 'type', kind: 'tabs', options: [
          { value: 'expense', label: t('form.type.expense') },
          { value: 'income',  label: t('form.type.income') } ], value: initial.type },
        { id: 'name', kind: 'text', label: t('form.name'), placeholder: t('form.name.ph.cat'), value: initial.name },
        { id: 'color', kind: 'color-picker', label: t('form.color'), value: initial.color },
        { id: 'icon', kind: 'icon-grid', label: t('form.icons'), options: CategoryIcons, value: initial.icon || '✦' },
        { id: 'groupId', kind: 'select', label: t('form.group'), options: [
          { value: '', label: t('form.group.none') },
          ...sortedGroups.map(g => ({ value: g.id, label: g.name })),
        ], value: initial.groupId == null ? '' : initial.groupId },
        { id: 'active', kind: 'toggle', activeLabel: t('form.active'), inactiveLabel: t('form.inactive'),
          help: t('form.active.catHelp'), value: initial.active },
      ],
      onSave: (v) => {
        if (!v.name.trim()) return window.toast(t('toast.nameRequired')), false;
        const s = window.App._state;
        if (editing) { Store.updateCategory(s, editing.id, { ...v, groupId: v.groupId || null }); window.toast(t('toast.cat.updated')); }
        else         { Store.addCategory(s, { ...v, groupId: v.groupId || null }); window.toast(t('toast.cat.added')); }
        window.dispatchEvent(new Event('store:changed'));
      },
      onDelete: editing ? () => deleteOne(editing.id) : null,
    });
  }

  function deleteOne(id) {
    const cat = window.App._state.categories.find(c => c.id === id);
    if (window.App._state.transactions.some(t => t.categoryId === id)) return window.toast(window.t('toast.catInUse'));
    if (!window.confirmAction(window.t('confirm.cat', { name: cat.name }))) return;
    Store.deleteCategory(window.App._state, id);
    window.toast(window.t('toast.cat.deleted'));
    window.dispatchEvent(new Event('store:changed'));
  }

  window.Modals = /** @type {Window["Modals"]} */ (window.Modals || {});
  window.Modals.category = open;
  window.Modals.categoryDelete = deleteOne;
})();