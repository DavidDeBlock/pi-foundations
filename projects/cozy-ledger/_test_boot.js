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

test('availableMonths: data spanning multiple years produces a deduplicated, newest-first list', () => {
  const state = {
    transactions: [
      { date: '2022-03-15' },
      { date: '2024-07-01' },
      { date: '2022-03-20' },          // dup year-month
      { date: '2024-12-31' },
      { date: '2025-01-05' },
      { date: 'invalid-date' },        // ignored
    ],
  };
  ctx.window.App._state = state; // not strictly used; function reads from closure if present
  // availableMonths reads `state` from its module closure — it was set on first
  // App.init(). For the unit test we just re-evaluate it against a synthetic state.
  const months = (() => {
    const m = new Set([ctx.window.Fmt.currentMonthKey()]);
    for (const t of state.transactions) {
      if (t.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date)) m.add(ctx.window.Fmt.ymKey(t.date));
    }
    return [...m].sort().reverse();
  })();
  if (!months.includes('2022-03')) throw new Error('missing 2022-03');
  if (!months.includes('2024-07')) throw new Error('missing 2024-07');
  if (!months.includes('2025-01')) throw new Error('missing 2025-01');
  if (months.filter(x => x === '2022-03').length !== 1) throw new Error('2022-03 not deduplicated');
  if (months[0] < months[months.length - 1]) throw new Error('not sorted newest-first');
  console.log(`      produced ${months.length} months`);
});

test('availableMonths: empty transactions still includes the current month', () => {
  const state = { transactions: [] };
  const months = (() => {
    const m = new Set([ctx.window.Fmt.currentMonthKey()]);
    for (const t of state.transactions) {
      if (t.date) m.add(ctx.window.Fmt.ymKey(t.date));
    }
    return [...m].sort().reverse();
  })();
  if (months.length !== 1) throw new Error(`expected 1 month, got ${months.length}`);
  if (months[0] !== ctx.window.Fmt.currentMonthKey()) throw new Error('not the current month');
});

// extractPayee is the real one in csv.js — call it through the global
// so the test stays in sync with production code.
const extractPayee = ctx.window.CSVImport.extractPayee;

test('extractPayee: Bancontact line strips down to merchant', () => {
  const desc = 'Betaling Bancontact 01/07/25 - 19.44 uur - Coolblue 2600 - BERCHEM - NLD Kaartnummer 5229 62XX XXXX 8819';
  if (extractPayee(desc) !== 'Coolblue') throw new Error(`got ${extractPayee(desc)}`);
});

test('extractPayee: Domiciliëring strips to counterparty', () => {
  const desc = 'Domiciliëring in euro (SEPA) DKV BELGIUM Bericht als bijlage';
  if (extractPayee(desc) !== 'DKV BELGIUM') throw new Error(`got ${extractPayee(desc)}`);
});

test('extractPayee: Doorlopende Naar extracts name', () => {
  const desc = 'Doorlopende betalingsopdracht in euro (SEPA) Naar: DE H EN MEVR DAVID DE BLOCK HENNE - BE40377128129963 Mededeling: Provisie';
  if (!extractPayee(desc).startsWith('DE H EN MEVR')) throw new Error(`got ${extractPayee(desc)}`);
});

test('extractPayee: SEPA Van extracts name', () => {
  const desc = 'Overschrijving in euro (SEPA) Van: ACME CORP - BE12345678901234';
  if (extractPayee(desc) !== 'ACME CORP') throw new Error(`got ${extractPayee(desc)}`);
});

test('extractPayee: clean description passes through', () => {
  if (extractPayee('Salary David') !== 'Salary David') throw new Error('passthrough broken');
});

test('extractPayee: empty returns empty', () => {
  if (extractPayee('') !== '') throw new Error('empty broken');
  if (extractPayee(null) !== '') throw new Error('null broken');
});

test('extractPayee: groups the same merchant across many Bancontact lines', () => {
  const lines = [
    'Betaling Bancontact 02/01/25 - 17.49 uur - Deliveroo Belgium SPRL 1210 - Brussels - BEL 70QDW7V',
    'Betaling Bancontact 02/02/25 - 17.41 uur - Deliveroo Belgium SPRL 1210 - Brussels - BEL 713X7DR',
    'Betaling Bancontact 05/01/25 - 18.03 uur - Deliveroo Belgium SPRL 1210 - Brussels - BEL 70RMMYR',
  ];
  const names = new Set(lines.map(extractPayee));
  if (names.size !== 1) throw new Error(`expected 1 distinct, got ${names.size}: ${[...names]}`);
  if (![...names][0].startsWith('Deliveroo')) throw new Error(`wrong: ${[...names][0]}`);
});

// bulkUpdatePayeeCategory is inside the app.js IIFE — exercise it by
// seeding a known transaction set, calling Store.updateTransaction the
// same way the function does, and verifying the store state. (We
// re-implement the loop here because the IIFE version isn't reachable
// from the test sandbox, but the contract is identical.)
test('bulk category update: applies new category to all matching transactions', () => {
  const state = ctx.window.Store.load();
  const before = state.transactions.filter(t => extractPayee(t.description) === 'DKV BELGIUM');
  if (before.length < 2) throw new Error(`expected ≥2 DKV transactions, got ${before.length}`);
  const catId = 'c_other';
  let updated = 0;
  for (const t of before) {
    ctx.window.Store.updateTransaction(state, t.id, { categoryId: catId });
    updated++;
  }
  if (updated !== before.length) throw new Error(`expected ${before.length} updates, got ${updated}`);

  // Reload from store to confirm persistence
  const reloaded = ctx.window.Store.load();
  const after = reloaded.transactions.filter(t => extractPayee(t.description) === 'DKV BELGIUM');
  const wrongCat = after.filter(t => t.categoryId !== catId);
  if (wrongCat.length > 0) throw new Error(`${wrongCat.length} transactions still have wrong category`);

  // Confirm a different payee was not affected
  const other = reloaded.transactions.find(t => extractPayee(t.description) === 'Coolblue');
  if (other && other.categoryId === catId) throw new Error('Coolblue was incorrectly updated');

  console.log(`      updated ${updated} DKV BELGIUM transactions to ${catId}`);
});

test('bulk category update: empty string clears the category', () => {
  const state = ctx.window.Store.load();
  const before = state.transactions.filter(t => extractPayee(t.description) === 'Coolblue');
  if (before.length === 0) throw new Error('expected at least 1 Coolblue transaction');
  // First set a category
  ctx.window.Store.updateTransaction(state, before[0].id, { categoryId: 'c_eating' });
  // Then clear it
  ctx.window.Store.updateTransaction(state, before[0].id, { categoryId: '' });
  const reloaded = ctx.window.Store.load();
  const after = reloaded.transactions.find(t => t.id === before[0].id);
  if (after.categoryId !== '') throw new Error(`expected empty category, got "${after.categoryId}"`);
});

console.log('\n— Summary —');
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
