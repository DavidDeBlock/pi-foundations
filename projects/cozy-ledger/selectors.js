// =====================================================================
// selectors.js — Pure functions over the persisted state.
// Used by app.js to keep the dashboard / transactions list / future
// balance chart all reading the same in-scope slice of data.
//
// Scope semantics (ISSUE-001):
//   private → sources where source.ownerId === settings.currentUserId
//   shared  → sources where source.ownerId === null
//   all     → every source
//
// A transaction is "in scope" iff its sourceId belongs to a source that
// is in scope. The per-transaction `scope` field ('private' | 'shared')
// is unrelated to this filter — it stays available for the existing
// shared-vs-private card.
// =====================================================================

const VALID_SCOPES = ['private', 'shared', 'all'];

function readSettings(state) {
  return (state && state.settings && typeof state.settings === 'object') ? state.settings : {};
}

function readScope(state) {
  const s = readSettings(state).scope;
  return VALID_SCOPES.includes(s) ? s : 'private';
}

function readCurrentUserId(state) {
  const id = readSettings(state).currentUserId;
  if (id && state.users && state.users.some(u => u.id === id)) return id;
  // Fall back to the first user; if there are no users, return '' (selections become empty).
  return (state.users && state.users[0] && state.users[0].id) || '';
}

const Selectors = {
  // ---- Scope filter ------------------------------------------------
  /**
   * Resolved scope for the current viewer. Defaults to 'private' on missing/invalid.
   * @param {State} state
   * @returns {Scope}
   */
  scope(state) { return readScope(state); },

  /**
   * Resolved current user id. Falls back to the first user, or '' if none.
   * @param {State} state
   * @returns {string}
   */
  currentUserId(state) { return readCurrentUserId(state); },

  /**
   * Sources visible in the current scope, ignoring inactive entries.
   * @param {State} state
   * @returns {Source[]}
   */
  sourcesInScope(state) {
    const scope = readScope(state);
    const currentUserId = readCurrentUserId(state);
    const sources = (state.sources || []).filter(s => s && s.active !== false);
    if (scope === 'all') return sources;
    if (scope === 'shared') return sources.filter(s => s.ownerId == null);
    // private
    if (!currentUserId) return [];
    return sources.filter(s => s.ownerId === currentUserId);
  },

  /**
   * Transactions whose source is in the current scope.
   * @param {State} state
   * @returns {Transaction[]}
   */
  transactionsInScope(state) {
    const inScopeSourceIds = new Set(Selectors.sourcesInScope(state).map(s => s.id));
    return (state.transactions || []).filter(t => inScopeSourceIds.has(t.sourceId));
  },

  // ---- Source map (handy for O(1) lookups in renderers) ------------
  /**
   * Map of source id → source. Includes inactive sources.
   * @param {State} state
   * @returns {Record<string,Source>}
   */
  sourcesById(state) {
    /** @type {Record<string,Source>} */
    const m = {};
    for (const s of (state.sources || [])) m[s.id] = s;
    return m;
  },

  // ---- Balance series (ISSUE-002) ---------------------------------
  // Returns `[{date, balance}]` sorted oldest → newest for one source,
  // walking transactions backwards from the user-typed `source.balance`.
  // Empty array means "no transactions" — the chart renderer treats
  // that as a flat horizontal line at `source.balance`.
  //
  // Walking rule: `B(d) = B(d+1) - N(d+1)` where N is the day's net
  // flow (income minus expense, signed amount). The rightmost point is
  // therefore `source.balance` by construction.
  /**
   * Daily balance for a single source, oldest first, walking back from `source.balance`.
   * @param {State} state
   * @param {string} sourceId
   * @returns {BalancePoint[]}
   */
  balanceSeries(state, sourceId) {
    const source = (state.sources || []).find(s => s.id === sourceId);
    if (!source) return [];
    const txns = (state.transactions || []).filter(t => t.sourceId === sourceId);
    if (!txns.length) return [];
    // Net flow per day, ISO date as the key (lexicographic sort = chronological).
    // The CSV import stores amounts as Math.abs(...) — positive for both
    // income and expense — and uses the `type` field to indicate direction.
    // We honour `type` first and fall back to the amount sign for manually
    // entered transactions that may omit `type`.
    const flowByDate = new Map();
    for (const t of txns) {
      if (!t.date) continue;
      const mag = Math.abs(Number(t.amount) || 0);
      let signed;
      if (t.type === 'income')       signed =  mag;
      else if (t.type === 'expense') signed = -mag;
      else                            signed = (Number(t.amount) < 0) ? -mag : mag;
      flowByDate.set(t.date, (flowByDate.get(t.date) || 0) + signed);
    }
    const dates = [...flowByDate.keys()].sort();
    // Walk backwards from the latest date.
    const points = [];
    let bal = Number(source.balance) || 0;
    for (let i = dates.length - 1; i >= 0; i--) {
      points.push({ date: dates[i], balance: round2(bal) });
      bal -= flowByDate.get(dates[i]) || 0;
    }
    return points.reverse(); // oldest first
  },

  // ---- Helpers used by the chart ----------------------------------
  // X-axis range for the balance chart: from the oldest date that
  // appears in any in-scope series, to today. If nothing has data,
  // fall back to a 90-day window so the chart still draws.
  /**
   * Inclusive chart range: from oldest in-scope tx (or 90 days back) to today.
   * @param {State} state
   * @returns {{ from: string, to: string }}
   */
  balanceChartDateRange(state) {
    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);
    let oldestIso = null;
    const sources = Selectors.sourcesInScope(state);
    for (const src of sources) {
      const pts = Selectors.balanceSeries(state, src.id);
      if (pts.length && (!oldestIso || pts[0].date < oldestIso)) {
        oldestIso = pts[0].date;
      }
    }
    if (!oldestIso) {
      const d = new Date(today.getTime() - 90 * 86400000);
      oldestIso = d.toISOString().slice(0, 10);
    }
    return { from: oldestIso, to: todayIso };
  },

  // ---- Net-worth aggregate (ISSUE-003) ---------------------------
  // Returns the source's balance on `date`. For dates with no
  // transaction, the bank balance is the most recent prior balance
  // from balanceSeries. For dates before the oldest transaction, the
  // leftmost balance is reused (bank balance is constant on non-tx
  // days). Sources with no transactions return the typed balance at
  // every date.
  /**
   * Reconstructed balance for a single source on a given date.
   * @param {State} state
   * @param {string} sourceId
   * @param {string} date  ISO YYYY-MM-DD
   * @returns {number}
   */
  balanceAtDate(state, sourceId, date) {
    const src = (state.sources || []).find(s => s.id === sourceId);
    if (!src) return 0;
    const typed = Number(src.balance) || 0;
    const pts = Selectors.balanceSeries(state, sourceId);
    if (!pts.length) return typed;
    if (date < pts[0].date) return pts[0].balance;
    let bal = pts[0].balance;
    for (const p of pts) {
      if (p.date <= date) bal = p.balance;
      else break;
    }
    return bal;
  },

  // Aggregate per-day balances across all in-scope sources into a
  // single sorted series. Returns `[]` if no in-scope sources exist.
  // When nothing in scope has any transactions, returns a flat pair
  // (from, total) → (to, total) so the renderer draws a flat line.
  /**
   * Net-worth series, one point per active date, across all in-scope sources.
   * @param {State} state
   * @returns {BalancePoint[]}
   */
  netWorthSeries(state) {
    const sources = Selectors.sourcesInScope(state);
    if (!sources.length) return [];
    const allDates = new Set();
    for (const src of sources) {
      for (const p of Selectors.balanceSeries(state, src.id)) {
        allDates.add(p.date);
      }
    }
    const range = Selectors.balanceChartDateRange(state);
    if (!allDates.size) {
      const total = sources.reduce((s, src) => s + (Number(src.balance) || 0), 0);
      return [
        { date: range.from, balance: round2(total) },
        { date: range.to,   balance: round2(total) },
      ];
    }
    const dates = [...allDates].sort();
    return dates.map(date => {
      let nw = 0;
      for (const src of sources) {
        nw += Selectors.balanceAtDate(state, src.id, date);
      }
      return { date, balance: round2(nw) };
    });
  },

  // ---- Heartbeat chart (ISSUE-004) -------------------------------
  // Per-day net flow breakdown across all in-scope sources. Each
  // entry: { date, perSource: { srcId: netFlow }, total }. Days with
  // no transactions are omitted — they render as gaps in the chart.
  // The chart range (oldest tx → today) is the inclusive window.
  /**
   * Per-day net flow across in-scope sources, oldest first. Days with no activity are omitted.
   * @param {State} state
   * @returns {{ date: string, perSource: Object<string, number>, total: number }[]}
   */
  dailyNetFlow(state) {
    const range = Selectors.balanceChartDateRange(state);
    const sources = Selectors.sourcesInScope(state);
    const srcIds = new Set(sources.map(s => s.id));
    const byDate = new Map();
    for (const t of (state.transactions || [])) {
      if (!t.date) continue;
      if (!srcIds.has(t.sourceId)) continue;
      if (t.date < range.from || t.date > range.to) continue;
      if (!byDate.has(t.date)) byDate.set(t.date, { date: t.date, perSource: {}, total: 0 });
      const row = byDate.get(t.date);
      const amt = Number(t.amount) || 0;
      row.perSource[t.sourceId] = round2((row.perSource[t.sourceId] || 0) + amt);
      row.total = round2(row.total + amt);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  },

  // End-of-month balances for a single source, going back `months`
  // (default 12). Each entry: { date: 'YYYY-MM-DD', month: 'YYYY-MM',
  // balance }. The rightmost point is always today's typed balance.
  /**
   * End-of-month balance points for one source, oldest first. The final point anchors at the typed current balance.
   * @param {State} state
   * @param {string} sourceId
   * @param {number} [months=12]
   * @returns {BalancePoint[]}
   */
  monthlyBalance(state, sourceId, months = 12) {
    const source = (state.sources || []).find(s => s.id === sourceId);
    if (!source) return [];
    const srcTxns = (state.transactions || []).filter(t => t.sourceId === sourceId && t.date);

    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);

    // Earliest anchor = oldest tx month, capped at N months ago.
    let oldestMonth = null;
    if (srcTxns.length) {
      const oldestIso = srcTxns.reduce((m, t) => t.date < m ? t.date : m, srcTxns[0].date);
      const od = new Date(oldestIso + 'T00:00:00Z');
      oldestMonth = new Date(Date.UTC(od.getUTCFullYear(), od.getUTCMonth(), 1));
    }
    const startMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - months + 1, 1));
    const startUtc = oldestMonth && oldestMonth > startMonth ? oldestMonth : startMonth;

    const points = [];
    let cursor = new Date(Date.UTC(startUtc.getUTCFullYear(), startUtc.getUTCMonth() + 1, 0));
    while (cursor <= today) {
      const dateIso = cursor.toISOString().slice(0, 10);
      const monthIso = cursor.toISOString().slice(0, 7);
      const bal = Selectors.balanceAtDate(state, sourceId, dateIso);
      points.push({ date: dateIso, month: monthIso, balance: round2(bal) });
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 2, 0));
    }
    // Rightmost point: today's typed balance (anchors the line).
    points.push({
      date: todayIso,
      month: today.toISOString().slice(0, 7),
      balance: round2(Number(source.balance) || 0),
    });
    return points;
  },

  // Monthly net-worth: same shape as monthlyBalance but summed across
  // every in-scope source. The rightmost point is the sum of today's
  // typed balances.
  /**
   * End-of-month net worth, summed across every in-scope source. Final point = sum of today's typed balances.
   * @param {State} state
   * @param {number} [months=12]
   * @returns {BalancePoint[]}
   */
  monthlyNetWorth(state, months = 12) {
    const sources = Selectors.sourcesInScope(state);
    if (!sources.length) return [];

    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);

    const srcIds = new Set(sources.map(s => s.id));
    let oldestIso = null;
    for (const t of (state.transactions || [])) {
      if (!t.date || !srcIds.has(t.sourceId)) continue;
      if (!oldestIso || t.date < oldestIso) oldestIso = t.date;
    }
    let oldestMonth = null;
    if (oldestIso) {
      const od = new Date(oldestIso + 'T00:00:00Z');
      oldestMonth = new Date(Date.UTC(od.getUTCFullYear(), od.getUTCMonth(), 1));
    }
    const startMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - months + 1, 1));
    const startUtc = oldestMonth && oldestMonth > startMonth ? oldestMonth : startMonth;

    const points = [];
    let cursor = new Date(Date.UTC(startUtc.getUTCFullYear(), startUtc.getUTCMonth() + 1, 0));
    while (cursor <= today) {
      const dateIso = cursor.toISOString().slice(0, 10);
      const monthIso = cursor.toISOString().slice(0, 7);
      let nw = 0;
      for (const src of sources) nw += Selectors.balanceAtDate(state, src.id, dateIso);
      points.push({ date: dateIso, month: monthIso, balance: round2(nw) });
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 2, 0));
    }
    const total = sources.reduce((s, src) => s + (Number(src.balance) || 0), 0);
    points.push({
      date: todayIso,
      month: today.toISOString().slice(0, 7),
      balance: round2(total),
    });
    return points;
  },

  // ---- Monthly net flow (bars) ----------------------------------
  // For each of the last N months, returns:
  //   { month: 'YYYY-MM', income, expense, net, perSource: { srcId: net } }
  // Income = sum of positive txns; expense = sum of |negative txns|;
  // net = income − expense. Today's month is included even if it's
  // partial, so the user sees their current month's progress.
  /**
   * Income / expense / net per month for the last N months. Current (partial) month included.
   * @param {State} state
   * @param {number} [months=12]
   * @returns {MonthFlow[]}
   */
  monthlyNetFlow(state, months = 12) {
    const sources = Selectors.sourcesInScope(state);
    const srcIds = new Set(sources.map(s => s.id));

    const today = new Date();
    const monthKeys = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
      monthKeys.push(d.toISOString().slice(0, 7));
    }

    const byMonth = new Map();
    for (const k of monthKeys) {
      byMonth.set(k, {
        month: k,
        income: 0,
        expense: 0,
        net: 0,
        perSource: Object.create(null),
      });
    }

    for (const t of (state.transactions || [])) {
      if (!t.date || !srcIds.has(t.sourceId)) continue;
      const m = t.date.slice(0, 7);
      if (!byMonth.has(m)) continue;
      const row = byMonth.get(m);
      const amt = Math.abs(Number(t.amount) || 0);
      // The source of truth for income vs expense is `type`. CSV imports
      // store amounts as positive numbers and rely on `type` to indicate
      // direction; manually-entered transactions may use a negative
      // amount for expenses. We honour `type` first and fall back to
      // sign-of-amount for transactions that don't carry a type.
      let signed;
      if (t.type === 'income')       signed =  amt;
      else if (t.type === 'expense') signed = -amt;
      else                            signed = (Number(t.amount) < 0) ? -amt : amt;
      if (signed >= 0) row.income = round2(row.income + signed);
      else             row.expense = round2(row.expense + Math.abs(signed));
      row.net = round2(row.income - row.expense);
      row.perSource[t.sourceId] = round2((row.perSource[t.sourceId] || 0) + signed);
    }
    return monthKeys.map(k => byMonth.get(k));
  },
};

function round2(n) { return Math.round(n * 100) / 100; }

window.Selectors = Selectors;
window.SelectorScopes = /** @type {Scope[]} */ (VALID_SCOPES);
