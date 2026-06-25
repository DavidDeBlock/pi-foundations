// modals/group.js — Add / edit / delete a group (ISSUE-009, ISSUE-007)
(function () {
  const { Store, Modal } = window;
  const t = window.t;

  function open(id) {
    const state = window.App._state;
    const editing = id ? (state.groups || []).find(g => g.id === id) : null;
    const initial = editing || { name: '', color: '#5a7248', icon: '✦',
      order: (state.groups?.length || 0) + 1, active: true };

    Modal.create({
      title: t(editing ? 'modal.grp.edit' : 'modal.grp.add'),
      saveLabel: t(editing ? 'btn.saveChanges' : 'btn.add'),
      fields: [
        { id: 'name', kind: 'text', label: t('form.name'), placeholder: t('form.name.ph.cat'), value: initial.name },
        { id: 'color', kind: 'color-picker', label: t('form.color'), value: initial.color },
        { id: 'icon', kind: 'text', label: t('form.icon'), value: initial.icon || '✦' },
        { id: 'order', kind: 'number', label: t('form.order'), value: initial.order, step: '1', min: '1' },
      ],
      onSave: (v) => {
        if (!v.name.trim()) return window.toast(t('toast.nameRequired')), false;
        const s = window.App._state;
        if (editing) { Store.updateGroup(s, editing.id, v); window.toast(t('toast.grp.updated')); }
        else         { Store.addGroup(s, v); window.toast(t('toast.grp.added')); }
        window.dispatchEvent(new Event('store:changed'));
      },
      onDelete: editing ? () => deleteOne(editing.id) : null,
    });
  }

  function deleteOne(id) {
    const s = window.App._state;
    const grp = (s.groups || []).find(g => g.id === id);
    if (!grp) return;
    const refs = s.categories.filter(c => c.groupId === id).length;
    if (refs > 0) return window.toast(window.t('grp.delete.inUse', { n: refs, cat: refs === 1 ? 'categorie' : 'categorieën' }));
    if (!window.confirmAction(window.t('confirm.grp', { name: grp.name }))) return;
    Store.deleteGroup(s, id);
    window.toast(window.t('toast.grp.deleted'));
    window.dispatchEvent(new Event('store:changed'));
  }

  window.Modals = /** @type {Window["Modals"]} */ (window.Modals || {});
  window.Modals.group = open;
  window.Modals.groupDelete = deleteOne;
})();