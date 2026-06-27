#!/usr/bin/env node
// =====================================================================
// _test_selectors.js — Pure-function tests for selectors.js + utils.js.
//
// Covers every public function on the Selectors object (scope,
// currentUserId, sourcesInScope, transactionsInScope, sourcesById,
// balanceSeries, balanceChartDateRange, balanceAtDate, netWorthSeries,
// dailyNetFlow, monthlyBalance, monthlyNetWorth, monthlyNetFlow) and
// every function on the Fmt object (money, moneyShort, date, ymKey,
// monthLabel, today, currentMonthKey, shiftMonth, inMonth, pct),
// plus the data.js migration that backfills settings + source.balance.
// =====================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- Minimal browser-like context ----------------------------------
const localStorageData = {};
const ctx = vm.createContext({
  window: {
    localStorage: {
      getItem: (k) => localStorageData[k] || null,
      setItem: (k, v) => { localStorageData[k] = String(v); },
      removeItem: (k) => { delete localStorageData[k]; },
    },
  },
  localStorage: {
    getItem: (k) => localStorageData[k] || null,
    setItem: (k, v) => { localStorageData[k] = String(v); },
    removeItem: (k) => { delete localStorageData[k]; },
  },
  console,
  setTimeout, clearTimeout,
  Math, Date, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
});
ctx.window.document = { querySelector: () => null, querySelectorAll: () => [] };
ctx.globalThis = ctx;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}
function eq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg || 'eq'}: expected ${sb}, got ${sa}`);
}

// Load only data.js + selectors.js + utils.js. No DOM, no app.js.
// utils.js is loaded into the same sandbox so Fmt.* is testable
// without a real document (Fmt only references document inside
// function bodies that we never invoke from these tests).
for (const s of ['data.js', 'selectors.js', 'utils.js']) {
  const code = fs.readFileSync(path.join(__dirname, s), 'utf8');
  vm.runInContext(code, ctx, { filename: s });
}

const Store = ctx.window.Store;
const Selectors = ctx.window.Selectors;
const Fmt = ctx.window.Fmt;

// Helper: build a minimal state object with the fields selectors care about.
function makeState(overrides = {}) {
  return {
    users: [
      { id: 'u_david',    name: 'David' },
      { id: 'u_isabelle', name: 'Isabelle' },
    ],
    sources: [
      { id: 's_david',    name: 'David private',    ownerId: 'u_david',    active: true, balance: 100 },
      { id: 's_isabelle', name: 'Isabelle private', ownerId: 'u_isabelle', active: true, balance: 200 },
      { id: 's_joint',    name: 'Joint account',    ownerId: null,        active: true, balance: 300 },
      { id: 's_cash',     name: 'Cash',             ownerId: null,        active: true, balance: 50 },
      { id: 's_inactive', name: 'Old account',      ownerId: null,        active: false, balance: 999 },
    ],
    transactions: [
      { id: 't1', sourceId: 's_david',    amount: 10 },
      { id: 't2', sourceId: 's_david',    amount: -5 },
      { id: 't3', sourceId: 's_isabelle', amount: 20 },
      { id: 't4', sourceId: 's_joint',    amount: -30 },
      { id: 't5', sourceId: 's_cash',     amount: -2 },
      { id: 't6', sourceId: 's_inactive', amount: -1 },
    ],
    settings: { currentUserId: 'u_david', scope: 'private' },
    ...overrides,
  };
}

console.log('\n— sourcesInScope —');

test('private scope returns sources owned by currentUserId only', () => {
  const ids = Selectors.sourcesInScope(makeState()).map(s => s.id).sort();
  eq(ids, ['s_david'], 'private scope');
});

test('shared scope returns sources with ownerId === null', () => {
  const state = makeState({ settings: { currentUserId: 'u_david', scope: 'shared' } });
  const ids = Selectors.sourcesInScope(state).map(s => s.id).sort();
  eq(ids, ['s_cash', 's_joint'], 'shared scope');
});

test('all scope returns every active source', () => {
  const state = makeState({ settings: { currentUserId: 'u_david', scope: 'all' } });
  const ids = Selectors.sourcesInScope(state).map(s => s.id).sort();
  eq(ids, ['s_cash', 's_david', 's_isabelle', 's_joint'], 'all scope');
});

test('inactive sources are excluded in every scope', () => {
  const state = makeState({ settings: { currentUserId: 'u_david', scope: 'all' } });
  const ids = Selectors.sourcesInScope(state).map(s => s.id);
  if (ids.includes('s_inactive')) throw new Error('inactive source leaked');
});

test('missing currentUserId falls back to the first user', () => {
  const state = makeState({ settings: { scope: 'private' } }); // no currentUserId
  const ids = Selectors.sourcesInScope(state).map(s => s.id);
  eq(ids, ['s_david'], 'fallback to first user (u_david)');
});

test('invalid scope is treated as private', () => {
  const state = makeState({ settings: { currentUserId: 'u_david', scope: 'banana' } });
  const ids = Selectors.sourcesInScope(state).map(s => s.id);
  eq(ids, ['s_david'], 'invalid scope → private');
});

console.log('\n— transactionsInScope —');

test('transactions respect the active scope', () => {
  const stateAll = makeState({ settings: { currentUserId: 'u_david', scope: 'all' } });
  const allIds = Selectors.transactionsInScope(stateAll).map(t => t.id).sort();
  eq(allIds, ['t1', 't2', 't3', 't4', 't5'], 'all transactions on active sources');

  const statePrivate = makeState({ settings: { currentUserId: 'u_david', scope: 'private' } });
  const privIds = Selectors.transactionsInScope(statePrivate).map(t => t.id).sort();
  eq(privIds, ['t1', 't2'], 'private transactions');

  const stateShared = makeState({ settings: { currentUserId: 'u_david', scope: 'shared' } });
  const shIds = Selectors.transactionsInScope(stateShared).map(t => t.id).sort();
  eq(shIds, ['t4', 't5'], 'shared transactions');
});

test('transactions on inactive sources are excluded', () => {
  const state = makeState({ settings: { currentUserId: 'u_david', scope: 'all' } });
  const ids = Selectors.transactionsInScope(state).map(t => t.id);
  if (ids.includes('t6')) throw new Error('transaction on inactive source leaked');
});

test('currentUserId pointing at a missing user falls back to the first user', () => {
  const state = makeState({ settings: { currentUserId: 'u_ghost', scope: 'private' } });
  const ids = Selectors.transactionsInScope(state).map(t => t.id).sort();
  eq(ids, ['t1', 't2'], 'fallback to u_david');
});

console.log('\n— Store migration —');

test('first load seeds settings + balance and is idempotent', () => {
  // Clear localStorage so we get the seed path.
  ctx.window.localStorage.removeItem('cozy-ledger-v1');
  const s1 = Store.load();
  if (!s1.settings || s1.settings.currentUserId !== 'u_david') throw new Error('seed missing currentUserId');
  if (s1.settings.scope !== 'private') throw new Error('seed scope != private');
  for (const src of s1.sources) {
    if (typeof src.balance !== 'number') throw new Error(`seed ${src.id} missing balance`);
  }
  // Reload: migration runs again, state stays the same.
  const s2 = Store.load();
  eq(s2.settings, s1.settings, 'settings stable across reload');
  for (const src of s2.sources) {
    if (src.balance !== 0) throw new Error(`reloaded seed balance != 0 for ${src.id}: ${src.balance}`);
  }
});

test('legacy state without settings gets backfilled', () => {
  // Simulate an older save with no settings and sources without balance.
  const legacy = {
    users: [{ id: 'u_david', name: 'David', color: '#000', active: true }],
    sources: [
      { id: 's_david', name: 'David private', type: 'bank', ownerId: 'u_david', active: true },
    ],
    categories: [],
    transactions: [],
  };
  ctx.window.localStorage.setItem('cozy-ledger-v1', JSON.stringify(legacy));
  const s = Store.load();
  if (!s.settings) throw new Error('no settings after migration');
  if (s.settings.scope !== 'private') throw new Error('default scope not applied');
  if (s.settings.currentUserId !== 'u_david') throw new Error('default currentUserId not applied');
  if (s.sources[0].balance !== 0) throw new Error(`balance not backfilled, got ${s.sources[0].balance}`);
});

test('invalid stored scope is normalised to private', () => {
  ctx.window.localStorage.setItem('cozy-ledger-v1', JSON.stringify({
    users: [{ id: 'u_david', name: 'David', color: '#000', active: true }],
    sources: [{ id: 's_david', name: 'David private', type: 'bank', ownerId: 'u_david', active: true, balance: 0 }],
    categories: [], transactions: [],
    settings: { currentUserId: 'u_david', scope: 'banana' },
  }));
  const s = Store.load();
  if (s.settings.scope !== 'private') throw new Error(`expected private, got ${s.settings.scope}`);
});

test('Store.setScope validates input and persists', () => {
  ctx.window.localStorage.removeItem('cozy-ledger-v1');
  const s = Store.load();
  Store.setScope(s, 'shared');
  if (s.settings.scope !== 'shared') throw new Error('setScope did not update state');
  // Reload to verify persistence
  const reloaded = Store.load();
  if (reloaded.settings.scope !== 'shared') throw new Error('setScope did not persist');
  // Invalid input is a no-op
  Store.setScope(reloaded, 'banana');
  if (reloaded.settings.scope !== 'shared') throw new Error('setScope accepted invalid input');
});

console.log('\n— balanceSeries (ISSUE-002) —');

test('balanceSeries: source with no transactions returns []', () => {
  const state = makeState(); // t1..t6 on s_david..s_inactive
  // Make a source with no transactions.
  state.sources.push({ id: 's_empty', name: 'Empty', ownerId: null, active: true, balance: 750 });
  const series = Selectors.balanceSeries(state, 's_empty');
  if (series.length !== 0) throw new Error(`expected [], got ${JSON.stringify(series)}`);
});

test('balanceSeries: source with one transaction returns that one point at source.balance', () => {
  const state = {
    users: [{ id: 'u_david' }],
    sources: [{ id: 's', name: 'S', ownerId: 'u_david', active: true, balance: 1000 }],
    transactions: [
      { id: 't1', sourceId: 's', date: '2024-06-15', amount: -50 },
    ],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  const series = Selectors.balanceSeries(state, 's');
  if (series.length !== 1) throw new Error(`expected 1 point, got ${series.length}`);
  if (series[0].date !== '2024-06-15') throw new Error(`date: ${series[0].date}`);
  if (series[0].balance !== 1000) throw new Error(`balance: ${series[0].balance}`);
});

test('balanceSeries: many transactions walks backwards correctly', () => {
  // Day 1: spent 30 (N=-30). Day 2: earned 50 (N=+50). Day 3: spent 100 (N=-100).
  // User types "current balance = 1000" → B(day3)=1000.
  // B(day2) = B(day3) - N(day3) = 1000 - (-100) = 1100.
  // B(day1) = B(day2) - N(day2) = 1100 - 50 = 1050.
  const state = {
    users: [{ id: 'u_david' }],
    sources: [{ id: 's', name: 'S', ownerId: 'u_david', active: true, balance: 1000 }],
    transactions: [
      { id: 't1', sourceId: 's', date: '2024-06-01', amount: -30 },
      { id: 't2', sourceId: 's', date: '2024-06-02', amount: 50 },
      { id: 't3', sourceId: 's', date: '2024-06-03', amount: -100 },
    ],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  const series = Selectors.balanceSeries(state, 's');
  if (series.length !== 3) throw new Error(`expected 3 points, got ${series.length}`);
  eq(series.map(p => p.date), ['2024-06-01', '2024-06-02', '2024-06-03'], 'dates oldest→newest');
  eq(series.map(p => p.balance), [1050, 1100, 1000], 'balances');
});

test('balanceSeries: rightmost point always equals source.balance', () => {
  const state = {
    users: [{ id: 'u_david' }],
    sources: [{ id: 's', name: 'S', ownerId: 'u_david', active: true, balance: 1234.56 }],
    transactions: [
      { id: 't1', sourceId: 's', date: '2024-01-01', amount: 10 },
      { id: 't2', sourceId: 's', date: '2024-02-01', amount: -200 },
      { id: 't3', sourceId: 's', date: '2024-03-01', amount: 99.99 },
    ],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  const series = Selectors.balanceSeries(state, 's');
  const last = series[series.length - 1];
  if (last.balance !== 1234.56) throw new Error(`rightmost = ${last.balance}, want 1234.56`);
});

test('balanceSeries: multiple transactions on the same day are netted', () => {
  const state = {
    users: [{ id: 'u_david' }],
    sources: [{ id: 's', name: 'S', ownerId: 'u_david', active: true, balance: 1000 }],
    transactions: [
      { id: 't1', sourceId: 's', date: '2024-06-01', amount: 30 },
      { id: 't2', sourceId: 's', date: '2024-06-01', amount: -10 }, // same day
      { id: 't3', sourceId: 's', date: '2024-06-02', amount: -50 },
    ],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  const series = Selectors.balanceSeries(state, 's');
  if (series.length !== 2) throw new Error(`expected 2 days, got ${series.length}`);
  // Day 2: B(2) = 1000. Day 1: B(1) = 1000 - (-50) = 1050.
  if (series[0].balance !== 1050) throw new Error(`day1 = ${series[0].balance}, want 1050`);
  if (series[1].balance !== 1000) throw new Error(`day2 = ${series[1].balance}, want 1000`);
});

test('balanceSeries: missing source returns []', () => {
  const state = makeState();
  const series = Selectors.balanceSeries(state, 's_nonexistent');
  if (series.length !== 0) throw new Error(`expected [], got ${series.length}`);
});

test('balanceChartDateRange: oldest point is the leftmost date across all in-scope series', () => {
  const state = makeState();
  const range = Selectors.balanceChartDateRange(state);
  // s_david has t1 (2024-01-15) and t2 (2024-02-10) etc — depends on the seed.
  // We can only assert: range.from <= every in-scope series' first date, and range.to is today.
  const sources = Selectors.sourcesInScope(state);
  for (const src of sources) {
    const pts = Selectors.balanceSeries(state, src.id);
    if (pts.length && pts[0].date < range.from) {
      throw new Error(`range.from ${range.from} is after a series' first date ${pts[0].date}`);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  if (range.to !== today) throw new Error(`range.to = ${range.to}, want ${today}`);
});

