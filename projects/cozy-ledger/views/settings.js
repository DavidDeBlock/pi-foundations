// =====================================================================
// views/settings.js — Backup / restore (ISSUE-006)
// =====================================================================
// Reads: App._state
// Calls: Backup.{exportJSON,exportCSV,readFileText,parseAndValidate},
//        window.Modals.importConfirm
// =====================================================================

const Settings = (() => {
  // File picker → FileReader → parseAndValidate → dry-run modal.
  async function onImportFileSelected(file) {
    if (!file) return;
    const text = await Backup.readFileText(file);
    const result = Backup.parseAndValidate(text);
    if (!result.ok) {
      toast(result.error);
      return;
    }
    window.Modals.importConfirm(result.data);
  }

  function render() {
    const wrap = el('div', { class: 'view-settings' });

    // Hidden file input is mounted on document.body so the click→file
    // picker flow works regardless of where the visible button sits.
    const fileInput = el('input', {
      type: 'file', accept: 'application/json,.json',
      class: 'sr-only-file',
      onchange: (e) => onImportFileSelected(e.target.files && e.target.files[0]),
    });

    const card = el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' },
          el('span', { html: Icons.settings }),
          ' ' + t('settings.backup.title')),
        el('div', { class: 'muted', style: { fontSize: '.82rem' } }, t('settings.backup.sub')),
      ),
      el('div', { class: 'settings-actions' },
        el('div', { class: 'settings-row' },
          el('div', {},
            el('div', { class: 'settings-row-title' }, t('settings.export.json')),
            el('div', { class: 'hint' }, t('settings.export.json.hint')),
          ),
          el('button', { class: 'btn btn-primary', onclick: () => Backup.exportJSON(App._state), id: 'export-json-btn' },
            el('span', { html: Icons.download }), ' ' + t('settings.btn.exportJson')),
        ),
        el('div', { class: 'settings-row' },
          el('div', {},
            el('div', { class: 'settings-row-title' }, t('settings.export.csv')),
            el('div', { class: 'hint' }, t('settings.export.csv.hint')),
          ),
          el('button', { class: 'btn btn-sage', onclick: () => Backup.exportCSV(App._state), id: 'export-csv-btn' },
            el('span', { html: Icons.download }), ' ' + t('settings.btn.exportCsv')),
        ),
        el('div', { class: 'settings-row' },
          el('div', {},
            el('div', { class: 'settings-row-title' }, t('settings.import.json')),
            el('div', { class: 'hint' }, t('settings.import.json.hint')),
          ),
          el('button', { class: 'btn btn-ghost', onclick: () => fileInput.click(), id: 'import-json-btn' },
            el('span', { html: Icons.upload }), ' ' + t('settings.btn.importJson')),
        ),
        fileInput,
      ),
    );
    wrap.appendChild(card);
    return wrap;
  }

  return { render };
})();
window.Settings = Settings;
