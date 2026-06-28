// =====================================================================
// modals/envelope.js — Add / edit / delete a spending envelope (ISSUE-018)
// =====================================================================
// Three flows live here:
//   - Add/Edit modal:    Modal.create with name / cap / period /
//                        categoryIds (chip multi-select) / payeeIds
//                        (chip multi-select) / notes. The multi-select
//                        fields use the custom field kind because the
//                        modal helper has no native checkbox-group
//                        renderer yet.
//   - Delete confirm:    window.confirmAction + Store.deleteEnvelope.
// =====================================================================

(function () {
  const { Store, Modal } = window;
  const t = window.t;

  // ---- Chip multi-select -------------------------------------------
  // A row of togglable chips, one per available option. Clicking
  // toggles the option's presence in the field's value array. Used
  // for both categoryIds and payeeIds; the option list is supplied
  // by the caller because categories and payees come from different
  // selectors (state.categories vs. ViewHelpers.distinctPayees()).
  //
  // Rendering lives in a `kind: 'custom'` block so we own the markup;
  // the value is read back from the DOM (`.chip-on` class) at save
  // time so the modal framework can stay declarative.
  function chipMultiSelect(fieldId, label, options, selectedIds) {
    // options: [{id, label}], selectedIds: string[]
    const selected = new Set(selectedIds || []);
    const wrap = el('div', { class: 'chip-multi' });
    function render() {
      wrap.innerHTML = '';
      if (!options.length) {
        wrap.appendChild(el('div', { class: 'muted', style: { fontSize: '.85rem' } }, '—'));
        return;
      }
      for (const opt of options) {
        const isOn = selected.has(opt.id);
        const chip = el('button', {
          type: 'button',
          class: 'chip' + (isOn ? ' chip-on' : ''),
          'data-id': opt.id,
        }, opt.label);
        chip.addEventListener('click', () => {
          if (selected.has(opt.id)) selected.delete(opt.id);
          else                       selected.add(opt.id);
          chip.classList.toggle('chip-on');
        });
        wrap.appendChild(chip);
      }
    }
    render();
    const node = el('div', { class: 'form-field', id: `f-${fieldId}` },
      el('label', {}, label),
      wrap,
    );
    return {
      node,
      getValue: () => [...wrap.querySelectorAll('.chip-on')].map(c => c.dataset.id),
    };
  }

  function open(id, initialOverride) {
    const s = App._state;
    const editing = id ? (s.envelopes || []).find(e => e.id === id) : null;
    // ISSUE-021: category detail's "Set envelope for this category"
    // CTA passes a partial pre-fill (e.g. { categoryIds: ['c_eat'] })
    // so the new-envelope modal opens with that category already
    // selected. We only honour the keys the override actually
    // carries — anything else falls back to the editing envelope or
    // empty defaults — so future CTAs can layer more pre-fills
    // (payeeIds, name) without us having to special-case them.
    const baseInitial = editing || { name: '', cap: '', period: 'monthly', categoryIds: [], payeeIds: [], notes: '' };
    const initial = initialOverride ? { ...baseInitial, ...initialOverride } : baseInitial;

    // Build option lists for both multi-selects. Categories come
    // straight from state (we don't filter on group/type — any
    // category or payee is valid). Payees come from the same helper
    // the Payees view uses, so the user sees exactly the distinct
    // payee names extracted from their transactions.
    const catOptions = (s.categories || [])
      .filter(c => c && c.name)
      .map(c => ({ id: c.id, label: c.name }))
      .sort((a, b) => (a.label || '').localeCompare(b.label || ''));
    const payeeOptions = (typeof ViewHelpers !== 'undefined' && ViewHelpers.distinctPayees)
      ? ViewHelpers.distinctPayees()
          .filter(p => p && p.name)  // defensive: skip any blank payee
          .map(p => ({ id: p.name, label: p.name }))
          .sort((a, b) => (a.label || '').localeCompare(b.label || ''))
      : [];

    Modal.create({
      title: t(editing ? 'envelopes.edit' : 'envelopes.add'),
      saveLabel: t(editing ? 'btn.saveChanges' : 'btn.add'),
      fields: [
        { id: 'name', kind: 'text', label: t('envelopes.form.name'), placeholder: t('envelopes.form.name'), value: initial.name || '' },
        { id: 'cap', kind: 'number', label: t('envelopes.form.cap'), placeholder: '0,00', value: initial.cap || '', min: '0.01', step: '0.01' },
        { id: 'period', kind: 'select', label: t('envelopes.form.period'), options: [
          { value: 'monthly', label: t('envelopes.form.period.monthly') },
          { value: 'yearly',  label: t('envelopes.form.period.yearly') },
        ], value: initial.period || 'monthly' },
        { id: 'categoryIds', kind: 'custom', label: t('envelopes.form.categories'),
          render: (_vals, _ctx) => chipMultiSelect('categoryIds', t('envelopes.form.categories'), catOptions, initial.categoryIds).node,
          getValue: (rootEl) => {
            const wrap = rootEl.querySelector('.chip-multi');
            if (!wrap) return [];
            // Read selected set from the rendered chips' `chip-on` class.
            return [...wrap.querySelectorAll('.chip-on')].map(c => c.dataset.id);
          },
        },
        { id: 'payeeIds', kind: 'custom', label: t('envelopes.form.payees'),
          render: (_vals, _ctx) => chipMultiSelect('payeeIds', t('envelopes.form.payees'), payeeOptions, initial.payeeIds).node,
          getValue: (rootEl) => {
            const wrap = rootEl.querySelector('.chip-multi');
            if (!wrap) return [];
            return [...wrap.querySelectorAll('.chip-on')].map(c => c.dataset.id);
          },
        },
        { id: 'notes', kind: 'textarea', label: t('envelopes.form.notes'), placeholder: '', value: initial.notes || '', rows: 3 },
      ],
      onSave: (v) => {
        const name = (v.name || '').trim();
        if (!name) return window.toast(t('goals.err.nameRequired')), false;
        const cap = Number(v.cap);
        if (!isFinite(cap) || cap <= 0) return window.toast(t('goals.err.targetRequired')), false;
        // At least one of categoryIds / payeeIds must be non-empty.
        // Otherwise the envelope matches nothing — refuse with a Dutch
        // message so the user understands the gate.
        const cats = Array.isArray(v.categoryIds) ? v.categoryIds : [];
        const pays = Array.isArray(v.payeeIds) ? v.payeeIds : [];
        if (cats.length === 0 && pays.length === 0) {
          return window.toast(t('envelopes.form.links.required')), false;
        }
        const patch = {
          name,
          cap,
          period: v.period,
          categoryIds: cats,
          payeeIds: pays,
          notes: v.notes || '',
        };
        const s = window.App._state;
        if (editing) {
          Store.updateEnvelope(s, editing.id, patch);
          window.toast(t('envelopes.updated'));
        } else {
          Store.addEnvelope(s, patch);
          window.toast(t('envelopes.added'));
        }
        window.dispatchEvent(new Event('store:changed'));
      },
      onDelete: editing ? () => deleteOne(editing.id) : null,
    });
  }

  function deleteOne(id) {
    const env = (window.App._state.envelopes || []).find(e => e.id === id);
    if (!env) return;
    if (!window.confirmAction(window.t('envelopes.delete.confirm'))) return;
    Store.deleteEnvelope(window.App._state, id);
    window.toast(window.t('envelopes.deleted'));
    window.dispatchEvent(new Event('store:changed'));
  }

  window.Modals = /** @type {Window["Modals"]} */ (window.Modals || {});
  window.Modals.envelope = open;
  window.Modals.envelopeDelete = deleteOne;
})();
