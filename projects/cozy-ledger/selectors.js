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
};

function round2(n) { return Math.round(n * 100) / 100; }

window.Selectors = Selectors;
window.SelectorScopes = /** @type {Scope[]} */ (VALID_SCOPES);
