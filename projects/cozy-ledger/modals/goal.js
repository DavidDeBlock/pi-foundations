// =====================================================================
// modals/goal.js — Add / edit a savings goal (ISSUE-017)
// =====================================================================
// Two flows live here:
//   - Add/Edit modal:    Modal.create with name / target / targetDate /
//                        notes fields. Save calls Store.addGoal or
//                        Store.updateGoal.
//   - Delete confirm:    window.confirmAction + Store.deleteGoal.
// Inline fund-from is handled by views/goals.js (per-row form).
// =====================================================================

(function () {
  const { Store, Modal } = window;
  const t = window.t;

  function open(id) {
    const state = window.App._state;
    const editing = id ? (state.goals || []).find(g => g.id === id) : null;
    const initial = editing || { name: '', target: '', targetDate: '', notes: '' };

    Modal.create({
      title: t(editing ? 'goals.edit' : 'goals.add'),
      saveLabel: t(editing ? 'btn.saveChanges' : 'btn.add'),
      fields: [
        { id: 'name', kind: 'text', label: t('goals.form.name'), placeholder: t('goals.form.name'), value: initial.name || '' },
        { id: 'target', kind: 'number', label: t('goals.form.target'), placeholder: '0,00', value: initial.target || '', min: '0.01', step: '0.01' },
        { id: 'targetDate', kind: 'date', label: t('goals.form.targetDate'), value: initial.targetDate || '' },
        { id: 'notes', kind: 'textarea', label: t('goals.form.notes'), placeholder: '', value: initial.notes || '', rows: 3 },
      ],
      onSave: (v) => {
        const name = (v.name || '').trim();
        if (!name) return window.toast(t('goals.err.nameRequired')), false;
        const target = Number(v.target);
        if (!isFinite(target) || target <= 0) return window.toast(t('goals.err.targetRequired')), false;
        const patch = {
          name,
          target,
          targetDate: v.targetDate || null,
          notes: v.notes || '',
        };
        const s = window.App._state;
        if (editing) {
          Store.updateGoal(s, editing.id, patch);
          window.toast(t('goals.updated'));
        } else {
          Store.addGoal(s, patch);
          window.toast(t('goals.added'));
        }
        window.dispatchEvent(new Event('store:changed'));
      },
      onDelete: editing ? () => deleteOne(editing.id) : null,
    });
  }

  function deleteOne(id) {
    const goal = (window.App._state.goals || []).find(g => g.id === id);
    if (!goal) return;
    if (!window.confirmAction(window.t('goals.delete.confirm'))) return;
    Store.deleteGoal(window.App._state, id);
    window.toast(window.t('goals.deleted'));
    window.dispatchEvent(new Event('store:changed'));
  }

  window.Modals = /** @type {Window["Modals"]} */ (window.Modals || {});
  window.Modals.goal = open;
  window.Modals.goalDelete = deleteOne;
})();
