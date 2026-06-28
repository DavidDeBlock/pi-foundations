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

  // ---- Period selectors (ISSUE-013 / PRD-004) ---------------------
  // The dashboard and Trends view share one { preset, from, to } state
  // owned by Router. These helpers turn a preset into a date range and
  // filter transactions to that range. They are pure: no Router /
  // Store / DOM coupling, so they can be exercised directly from the
  // test harness without booting the app.
  //
  // Preset semantics (rolling, not "current month + N previous"):
  //   1m  → [first of this month, today]
  //   3m  → [first of (today - 2 months), today]
  //   6m  → [first of (today - 5 months), today]
  //   1y  → [first of (today - 11 months), today]
  //   2y  → [first of (today - 23 months), today]
  //   all → [earliest in-scope transaction date, today]
  //
  // All `from` values snap to the first of the month to keep the
  // chart x-axis tidy.
  /**
   * ISO range for a preset, rolling from `today`. Returns null for
   * presets that need state ('all'); use `periodRangeForAll` for those.
   * @param {'1m'|'3m'|'6m'|'1y'|'2y'} preset
   * @param {Date} [today=new Date()]
   * @returns {{ from: string, to: string } | null}
   */
  periodRangeForPreset(preset, today = new Date()) {
    /** @type {Record<string, number>} */
    const monthOffsets = { '1m': 0, '3m': 2, '6m': 5, '1y': 11, '2y': 23 };
    const monthsBack = monthOffsets[preset];
    if (monthsBack === undefined) return null; // 'all', 'custom', or unknown
    const firstOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const from = new Date(firstOfThisMonth.getFullYear(), firstOfThisMonth.getMonth() - monthsBack, 1);
    const to = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    };
  },

  /**
   * ISO range for the 'all' preset: earliest in-scope transaction
   * date (snapped to first-of-month) through today. Returns today as
   * `from` if the scope is empty.
   * @param {State} state
   * @param {Date} [today=new Date()]
   * @returns {{ from: string, to: string }}
   */
  periodRangeForAll(state, today = new Date()) {
    const inScope = Selectors.transactionsInScope(state);
    let oldestIso = null;
    for (const t of inScope) {
      if (!t.date) continue;
      if (!oldestIso || t.date < oldestIso) oldestIso = t.date;
    }
    const toIso = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString().slice(0, 10);
    if (!oldestIso) {
      return { from: toIso, to: toIso };
    }
    // Snap to first-of-month.
    const od = new Date(oldestIso + 'T00:00:00');
    const from = new Date(od.getFullYear(), od.getMonth(), 1);
    return { from: from.toISOString().slice(0, 10), to: toIso };
  },

  /**
   * In-scope transactions whose `date` falls in [from, to] inclusive.
   * Lexicographic comparison on ISO dates = chronological comparison.
   * @param {State} state
   * @param {{ from: string, to: string }} range
   * @returns {Transaction[]}
   */
  txnsInPeriod(state, range) {
    const inScope = Selectors.transactionsInScope(state);
    if (!range || !range.from || !range.to) return [];
    const { from, to } = range;
    return inScope.filter(t => t && t.date && t.date >= from && t.date <= to);
  },

  /**
   * Ordered list of `YYYY-MM` strings covering [from, to] inclusive.
   * Capped at 240 months (20 years) so chart builders can't blow up.
   * Returns [] when from > to.
   * @param {{ from: string, to: string }} range
   * @returns {string[]}
   */
  monthsInPeriod(range) {
    if (!range || !range.from || !range.to) return [];
    const { from, to } = range;
    if (from > to) return [];
    const [fy, fm] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    if (!fy || !fm || !ty || !tm) return [];
    const startYearMonth = fy * 12 + (fm - 1);
    const endYearMonth = ty * 12 + (tm - 1);
    const total = endYearMonth - startYearMonth + 1;
    if (total <= 0) return [];
    const cap = Math.min(total, 240);
    const out = [];
    for (let i = 0; i < cap; i++) {
      const ym = startYearMonth + i;
      const y = Math.floor(ym / 12);
      const m = (ym % 12) + 1;
      out.push(`${y}-${String(m).padStart(2, '0')}`);
    }
    return out;
  },

  // ---- Goals (ISSUE-017) -----------------------------------------
  // Compute progress for a single goal. Pure function: caller passes
  // the goal object directly so this works for both in-memory state
  // and exported backups. `percent` can exceed 100 when funded > target;
  // renderers use `>= 100` / `> 100` to pick bar colour. `remaining` is
  // clamped to 0 so a funded goal reads "Nog €0 te gaan".
  /**
   * Progress summary for a goal. `percent` may exceed 100; `remaining` is clamped to 0.
   * @param {Partial<Goal> | null | undefined} goal
   * @returns {{ funded: number, target: number, percent: number, remaining: number }}
   */
  goalProgress(goal) {
    const funded = Math.max(0, Number(goal && goal.funded) || 0);
    const target = Math.max(0, Number(goal && goal.target) || 0);
    const percent = target > 0 ? round2((funded / target) * 100) : 0;
    const remaining = target > funded ? round2(target - funded) : 0;
    return { funded, target, percent, remaining };
  },

  // ---- Envelopes (ISSUE-018) ------------------------------------
  // Spend-cap evaluation. Pure: callers pass the envelope directly
  // so the helpers work for both in-memory state and exported backups.
  //
  // `currentPeriodFor` rolls forward each call — the current month for
  // monthly envelopes, the current calendar year for yearly. The
  // window's `to` is today, so partial periods are reflected in the
  // spend number (a monthly envelope on the 5th shows 5 days of spend).
  //
  // `envelopeSpend` sums in-scope expense txns whose category OR
  // payee matches the envelope, dated in [from, to]. A txn matching
  // both criteria is counted once (Set dedup).
  //
  // `envelopeProgress` packages spent/cap/percent/remaining/overspent
  // for the view. Both `remaining` and `overspent` are clamped to 0 so
  // a UI can always show one of: "Nog €X over" / "Doel bereikt" /
  // "€X over limiet".

  /**
   * Current window for an envelope. `monthly` = first of this month
   * through today; `yearly` = Jan 1 of this year through today.
   * Unknown periods fall back to monthly.
   * @param {Partial<Envelope> | null | undefined} envelope
   * @param {Date} [today=new Date()]
   * @returns {{ from: string, to: string }}
   */
  currentPeriodFor(envelope, today = new Date()) {
    const period = envelope && envelope.period;
    const toIso = new Date(today.getFullYear(), today.getMonth(), today.getDate())
      .toISOString().slice(0, 10);
    if (period === 'yearly') {
      return { from: `${today.getFullYear()}-01-01`, to: toIso };
    }
    // 'monthly' or unknown — default to monthly.
    const fromIso = new Date(today.getFullYear(), today.getMonth(), 1)
      .toISOString().slice(0, 10);
    return { from: fromIso, to: toIso };
  },

  /**
   * Sum of expense-txns in [from, to] whose categoryId ∈
   * `envelope.categoryIds` OR whose extracted payee ∈
   * `envelope.payeeIds`. A txn matching both is counted once.
   * Returns 0 when the envelope has no links or no matches.
   * @param {Partial<Envelope> | null | undefined} envelope
   * @param {State} state
   * @param {Date} [today=new Date()]
   * @returns {number}
   */
  envelopeSpend(envelope, state, today = new Date()) {
    if (!envelope) return 0;
    const catIds = Array.isArray(envelope.categoryIds) ? envelope.categoryIds : [];
    const payeeIds = Array.isArray(envelope.payeeIds) ? envelope.payeeIds : [];
    // Short-circuit when no links at all — nothing can match.
    if (catIds.length === 0 && payeeIds.length === 0) return 0;
    const range = Selectors.currentPeriodFor(envelope, today);
    if (!range.from || !range.to) return 0;

    // Use the extractPayee helper so envelope payee matching agrees
    // with how the rest of the app identifies a payee (stripped of the
    // ING-specific boilerplate). It lives on CSVImport / ViewHelpers.
    const extractPayee = (typeof CSVImport !== 'undefined' && CSVImport.extractPayee)
      || (typeof window !== 'undefined' && window.CSVImport && window.CSVImport.extractPayee)
      || (d => String(d || ''));
    const payeeSet = new Set(payeeIds);
    const catSet = new Set(catIds);

    // Dedup by txn id (a row that matches both criteria is counted once).
    let spent = 0;
    const seen = new Set();
    const txns = Array.isArray(state && state.transactions) ? state.transactions : [];
    for (const t of txns) {
      if (!t || !t.date) continue;
      if (t.date < range.from || t.date > range.to) continue;
      // Income counts as negative spend (refund / inflow) within the
      // cap. We only subtract for `type === 'income'` rows that still
      // match the envelope's links; out-of-scope inflows are ignored.
      const catMatch = t.categoryId && catSet.has(t.categoryId);
      const payeeMatch = (() => {
        if (payeeSet.size === 0) return false;
        const p = extractPayee(t.description);
        return p != null && payeeSet.has(p);
      })();
      if (!catMatch && !payeeMatch) continue;
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const amt = Math.abs(Number(t.amount) || 0);
      if (t.type === 'income') spent -= amt;
      else                     spent += amt;
    }
    return round2(spent);
  },

  /**
   * Progress summary for an envelope. `percent` may exceed 100;
   * `remaining` and `overspent` are clamped to 0 so exactly one of
   * them is non-zero (both can't be positive).
   * @param {Partial<Envelope> | null | undefined} envelope
   * @param {State} state
   * @param {Date} [today=new Date()]
   * @returns {{ spent: number, cap: number, percent: number, remaining: number, overspent: number }}
   */
  envelopeProgress(envelope, state, today = new Date()) {
    const cap = Math.max(0, Number(envelope && envelope.cap) || 0);
    const spent = Selectors.envelopeSpend(envelope, state, today);
    const percent = cap > 0 ? round2((spent / cap) * 100) : 0;
    const remaining = spent < cap ? round2(cap - spent) : 0;
    const overspent = spent > cap ? round2(spent - cap) : 0;
    return { spent, cap, percent, remaining, overspent };
  },

  // ---- Envelope comparison (ISSUE-020) ------------------------------
  // Multi-period history for an envelope. The current period is
  // `Selectors.currentPeriodFor(envelope, today)`; previous periods
  // are computed by walking back the same shape (full months for
  // monthly, full calendar years for yearly). The selector deliberately
  // uses `Selectors.transactionsInScope(state)` (per the spec) so the
  // current period matches what the dashboard summary cards show
  // under the active scope — NOT necessarily `Selectors.envelopeSpend`,
  // which predates this selector and is used by `envelopeProgress` on
  // the envelopes page (where scope is global).
  //
  // Result shape:
  //   { current: { periodLabel, from, to, spent },
  //     history: [ { periodLabel, from, to, spent,
  //                  delta, deltaPct, direction,
  //                  notYetExisted }, ... ] }
  //
  // `spent` is always a number. For past periods before `createdAt`
  // we still compute the spend (the envelope's links define a bucket
  // that already had spending history) and tag the row with
  // `notYetExisted: true` so the view can append a small "schatting"
  // badge. This way new users see real-looking numbers from the
  // start; mature users only see the badge on the oldest periods.
  //
  // Monthly envelopes return 7 entries (current + 6 previous);
  // yearly envelopes return 4 (current + 3 previous).

  /**
   * Dutch month-name lookup, defaulting to a hard-coded list so the
   * selector is testable in isolation (i18n.js may not be loaded by
   * the pure-function test harness).
   * @returns {string[]}
   */
  _monthNames() {
    if (typeof window !== 'undefined' && window.i18n && Array.isArray(window.i18n.monthNames)) {
      return window.i18n.monthNames;
    }
    return ['januari', 'februari', 'maart', 'april', 'mei', 'juni',
            'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
  },
  /** @returns {string[]} */
  _monthShortNames() {
    if (typeof window !== 'undefined' && window.i18n && Array.isArray(window.i18n.monthShortNames)) {
      return window.i18n.monthShortNames;
    }
    return ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun',
            'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  },

  /**
   * Spend for an envelope across an arbitrary date range. Mirrors
   * `envelopeSpend`'s matching (category OR payee) but doesn't depend
   * on `Selectors.currentPeriodFor` and scopes its transaction input
   * to `Selectors.transactionsInScope(state)` per the ISSUE-020 spec.
   * Returns 0 when the envelope has no links, the range is invalid,
   * or no transactions match.
   * @param {Partial<Envelope> | null | undefined} envelope
   * @param {State} state
   * @param {{ from: string, to: string }} range
   * @returns {number}
   */
  envelopeSpendInRange(envelope, state, range) {
    if (!envelope || !range || !range.from || !range.to) return 0;
    const catIds = Array.isArray(envelope.categoryIds) ? envelope.categoryIds : [];
    const payeeIds = Array.isArray(envelope.payeeIds) ? envelope.payeeIds : [];
    if (catIds.length === 0 && payeeIds.length === 0) return 0;

    const extractPayee = (typeof CSVImport !== 'undefined' && CSVImport.extractPayee)
      || (typeof window !== 'undefined' && window.CSVImport && window.CSVImport.extractPayee)
      || (d => String(d || ''));
    const payeeSet = new Set(payeeIds);
    const catSet = new Set(catIds);

    const txns = Selectors.transactionsInScope(state || {});
    let spent = 0;
    const seen = new Set();
    for (const t of txns) {
      if (!t || !t.date) continue;
      if (t.date < range.from || t.date > range.to) continue;
      const catMatch = t.categoryId && catSet.has(t.categoryId);
      const payeeMatch = (() => {
        if (payeeSet.size === 0) return false;
        const p = extractPayee(t.description);
        return p != null && payeeSet.has(p);
      })();
      if (!catMatch && !payeeMatch) continue;
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const amt = Math.abs(Number(t.amount) || 0);
      if (t.type === 'income') spent -= amt;
      else                     spent += amt;
    }
    return round2(spent);
  },

  /**
   * Date range for the period `offset` steps before today, using the
   * same shape as `currentPeriodFor` (full month / full year for
   * `offset >= 1`, partial for `offset === 0`). Internal helper.
   * @param {'monthly'|'yearly'} periodType
   * @param {Date} today
   * @param {number} offset  0 = current, 1 = previous, ...
   * @returns {{ from: string, to: string }}
   */
  _comparisonOffsetRange(periodType, today, offset) {
    if (offset <= 0) {
      // The "current" range is the canonical one — caller can also
      // just call currentPeriodFor. Kept here for symmetry.
      return Selectors.currentPeriodFor({ period: periodType }, today);
    }
    if (periodType === 'yearly') {
      const year = today.getFullYear() - offset;
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    }
    // monthly: full calendar month `offset` months before today.
    const startOfMonth = new Date(today.getFullYear(), today.getMonth() - offset, 1);
    const endOfMonth = new Date(today.getFullYear(), today.getMonth() - offset + 1, 0);
    return {
      from: startOfMonth.toISOString().slice(0, 10),
      to: endOfMonth.toISOString().slice(0, 10),
    };
  },

  /**
   * Dutch period label for a comparison row. Monthly uses
   * `<full month> <year>` for current/previous and `<short month> <year>`
   * for the older "N maanden geleden" entries; yearly always uses
   * `<year>`.
   * @param {'monthly'|'yearly'} periodType
   * @param {number} offset  0 = current, 1 = previous, 2+ = N ago
   * @param {{ from: string, to: string }} range
   * @returns {string}
   */
  _comparisonPeriodLabel(periodType, offset, range) {
    const monthNames = Selectors._monthNames();
    const monthShort = Selectors._monthShortNames();
    const [, mStr, ] = range.from.split('-');
    const year = Number(range.from.split('-')[0]);
    const monthIdx = Math.max(0, Math.min(11, Number(mStr) - 1));
    const fullName = monthNames[monthIdx] || '';
    const shortName = monthShort[monthIdx] || '';
    const monthYearFull = `${fullName} ${year}`;
    const monthYearShort = `${shortName} ${year}`;

    // Period unit word ("maand" / "jaar") for the Deze/Vorige templates.
    const unitWordKey = periodType === 'yearly' ? 'envelopes.compare.year' : 'envelopes.compare.month';

    if (periodType === 'yearly') {
      if (offset === 0) return t('envelopes.compare.current.yearly', { year });
      if (offset === 1) return t('envelopes.compare.previous.yearly', { year });
      return t('envelopes.compare.nYearsAgo.yearly', { n: offset, year });
    }
    // monthly
    if (offset === 0) {
      return t('envelopes.compare.current', {
        period: t(unitWordKey),
        monthYear: monthYearFull,
      });
    }
    if (offset === 1) {
      return t('envelopes.compare.previous', {
        period: t(unitWordKey),
        monthYear: monthYearFull,
      });
    }
    return t('envelopes.compare.nMonthsAgo', { n: offset, monthYear: monthYearShort });
  },

  /**
   * Multi-period comparison for an envelope. See module comment above
   * for the result shape and the period-count policy.
   * @param {Partial<Envelope> | null | undefined} envelope
   * @param {State} state
   * @param {Date} [today=new Date()]
   * @returns {null | {
   *   current: { periodLabel: string, from: string, to: string, spent: number },
   *   history: Array<{
   *     periodLabel: string, from: string, to: string,
   *     spent: number | null,
   *     delta?: number, deltaPct?: number, direction?: 'up'|'down'|'same',
   *     notYetExisted?: boolean
   *   }>
   * }}
   */
  envelopeComparison(envelope, state, today = new Date()) {
    if (!envelope) return null;
    const periodType = envelope.period === 'yearly' ? 'yearly' : 'monthly';
    const historyCount = periodType === 'yearly' ? 3 : 6;

    const currentRange = Selectors.currentPeriodFor(envelope, today);
    const currentSpent = Selectors.envelopeSpendInRange(envelope, state, currentRange);
    const current = {
      periodLabel: Selectors._comparisonPeriodLabel(periodType, 0, currentRange),
      from: currentRange.from,
      to: currentRange.to,
      spent: currentSpent,
    };

    // Empty envelope (no categoryIds, no payeeIds) — still return the
    // current row, but every history entry is spent=0 so the panel is
    // informative (shows the user that nothing was tracked historically).
    const history = [];
    for (let i = 1; i <= historyCount; i++) {
      const pastRange = Selectors._comparisonOffsetRange(periodType, today, i);
      const label = Selectors._comparisonPeriodLabel(periodType, i, pastRange);

      const pastSpent = Selectors.envelopeSpendInRange(envelope, state, pastRange);
      const delta = round2(currentSpent - pastSpent);
      // `deltaPct` is undefined when pastSpent === 0 and currentSpent === 0
      // (the "100%" convention only fires when current is non-zero).
      let deltaPct;
      if (pastSpent > 0) deltaPct = round2((delta / pastSpent) * 100);
      else if (currentSpent > 0) deltaPct = 100;
      else deltaPct = 0;
      let direction;
      if (delta > 0.005) direction = 'up';
      else if (delta < -0.005) direction = 'down';
      else direction = 'same';

      // Envelope didn't exist yet for this past period. We still
      // compute the spend (the envelope's links define a bucket that
      // already had spending history before the user named it) and
      // include delta/deltaPct/direction so the row is comparable. The
      // `notYetExisted` flag tells the view to append a small
      // "schatting" badge so the user knows the value is retroactive.
      // createdAt is an ISO timestamp; pastRange.to is an ISO date.
      // Lexicographic order on the prefix matches chronological order.
      const notYetExisted = !!(envelope.createdAt && envelope.createdAt > pastRange.to);
      history.push({
        periodLabel: label,
        from: pastRange.from,
        to: pastRange.to,
        spent: pastSpent,
        delta,
        deltaPct,
        direction,
        notYetExisted,
      });
    }

    return { current, history };
  },

  // ---- Category / Payee deep-dives (ISSUE-021) -------------------
  // The category and payee detail views share the same shape: totals
  // (this month / this year / count / % of expenses), a 12-month
  // trend, top related entities, and the recent in-scope transactions
  // for that entity. All helpers below operate in-scope via
  // `transactionsInScope(state)` so the detail page matches the rest
  // of the dashboard.
  //
  // For payee-scoped variants the helper takes the raw payee name
  // (the value `CSVImport.extractPayee` returns) and matches against
  // `txn.description` through the same extractor.

  /**
   * Current month range as ISO {from, to}, matching the dashboard's
   * 'this month' window. Exposed so category/payee selectors don't
   * each duplicate the first-of-month arithmetic.
   * @param {Date} [today=new Date()]
   * @returns {{ from: string, to: string }}
   */
  _currentMonthRange(today = new Date()) {
    return {
      from: new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10),
      to: new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString().slice(0, 10),
    };
  },

  /**
   * Current year range as ISO {from, to}, Jan 1 through today.
   * @param {Date} [today=new Date()]
   * @returns {{ from: string, to: string }}
   */
  _currentYearRange(today = new Date()) {
    return {
      from: `${today.getFullYear()}-01-01`,
      to: new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString().slice(0, 10),
    };
  },

  /**
   * Filter a list of transactions to those matching `categoryId`.
   * Defensive: missing `txn.categoryId` never matches.
   * @param {Transaction[]} txns
   * @param {string} categoryId
   * @returns {Transaction[]}
   */
  _txnsByCategory(txns, categoryId) {
    if (!categoryId) return [];
    return txns.filter(t => t && t.categoryId === categoryId);
  },

  /**
   * Filter a list of transactions to those whose extracted payee
   * equals `payeeName`. Empty/missing payee matches nothing.
   * @param {Transaction[]} txns
   * @param {string} payeeName
   * @returns {Transaction[]}
   */
  _txnsByPayee(txns, payeeName) {
    if (!payeeName) return [];
    const ext = (typeof CSVImport !== 'undefined' && CSVImport.extractPayee)
      || (typeof window !== 'undefined' && window.CSVImport && window.CSVImport.extractPayee)
      || (d => String(d || ''));
    return txns.filter(t => t && ext(t.description) === payeeName);
  },

  /**
   * Absolute expense total for a transaction set (income rows add
   * nothing). `sign` is 1 for expenses, -1 for income-only totals.
   * @param {Transaction[]} txns
   * @param {{ type?: 'expense'|'income'|'all', sign?: 1|-1 }} [opts]
   * @returns {number}
   */
  _absTotal(txns, opts) {
    const o = opts || {};
    const sign = o.sign || 1;
    let total = 0;
    for (const t of txns) {
      if (!t) continue;
      if (o.type === 'expense' && t.type !== 'expense') continue;
      if (o.type === 'income'  && t.type !== 'income')  continue;
      total += sign * Math.abs(Number(t.amount) || 0);
    }
    return round2(total);
  },

  /**
   * Totals for one expense category: this-month, this-year, count,
   * and the share of this-month's total expense (0..100). All
   * in-scope; income rows in the same category are excluded.
   * Returns zeros for an unknown / empty category.
   * @param {State} state
   * @param {string} categoryId
   * @param {Date} [today=new Date()]
   * @returns {{ thisMonth: number, thisYear: number, count: number, percentOfExpenses: number }}
   */
  categoryTotals(state, categoryId, today = new Date()) {
    const inScope = Selectors.transactionsInScope(state || {});
    const matching = Selectors._txnsByCategory(inScope, categoryId);
    const month = Selectors._currentMonthRange(today);
    const year  = Selectors._currentYearRange(today);
    const inMonth = matching.filter(t => t.date >= month.from && t.date <= month.to);
    const inYear  = matching.filter(t => t.date >= year.from  && t.date <= year.to);
    const thisMonth = Selectors._absTotal(inMonth, { type: 'expense' });
    const thisYear  = Selectors._absTotal(inYear,  { type: 'expense' });
    const count = inYear.length;
    // Denominator: total in-scope expense in this month, across every
    // category. Computed from the same month filter so the percentage
    // stays consistent with the dashboard's expense card.
    const totalMonthExpense = Selectors._absTotal(
      inScope.filter(t => t.date >= month.from && t.date <= month.to && t.type === 'expense'),
      { type: 'expense' }
    );
    const percentOfExpenses = totalMonthExpense > 0
      ? round2((thisMonth / totalMonthExpense) * 100)
      : 0;
    return { thisMonth, thisYear, count, percentOfExpenses };
  },

  /**
   * 12 (or N) month buckets for a category, oldest first. Months with
   * no matching in-scope transactions render with `amount = 0`. The
   * returned `month` keys are `YYYY-MM` and are stable so the chart
   * renderer can label each bar.
   * @param {State} state
   * @param {string} categoryId
   * @param {number} [months=12]
   * @param {Date} [today=new Date()]
   * @returns {{ month: string, amount: number }[]}
   */
  categoryMonthlyTrend(state, categoryId, months = 12, today = new Date()) {
    const inScope = Selectors.transactionsInScope(state || {});
    const matching = Selectors._txnsByCategory(inScope, categoryId);
    const keys = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      keys.push(d.toISOString().slice(0, 7));
    }
    const buckets = Object.create(null);
    for (const k of keys) buckets[k] = 0;
    for (const t of matching) {
      if (!t || !t.date || t.type !== 'expense') continue;
      const k = t.date.slice(0, 7);
      if (!(k in buckets)) continue;
      buckets[k] = round2(buckets[k] + Math.abs(Number(t.amount) || 0));
    }
    return keys.map(k => ({ month: k, amount: buckets[k] }));
  },

  /**
   * Top payees driving spend in a category, by total expense desc.
   * Each row: `{ payeeName, total, count }`. In-scope; cap at
   * `limit` (default 5). Payees whose extractor returns null/empty
   * collapse into a single '—' bucket so uncategorised rows still
   * contribute to the ranking.
   *
   * NOTE: The spec signature is `topPayeesInCategory(state, categoryId,
   * today, limit)` for symmetry with `categoryTotals`. We currently
   * compute all-time totals — `today` is accepted but unused so the
   * public API matches the spec without lint warnings. Wiring a
   * year/month filter here would be a behaviour change for the
   * dashboard; keep that as a deliberate follow-up if the user asks
   * for it.
   * @param {State} state
   * @param {string} categoryId
   * @param {Date} [_today=new Date()]  Unused; kept for spec symmetry.
   * @param {number} [limit=5]
   * @returns {{ payeeName: string, total: number, count: number }[]}
   */
  topPayeesInCategory(state, categoryId, _today = new Date(), limit = 5) {
    const inScope = Selectors.transactionsInScope(state || {});
    const matching = Selectors._txnsByCategory(inScope, categoryId)
      .filter(t => t.type === 'expense');
    const ext = (typeof CSVImport !== 'undefined' && CSVImport.extractPayee)
      || (typeof window !== 'undefined' && window.CSVImport && window.CSVImport.extractPayee)
      || (d => String(d || ''));
    const map = new Map();
    for (const t of matching) {
      const name = ext(t.description) || '—';
      if (!map.has(name)) map.set(name, { payeeName: name, total: 0, count: 0 });
      const row = map.get(name);
      row.total = round2(row.total + Math.abs(Number(t.amount) || 0));
      row.count++;
    }
    return [...map.values()]
      .sort((a, b) => (b.total - a.total) || (b.count - a.count))
      .slice(0, limit);
  },

  /**
   * Recent in-scope transactions for a category, sorted date desc
   * with `createdAt` as tie-breaker. Cap at `limit` (default 25).
   * @param {State} state
   * @param {string} categoryId
   * @param {number} [limit=25]
   * @returns {Transaction[]}
   */
  recentTransactionsForCategory(state, categoryId, limit = 25) {
    const inScope = Selectors.transactionsInScope(state || {});
    return Selectors._txnsByCategory(inScope, categoryId)
      .slice()
      .sort((a, b) =>
        (b.date || '').localeCompare(a.date || '') ||
        (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, limit);
  },

  /**
   * All-category totals for the categories list page (ISSUE-023).
   *
   * Returns one row per category in `state.categories`, regardless of
   * whether the category has any in-scope transactions — a category
   * with no spend still shows up (with zeros) because it's a real
   * category the user can drill into. Rows are sorted by this-month
   * expense total desc, with ties broken by this-year total desc, so
   * the most recently-active categories bubble to the top.
   *
   * `percentOfExpenses` is computed against the sum of this-month
   * expenses across all in-scope expense categories — categories
   * that are `type: 'income'` get 0% by design (the user is asking
   * "where did my money go?", income is the answer, not the bucket).
   *
   * @param {State} state
   * @param {Date} [_today=new Date()]  Reserved for symmetry; not used
   *   yet — the selector always evaluates "this month" relative to
   *   the device clock. Adding a custom-month filter is a deliberate
   *   follow-up if the page ever needs historical scrubbing.
   * @returns {{ category: Category, thisMonth: number, thisYear: number, count: number, percentOfExpenses: number }[]}
   */
  allCategoryTotals(state, _today = new Date()) {
    const cats = (state && state.categories) || [];
    const monthRange = Selectors._currentMonthRange(new Date());
    const yearRange = Selectors._currentYearRange(new Date());
    const inScope = Selectors.transactionsInScope(state || {});

    // Pre-aggregate expense totals per category so we only walk the
    // txns once and so the percent denominator is consistent across
    // every row.
    const monthByCat = Object.create(null);
    const yearByCat = Object.create(null);
    const countByCat = Object.create(null);
    let totalMonthExpense = 0;
    for (const t of inScope) {
      if (t.type !== 'expense') continue;
      const cid = t.categoryId;
      if (!cid) continue;
      const isMonth = t.date >= monthRange.from && t.date <= monthRange.to;
      const isYear = t.date >= yearRange.from && t.date <= yearRange.to;
      if (isMonth) {
        monthByCat[cid] = (monthByCat[cid] || 0) + Math.abs(t.amount);
        totalMonthExpense += Math.abs(t.amount);
      }
      if (isYear) yearByCat[cid] = (yearByCat[cid] || 0) + Math.abs(t.amount);
      countByCat[cid] = (countByCat[cid] || 0) + 1;
    }

    const rows = cats.map(cat => {
      const thisMonth = round2(monthByCat[cat.id] || 0);
      const thisYear = round2(yearByCat[cat.id] || 0);
      const count = countByCat[cat.id] || 0;
      const percentOfExpenses = totalMonthExpense > 0
        ? round2((thisMonth / totalMonthExpense) * 100)
        : 0;
      return { category: cat, thisMonth, thisYear, count, percentOfExpenses };
    });

    rows.sort((a, b) =>
      (b.thisMonth - a.thisMonth) ||
      (b.thisYear - a.thisYear) ||
      // Deterministic fallback for full ties (no spend, no count) so
      // tests can assert exact order.
      a.category.id.localeCompare(b.category.id));
    return rows;
  },

  /**
   * Totals for one payee (ISSUE-024). Same shape as `categoryTotals`
   * so the shared EntityDetail renderer can reuse the header card
   * without branching on kind.
   *
   * `payeeName` is matched against `extractPayee(txn.description)`,
   * the same extractor the rest of the app uses. In-scope only.
   *
   * `percentOfExpenses` is the payee's share of this-month's total
   * expense across every category. A payee that appears only in
   * income transactions returns all-zeros (income is the answer,
   * not the bucket).
   *
   * @param {State} state
   * @param {string} payeeName
   * @param {Date} [today=new Date()]
   * @returns {{ thisMonth: number, thisYear: number, count: number, percentOfExpenses: number }}
   */
  payeeTotals(state, payeeName, today = new Date()) {
    const month = Selectors._currentMonthRange(today);
    const year = Selectors._currentYearRange(today);
    const inScope = Selectors.transactionsInScope(state || {});
    const matching = Selectors._txnsByPayee(inScope, payeeName);

    const inMonth = matching.filter(t => t.date >= month.from && t.date <= month.to);
    const inYear = matching.filter(t => t.date >= year.from && t.date <= year.to);
    const thisMonth = Selectors._absTotal(inMonth, { type: 'expense' });
    const thisYear = Selectors._absTotal(inYear, { type: 'expense' });
    const count = inYear.length;

    const totalMonthExpense = Selectors._absTotal(
      inScope.filter(t => t.date >= month.from && t.date <= month.to && t.type === 'expense'),
      { type: 'expense' });
    const percentOfExpenses = totalMonthExpense > 0
      ? round2((thisMonth / totalMonthExpense) * 100)
      : 0;
    return { thisMonth, thisYear, count, percentOfExpenses };
  },

  /**
   * 12 (or N) monthly buckets for one payee, oldest first. Mirrors
   * `categoryMonthlyTrend` exactly — empty months fill with 0 so the
   * chart always renders 12 bars. The series is expense-only; income
   * rows don't drive the "where does the money go" question.
   *
   * @param {State} state
   * @param {string} payeeName
   * @param {number} [months=12]
   * @param {Date} [today=new Date()]
   * @returns {{ month: string, amount: number }[]}
   */
  payeeMonthlyTrend(state, payeeName, months = 12, today = new Date()) {
    const inScope = Selectors.transactionsInScope(state || {});
    const matching = Selectors._txnsByPayee(inScope, payeeName);
    const keys = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      keys.push(d.toISOString().slice(0, 7));
    }
    const buckets = Object.create(null);
    for (const k of keys) buckets[k] = 0;
    for (const t of matching) {
      if (!t || !t.date || t.type !== 'expense') continue;
      const k = t.date.slice(0, 7);
      if (!(k in buckets)) continue;
      buckets[k] = round2(buckets[k] + Math.abs(Number(t.amount) || 0));
    }
    return keys.map(k => ({ month: k, amount: buckets[k] }));
  },

  /**
   * Top categories for one payee, by total expense desc (ISSUE-024).
   * Symmetric with `topPayeesInCategory`: same shape (just `category`
   * in place of `payeeName`), same tie-break (count desc), same
   * spec-driven `_today` parameter for symmetry.
   *
   * Rows include the live `category` object so the top-list renderer
   * can build a click target to `category-{category.id}` without a
   * second lookup. Categories with no spend still appear when the
   * payee has any other expense — actually no: a category only
   * appears if the payee has spent against it, by construction.
   *
   * @param {State} state
   * @param {string} payeeName
   * @param {Date} [_today=new Date()]  Unused; kept for spec symmetry.
   * @param {number} [limit=5]
   * @returns {{ category: Category, total: number, count: number }[]}
   */
  topCategoriesForPayee(state, payeeName, _today = new Date(), limit = 5) {
    const inScope = Selectors.transactionsInScope(state || {});
    const matching = Selectors._txnsByPayee(inScope, payeeName)
      .filter(t => t.type === 'expense');
    const map = new Map();
    for (const t of matching) {
      const cid = t.categoryId;
      if (!cid) continue;
      if (!map.has(cid)) {
        const cat = (state.categories || []).find(c => c.id === cid);
        // Skip rows whose category was deleted from state — the
        // expense still counted toward the payee total, but we
        // can't show "deleted category" in the top list.
        if (!cat) continue;
        map.set(cid, { category: cat, total: 0, count: 0 });
      }
      const row = map.get(cid);
      row.total = round2(row.total + Math.abs(Number(t.amount) || 0));
      row.count++;
    }
    return [...map.values()]
      .sort((a, b) => (b.total - a.total) || (b.count - a.count))
      .slice(0, limit);
  },

  /**
   * Recent in-scope transactions for one payee, sorted date desc
   * with `createdAt` as tie-breaker. Cap at `limit` (default 25).
   * Symmetric with `recentTransactionsForCategory` so the shared
   * EntityDetail renderer can render either kind's recent card.
   *
   * @param {State} state
   * @param {string} payeeName
   * @param {number} [limit=25]
   * @returns {Transaction[]}
   */
  recentTransactionsForPayee(state, payeeName, limit = 25) {
    const inScope = Selectors.transactionsInScope(state || {});
    return Selectors._txnsByPayee(inScope, payeeName)
      .slice()
      .sort((a, b) =>
        (b.date || '').localeCompare(a.date || '') ||
        (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, limit);
  },

  /**
   * Every distinct payee with a positive this-month total (ISSUE-024,
   * optional browse-list support). The result is sorted by thisMonth
   * desc so the natural display order is "biggest first". Payees
   * with zero spend this month are excluded — the page is about
   * "who's getting our money right now", which excludes dormant
   * names.
   *
   * Documented as a deliberate follow-up if a payee list page ever
   * ships; the selector is here so callers can experiment without
   * re-implementing the aggregation.
   *
   * @param {State} state
   * @param {Date} [_today=new Date()]  Unused; for API symmetry.
   * @returns {{ name: string, thisMonth: number }[]}
   */
  payeeList(state, _today = new Date()) {
    const month = Selectors._currentMonthRange(new Date());
    const inScope = Selectors.transactionsInScope(state || {});
    const map = new Map();
    for (const t of inScope) {
      if (t.type !== 'expense') continue;
      if (t.date < month.from || t.date > month.to) continue;
      const name = (typeof CSVImport !== 'undefined' && CSVImport.extractPayee)
        ? CSVImport.extractPayee(t.description)
        : String(t.description || '');
      if (!name) continue;
      if (!map.has(name)) map.set(name, { name, thisMonth: 0 });
      map.get(name).thisMonth = round2(
        map.get(name).thisMonth + Math.abs(Number(t.amount) || 0));
    }
    return [...map.values()]
      .filter(p => p.thisMonth > 0)
      .sort((a, b) => b.thisMonth - a.thisMonth);
  },

  /**
   * Aggregate stats over a (already-filtered) list of transactions
   * (ISSUE-025). Used by the Transactions view to power the "exactly
   * one entity filter is set" stats strip above the table.
   *
   * The selector is deliberately pure and doesn't read state or
   * know about filters — the view already ran `transactionsInScope`
   * and applied the active filter pipeline before calling this, so
   * "in-scope only" is the caller's responsibility, not ours. This
   * keeps the selector testable in isolation and reusable for any
   * future filtered-list view that wants a "totals" header.
   *
   * `minDate` / `maxDate` are ISO strings (`'YYYY-MM-DD'`) so the
   * view can format them with whatever locale it likes; we don't
   * pre-format here because we want to keep the selector
   * presentation-agnostic.
   *
   * `avg` is the simple mean of `txn.amount` over the set — it's
   * the same number you'd get by dividing `total / count`, but
   * computed as a single pass so callers can rely on it being
   * `0` (not `NaN`) when count is 0.
   *
   * @param {Transaction[]} txns  Already-filtered (incl. in-scope) txns.
   * @returns {{ total: number, count: number, avg: number, minDate: string|null, maxDate: string|null }}
   */
  entityTransactionStats(txns) {
    if (!txns || txns.length === 0) {
      return { total: 0, count: 0, avg: 0, minDate: null, maxDate: null };
    }
    let total = 0;
    let minDate = null;
    let maxDate = null;
    for (const t of txns) {
      if (!t) continue;
      total += Number(t.amount) || 0;
      if (t.date) {
        if (minDate === null || t.date < minDate) minDate = t.date;
        if (maxDate === null || t.date > maxDate) maxDate = t.date;
      }
    }
    return {
      total: round2(total),
      count: txns.length,
      avg: round2(total / txns.length),
      minDate,
      maxDate,
    };
  },
};

function round2(n) { return Math.round(n * 100) / 100; }

window.Selectors = Selectors;
window.SelectorScopes = /** @type {Scope[]} */ (VALID_SCOPES);
