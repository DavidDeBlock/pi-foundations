// modals/import.js — CSV import preview + commit (ISSUE-009)
// Preview table rendering lives in modals/import-preview.js.
(function () {
  const { Store, Modal, Icons, CSVImport, App, ImportPreview } = window;
  const t = window.t;

  function open() {
    const state = App._state;
    let parsedRows = [];
    const defaults = { userId: state.users[0]?.id || '', sourceId: state.sources[0]?.id || '', scope: 'private' };
    const existingKeys = new Set(state.transactions.map(x => x.importedKey).filter(Boolean));

    const { modal } = Modal.create({
      title: t('modal.import.title'), size: 'lg', saveLabel: t('csv.btn.import0'),
      fields: [
        { id: 'file', kind: 'file', label: t('csv.file'), accept: '.csv,text/csv', hint: t('csv.file.hint') },
        { id: 'defaults', kind: 'row', fields: [
          { id: 'userId', kind: 'select', label: t('csv.defaults.user'),
            options: state.users.filter(u => u.active).map(u => ({ value: u.id, label: u.name })), value: defaults.userId },
          { id: 'sourceId', kind: 'select', label: t('csv.defaults.source'),
            options: state.sources.filter(s => s.active).map(s => ({ value: s.id, label: s.name })), value: defaults.sourceId },
        ] },
        { id: 'scope', kind: 'scope-pick', label: t('csv.defaults.scope'), options: [
          { value: 'private', label: t('txn.scope.private'), icon: Icons.user },
          { value: 'shared',  label: t('txn.scope.shared'),  icon: Icons.globe },
        ], value: defaults.scope },
        { id: 'preview', kind: 'custom', render: () => {
          const w = document.createElement('div');
          w.innerHTML = '<div class="imp-summary"></div><div class="imp-preview"></div>';
          return w;
        }, getValue: () => parsedRows },
      ],
      onSave: () => {
        const toImport = parsedRows.filter(r => r.selected && !r.skip && !r.dupe);
        if (toImport.length === 0) return false;
        let n = 0;
        for (const item of toImport) {
          const txn = CSVImport.mapRowToTxn(item.row, item.classification, defaults, item.categoryId);
          txn.importedKey = item.key; Store.addTransaction(state, txn); n++;
        }
        if (n > 0) { window.toast(t('toast.imported', { n })); window.dispatchEvent(new Event('store:changed')); }
      },
    });

    const refs = {
      summary: modal.querySelector('.imp-summary'),
      preview: modal.querySelector('.imp-preview'),
      importBtn: modal.querySelector('#m-save'),
    };
    modal.querySelector('#f-scope').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) defaults.scope = b.dataset.v; });
    modal.querySelector('#f-userId').onchange = e => { defaults.userId = e.target.value; };
    modal.querySelector('#f-sourceId').onchange = e => { defaults.sourceId = e.target.value; };

    modal.querySelector('#f-file').onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      let text; try { text = await file.text(); } catch (err) { window.toast(t('csv.err.read')); return; }
      const rows = CSVImport.parseIngStatement(text);
      if (rows.length === 0) { window.toast(t('csv.err.noRows')); parsedRows = []; ImportPreview.render(parsedRows, state, refs); return; }
      const seen = new Set(existingKeys);
      parsedRows = rows.map(row => {
        const cls = CSVImport.classifyRow(row);
        if (cls.skip) return { row, classification: cls, skip: true, dupe: false, selected: false, key: null };
        const key = CSVImport.makeDedupKey(row);
        const dupe = seen.has(key); if (!dupe) seen.add(key);
        const suggested = CSVImport.suggestedCategoryFor(cls.categoryHint, cls.type, state);
        const payeeName = CSVImport.extractPayee(row.omschrijving);
        const mapped = !suggested && payeeName ? (state.payeeCategories || {})[payeeName] : '';
        return { row, classification: cls, key, skip: false, dupe, selected: !dupe,
          categoryId: suggested?.id || mapped || '', autoMapped: !suggested && !!mapped };
      });
      ImportPreview.render(parsedRows, state, refs);
    };

    ImportPreview.render(parsedRows, state, refs);
  }

  window.Modals = window.Modals || {};
  window.Modals.import = open;
})();