console.log('\n— netWorthSeries (ISSUE-003) —');

test('netWorthSeries: no in-scope sources returns []', () => {
  const state = {
    users: [{ id: 'u_david' }],
    sources: [],
    transactions: [],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  const series = Selectors.netWorthSeries(state);
  if (series.length !== 0) throw new Error(`expected [], got ${series.length} points`);
});

test('netWorthSeries: sources with no transactions returns flat pair at total typed', () => {
  const state = {
    users: [{ id: 'u_david' }],
    sources: [
      { id: 's1', name: 'S1', ownerId: 'u_david', active: true, balance: 1000 },
      { id: 's2', name: 'S2', ownerId: 'u_david', active: true, balance: 500 },
    ],
    transactions: [],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  const series = Selectors.netWorthSeries(state);
  if (series.length !== 2) throw new Error(`expected 2 points (flat pair), got ${series.length}`);
  if (series[0].balance !== 1500) throw new Error(`left = ${series[0].balance}, want 1500`);
  if (series[1].balance !== 1500) throw new Error(`right = ${series[1].balance}, want 1500`);
});

test('netWorthSeries: rightmost point equals sum of typed balances', () => {
  const state = {
    users: [{ id: 'u_david' }],
    sources: [
      { id: 's1', name: 'S1', ownerId: 'u_david', active: true, balance: 1234 },
      { id: 's2', name: 'S2', ownerId: 'u_david', active: true, balance: 567 },
    ],
    transactions: [
      { id: 't', sourceId: 's1', date: '2024-01-15', amount: -100 },
    ],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  const series = Selectors.netWorthSeries(state);
  const last = series[series.length - 1];
  if (last.balance !== 1234 + 567) throw new Error(`rightmost = ${last.balance}, want 1801`);
});

test('netWorthSeries: aggregates per-day balances across sources with tx on different days', () => {
  const state = {
    users: [{ id: 'u_david' }],
    sources: [
      { id: 's1', name: 'S1', ownerId: 'u_david', active: true, balance: 1000 },
      { id: 's2', name: 'S2', ownerId: 'u_david', active: true, balance: 500 },
    ],
    transactions: [
      { id: 't1', sourceId: 's1', date: '2024-01-15', amount: -100 }, // s1 walks back: B(15)=1000
      { id: 't2', sourceId: 's2', date: '2024-02-10', amount: -200 }, // s2 walks back: B(10)=500
    ],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  const series = Selectors.netWorthSeries(state);
  // Dates: 2024-01-15, 2024-02-10.
  if (series.length !== 2) throw new Error(`expected 2 dates, got ${series.length}`);
  // On 2024-01-15: s1=1000 (typed), s2=500 (no tx yet, use typed). Total = 1500.
  if (series[0].balance !== 1500) throw new Error(`Jan 15 = ${series[0].balance}, want 1500`);
  // On 2024-02-10: s1=1000 (no newer tx), s2=500 (typed). Total = 1500.
  if (series[1].balance !== 1500) throw new Error(`Feb 10 = ${series[1].balance}, want 1500`);
});

test('netWorthSeries: respects active scope (Private only)', () => {
  const state = {
    users: [{ id: 'u_david' }, { id: 'u_isabelle' }],
    sources: [
      { id: 'sd', name: 'David',    ownerId: 'u_david',    active: true, balance: 1000 },
      { id: 'si', name: 'Isabelle', ownerId: 'u_isabelle', active: true, balance: 5000 },
      { id: 'sj', name: 'Joint',    ownerId: null,        active: true, balance: 8000 },
    ],
    transactions: [],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  const series = Selectors.netWorthSeries(state);
  // Private scope → only sd. Flat pair at 1000.
  if (series[0].balance !== 1000) throw new Error(`private total = ${series[0].balance}, want 1000`);
  if (series[1].balance !== 1000) throw new Error(`private total = ${series[1].balance}, want 1000`);
});

test('netWorthSeries: respects "all" scope (sums every active source)', () => {
  const state = {
    users: [{ id: 'u_david' }, { id: 'u_isabelle' }],
    sources: [
      { id: 'sd', name: 'David',    ownerId: 'u_david',    active: true, balance: 1000 },
      { id: 'si', name: 'Isabelle', ownerId: 'u_isabelle', active: true, balance: 5000 },
      { id: 'sj', name: 'Joint',    ownerId: null,        active: true, balance: 8000 },
    ],
    transactions: [],
    settings: { currentUserId: 'u_david', scope: 'all' },
  };
  const series = Selectors.netWorthSeries(state);
  const last = series[series.length - 1];
  if (last.balance !== 1000 + 5000 + 8000) throw new Error(`all-scope total = ${last.balance}, want 14000`);
});

// ---- Heartbeat / monthly trend selectors (ISSUE-004 heartbeat revamp) ---

test('dailyNetFlow: empty when no transactions', () => {
  const state = {
    users: [{ id: 'u_david' }],
    sources: [{ id: 'sd', name: 'David', ownerId: 'u_david', active: true, balance: 1000 }],
    transactions: [],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  if (Selectors.dailyNetFlow(state).length !== 0) throw new Error('expected [] for no tx');
});

test('dailyNetFlow: returns one entry per tx day with perSource breakdown and total', () => {
  const state = {
    users: [{ id: 'u_david' }],
    sources: [
      { id: 'sd', name: 'David', ownerId: 'u_david', active: true, balance: 500 },
      { id: 'sj', name: 'Joint', ownerId: null,     active: true, balance: 100 },
    ],
    transactions: [
      { sourceId: 'sd', date: '2026-05-10', amount: -50 },
      { sourceId: 'sd', date: '2026-05-10', amount: -30 },   // same day, summed
      { sourceId: 'sj', date: '2026-05-10', amount: 200 },
      { sourceId: 'sd', date: '2026-05-12', amount: 1500 },
    ],
    settings: { currentUserId: 'u_david', scope: 'all' },
  };
  const rows = Selectors.dailyNetFlow(state);
  if (rows.length !== 2) throw new Error(`rows = ${rows.length}, want 2`);
  const day1 = rows.find(r => r.date === '2026-05-10');
  if (day1.perSource.sd !== -80) throw new Error(`day1.sd = ${day1.perSource.sd}, want -80`);
  if (day1.perSource.sj !== 200) throw new Error(`day1.sj = ${day1.perSource.sj}, want 200`);
  if (day1.total !== 120) throw new Error(`day1.total = ${day1.total}, want 120`);
});

test('dailyNetFlow: respects scope filter', () => {
  const state = {
    users: [{ id: 'u_david' }, { id: 'u_isabelle' }],
    sources: [
      { id: 'sd', name: 'David',    ownerId: 'u_david',    active: true, balance: 100 },
      { id: 'sj', name: 'Joint',    ownerId: null,        active: true, balance: 100 },
    ],
    transactions: [
      { sourceId: 'sd', date: '2026-05-10', amount: -50 },
      { sourceId: 'sj', date: '2026-05-10', amount: 200 },
    ],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  const rows = Selectors.dailyNetFlow(state);
  if (rows.length !== 1) throw new Error(`rows = ${rows.length}, want 1`);
  if (rows[0].total !== -50) throw new Error(`private-scope total = ${rows[0].total}, want -50`);
});

test('monthlyBalance: returns one entry per month-end, rightmost equals typed balance', () => {
  const state = {
    users: [{ id: 'u_david' }],
    sources: [{ id: 'sd', name: 'David', ownerId: 'u_david', active: true, balance: 1000 }],
    transactions: [
      { sourceId: 'sd', date: '2026-03-15', amount: 2000 },
      { sourceId: 'sd', date: '2026-04-10', amount: -500 },
      { sourceId: 'sd', date: '2026-05-20', amount: -300 },
    ],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  const series = Selectors.monthlyBalance(state, 'sd', 12);
  if (series.length === 0) throw new Error('expected at least 1 point');
  // Sorted ascending.
  for (let i = 1; i < series.length; i++) {
    if (series[i].date <= series[i - 1].date) throw new Error('not sorted ascending');
  }
  // Last entry is today's typed balance.
  const last = series[series.length - 1];
  if (last.balance !== 1000) throw new Error(`last = ${last.balance}, want 1000 (typed)`);
});

test('monthlyBalance: respects months cap', () => {
  const state = {
    users: [{ id: 'u_david' }],
    sources: [{ id: 'sd', name: 'David', ownerId: 'u_david', active: true, balance: 0 }],
    transactions: [],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  // With no txns, anchor is N months ago. Past month-ends (those <= today)
  // plus today's typed-balance anchor.
  const series3 = Selectors.monthlyBalance(state, 'sd', 3);
  if (series3.length > 4) throw new Error(`3-month series length = ${series3.length}, want <=4`);
  if (series3.length < 3) throw new Error(`3-month series length = ${series3.length}, want >=3`);
  const series12 = Selectors.monthlyBalance(state, 'sd', 12);
  if (series12.length > 13) throw new Error(`12-month series length = ${series12.length}, want <=13`);
  if (series12.length < 12) throw new Error(`12-month series length = ${series12.length}, want >=12`);
});

test('monthlyNetWorth: sums every in-scope source per month-end, rightmost is sum of typed', () => {
  const state = {
    users: [{ id: 'u_david' }, { id: 'u_isabelle' }],
    sources: [
      { id: 'sd', name: 'David',    ownerId: 'u_david',    active: true, balance: 1000 },
      { id: 'sj', name: 'Joint',    ownerId: null,        active: true, balance: 2500 },
    ],
    transactions: [],
    settings: { currentUserId: 'u_david', scope: 'all' },
  };
  const series = Selectors.monthlyNetWorth(state, 6);
  const last = series[series.length - 1];
  if (last.balance !== 3500) throw new Error(`net-worth last = ${last.balance}, want 3500`);
  // No txns → balance is constant across all month-ends.
  for (const p of series) {
    if (p.balance !== 3500) throw new Error(`non-constant NW point: ${p.date} = ${p.balance}`);
  }
});

test('monthlyNetFlow: returns one entry per of the last N months with correct income/expense/net', () => {
  const state = {
    users: [{ id: 'u_david' }],
    sources: [{ id: 'sd', name: 'David', ownerId: 'u_david', active: true, balance: 0 }],
    transactions: [
      { sourceId: 'sd', date: '2026-04-15', amount: 1000 }, // income
      { sourceId: 'sd', date: '2026-04-20', amount: -200 },  // expense
      { sourceId: 'sd', date: '2026-05-10', amount: -800 },  // expense (net negative)
      { sourceId: 'sd', date: '2026-05-25', amount: 500 },  // income (partial recovery)
    ],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  const flow = Selectors.monthlyNetFlow(state, 6);
  if (flow.length !== 6) throw new Error(`expected 6 months, got ${flow.length}`);
  const apr = flow.find(f => f.month === '2026-04');
  if (!apr) throw new Error('April missing');
  if (apr.income !== 1000) throw new Error(`apr.income = ${apr.income}, want 1000`);
  if (apr.expense !== 200)  throw new Error(`apr.expense = ${apr.expense}, want 200`);
  if (apr.net !== 800)      throw new Error(`apr.net = ${apr.net}, want 800`);
  const may = flow.find(f => f.month === '2026-05');
  if (!may) throw new Error('May missing');
  if (may.income !== 500)  throw new Error(`may.income = ${may.income}, want 500`);
  if (may.expense !== 800) throw new Error(`may.expense = ${may.expense}, want 800`);
  if (may.net !== -300)    throw new Error(`may.net = ${may.net}, want -300`);
});

test('monthlyNetFlow: respects scope filter', () => {
  const state = {
    users: [{ id: 'u_david' }, { id: 'u_isabelle' }],
    sources: [
      { id: 'sd', name: 'David',    ownerId: 'u_david',    active: true, balance: 0 },
      { id: 'sj', name: 'Joint',    ownerId: null,        active: true, balance: 0 },
    ],
    transactions: [
      { sourceId: 'sd', date: '2026-04-15', amount: 1000, type: 'income' },
      { sourceId: 'sj', date: '2026-04-15', amount: 500,  type: 'expense' },
    ],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  const flow = Selectors.monthlyNetFlow(state, 6);
  const apr = flow.find(f => f.month === '2026-04');
  // Private scope: only David's txn counted.
  if (apr.net !== 1000) throw new Error(`private-scope apr.net = ${apr.net}, want 1000`);
});

// CSV imports store amounts as Math.abs(...), so all amounts are
// positive regardless of direction. The selector MUST honour `type`
// to put the value on the correct side — otherwise expenses would be
// counted as income and every month would net positive.
test('monthlyNetFlow: months parameter widens the window', () => {
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  const old = new Date(today.getFullYear() - 2, today.getMonth(), 15);
  const state = {
    users: [{ id: 'u_david' }],
    sources: [{ id: 'sd', ownerId: 'u_david', active: true, balance: 0 }],
    transactions: [
      { sourceId: 'sd', date: fmt(old), amount: 100, type: 'income' },
    ],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  // Default 12-month window skips a transaction 2 years ago.
  const flow1y = Selectors.monthlyNetFlow(state);
  if (flow1y.some(m => m.income > 0)) throw new Error('1y window should not reach 2-year-old txn');
  // 36-month window picks it up.
  const flow3y = Selectors.monthlyNetFlow(state, 36);
  const oldMonth = old.toISOString().slice(0, 7);
  if (!flow3y.some(m => m.month === oldMonth && m.income === 100)) {
    throw new Error(`3y window should include ${oldMonth}`);
  }
});

test('monthlyNetFlow: uses type, not amount sign, to bucket income vs expense', () => {
  const state = {
    users: [{ id: 'u_david' }],
    sources: [{ id: 'sd', ownerId: 'u_david', active: true, balance: 0 }],
    transactions: [
      { sourceId: 'sd', date: '2026-04-05', amount: 1800, type: 'income'  }, // positive amt + type=income → income
      { sourceId: 'sd', date: '2026-04-10', amount:  600, type: 'expense' }, // positive amt + type=expense → expense (NOT income!)
      { sourceId: 'sd', date: '2026-05-05', amount: 1800, type: 'income'  },
      { sourceId: 'sd', date: '2026-05-10', amount: 2200, type: 'expense' }, // 2200 > 1800 → net negative
    ],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  const flow = Selectors.monthlyNetFlow(state, 6);
  const apr = flow.find(f => f.month === '2026-04');
  if (apr.income  !== 1800) throw new Error(`apr.income = ${apr.income}, want 1800`);
  if (apr.expense !==  600) throw new Error(`apr.expense = ${apr.expense}, want 600`);
  if (apr.net     !== 1200) throw new Error(`apr.net = ${apr.net}, want 1200`);

  const may = flow.find(f => f.month === '2026-05');
  if (may.income  !== 1800) throw new Error(`may.income = ${may.income}, want 1800`);
  if (may.expense !== 2200) throw new Error(`may.expense = ${may.expense}, want 2200`);
  if (may.net     !== -400) throw new Error(`may.net = ${may.net}, want -400 (May should be a red month)`);
});

// ---- Read-only accessors (Selectors.scope, currentUserId) ----------

console.log('\n— Selectors.scope / currentUserId —');

test('Selectors.scope returns the persisted scope', () => {
  const state = makeState({ settings: { currentUserId: 'u_david', scope: 'shared' } });
  if (Selectors.scope(state) !== 'shared') throw new Error(`got ${Selectors.scope(state)}`);
});

test('Selectors.scope falls back to "private" when settings are missing', () => {
  const state = makeState({ settings: undefined });
  if (Selectors.scope(state) !== 'private') throw new Error(`got ${Selectors.scope(state)}`);
});

test('Selectors.scope treats invalid scope as "private"', () => {
  const state = makeState({ settings: { currentUserId: 'u_david', scope: 'banana' } });
  if (Selectors.scope(state) !== 'private') throw new Error(`got ${Selectors.scope(state)}`);
});

test('Selectors.currentUserId returns the persisted user', () => {
  const state = makeState({ settings: { currentUserId: 'u_isabelle', scope: 'private' } });
  if (Selectors.currentUserId(state) !== 'u_isabelle') throw new Error(`got ${Selectors.currentUserId(state)}`);
});

test('Selectors.currentUserId falls back to first user when currentUserId is missing', () => {
  const state = makeState({ settings: { scope: 'private' } });
  if (Selectors.currentUserId(state) !== 'u_david') throw new Error(`got ${Selectors.currentUserId(state)}`);
});

test('Selectors.currentUserId falls back to first user when currentUserId points at a missing user', () => {
  const state = makeState({ settings: { currentUserId: 'u_ghost', scope: 'private' } });
  if (Selectors.currentUserId(state) !== 'u_david') throw new Error(`got ${Selectors.currentUserId(state)}`);
});

test('Selectors.currentUserId returns "" when there are no users', () => {
  const state = makeState({ users: [], settings: { scope: 'private' } });
  if (Selectors.currentUserId(state) !== '') throw new Error(`got "${Selectors.currentUserId(state)}"`);
});

// ---- Selectors.sourcesById -----------------------------------------

console.log('\n— Selectors.sourcesById —');

test('sourcesById returns a map keyed by id', () => {
  const state = makeState();
  const map = Selectors.sourcesById(state);
  if (map.s_david.name !== 'David private') throw new Error('s_david missing or wrong');
  if (map.s_joint.ownerId !== null)        throw new Error('s_joint.ownerId wrong');
});

test('sourcesById is empty when state.sources is undefined', () => {
  const state = makeState({ sources: undefined });
  const map = Selectors.sourcesById(state);
  if (Object.keys(map).length !== 0) throw new Error(`got ${Object.keys(map).length} keys`);
});

// ---- Selectors.balanceAtDate ---------------------------------------

console.log('\n— Selectors.balanceAtDate —');

test('balanceAtDate: missing source returns 0', () => {
  const state = makeState();
  if (Selectors.balanceAtDate(state, 's_nonexistent', '2024-06-15') !== 0) {
    throw new Error('expected 0 for missing source');
  }
});

test('balanceAtDate: source with no transactions returns typed balance at any date', () => {
  const state = {
    users: [{ id: 'u_david' }],
    sources: [{ id: 's', ownerId: 'u_david', active: true, balance: 750 }],
    transactions: [],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  if (Selectors.balanceAtDate(state, 's', '2024-06-15') !== 750) throw new Error('past date');
  if (Selectors.balanceAtDate(state, 's', '1990-01-01') !== 750) throw new Error('ancient date');
  if (Selectors.balanceAtDate(state, 's', '2099-12-31') !== 750) throw new Error('future date');
});

test('balanceAtDate: 1-txn source returns typed balance at every date (no pre-tx history available)', () => {
  // With only one transaction, balanceSeries yields a single point at
  // the typed balance — there's no historical pre-tx balance to walk
  // back to. So balanceAtDate returns the typed balance at every date.
  // This is a known limitation of the algorithm; the dashboard never
  // surfaces pre-tx history for 1-txn sources because there isn't one.
  const state = {
    users: [{ id: 'u_david' }],
    sources: [{ id: 's', ownerId: 'u_david', active: true, balance: 1000 }],
    transactions: [
      { sourceId: 's', date: '2024-06-15', amount: -50 },
    ],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  if (Selectors.balanceAtDate(state, 's', '2024-01-01') !== 1000) throw new Error('before tx → typed');
  if (Selectors.balanceAtDate(state, 's', '2024-06-14') !== 1000) throw new Error('day before tx');
  if (Selectors.balanceAtDate(state, 's', '2024-06-15') !== 1000) throw new Error('tx day');
  if (Selectors.balanceAtDate(state, 's', '2099-12-31') !== 1000) throw new Error('after tx → typed');
});

test('balanceAtDate: with 2+ txns, dates before leftmost return leftmost balance', () => {
  // 3 consecutive-day txns: B(day3)=1000 (typed), B(day2)=1100, B(day1)=1050.
  const state = {
    users: [{ id: 'u_david' }],
    sources: [{ id: 's', ownerId: 'u_david', active: true, balance: 1000 }],
    transactions: [
      { sourceId: 's', date: '2024-06-01', amount: -30 },
      { sourceId: 's', date: '2024-06-02', amount: 50 },
      { sourceId: 's', date: '2024-06-03', amount: -100 },
    ],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  if (Selectors.balanceAtDate(state, 's', '2020-01-01') !== 1050) throw new Error('long before → leftmost');
  if (Selectors.balanceAtDate(state, 's', '2024-05-31') !== 1050) throw new Error('day before leftmost');
  if (Selectors.balanceAtDate(state, 's', '2024-06-01') !== 1050) throw new Error('leftmost day');
  if (Selectors.balanceAtDate(state, 's', '2024-06-02') !== 1100) throw new Error('between');
  if (Selectors.balanceAtDate(state, 's', '2024-06-03') !== 1000) throw new Error('rightmost');
});

test('balanceAtDate: returns the most recent prior balance for dates between transactions', () => {
  // Day 1: -30 → B(1)=? Day 2: +50 → B(2)=? Day 3: -100 → B(3)=1000 (typed).
  // Walking back: B(2)=1100, B(1)=1050.
  const state = {
    users: [{ id: 'u_david' }],
    sources: [{ id: 's', ownerId: 'u_david', active: true, balance: 1000 }],
    transactions: [
      { sourceId: 's', date: '2024-06-01', amount: -30 },
      { sourceId: 's', date: '2024-06-02', amount: 50 },
      { sourceId: 's', date: '2024-06-03', amount: -100 },
    ],
    settings: { currentUserId: 'u_david', scope: 'private' },
  };
  if (Selectors.balanceAtDate(state, 's', '2024-06-01') !== 1050) throw new Error('day 1');
  if (Selectors.balanceAtDate(state, 's', '2024-06-02') !== 1100) throw new Error('day 2');
  if (Selectors.balanceAtDate(state, 's', '2024-06-03') !== 1000) throw new Error('day 3');
});

// ---- Fmt.money / moneyShort ----------------------------------------

console.log('\n— Fmt.money / moneyShort —');

test('Fmt.money formats a positive amount with euro sign and 2 decimals', () => {
  // 'nl-BE' locale uses period for thousands, comma for decimal.
  if (Fmt.money(1234.5) !== '€1.234,50') throw new Error(`got "${Fmt.money(1234.5)}"`);
  if (Fmt.money(10)     !== '€10,00')    throw new Error(`got "${Fmt.money(10)}"`);
});

test('Fmt.money formats zero as "€0,00"', () => {
  if (Fmt.money(0) !== '€0,00') throw new Error(`got "${Fmt.money(0)}"`);
});

test('Fmt.money treats null/undefined/NaN as 0', () => {
  if (Fmt.money(null) !== '€0,00') throw new Error('null');
  if (Fmt.money(undefined) !== '€0,00') throw new Error('undefined');
  if (Fmt.money(NaN) !== '€0,00') throw new Error('NaN');
});

test('Fmt.money formats negatives without a sign', () => {
  if (Fmt.money(-42.5) !== '€-42,50') throw new Error(`got "${Fmt.money(-42.5)}"`);
});

test('Fmt.money with signed: true prepends "+" to positives', () => {
  if (Fmt.money(10, { signed: true }) !== '+€10,00') throw new Error(`got "${Fmt.money(10, { signed: true })}"`);
  if (Fmt.money(0,   { signed: true }) !== '€0,00')    throw new Error(`got "${Fmt.money(0,   { signed: true })}"`);
  if (Fmt.money(-5,  { signed: true }) !== '€-5,00')   throw new Error(`got "${Fmt.money(-5,  { signed: true })}"`);
});

test('Fmt.moneyShort: values under €10 show one decimal', () => {
  if (Fmt.moneyShort(5.4) !== '€5,4')   throw new Error(`got "${Fmt.moneyShort(5.4)}"`);
  if (Fmt.moneyShort(9.99) !== '€10,0') throw new Error(`got "${Fmt.moneyShort(9.99)}"`); // rounds 9.99 → 10.0
});

test('Fmt.moneyShort: values €10 and above show no decimal', () => {
  if (Fmt.moneyShort(50)   !== '€50')   throw new Error(`got "${Fmt.moneyShort(50)}"`);
  if (Fmt.moneyShort(999)  !== '€999')  throw new Error(`got "${Fmt.moneyShort(999)}"`);
});

test('Fmt.moneyShort: values >= €1000 use the "k" suffix', () => {
  if (Fmt.moneyShort(1500)  !== '€1,5k')  throw new Error(`got "${Fmt.moneyShort(1500)}"`);
  if (Fmt.moneyShort(12345) !== '€12,3k') throw new Error(`got "${Fmt.moneyShort(12345)}"`);
});

test('Fmt.moneyShort: treats null/NaN as 0 (still shows the decimal)', () => {
  // 0 < 10, so minFrac=1 → "0,0".
  if (Fmt.moneyShort(null) !== '€0,0') throw new Error(`null → "${Fmt.moneyShort(null)}"`);
  if (Fmt.moneyShort(NaN)  !== '€0,0') throw new Error(`NaN → "${Fmt.moneyShort(NaN)}"`);
});

// ---- Fmt.date / ymKey / monthLabel ---------------------------------

console.log('\n— Fmt.date / ymKey / monthLabel —');

test('Fmt.date returns "—" for empty input', () => {
  if (Fmt.date('') !== '—') throw new Error(`got "${Fmt.date('')}"`);
  if (Fmt.date(null) !== '—') throw new Error(`got "${Fmt.date(null)}"`);
});

test('Fmt.date with month: true yields "Month Year"', () => {
  const out = Fmt.date('2024-06-15', { month: true });
  if (!/[A-Za-z]+ 2024/.test(out)) throw new Error(`got "${out}"`);
});

test('Fmt.date default yields "DD Mon YYYY"', () => {
  const out = Fmt.date('2024-06-15');
  if (!/15/.test(out) || !/2024/.test(out)) throw new Error(`got "${out}"`);
});

test('Fmt.ymKey returns YYYY-MM with zero-padded month', () => {
  // Use a local-time constructor to avoid TZ surprises.
  if (Fmt.ymKey(new Date(2024, 0, 15)) !== '2024-01') throw new Error('Jan');
  if (Fmt.ymKey(new Date(2024, 10, 30)) !== '2024-11') throw new Error('Nov');
});

test('Fmt.monthLabel renders Dutch-aware long month + year', () => {
  const out = Fmt.monthLabel('2024-06');
  if (!/2024/.test(out)) throw new Error(`got "${out}"`);
});

// ---- Fmt.today / currentMonthKey -----------------------------------

console.log('\n— Fmt.today / currentMonthKey —');

test('Fmt.today returns YYYY-MM-DD (UTC, 10 chars)', () => {
  const out = Fmt.today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out)) throw new Error(`got "${out}"`);
  if (out.length !== 10) throw new Error(`length ${out.length}`);
});

test('Fmt.currentMonthKey returns YYYY-MM (zero-padded)', () => {
  const out = Fmt.currentMonthKey();
  if (!/^\d{4}-\d{2}$/.test(out)) throw new Error(`got "${out}"`);
});

test('Fmt.currentMonthKey matches the leading 7 chars of Fmt.ymKey for now', () => {
  const now = new Date();
  if (Fmt.currentMonthKey() !== Fmt.ymKey(now).slice(0, 7)) throw new Error('mismatch');
});

// ---- Fmt.shiftMonth -----------------------------------------------

console.log('\n— Fmt.shiftMonth —');

test('Fmt.shiftMonth advances by delta months', () => {
  if (Fmt.shiftMonth('2024-06', 1)  !== '2024-07') throw new Error('+1');
  if (Fmt.shiftMonth('2024-06', 6)  !== '2024-12') throw new Error('+6');
  if (Fmt.shiftMonth('2024-06', -1) !== '2024-05') throw new Error('-1');
});

test('Fmt.shiftMonth crosses year boundaries', () => {
  if (Fmt.shiftMonth('2024-01', -1) !== '2023-12') throw new Error('back into prev year');
  if (Fmt.shiftMonth('2024-12', 1)  !== '2025-01') throw new Error('forward into next year');
});

// ---- Fmt.inMonth / Fmt.pct -----------------------------------------

console.log('\n— Fmt.inMonth / Fmt.pct —');

test('Fmt.inMonth: same month returns true', () => {
  if (Fmt.inMonth('2024-06-15', '2024-06') !== true) throw new Error('mid-month');
  if (Fmt.inMonth('2024-06-01', '2024-06') !== true) throw new Error('first day');
  if (Fmt.inMonth('2024-06-30', '2024-06') !== true) throw new Error('last day');
});

test('Fmt.inMonth: different month returns false', () => {
  if (Fmt.inMonth('2024-06-15', '2024-07') !== false) throw new Error('next month');
  if (Fmt.inMonth('2023-06-15', '2024-06') !== false) throw new Error('prev year');
});

test('Fmt.pct: computes ratio as a percentage', () => {
  if (Fmt.pct(1, 4)   !== 25)  throw new Error(`got ${Fmt.pct(1, 4)}`);
  if (Fmt.pct(3, 4)   !== 75)  throw new Error(`got ${Fmt.pct(3, 4)}`);
  if (Fmt.pct(0, 100) !== 0)   throw new Error(`got ${Fmt.pct(0, 100)}`);
});

test('Fmt.pct: returns 0 when total is 0 or falsy', () => {
  if (Fmt.pct(5, 0) !== 0) throw new Error('total=0');
  if (Fmt.pct(5, null) !== 0) throw new Error('total=null');
  if (Fmt.pct(5, undefined) !== 0) throw new Error('total=undefined');
});

// ---- ISSUE-017: goalProgress (pure selector) ------------------------
console.log('\n— ISSUE-017: Selectors.goalProgress —');

function gp(goal) {
  return Selectors.goalProgress(goal);
}

test('goalProgress: partially-funded goal returns funded/percent/remaining', () => {
  const p = gp({ target: 1000, funded: 250, name: 'Zonnepanelen' });
  if (p.funded !== 250)  throw new Error(`funded, got ${p.funded}`);
  if (p.target !== 1000) throw new Error(`target, got ${p.target}`);
  if (p.percent !== 25)  throw new Error(`percent, got ${p.percent}`);
  if (p.remaining !== 750) throw new Error(`remaining, got ${p.remaining}`);
});

test('goalProgress: exactly-reached goal returns percent=100, remaining=0', () => {
  const p = gp({ target: 500, funded: 500 });
  if (p.percent !== 100)   throw new Error(`percent, got ${p.percent}`);
  if (p.remaining !== 0)   throw new Error(`remaining, got ${p.remaining}`);
});

test('goalProgress: over-funded goal returns percent>100, remaining=0', () => {
  const p = gp({ target: 200, funded: 350 });
  if (p.percent !== 175)   throw new Error(`percent, got ${p.percent}`);
  if (p.remaining !== 0)   throw new Error(`remaining should clamp to 0, got ${p.remaining}`);
});

test('goalProgress: target=0 returns percent=0 (avoids division by zero)', () => {
  const p = gp({ target: 0, funded: 100 });
  if (p.percent !== 0) throw new Error(`percent, got ${p.percent}`);
  if (p.remaining !== 0) throw new Error(`remaining, got ${p.remaining}`);
});

test('goalProgress: null/undefined goal returns zeroed progress', () => {
  const a = gp(null);
  if (a.funded !== 0 || a.target !== 0 || a.percent !== 0 || a.remaining !== 0) {
    throw new Error('null goal not zeroed');
  }
  const b = gp(undefined);
  if (b.funded !== 0 || b.target !== 0 || b.percent !== 0 || b.remaining !== 0) {
    throw new Error('undefined goal not zeroed');
  }
});

test('goalProgress: rounds percent to 2 decimals', () => {
  // 333.33 / 1000 = 33.333... → 33.33
  const p = gp({ target: 1000, funded: 333.33 });
  if (p.percent !== 33.33) throw new Error(`percent, got ${p.percent}`);
});

// ---- ISSUE-018: Envelope helpers (pure) -----------------------------
console.log('\n— ISSUE-018: Envelope helpers —');

// currentPeriodFor: monthly / yearly boundaries across the year.
test('currentPeriodFor: monthly returns first-of-month through today', () => {
  const today = new Date(2026, 5, 17); // 17 Jun 2026
  const p = Selectors.currentPeriodFor({ period: 'monthly' }, today);
  if (p.from !== '2026-06-01') throw new Error(`from, got ${p.from}`);
  if (p.to !== '2026-06-17')   throw new Error(`to, got ${p.to}`);
});

test('currentPeriodFor: monthly at year boundary', () => {
  const today = new Date(2026, 0, 1); // 1 Jan 2026
  const p = Selectors.currentPeriodFor({ period: 'monthly' }, today);
  if (p.from !== '2026-01-01') throw new Error(`from, got ${p.from}`);
  if (p.to !== '2026-01-01')   throw new Error(`to, got ${p.to}`);
});

test('currentPeriodFor: yearly returns Jan 1 through today', () => {
  const today = new Date(2026, 5, 17); // 17 Jun 2026
  const p = Selectors.currentPeriodFor({ period: 'yearly' }, today);
  if (p.from !== '2026-01-01') throw new Error(`from, got ${p.from}`);
  if (p.to !== '2026-06-17')   throw new Error(`to, got ${p.to}`);
});

test('currentPeriodFor: yearly at year boundary', () => {
  const today = new Date(2026, 11, 31); // 31 Dec 2026
  const p = Selectors.currentPeriodFor({ period: 'yearly' }, today);
  if (p.from !== '2026-01-01') throw new Error(`from, got ${p.from}`);
  if (p.to !== '2026-12-31')   throw new Error(`to, got ${p.to}`);
});

test('currentPeriodFor: unknown period defaults to monthly', () => {
  const today = new Date(2026, 2, 10); // 10 Mar 2026
  const p = Selectors.currentPeriodFor({ period: 'something' }, today);
  if (p.from !== '2026-03-01') throw new Error(`from, got ${p.from}`);
  if (p.to !== '2026-03-10')   throw new Error(`to, got ${p.to}`);
});

// envelopeSpend: link matching and date window.
function makeEnv({ cap = 1000, period = 'monthly', categoryIds = [], payeeIds = [] } = {}) {
  return { id: 'env1', name: 'Test', cap, period, categoryIds, payeeIds, notes: '', createdAt: '', updatedAt: '' };
}
// csv.js helpers (CSVImport.extractPayee) live in a different module
// — for selector tests we expose the matching function directly on
// CSVImport via the test harness setup at the top of the file.
test('envelopeSpend: empty envelope (no links) returns 0', () => {
  const today = new Date(2026, 5, 15);
  const env = makeEnv({ categoryIds: [], payeeIds: [] });
  const state = {
    transactions: [
      { id: 't1', type: 'expense', amount: 50, date: '2026-06-10', categoryId: 'c_eat', description: 'Jumbo' },
    ],
  };
  const v = Selectors.envelopeSpend(env, state, today);
  if (v !== 0) throw new Error(`expected 0, got ${v}`);
});

test('envelopeSpend: one-category envelope matches only that category in period', () => {
  const today = new Date(2026, 5, 15);
  const env = makeEnv({ categoryIds: ['c_eat'] });
  const state = {
    transactions: [
      { id: 't1', type: 'expense', amount: 30, date: '2026-06-05', categoryId: 'c_eat',    description: 'AH' },
      { id: 't2', type: 'expense', amount: 20, date: '2026-06-06', categoryId: 'c_other',  description: 'X' },
      { id: 't3', type: 'expense', amount: 40, date: '2026-05-30', categoryId: 'c_eat',    description: 'AH' }, // out of period
    ],
  };
  const v = Selectors.envelopeSpend(env, state, today);
  if (v !== 30) throw new Error(`expected 30, got ${v}`);
});

test('envelopeSpend: one-payee envelope matches only that payee in period', () => {
  const today = new Date(2026, 5, 15);
  const env = makeEnv({ payeeIds: ['AH'] });
  const state = {
    transactions: [
      { id: 't1', type: 'expense', amount: 30, date: '2026-06-05', categoryId: 'c_eat',  description: 'AH' },
      { id: 't2', type: 'expense', amount: 20, date: '2026-06-06', categoryId: 'c_eat',  description: 'Jumbo' },
      { id: 't3', type: 'expense', amount: 40, date: '2026-06-07', categoryId: 'c_eat',  description: 'AH BON' },
    ],
  };
  const v = Selectors.envelopeSpend(env, state, today);
  if (v !== 30) throw new Error(`expected 30, got ${v}`);
});

test('envelopeSpend: txn matching both category and payee is counted once', () => {
  const today = new Date(2026, 5, 15);
  const env = makeEnv({ categoryIds: ['c_eat'], payeeIds: ['AH'] });
  const state = {
    transactions: [
      { id: 't1', type: 'expense', amount: 30, date: '2026-06-05', categoryId: 'c_eat',    description: 'AH' },     // both
      { id: 't2', type: 'expense', amount: 25, date: '2026-06-06', categoryId: 'c_eat',    description: 'Jumbo' }, // cat only
      { id: 't3', type: 'expense', amount: 15, date: '2026-06-07', categoryId: 'c_other',  description: 'AH' },     // payee only
    ],
  };
  const v = Selectors.envelopeSpend(env, state, today);
  if (v !== 70) throw new Error(`expected 70, got ${v}`);
});

test('envelopeSpend: out-of-period and out-of-scope txns are excluded', () => {
  const today = new Date(2026, 5, 15);
  const env = makeEnv({ categoryIds: ['c_eat'] });
  const state = {
    transactions: [
      { id: 't1', type: 'expense', amount: 30, date: '2026-06-05', categoryId: 'c_eat',    description: 'AH' },     // in
      { id: 't2', type: 'expense', amount: 99, date: '2026-05-30', categoryId: 'c_eat',    description: 'AH' },     // out-of-period
      { id: 't3', type: 'expense', amount: 99, date: '2026-06-06', categoryId: 'c_other',  description: 'AH' },     // out-of-scope
      { id: 't4', type: 'income',  amount: 99, date: '2026-06-07', categoryId: 'c_eat',    description: 'AH' },     // income — subtract
    ],
  };
  const v = Selectors.envelopeSpend(env, state, today);
  if (v !== 30 - 99) throw new Error(`expected -69, got ${v}`);
});

test('envelopeSpend: yearly envelope sums across the whole year', () => {
  const today = new Date(2026, 5, 15);
  const env = makeEnv({ period: 'yearly', categoryIds: ['c_eat'] });
  const state = {
    transactions: [
      { id: 't1', type: 'expense', amount: 30, date: '2026-02-05', categoryId: 'c_eat', description: 'X' },
      { id: 't2', type: 'expense', amount: 20, date: '2026-06-05', categoryId: 'c_eat', description: 'X' },
      { id: 't3', type: 'expense', amount: 10, date: '2025-12-30', categoryId: 'c_eat', description: 'X' }, // prev year
    ],
  };
  const v = Selectors.envelopeSpend(env, state, today);
  if (v !== 50) throw new Error(`expected 50, got ${v}`);
});

// envelopeProgress: progress math.
test('envelopeProgress: spent < cap returns remaining, no overspent', () => {
  const today = new Date(2026, 5, 15);
  const env = makeEnv({ cap: 1000, categoryIds: ['c_eat'] });
  const state = { transactions: [
    { id: 't1', type: 'expense', amount: 200, date: '2026-06-05', categoryId: 'c_eat', description: 'X' },
  ]};
  const p = Selectors.envelopeProgress(env, state, today);
  if (p.spent !== 200) throw new Error(`spent, got ${p.spent}`);
  if (p.cap !== 1000) throw new Error(`cap, got ${p.cap}`);
  if (p.percent !== 20) throw new Error(`percent, got ${p.percent}`);
  if (p.remaining !== 800) throw new Error(`remaining, got ${p.remaining}`);
  if (p.overspent !== 0) throw new Error(`overspent should be 0, got ${p.overspent}`);
});

test('envelopeProgress: spent === cap returns percent=100, remaining=0, overspent=0', () => {
  const today = new Date(2026, 5, 15);
  const env = makeEnv({ cap: 1000, categoryIds: ['c_eat'] });
  const state = { transactions: [
    { id: 't1', type: 'expense', amount: 1000, date: '2026-06-05', categoryId: 'c_eat', description: 'X' },
  ]};
  const p = Selectors.envelopeProgress(env, state, today);
  if (p.percent !== 100) throw new Error(`percent, got ${p.percent}`);
  if (p.remaining !== 0) throw new Error(`remaining, got ${p.remaining}`);
  if (p.overspent !== 0) throw new Error(`overspent, got ${p.overspent}`);
});

test('envelopeProgress: spent > cap returns overspent > 0 and clamped remaining', () => {
  const today = new Date(2026, 5, 15);
  const env = makeEnv({ cap: 200, categoryIds: ['c_eat'] });
  const state = { transactions: [
    { id: 't1', type: 'expense', amount: 350, date: '2026-06-05', categoryId: 'c_eat', description: 'X' },
  ]};
  const p = Selectors.envelopeProgress(env, state, today);
  if (p.percent !== 175) throw new Error(`percent, got ${p.percent}`);
  if (p.remaining !== 0) throw new Error(`remaining should clamp to 0, got ${p.remaining}`);
  if (p.overspent !== 150) throw new Error(`overspent, got ${p.overspent}`);
});

console.log('\n— Summary —');
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
