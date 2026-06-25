// =====================================================================
// utils.js — Formatters + small helpers
// =====================================================================

const Fmt = {
  money(n, opts = {}) {
    if (n == null || isNaN(n)) n = 0;
    const sign = opts.signed && n > 0 ? '+' : '';
    return sign + '€' + n.toLocaleString('nl-BE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  },
  moneyShort(n) {
    if (n == null || isNaN(n)) n = 0;
    const abs = Math.abs(n);
    let v, suf = '';
    if (abs >= 1000) { v = n / 1000; suf = 'k'; }
    else v = n;
    return '€' + v.toLocaleString('nl-BE', { minimumFractionDigits: v < 10 ? 1 : 0, maximumFractionDigits: 1 }) + suf;
  },
  date(d, opts = {}) {
    if (!d) return '—';
    const dt = new Date(d);
    if (opts.month) {
      return dt.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }
    return dt.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
  },
  ymKey(d) {
    const dt = new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  },
  monthLabel(yyyyMm) {
    const [y, m] = yyyyMm.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  },
  today() {
    return new Date().toISOString().slice(0, 10);
  },
  currentMonthKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  },
  shiftMonth(yyyyMm, delta) {
    const [y, m] = yyyyMm.split('-').map(Number);
    const dt = new Date(y, m - 1 + delta, 1);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  },
  inMonth(date, yyyyMm) {
    return Fmt.ymKey(date) === yyyyMm;
  },
  pct(part, total) {
    if (!total) return 0;
    return (part / total) * 100;
  },
};

// ---- DOM helpers ----
const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'g', 'line', 'rect', 'circle', 'ellipse', 'polyline', 'polygon', 'path', 'text', 'tspan', 'defs', 'use', 'image', 'foreignObject', 'marker', 'pattern', 'clipPath', 'mask', 'filter']);
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
function el(tag, props, ...children) {
  // SVG elements need the SVG namespace or browsers silently treat them
  // as HTMLUnknownElement and ignore the positioning attributes.
  const node = SVG_TAGS.has(tag)
    ? document.createElementNS(SVG_NS, tag)
    : document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') node.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else if (v === false || v == null) continue;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    if (c instanceof Node) {
      // When appending into an SVG element, text/element children must
      // be in the SVG namespace too — text nodes in SVG need createTextNodeNS.
      if (node.namespaceURI === SVG_NS && c.nodeType === 3) {
        node.appendChild(document.createTextNode(c.textContent));
      } else {
        node.appendChild(c);
      }
    } else {
      const text = (node.namespaceURI === SVG_NS)
        ? document.createTextNode(String(c))
        : document.createTextNode(String(c));
      node.appendChild(text);
    }
  }
  return node;
}

function svg(html) {
  const wrap = document.createElement('span');
  wrap.innerHTML = html.trim();
  return wrap.firstChild;
}

function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

// Confirm helper
function confirmAction(message) {
  return Promise.resolve(window.confirm(message));
}

// Expose to window
window.Fmt = Fmt;
window.$ = $;
window.$$ = $$;
window.el = el;
window.toast = toast;
window.confirmAction = confirmAction;
