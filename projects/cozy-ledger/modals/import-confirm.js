// modals/import-confirm.js — Backup import confirmation (ISSUE-009)
// Shows record counts from a parsed backup, a warning, and a
// destructive "Replace" button. Triggered by the Settings import flow.
(function () {
  const { Backup, Store, App, Modal } = window;
  const t = window.t;
  const Fmt = window.Fmt;

  function open(parsed) {
    const counts = Backup.countRecords(parsed);
    const backupDate = parsed.exportedAt ? Fmt.date(parsed.exportedAt) : '—';
    const countsParts = [
      `${counts.transactions} ${t('txn.th.count').toLowerCase()}`,
      `${counts.categories} ${t('nav.categories').toLowerCase()}`,
      `${counts.sources} ${t('nav.sources').toLowerCase()}`,
      `${counts.users} ${t('nav.users').toLowerCase()}`,
    ];
    if (counts.groups > 0) countsParts.push(`${counts.groups} ${t('grp.section.title').toLowerCase()}`);

    Modal.create({
      title: t('settings.import.title'),
      // The "Replace" button replaces save; "Annuleren" replaces cancel.
      // We render the body and footer as custom fields so the destructive
      // Replace action lives outside the standard save/cancel contract.
      fields: [
        { id: 'body', kind: 'custom', render: () => {
          const wrap = document.createElement('div');
          wrap.innerHTML = `
            <div class="backup-summary">
              <p>${t('settings.import.summary', { n: countsParts.join(', ') })}</p>
              <p class="muted" style="font-size:.85rem">${t('settings.import.meta', { date: backupDate, ver: parsed.schemaVersion })}</p>
            </div>
            <div class="backup-warning">
              <strong>${t('settings.import.warn')}</strong>${t('settings.import.warn2')}
            </div>`;
          return wrap;
        }, getValue: () => null },
      ],
      onSave: () => false, // disable save button — handled below
    });

    // Replace the save button semantics with "Replace" (danger) and add Cancel.
    const saveBtn = document.querySelector('#m-save');
    if (saveBtn) saveBtn.remove();
    const foot = document.querySelector('.modal-foot');
    if (foot) {
      const cancel = foot.querySelector('#m-cancel');
      const replace = document.createElement('button');
      replace.className = 'btn btn-danger';
      replace.id = 'imp-replace';
      replace.textContent = t('btn.replace');
      replace.onclick = () => {
        const err = Backup.applyImport(App._state, parsed, Store.save);
        document.querySelector('.modal-backdrop').remove();
        if (err) { window.toast(err.error); return; }
        window.dispatchEvent(new Event('store:changed'));
        window.toast(t('settings.import.done', { n: counts.transactions }));
      };
      foot.appendChild(replace);
    }
  }

  window.Modals = window.Modals || {};
  window.Modals.importConfirm = open;
})();