#!/usr/bin/env node
// =====================================================================
// _test_boot.js — Boot the entire app in a stubbed DOM and verify
// App.init() runs without errors. Also exercises the import flow end
// to end: parse a real CSV file, classify, dedup, map to transactions,
// and Store.addTransaction.
// =====================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- Stubbed DOM / browser globals -----------------------------------
function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); },
    },
    attributes: {},
    _listeners: {},
    appendChild(c) { if (c) this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); },
    remove() {},
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    dispatchEvent(ev) { (this._listeners[ev.type] || []).forEach(fn => fn(ev)); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {},
    set className(v) { this.attributes.class = v; this.classList._set = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className() { return [...this.classList._set].join(' '); },
    set innerHTML(v) { this.attributes['innerHTML'] = v; },
    get innerHTML() { return this.attributes['innerHTML'] || ''; },
    set textContent(v) { this.attributes['textContent'] = v; },
    get textContent() { return this.attributes['textContent'] || ''; },
  };
}

const localStorageData = {};
const documentStub = {
  createElement: makeEl,
  createTextNode: (s) => ({ nodeType: 3, textContent: String(s) }),
  body: makeEl('body'),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
};
const windowStub = {
  localStorage: {
    getItem: (k) => localStorageData[k] || null,
    setItem: (k, v) => { localStorageData[k] = String(v); },
    removeItem: (k) => { delete localStorageData[k]; },
  },
  addEventListener: () => {},
  dispatchEvent: () => {},
  confirm: () => true,
};

const ctx = vm.createContext({
  window: windowStub,
  document: documentStub,
  localStorage: windowStub.localStorage,
  console,
  setTimeout, clearTimeout,
  Math, Date, JSON, Object, Array, String, Number, Boolean, RegExp, Error, parseFloat, parseInt,
  Promise,
});
ctx.window.document = documentStub;
ctx.globalThis = ctx;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

// ---- Load all 5 scripts in order ------------------------------------
const scripts = ['data.js', 'utils.js', 'icons.js', 'csv.js', 'app.js'];
for (const s of scripts) {
  const code = fs.readFileSync(path.join(__dirname, s), 'utf8');
  vm.runInContext(code, ctx, { filename: s });
}

console.log('\n— Globals exposed —');

test('Store is on window', () => {
  if (!ctx.window.Store || typeof ctx.window.Store.load !== 'function') throw new Error('no Store');
});

test('Fmt is on window', () => {
  if (!ctx.window.Fmt || typeof ctx.window.Fmt.money !== 'function') throw new Error('no Fmt');
});

test('Icons is on window', () => {
  if (!ctx.window.Icons || !ctx.window.Icons.upload) throw new Error('no Icons.upload');
});

test('CSVImport is on window', () => {
  if (!ctx.window.CSVImport || typeof ctx.window.CSVImport.parseIngStatement !== 'function') throw new Error('no CSVImport');
});

test('App is on window', () => {
  if (!ctx.window.App || typeof ctx.window.App.init !== 'function') throw new Error('no App');
});

console.log('\n— App boots —');

test('App.init() runs without throwing', () => {
  ctx.window.App.init();
});

console.log('\n— End-to-end import flow —');

test('parse the 2025 statement file', () => {
  const file = path.join(__dirname, 'statements', fs.readdirSync(path.join(__dirname, 'statements')).find(f => f.includes('2025')));
  const text = fs.readFileSync(file, 'utf8');
  const rows = ctx.window.CSVImport.parseIngStatement(text);
  if (rows.length !== 230) throw new Error(`expected 230, got ${rows.length}`);
});

test('classify + dedup + map to transactions and Store.addTransaction', () => {
  const state = ctx.window.Store.load();
  const file = path.join(__dirname, 'statements', fs.readdirSync(path.join(__dirname, 'statements')).find(f => f.includes('2025')));
  const text = fs.readFileSync(file, 'utf8');
  const rows = ctx.window.CSVImport.parseIngStatement(text);

  const existingKeys = new Set(state.transactions.map(t => t.importedKey).filter(Boolean));
  const diff = ctx.window.CSVImport.diffAgainstStore(rows, existingKeys);

  if (diff.newRows.length === 0) throw new Error('expected new rows on first import');

  const defaults = { userId: state.users[0].id, sourceId: state.sources[0].id, scope: 'private' };
  let imported = 0, skipped = 0;
  for (const { row, classification, key } of diff.newRows) {
    const cat = ctx.window.CSVImport.suggestedCategoryFor(classification.categoryHint, classification.type, state);
    const txn = ctx.window.CSVImport.mapRowToTxn(row, classification, defaults, cat && cat.id);
    txn.importedKey = key;
    if (!txn.amount || !txn.date || !txn.paidByUserId || !txn.sourceId) { skipped++; continue; }
    // For test: only set categoryId if the suggestion was valid (auto-map);
    // otherwise leave empty so user must pick in the UI.
    if (cat) txn.categoryId = cat.id;
    ctx.window.Store.addTransaction(state, txn);
    imported++;
  }
  if (imported < 100) throw new Error(`expected ~180-220 imported, got ${imported}`);
  if (skipped > 0) throw new Error(`expected 0 skipped, got ${skipped}`);
  console.log(`      imported ${imported} transactions`);
});

test('re-importing the same file dedups against the store', () => {
  const state = ctx.window.Store.load();
  const file = path.join(__dirname, 'statements', fs.readdirSync(path.join(__dirname, 'statements')).find(f => f.includes('2025')));
  const text = fs.readFileSync(file, 'utf8');
  const rows = ctx.window.CSVImport.parseIngStatement(text);

  const existingKeys = new Set(state.transactions.map(t => t.importedKey).filter(Boolean));
  const diff = ctx.window.CSVImport.diffAgainstStore(rows, existingKeys);

  if (diff.newRows.length !== 0) throw new Error(`expected 0 new rows on re-import, got ${diff.newRows.length}`);
  if (diff.skippedDupes.length < 200) throw new Error(`expected ≥200 dupes, got ${diff.skippedDupes.length}`);
  console.log(`      skipped ${diff.skippedDupes.length} duplicates, ${diff.skippedZero.length} zero rows`);
});

console.log('\n— Summary —');
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
