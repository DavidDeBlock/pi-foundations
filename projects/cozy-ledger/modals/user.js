// modals/user.js — Add / edit / delete a user (ISSUE-009)
(function () {
  const { Store, Modal } = window;
  const t = window.t;

  function open(id) {
    const state = window.App._state;
    const editing = id ? state.users.find(u => u.id === id) : null;
    const initial = editing || { name: '', color: '#5a7248', active: true };

    Modal.create({
      title: t(editing ? 'modal.usr.edit' : 'modal.usr.add'),
      saveLabel: t(editing ? 'btn.saveChanges' : 'btn.add'),
      fields: [
        { id: 'name', kind: 'text', label: t('form.name'), placeholder: t('form.name.ph.usr'), value: initial.name },
        { id: 'color', kind: 'color-picker', label: t('form.color'), value: initial.color },
        { id: 'active', kind: 'toggle', activeLabel: t('form.active'), inactiveLabel: t('form.inactive'),
          help: t('form.active.usrHelp'), value: initial.active },
      ],
      onSave: (v) => {
        if (!v.name.trim()) return window.toast(t('toast.nameRequired')), false;
        const s = window.App._state;
        if (editing) { Store.updateUser(s, editing.id, v); window.toast(t('toast.usr.updated')); }
        else         { Store.addUser(s, v); window.toast(t('toast.usr.added')); }
        window.dispatchEvent(new Event('store:changed'));
      },
      onDelete: editing ? () => deleteOne(editing.id) : null,
    });
  }

  function deleteOne(id) {
    const s = window.App._state;
    const u = s.users.find(x => x.id === id);
    if (s.transactions.some(t => t.paidByUserId === id)) return window.toast(window.t('toast.usrInUse'));
    if (!window.confirmAction(window.t('confirm.usr', { name: u.name }))) return;
    Store.deleteUser(s, id);
    window.toast(window.t('toast.usr.deleted'));
    window.dispatchEvent(new Event('store:changed'));
  }

  window.Modals = window.Modals || {};
  window.Modals.user = open;
  window.Modals.userDelete = deleteOne;
})();