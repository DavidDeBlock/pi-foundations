// modals/import-preview.js — CSV preview table rendering (ISSUE-009 split)
// Used by modals/import.js. Kept separate so the modal config file
// (import.js) stays focused on its fields + lifecycle.
(function () {
  const { Fmt } = window;
  const t = window.t;

  function renderPreview(parsedRows, state, refs) {
    const { summary, preview, importBtn } = refs;
    if (parsedRows.length === 0) {
      summary.innerHTML = ''; preview.innerHTML = '';
      importBtn.disabled = true; importBtn.textContent = t('csv.btn.import0');
      return;
    }
    const sel = parsedRows.filter(r => r.selected && !r.skip && !r.dupe).length;
    const dupe = parsedRows.filter(r => r.dupe).length;
    const skip = parsedRows.filter(r => r.skip).length;
    summary.innerHTML =
      `<span class="pill pill-pos">${t('csv.pill.import', { n: sel })}</span>` +
      `<span class="pill">${t('csv.pill.dupe', { n: dupe })}</span>` +
      `<span class="pill">${t('csv.pill.skip', { n: skip })}</span>`;
    const head = `<thead><tr><th style="width:32px"></th><th>${t('csv.th.date')}</th><th>${t('csv.th.desc')}</th><th class="right">${t('csv.th.amount')}</th><th>${t('csv.th.type')}</th><th>${t('csv.th.category')}</th></tr></thead>`;
    const body = parsedRows.map(item => {
      const dis = (item.skip || item.dupe) ? 'disabled' : '';
      const sign = item.classification?.type === 'expense' ? '−' : '+';
      const typeText = item.classification ? (item.classification.type === 'income' ? t('csv.th.type.income') : t('csv.th.type.expense')) : (item.skip ? t('csv.th.type.skip') : t('csv.th.type.unset'));
      const opts = state.categories.filter(c => c.type === (item.classification?.type || 'expense'))
        .map(c => `<option value="${c.id}" ${c.id === item.categoryId ? 'selected' : ''}>${c.name}</option>`).join('');
      const badge = item.autoMapped ? `<span class="pill" title="${t('csv.autoMapped.title')}" style="margin-left:6px;font-size:.7rem;background:var(--cream-deep);color:var(--ink-soft)">${t('csv.autoMapped')}</span>` : '';
      return `<tr class="${(item.skip || item.dupe) ? 'muted' : ''}">
        <td><input type="checkbox" ${dis} ${item.selected ? 'checked' : ''}/></td>
        <td>${Fmt.date(item.row.boekingsdatum)}</td>
        <td class="desc" title="${item.row.detail || ''}">${item.row.omschrijving || '—'}</td>
        <td class="right amt">${sign + Fmt.money(Math.abs(item.row.bedrag))}</td>
        <td>${typeText}</td>
        <td><select class="select" ${dis}>${opts}</select>${badge}</td>
      </tr>`;
    }).join('');
    preview.innerHTML = `<table class="imp-table">${head}<tbody>${body}</tbody></table>`;
    preview.querySelectorAll('tbody tr').forEach((tr, i) => {
      const item = parsedRows[i];
      tr.querySelector('input[type=checkbox]').onchange = e => { item.selected = e.target.checked; renderPreview(parsedRows, state, refs); };
      tr.querySelector('select').onchange = e => { item.categoryId = e.target.value; item.autoMapped = false; };
    });
    importBtn.disabled = sel === 0;
    importBtn.textContent = t('csv.btn.importN', { n: sel });
  }

  window.ImportPreview = { render: renderPreview };
})();