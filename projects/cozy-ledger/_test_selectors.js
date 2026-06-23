#!/usr/bin/env node
// =====================================================================
// _test_selectors.js — Pure-function tests for selectors.js.
// Covers sourcesInScope and transactionsInScope for every scope, plus
// the data.js migration that backfills settings + source.balance.
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

// Load only data.js + selectors.js. No DOM, no app.js.
for (const s of ['data.js', 'selectors.js']) {
  const code = fs.readFileSync(path.join(__dirname, s), 'utf8');
  vm.runInContext(code, ctx, { filename: s });
}

const Store = ctx.window.Store;
const Selectors = ctx.window.Selectors;

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

console.log('\n— Summary —');
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
