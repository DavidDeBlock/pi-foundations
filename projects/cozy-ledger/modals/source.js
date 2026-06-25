// modals/source.js — Add / edit / delete a source (ISSUE-009)
(function () {
  const { Store, Modal } = window;
  const t = window.t;

  function open(id) {
    const state = window.App._state;
    const editing = id ? state.sources.find(s => s.id === id) : null;
    const initial = editing || { name: '', type: 'bank', ownerId: '', active: true };

    Modal.create({
      title: t(editing ? 'modal.src.edit' : 'modal.src.add'),
      saveLabel: t(editing ? 'btn.saveChanges' : 'btn.add'),
      fields: [
        { id: 'name', kind: 'text', label: t('form.name'), placeholder: t('form.name.ph.src'), value: initial.name },
        { id: 'type', kind: 'select', label: t('form.type'), options: [
          { value: 'bank', label: t('form.bank') },
          { value: 'cash', label: t('form.cash') },
          { value: 'savings', label: t('form.savings') },
          { value: 'other', label: t('form.other') },
        ], value: initial.type },
        { id: 'ownerId', kind: 'select', label: t('form.owner'), options: [
          { value: '', label: t('form.owner.none') },
          ...state.users.map(u => ({ value: u.id, label: u.name })),
        ], value: initial.ownerId || '' },
        { id: 'active', kind: 'toggle', activeLabel: t('form.active'), inactiveLabel: t('form.inactive'),
          help: t('form.active.srcHelp'), value: initial.active },
      ],
      onSave: (v) => {
        if (!v.name.trim()) return window.toast(t('toast.nameRequired')), false;
        const s = window.App._state;
        if (editing) { Store.updateSource(s, editing.id, { ...v, ownerId: v.ownerId || null }); window.toast(t('toast.src.updated')); }
        else         { Store.addSource(s, { ...v, ownerId: v.ownerId || null }); window.toast(t('toast.src.added')); }
        window.dispatchEvent(new Event('store:changed'));
      },
      onDelete: editing ? () => deleteOne(editing.id) : null,
    });
  }

  function deleteOne(id) {
    const s = window.App._state;
    const src = s.sources.find(x => x.id === id);
    if (s.transactions.some(t => t.sourceId === id)) return window.toast(window.t('toast.srcInUse'));
    if (!window.confirmAction(window.t('confirm.src', { name: src.name }))) return;
    Store.deleteSource(s, id);
    window.toast(window.t('toast.src.deleted'));
    window.dispatchEvent(new Event('store:changed'));
  }

  window.Modals = window.Modals || {};
  window.Modals.source = open;
  window.Modals.sourceDelete = deleteOne;
})();