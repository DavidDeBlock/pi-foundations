// modals/transaction.js — Add / edit / delete a transaction (ISSUE-009)
(function () {
  const { Store, Selectors, Modal, Icons, Fmt, CSVImport } = window;
  const t = window.t;
  const extractPayee = CSVImport.extractPayee;

  function open(id) {
    const state = window.App._state;
    const isEdit = !!id;
    const editing = isEdit ? state.transactions.find(x => x.id === id) : null;
    const u0 = state.users[0]?.id || '', s0 = state.sources[0]?.id || '';
    const initial = editing || { type: 'expense', amount: 0, date: Fmt.today(), description: '',
      categoryId: '', paidByUserId: u0, sourceId: s0, scope: 'private', notes: '' };

    Modal.create({
      title: t(isEdit ? 'modal.txn.edit' : 'modal.txn.add'),
      saveLabel: t(isEdit ? 'btn.saveChanges' : 'modal.txn.add'),
      fields: [
        { id: 'type', kind: 'tabs', options: [
          { value: 'expense', label: t('form.type.expense') },
          { value: 'income',  label: t('form.type.income') } ] },
        { id: 'amount', kind: 'number', label: t('form.amount'), value: initial.amount },
        { id: 'date', kind: 'date', label: t('form.date'), value: initial.date },
        { id: 'categoryId', kind: 'select', label: t('form.category'),
          options: (v) => state.categories.filter(c => c.type === (v.type || initial.type))
            .map(c => ({ value: c.id, label: c.name })), value: initial.categoryId },
        { id: 'description', kind: 'text', label: t('form.description'),
          placeholder: t('form.descPlaceholder'), value: initial.description },
        { id: 'paidByUserId', kind: 'select', label: t('form.paidBy'),
          options: state.users.filter(u => u.active).map(u => ({ value: u.id, label: u.name })),
          value: initial.paidByUserId },
        { id: 'sourceId', kind: 'select', label: t('form.source'),
          options: state.sources.filter(s => s.active).map(s => ({ value: s.id, label: s.name })),
          value: initial.sourceId },
        { id: 'scope', kind: 'scope-pick', options: [
          { value: 'private', label: t('txn.scope.private'), icon: Icons.user },
          { value: 'shared',  label: t('txn.scope.shared'),  icon: Icons.globe } ], value: initial.scope },
        { id: 'notes', kind: 'textarea', label: t('form.notes'),
          placeholder: t('form.notesPh'), value: initial.notes || '' },
        { id: 'applyAll', kind: 'checkbox', visible: (v, ctx) => {
          const name = extractPayee(v.description || '');
          if (!name) return false;
          const others = Selectors.transactionsInScope(state)
            .filter(x => x.id !== id && extractPayee(x.description) === name).length;
          if (others === 0) return false;
          const text = ctx.body.querySelector('#f-applyAll-text');
          if (text) text.innerHTML = t('applyAll.template', { n: others, name });
          const cb = ctx.body.querySelector('#f-applyAll-cb');
          if (cb) cb.checked = !!state.settings.applyCategoryToPayee;
          return true;
        } },
      ],
      onSave: (v) => {
        if (!v.amount || v.amount <= 0) return window.toast(t('toast.amountRequired')), false;
        if (!v.date) return window.toast(t('toast.dateRequired')), false;
        if (!v.categoryId) return window.toast(t('toast.catRequired')), false;
        if (!v.paidByUserId) return window.toast(t('toast.userRequired')), false;
        if (!v.sourceId) return window.toast(t('toast.sourceRequired')), false;
        const s = window.App._state;
        if (isEdit) { Store.updateTransaction(s, id, v); window.toast(t('toast.txn.updated')); }
        else        { Store.addTransaction(s, v);     window.toast(t('toast.txn.added')); }
        const propagated = (isEdit && v.applyAll)
          ? window.App.bulkUpdatePayeeCategory(extractPayee(v.description), v.categoryId) : 0;
        if (propagated === 0) window.dispatchEvent(new Event('store:changed'));
      },
      onDelete: isEdit ? () => deleteOne(id) : null,
    });
  }

  function deleteOne(id) {
    if (!window.confirmAction(t('confirm.txn'))) return;
    Store.deleteTransaction(window.App._state, id);
    window.toast(t('toast.txn.deleted'));
    window.dispatchEvent(new Event('store:changed'));
  }

  window.Modals = /** @type {Window['Modals']} */ (window.Modals || {});
  window.Modals.transaction = open;
  window.Modals.transactionDelete = deleteOne;
})();