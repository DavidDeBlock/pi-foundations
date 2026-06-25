// =====================================================================
// modals/_helper.js — Shared modal shell + declarative field renderer
// =====================================================================
// ISSUE-009: collapses the six modal openers into a config + helper.
// Field kinds cover every shape used across the openers:
//   text, number, date, textarea, select, tabs, scope-pick,
//   checkbox, toggle, color-picker, icon-grid, file,
//   row (a horizontal form-row group), custom (escape hatch).
//
// The helper handles, with no caller code:
//   - shell (head + body + foot)
//   - Save / Cancel / optional Delete buttons (Dutch labels via t())
//   - escape-to-close, click-on-backdrop-to-close, focus first input
//   - automatic values collection for declarative kinds
//   - conditional visibility via `visible?: (values) => boolean`
//
// Custom fields contribute to `values` via a `getValue(rootEl)` hook
// or by calling `ctx.setValue(id, val)` from inside their render fn.

(function () {
  const { el } = window;
  const t = window.t;
  const Icons = window.Icons;

  // ---- text helpers (kept here so modal files don't import utils) ---
  function escText(s) { return String(s ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return String(s ?? '').replace(/"/g, '&quot;'); }

  function readOpts(opts, values) {
    return typeof opts === 'function' ? opts(values) : (opts || []);
  }

  // ---- field renderers ---------------------------------------------
  // Each renderer returns { node, collect(values), bind?(values) }.
  // `bind` runs once after the field is attached; lets a field hook up
  // listeners that read other values (e.g. icon-grid re-render on change).
  const KIND = {
    text(f, values) {
      const id = `f-${f.id}`;
      const input = el('input', { class: 'input', type: 'text', id, placeholder: f.placeholder || '', value: values[f.id] ?? '' });
      return {
        node: wrap(f, input),
        collect: (v) => { v[f.id] = input.value; },
      };
    },
    number(f, values) {
      const id = `f-${f.id}`;
      const input = el('input', { class: 'input amount-input', type: 'number', id, value: values[f.id] ?? '', placeholder: f.placeholder || '0.00', step: f.step || '0.01', min: f.min ?? '0' });
      const wrap = el('div', { class: 'form-field' });
      if (f.label) wrap.appendChild(el('label', { for: id }, f.label));
      wrap.appendChild(el('div', { class: 'amount-wrap' }, el('span', { class: 'currency' }, '€'), input));
      return {
        node: wrap,
        collect: (v) => { v[f.id] = parseFloat(input.value) || 0; },
      };
    },
    date(f, values) {
      const id = `f-${f.id}`;
      const input = el('input', { class: 'input', type: 'date', id, value: values[f.id] ?? '' });
      return {
        node: wrap(f, input),
        collect: (v) => { v[f.id] = input.value; },
      };
    },
    textarea(f, values) {
      const id = `f-${f.id}`;
      const ta = el('textarea', { class: 'textarea', id, placeholder: f.placeholder || '', rows: f.rows || 3 }, values[f.id] ?? '');
      return {
        node: wrap(f, ta),
        collect: (v) => { v[f.id] = ta.value; },
      };
    },
    select(f, values) {
      const id = `f-${f.id}`;
      const sel = el('select', { class: 'select', id });
      // Re-populated on each bind so dynamic options (e.g. categories
      // filtered by current type) stay in sync after onChange.
      function repopulate() {
        sel.innerHTML = '';
        const opts = readOpts(f.options, values);
        const cur = values[f.id];
        for (const opt of opts) {
          const o = el('option', { value: opt.value }, opt.label);
          if (opt.value === cur || (cur == null && opt.value === '')) o.selected = true;
          sel.appendChild(o);
        }
        if (!sel.value && opts[0]) sel.value = opts[0].value;
        values[f.id] = sel.value;
      }
      repopulate();
      sel.onchange = () => { values[f.id] = sel.value; if (f.onChange) f.onChange(sel.value, values, repopulate); };
      return {
        node: wrap(f, sel),
        collect: (v) => { v[f.id] = sel.value; },
        bind: () => repopulate(),
      };
    },
    tabs(f, values) {
      const id = `f-${f.id}`;
      const tabs = el('div', { class: 'tabs', id });
      const opts = readOpts(f.options, values);
      function repaint() {
        tabs.innerHTML = '';
        for (const opt of opts) {
          const b = el('button', { type: 'button', 'data-v': opt.value, class: opt.value === values[f.id] ? `active ${opt.value}` : '' }, opt.label);
          b.onclick = () => {
            values[f.id] = opt.value;
            repaint();
            if (f.onChange) f.onChange(opt.value, values);
          };
          tabs.appendChild(b);
        }
      }
      repaint();
      return {
        node: wrap(f, tabs, /*labelHidden*/ true),
        collect: (v) => { v[f.id] = values[f.id]; },
        bind: repaint,
      };
    },
    'scope-pick'(f, values) {
      const id = `f-${f.id}`;
      const pick = el('div', { class: 'scope-pick', id });
      const opts = readOpts(f.options, values);
      function repaint() {
        pick.innerHTML = '';
        for (const opt of opts) {
          const iconHtml = opt.icon ? `${opt.icon} ` : '';
          // The icon is SVG markup; set it via html so the browser parses it.
          const b = el('button', { type: 'button', 'data-v': opt.value, class: opt.value === values[f.id] ? 'active' : '', html: iconHtml + escText(opt.label) });
          b.onclick = () => {
            values[f.id] = opt.value;
            repaint();
            if (f.onChange) f.onChange(opt.value, values);
          };
          pick.appendChild(b);
        }
      }
      repaint();
      return {
        node: wrap(f, pick, /*labelHidden*/ true),
        collect: (v) => { v[f.id] = values[f.id]; },
        bind: repaint,
      };
    },
    checkbox(f, values) {
      const id = `f-${f.id}`;
      const cb = el('input', { type: 'checkbox', id: `${id}-cb` });
      const text = el('span', { id: `${id}-text`, html: f.textHtml || f.text || '' });
      const lbl = el('label', { class: 'apply-all-opt', id }, cb, text);
      lbl.style.display = '';
      cb.addEventListener('change', () => { values[f.id] = cb.checked; if (f.onChange) f.onChange(cb.checked, values); });
      // Pre-check from value
      if (values[f.id]) cb.checked = true;
      return {
        node: lbl,
        collect: (v) => { v[f.id] = cb.checked; },
        // NOTE: visCtx isn't built until after all `bind()` hooks have
        // run, so a checkbox with a `visible` callback that needs the
        // modal body (e.g. the transaction modal's `applyAll`) cannot
        // safely touch `visCtx.body` here. Defer that to applyVisibility()
        // which runs immediately after visCtx is constructed.
        bind: () => { lbl.style.display = ''; },
      };
    },
    toggle(f, values) {
      const id = `f-${f.id}`;
      const tog = el('div', { class: 'toggle', id });
      tog.appendChild(el('div', {},
        el('div', { style: { fontWeight: '600' } }, values[f.id] ? (f.activeLabel || 'Actief') : (f.inactiveLabel || 'Inactief')),
        f.help ? el('div', { class: 'muted', style: { fontSize: '.8rem' } }, f.help) : null,
      ));
      tog.onclick = () => {
        const isOn = tog.classList.toggle('on');
        values[f.id] = isOn;
        tog.firstChild.firstChild.textContent = isOn ? (f.activeLabel || 'Actief') : (f.inactiveLabel || 'Inactief');
        if (f.onChange) f.onChange(isOn, values);
      };
      if (values[f.id]) tog.classList.add('on');
      const wrap = el('div', { class: 'form-field flex center', style: { flexDirection: 'row', gap: '10px' } }, tog);
      return {
        node: wrap,
        collect: (v) => { v[f.id] = tog.classList.contains('on'); },
      };
    },
    'color-picker'(f, values) {
      const id = `f-${f.id}`;
      const colorInput = el('input', { type: 'color', id, value: values[f.id] || '#5a7248' });
      const textInput = el('input', { class: 'input', type: 'text', value: values[f.id] || '#5a7248', style: { flex: '1' } });
      const picker = el('div', { class: 'color-picker' }, colorInput, textInput);
      colorInput.oninput = () => { textInput.value = colorInput.value; values[f.id] = colorInput.value; };
      textInput.oninput = () => { colorInput.value = textInput.value; values[f.id] = textInput.value; };
      return {
        node: wrap(f, picker),
        collect: (v) => { v[f.id] = textInput.value; },
      };
    },
    'icon-grid'(f, values) {
      const id = `f-${f.id}`;
      const grid = el('div', { class: 'icon-grid', id });
      const icons = readOpts(f.options, values);
      function repaint() {
        grid.innerHTML = '';
        for (const ic of icons) {
          const b = el('button', { type: 'button', class: ic === values[f.id] ? 'active' : '' }, ic);
          b.onclick = () => { values[f.id] = ic; repaint(); if (f.onChange) f.onChange(ic, values); };
          grid.appendChild(b);
        }
      }
      repaint();
      return {
        node: wrap(f, grid),
        collect: (v) => { v[f.id] = values[f.id]; },
      };
    },
    file(f, values) {
      const id = `f-${f.id}`;
      const input = el('input', { class: 'input', type: 'file', id, accept: f.accept || '' });
      const hint = f.hint ? el('div', { class: 'hint' }, f.hint) : null;
      const wrap = el('div', { class: 'form-field' });
      if (f.label) wrap.appendChild(el('label', { for: id }, f.label));
      wrap.appendChild(input);
      if (hint) wrap.appendChild(hint);
      return {
        node: wrap,
        collect: (v) => { v[f.id] = input.files[0] || null; },
      };
    },
  };

  function wrap(f, control, labelHidden) {
    const w = el('div', { class: 'form-field' });
    if (f.label && !labelHidden) w.appendChild(el('label', {}, f.label));
    w.appendChild(control);
    if (f.hint && !hintAlreadyAdded(control)) w.appendChild(el('div', { class: 'hint' }, f.hint));
    return w;
  }
  function hintAlreadyAdded(control) {
    return control.querySelector && control.querySelector('.hint');
  }

  // ---- row layout: render a list of fields side by side -------------
  function renderRow(fields, values) {
    const row = el('div', { class: 'form-row' + (fields.length === 3 ? ' cols-3' : '') });
    const renderers = fields.map(f => renderField(f, values));
    renderers.forEach(r => row.appendChild(r.node));
    return { node: row, renderers };
  }

  // ---- single-field dispatch ----------------------------------------
  function renderField(f, values) {
    if (f.kind === 'custom') {
      // Custom fields own their rendering and value plumbing.
      const ctx = { setValue: (id, v) => { values[id] = v; }, values };
      const node = f.render(values, ctx);
      const getValue = f.getValue || ((rootEl) => ctx._lastValue);
      return {
        node,
        collect: (v) => {
          const got = getValue(node);
          if (got !== undefined) v[f.id] = got;
        },
      };
    }
    if (f.kind === 'row') return renderRow(f.fields, values);
    const renderer = KIND[f.kind];
    if (!renderer) throw new Error(`Modal.create: unknown kind '${f.kind}'`);
    return renderer(f, values);
  }

  // ---- main create() -----------------------------------------------
  function create(config) {
    const { title, fields = [], onSave, onDelete, onCancel, size = 'md' } = config;
    const values = {};
    const renderers = [];
    const body = el('div', { class: 'modal-body' });

    // Pre-populate values with field defaults (so options functions see them)
    for (const f of fields) {
      if (f.value !== undefined) values[f.id] = f.value;
    }

    for (const f of fields) {
      const r = renderField(f, values);
      renderers.push(r);
      body.appendChild(r.node);
    }

    // Run bind hooks (e.g. select repopulate after default values land)
    for (const r of renderers) r.bind && r.bind(values);

    // Visibility: re-evaluate on every input/change in the body.
    // visCtx is exposed so conditional fields like `applyAll` can query
    // the modal body for related elements (e.g. `#f-applyAll-text`) and
    // call `setValue()` to mutate other fields' values.
    const visibilityFields = fields.filter(f => typeof f.visible === 'function');
    const visCtx = { body, values, setValue: (id, v) => { values[id] = v; } };

    // After visCtx exists, run initial visibility evaluation. Some
    // field kinds (e.g. checkbox) also call `f.visible(values, visCtx)`
    // from their `bind()` hook. Those bind hooks run before visCtx is
    // defined here, so the visibility call must be deferred to NOW so
    // the callback can safely read `visCtx.body` etc.
    function applyVisibility() {
      for (const f of visibilityFields) {
        const target = body.querySelector(`#f-${f.id}`);
        if (!target) continue;
        const wrap = target.closest('.form-field, .apply-all-opt') || target;
        if (wrap) wrap.style.display = f.visible(values, visCtx) ? '' : 'none';
      }
    }
    applyVisibility();

    function reevaluate() {
      for (const r of renderers) r.collect && r.collect(values);
      for (const f of visibilityFields) {
        const target = body.querySelector(`#f-${f.id}`);
        const wrap = target?.closest('.form-field, .apply-all-opt') || target;
        if (wrap) wrap.style.display = f.visible(values, visCtx) ? '' : 'none';
      }
    }
    body.addEventListener('input', reevaluate);
    body.addEventListener('change', reevaluate);

    // Shell
    const modalCls = 'modal' + (size === 'lg' ? ' modal-wide' : size === 'sm' ? ' modal-sm' : '');
    const modal = el('div', { class: modalCls },
      el('div', { class: 'modal-head' },
        el('div', { class: 'modal-title' }, title),
        el('button', { class: 'btn-icon', id: 'm-close', 'aria-label': t('btn.close'), type: 'button', html: Icons.close }),
      ),
      body,
      el('div', { class: 'modal-foot' },
        onDelete ? el('button', { class: 'btn btn-danger', id: 'm-delete', type: 'button', html: `${Icons.trash} ${escText(t('btn.delete'))}` }) : null,
        el('div', { style: { flex: '1' } }),
        el('button', { class: 'btn btn-ghost', id: 'm-cancel', type: 'button' }, t('btn.cancel')),
        el('button', { class: 'btn btn-primary', id: 'm-save', type: 'button' }, config.saveLabel || t('btn.save')),
      ),
    );

    // Backdrop + lifecycle
    let removed = false;
    function close() {
      if (removed) return;
      removed = true;
      back.remove();
      document.removeEventListener('keydown', escListener);
      if (onCancel) onCancel();
    }
    function escListener(e) { if (e.key === 'Escape') close(); }
    const back = el('div', { class: 'modal-backdrop' });
    back.addEventListener('click', e => { if (e.target === back) close(); });
    back.appendChild(modal);
    document.body.appendChild(back);
    document.addEventListener('keydown', escListener);
    setTimeout(() => modal.querySelector('input, select, textarea, button')?.focus(), 50);

    modal.querySelector('#m-close').addEventListener('click', close);
    modal.querySelector('#m-cancel').addEventListener('click', close);
    if (onDelete) modal.querySelector('#m-delete').addEventListener('click', () => { close(); onDelete(); });
    modal.querySelector('#m-save').addEventListener('click', () => {
      for (const r of renderers) r.collect && r.collect(values);
      try {
        const result = onSave(values);
        if (result === false) return; // validation refused; keep open
        if (result && typeof result.then === 'function') {
          result.then(shouldClose => { if (shouldClose !== false) close(); }).catch(() => close());
        } else {
          close();
        }
      } catch (_) { close(); }
    });

    return { modal, values, close };
  }

  window.Modal = { create };
})();