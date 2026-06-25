#!/usr/bin/env node
// =====================================================================
// _test_period.js — Tests for ISSUE-013 (period state + pure helpers)
//
// Covers:
//   - Selectors.periodRangeForPreset (each preset, 3 today values)
//   - Selectors.periodRangeForAll (uses earliest in-scope tx)
//   - Selectors.txnsInPeriod (boundary inclusivity, scope filter)
//   - Selectors.monthsInPeriod (ordering, empty, cap)
//   - Router period state (set/reset/persistence round-trip)
//
// Pure-function helpers (Selectors.*) run in a minimal sandbox.
// Router-dependent tests reuse the same sandbox and a window stub so
// the localStorage round-trip and re-render invariants can be checked
// without booting the rest of the app.
// =====================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- Sandbox ------------------------------------------------------
const localStorageData = {};
const windowStub = {
  localStorage: {
    getItem: (k) => localStorageData[k] || null,
    setItem: (k, v) => { localStorageData[k] = String(v); },
    removeItem: (k) => { delete localStorageData[k]; },
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
};
// Minimal DOM stub: renderView() touches #view, #page-title, #page-sub,
// #add-txn-btn. Make sure they exist as objects with the properties the
// production code writes to.
const fakeNode = {
  innerHTML: '', textContent: '', style: { display: '' },
  appendChild() {}, classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
  querySelector: () => fakeNode, querySelectorAll: () => [],
  addEventListener() {}, dispatchEvent() {}, setAttribute() {}, getAttribute: () => null,
};
const documentStub = {
  querySelector: (sel) => sel && sel.startsWith('#') ? fakeNode : null,
  querySelectorAll: () => [],
  getElementById: () => fakeNode,
  createElement: () => fakeNode, createTextNode: () => ({ nodeType: 3 }),
};
// renderView() also touches Dashboard/Trends/etc. Stubs so the period
// helpers can be exercised without booting every view module.
const viewStubs = {
  Dashboard: { render: () => fakeNode },
  Trends: { render: () => fakeNode },
  Transactions: { render: () => fakeNode },
  Categories: { render: () => fakeNode },
  Sources: { render: () => fakeNode },
  Users: { render: () => fakeNode },
  Payees: { render: () => fakeNode },
  Settings: { render: () => fakeNode },
  Shell: {
    render: () => {}, closeSidebar: () => {}, ensureMonthPicker: () => {},
    updateSidebarBadges: () => {}, updateScopePills: () => {},
    updateSidebarActiveClass: () => {}, getRenderCount: () => 1, resetRenderCount: () => {},
  },
  App: { _state: { transactions: [], sources: [], users: [], categories: [], settings: {} } },
};
const ctx = vm.createContext({
  window: windowStub,
  localStorage: windowStub.localStorage,
  document: documentStub,
  console,
  setTimeout, clearTimeout,
  Math, Date, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
});
ctx.globalThis = ctx;
ctx.window.document = documentStub;
// Pre-install view + Shell + App stubs so router.js's renderView() can
// call into them without booting the rest of the app.
for (const [k, v] of Object.entries(viewStubs)) ctx[k] = v;
ctx.window.App = viewStubs.App;

// Load data.js, utils.js, selectors.js, i18n.js, router.js. router.js
// depends on Store + Fmt + Selectors + t (i18n) at call-time via
// renderView(), so the IIFE boots fine without them but renderView()
// needs them in scope. We load i18n.js so `t('...')` resolves.
for (const s of ['data.js', 'utils.js', 'selectors.js', 'i18n.js', 'router.js']) {
  const code = fs.readFileSync(path.join(__dirname, s), 'utf8');
  vm.runInContext(code, ctx, { filename: s });
}

const Selectors = ctx.window.Selectors;
const Router = ctx.window.Router;
const Fmt = ctx.window.Fmt;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); if (process.env.DEBUG_TEST) console.log(e.stack); failed++; }
}
function eq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg || 'eq'}: expected ${sb}, got ${sa}`);
}

// Helper: build a controlled state with in-scope transactions on the
// given ISO dates. Dates are deduped to keep the test scenarios
// readable.
function makeStateWithTxns(dates, opts = {}) {
  const txns = dates.map((d, i) => ({
    id: 't' + i,
    sourceId: 's_david',
    date: d,
    type: 'expense',
    amount: 1,
    ...(opts.txn || {}),
  }));
  return {
    users: [{ id: 'u_david' }, { id: 'u_isabelle' }],
    sources: [
      { id: 's_david',    ownerId: 'u_david',    active: true, balance: 0 },
      { id: 's_isabelle', ownerId: 'u_isabelle', active: true, balance: 0 },
    ],
    transactions: txns,
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
}

// ---- Selectors.periodRangeForPreset -------------------------------

console.log('\n— Selectors.periodRangeForPreset —');

const firstOfJune  = new Date(2026, 5, 1);   // 2026-06-01 (local)
const midJune      = new Date(2026, 5, 15);  // 2026-06-15
const lastOfJune   = new Date(2026, 5, 30);  // 2026-06-30

test('1m: snaps from to first of today\'s month, to to today (1st)', () => {
  eq(Selectors.periodRangeForPreset('1m', firstOfJune), { from: '2026-06-01', to: '2026-06-01' });
});

test('1m: same month, to follows today (15th)', () => {
  eq(Selectors.periodRangeForPreset('1m', midJune), { from: '2026-06-01', to: '2026-06-15' });
});

test('1m: same month, to follows today (30th)', () => {
  eq(Selectors.periodRangeForPreset('1m', lastOfJune), { from: '2026-06-01', to: '2026-06-30' });
});

test('3m on the 1st of month: from = first of (today - 2 months)', () => {
  eq(Selectors.periodRangeForPreset('3m', firstOfJune), { from: '2026-04-01', to: '2026-06-01' });
});

test('6m on the 15th: from = first of (today - 5 months)', () => {
  eq(Selectors.periodRangeForPreset('6m', midJune), { from: '2026-01-01', to: '2026-06-15' });
});

test('1y on the 30th: from = first of (today - 11 months)', () => {
  eq(Selectors.periodRangeForPreset('1y', lastOfJune), { from: '2025-07-01', to: '2026-06-30' });
});

test('2y on the 15th: from = first of (today - 23 months)', () => {
  eq(Selectors.periodRangeForPreset('2y', midJune), { from: '2024-07-01', to: '2026-06-15' });
});

test('all returns null (needs state)', () => {
  if (Selectors.periodRangeForPreset('all', midJune) !== null) {
    throw new Error('all should return null');
  }
});

test('custom / unknown returns null', () => {
  if (Selectors.periodRangeForPreset('custom', midJune) !== null) throw new Error('custom should return null');
  if (Selectors.periodRangeForPreset('7y', midJune)     !== null) throw new Error('unknown should return null');
});

// ---- Selectors.periodRangeForAll ----------------------------------

console.log('\n— Selectors.periodRangeForAll —');

test('all: earliest in-scope tx date (snapped to first of month) to today', () => {
  const state = makeStateWithTxns(['2025-08-22', '2026-03-04', '2025-12-15']);
  eq(Selectors.periodRangeForAll(state, midJune), { from: '2025-08-01', to: '2026-06-15' });
});

test('all: empty in-scope → from = to (today)', () => {
  const state = makeStateWithTxns([]);
  eq(Selectors.periodRangeForAll(state, midJune), { from: '2026-06-15', to: '2026-06-15' });
});

test('all: respects scope (transactions on other users\' sources are ignored)', () => {
  const state = {
    users: [{ id: 'u_david' }, { id: 'u_isabelle' }],
    sources: [
      { id: 's_david',    ownerId: 'u_david',    active: true, balance: 0 },
      { id: 's_isabelle', ownerId: 'u_isabelle', active: true, balance: 0 },
    ],
    transactions: [
      { id: 't1', sourceId: 's_david',    date: '2024-01-15', type: 'expense', amount: 1 },
      { id: 't2', sourceId: 's_isabelle', date: '2025-06-01', type: 'expense', amount: 1 },
    ],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  // Private scope = only s_david → earliest in scope = 2024-01-15.
  eq(Selectors.periodRangeForAll(state, midJune), { from: '2024-01-01', to: '2026-06-15' });
});

// ---- Selectors.txnsInPeriod ---------------------------------------

console.log('\n— Selectors.txnsInPeriod —');

test('txnsInPeriod: from boundary is inclusive', () => {
  const state = makeStateWithTxns(['2026-06-01', '2026-06-15', '2026-06-30']);
  const out = Selectors.txnsInPeriod(state, { from: '2026-06-01', to: '2026-06-30' });
  if (out.length !== 3) throw new Error(`expected 3, got ${out.length}`);
});

test('txnsInPeriod: to boundary is inclusive', () => {
  const state = makeStateWithTxns(['2026-06-01', '2026-06-15', '2026-06-30']);
  const out = Selectors.txnsInPeriod(state, { from: '2026-06-15', to: '2026-06-15' });
  if (out.length !== 1 || out[0].id !== 't1') throw new Error(`expected t1, got ${out.map(t => t.id).join(',')}`);
});

test('txnsInPeriod: txns outside the range are excluded', () => {
  const state = makeStateWithTxns(['2026-05-31', '2026-06-01', '2026-06-30', '2026-07-01']);
  const out = Selectors.txnsInPeriod(state, { from: '2026-06-01', to: '2026-06-30' });
  if (out.length !== 2) throw new Error(`expected 2, got ${out.length}`);
});

test('txnsInPeriod: out-of-scope txns are excluded', () => {
  const state = {
    users: [{ id: 'u_david' }, { id: 'u_isabelle' }],
    sources: [
      { id: 's_david',    ownerId: 'u_david',    active: true, balance: 0 },
      { id: 's_isabelle', ownerId: 'u_isabelle', active: true, balance: 0 },
    ],
    transactions: [
      { id: 't1', sourceId: 's_david',    date: '2026-06-15', type: 'expense', amount: 1 },
      { id: 't2', sourceId: 's_isabelle', date: '2026-06-15', type: 'expense', amount: 1 },
    ],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  const out = Selectors.txnsInPeriod(state, { from: '2026-06-01', to: '2026-06-30' });
  if (out.length !== 1 || out[0].id !== 't1') throw new Error(`expected only t1, got ${out.map(t => t.id).join(',')}`);
});

test('txnsInPeriod: missing range returns []', () => {
  const state = makeStateWithTxns(['2026-06-15']);
  if (Selectors.txnsInPeriod(state, null).length !== 0) throw new Error('null range should return []');
  if (Selectors.txnsInPeriod(state, {}).length !== 0)    throw new Error('{} range should return []');
});

// ---- Selectors.monthsInPeriod -------------------------------------

console.log('\n— Selectors.monthsInPeriod —');

test('monthsInPeriod: same month returns [YYYY-MM]', () => {
  eq(Selectors.monthsInPeriod({ from: '2026-06-15', to: '2026-06-30' }), ['2026-06']);
});

test('monthsInPeriod: crosses year boundary and is ordered', () => {
  eq(
    Selectors.monthsInPeriod({ from: '2025-11-01', to: '2026-02-15' }),
    ['2025-11', '2025-12', '2026-01', '2026-02'],
  );
});

test('monthsInPeriod: from > to returns []', () => {
  eq(Selectors.monthsInPeriod({ from: '2026-06-30', to: '2026-06-01' }), []);
});

test('monthsInPeriod: caps at 240 months even for huge ranges', () => {
  const out = Selectors.monthsInPeriod({ from: '1900-01-01', to: '2200-12-31' });
  if (out.length !== 240) throw new Error(`expected 240, got ${out.length}`);
  // First and last should still be reasonable endpoints.
  if (out[0] !== '1900-01') throw new Error(`expected first=1900-01, got ${out[0]}`);
});

test('monthsInPeriod: multi-year span is contiguous', () => {
  const out = Selectors.monthsInPeriod({ from: '2024-01-15', to: '2024-03-10' });
  eq(out, ['2024-01', '2024-02', '2024-03']);
});

// ---- Router period state ------------------------------------------

console.log('\n— Router period state —');

// Router boots into the dashboard default (1m).
test('Router.boot: defaults to 1m for dashboard on fresh boot', () => {
  localStorageData['cozy.ledger.period'] = undefined;
  Router.boot();
  const p = Router.period;
  if (p.preset !== '1m') throw new Error(`preset=${p.preset}`);
  if (!/^\d{4}-\d{2}-01$/.test(p.from)) throw new Error(`from should snap to first of month: ${p.from}`);
  if (p.to !== Fmt.today()) throw new Error(`to should be today: ${p.to}`);
});

test('Router.setPeriodPreset: 3m re-derives from/to and persists', () => {
  Router.setPeriodPreset('3m');
  const p = Router.period;
  if (p.preset !== '3m') throw new Error(`preset=${p.preset}`);
  // Stored value should round-trip.
  const stored = JSON.parse(localStorageData['cozy.ledger.period']);
  if (stored.preset !== '3m' || stored.from !== p.from || stored.to !== p.to) {
    throw new Error(`stored ${JSON.stringify(stored)} ≠ live ${JSON.stringify(p)}`);
  }
});

test('Router.setPeriodRange: sets preset=custom and clamps to to today', () => {
  Router.setPeriodRange({ from: '2026-01-15', to: '2030-12-31' });
  const p = Router.period;
  if (p.preset !== 'custom') throw new Error(`preset=${p.preset}`);
  if (p.from !== '2026-01-15') throw new Error(`from=${p.from}`);
  if (p.to !== Fmt.today())   throw new Error(`to should be clamped to today, got ${p.to}`);
});

test('Router.setPeriodRange: rejects from > to', () => {
  Router.setPeriodPreset('1m'); // known state
  const before = JSON.stringify(Router.period);
  Router.setPeriodRange({ from: '2026-06-30', to: '2026-06-01' });
  if (JSON.stringify(Router.period) !== before) {
    throw new Error(`period changed after invalid range: ${JSON.stringify(Router.period)}`);
  }
});

test('Router.resetPeriod(dashboard): restores 1m preset', () => {
  Router.setPeriodPreset('2y');
  Router.resetPeriod('dashboard');
  if (Router.period.preset !== '1m') throw new Error(`preset=${Router.period.preset}`);
});

test('Router.resetPeriod(trends): restores 1y preset', () => {
  Router.setPeriodPreset('1m');
  Router.resetPeriod('trends');
  if (Router.period.preset !== '1y') throw new Error(`preset=${Router.period.preset}`);
});

test('Router.defaultPresetFor: maps known view keys', () => {
  if (Router.defaultPresetFor('dashboard') !== '1m') throw new Error('dashboard');
  if (Router.defaultPresetFor('trends')    !== '1y') throw new Error('trends');
  if (Router.defaultPresetFor('unknown')   !== '1m') throw new Error('unknown falls back to dashboard');
});

// ---- Persistence round-trip ---------------------------------------

console.log('\n— Persistence round-trip —');

test('Persistence: round-trip survives a fresh Router.boot()', () => {
  // Write a known value, simulate fresh boot, verify restore.
  localStorageData['cozy.ledger.period'] = JSON.stringify({
    preset: '6m', from: '2025-12-01', to: '2026-06-15',
  });
  Router.boot();
  const p = Router.period;
  if (p.preset !== '6m' || p.from !== '2025-12-01' || p.to !== '2026-06-15') {
    throw new Error(`restore failed: ${JSON.stringify(p)}`);
  }
});

test('Persistence: malformed stored value falls back to dashboard default without throwing', () => {
  localStorageData['cozy.ledger.period'] = '{"preset": "bogus", "from": "nope"}';
  // Wrapped in a try in case the implementation crashes on garbage.
  try { Router.boot(); }
  catch (e) { throw new Error(`boot threw on malformed input: ${e.message}`); }
  if (Router.period.preset !== '1m') {
    throw new Error(`expected fallback to 1m, got ${Router.period.preset}`);
  }
});

test('Persistence: to in the future is rejected and falls back to default', () => {
  localStorageData['cozy.ledger.period'] = JSON.stringify({
    preset: 'custom', from: '2025-01-01', to: '2099-12-31',
  });
  Router.boot();
  if (Router.period.preset !== '1m') {
    throw new Error(`expected fallback, got preset=${Router.period.preset}`);
  }
});

test('Persistence: missing key falls back to dashboard default', () => {
  delete localStorageData['cozy.ledger.period'];
  Router.boot();
  if (Router.period.preset !== '1m') {
    throw new Error(`expected fallback to 1m, got ${Router.period.preset}`);
  }
});

test('Persistence: localStorage disabled (setItem throws) does not crash', () => {
  // Override localStorage to throw on write, simulating private mode.
  const original = windowStub.localStorage.setItem;
  windowStub.localStorage.setItem = () => { throw new Error('QuotaExceeded'); };
  try {
    Router.boot();
    Router.setPeriodPreset('1y');
    // Should not have thrown; in-memory state still tracks the change.
    if (Router.period.preset !== '1y') throw new Error('in-memory state should update even without persistence');
  } finally {
    windowStub.localStorage.setItem = original;
  }
});

console.log('\n— Summary —');
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);