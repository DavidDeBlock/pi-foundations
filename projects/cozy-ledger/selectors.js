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
  scope(state) { return readScope(state); },
  currentUserId(state) { return readCurrentUserId(state); },

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

  transactionsInScope(state) {
    const inScopeSourceIds = new Set(Selectors.sourcesInScope(state).map(s => s.id));
    return (state.transactions || []).filter(t => inScopeSourceIds.has(t.sourceId));
  },

  // ---- Source map (handy for O(1) lookups in renderers) ------------
  sourcesById(state) {
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
  balanceSeries(state, sourceId) {
    const source = (state.sources || []).find(s => s.id === sourceId);
    if (!source) return [];
    const txns = (state.transactions || []).filter(t => t.sourceId === sourceId);
    if (!txns.length) return [];
    // Net flow per day, ISO date as the key (lexicographic sort = chronological).
    const flowByDate = new Map();
    for (const t of txns) {
      if (!t.date) continue;
      flowByDate.set(t.date, (flowByDate.get(t.date) || 0) + (Number(t.amount) || 0));
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
};

function round2(n) { return Math.round(n * 100) / 100; }

window.Selectors = Selectors;
window.SelectorScopes = VALID_SCOPES;
