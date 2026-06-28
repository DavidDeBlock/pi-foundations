// =====================================================================
// views/_entity-detail.js — Shared chrome for category and payee detail
// pages (ISSUE-021).
//
// The category and payee detail views share most of their structure:
// header (name + swatch + totals + this-month bar), monthly trend
// chart (12 monthly bars), top related entities (top payees for a
// category, top categories for a payee), recent transactions, a
// "view all transactions" link, and a back button. This module owns
// the shared chrome so the category and payee wrappers can stay
// tiny — they parse their `:id`, fetch the entity from state, run
// the right selectors, and hand the pre-computed pieces to
// `EntityDetail.render`.
//
// The 12-month trend chart is a small inline SVG (no library, no
// reuse from charts/monthly-flow.js — that one is a heartbeat
// (income vs expense) bar shape, not a single-series bar). Aim is
// 60-ish lines of SVG markup; keep it readable.
// =====================================================================

const EntityDetail = (() => {
  // -- Inline trend chart -------------------------------------------
  // Small SVG bar chart, one bar per month. Oldest month on the
  // left, current month on the right. Bar height is normalised to
  // the largest value in the series so the chart always reads;
  // empty series render an "Geen data" placeholder.
  //
  // Returns the wrapper element so the caller can append it.
  function renderTrendChart(series) {
    const W = 720, H = 160;
    const M = { top: 12, right: 8, bottom: 24, left: 36 };
    const innerW = W - M.left - M.right;
    const innerH = H - M.top - M.bottom;
    const wrap = el('div', { class: 'entity-detail-trend' });
    if (!series.length) {
      wrap.appendChild(el('div', { class: 'entity-trend-empty' }, '\u2014'));
      return wrap;
    }
    const max = Math.max(1, ...series.map(s => Math.abs(s.amount)));
    const N = series.length;
    const colW = innerW / N;
    const barW = Math.max(6, colW * 0.6);

    const svg = el('svg', {
      class: 'entity-trend-svg',
      viewBox: `0 0 ${W} ${H}`,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': 'Monthly spend trend',
    });
    // Zero baseline + axis labels
    for (const v of [0, max]) {
      const y = M.top + (1 - v / max) * innerH;
      svg.appendChild(el('line', {
        x1: M.left, x2: W - M.right, y1: y, y2: y, class: 'et-zero',
      }));
      svg.appendChild(el('text', {
        x: M.left - 6, y: y + 4,
        'text-anchor': 'end', class: 'et-axis',
      }, Fmt.moneyShort(v)));
    }
    // Bars
    series.forEach((s, i) => {
      const cx = M.left + (i + 0.5) * colW;
      const v = Math.abs(s.amount);
      const h = (v / max) * innerH;
      const y = M.top + innerH - h;
      const rect = el('rect', {
        x: cx - barW / 2, y, width: barW, height: Math.max(1, h),
        rx: 2, ry: 2, class: 'et-bar',
        'data-month': s.month, 'data-amount': s.amount,
      });
      const title = el('title', {}, `${Fmt.monthLabel(s.month)}: ${Fmt.money(s.amount)}`);
      rect.appendChild(title);
      svg.appendChild(rect);
    });
    // X-axis ticks: label every other month so the labels stay
    // legible; for 12 months that's 6 labels. For shorter series we
    // label every month.
    const tickStep = N <= 6 ? 1 : 2;
    for (let i = 0; i < N; i += tickStep) {
      const cx = M.left + (i + 0.5) * colW;
      svg.appendChild(el('text', {
        x: cx, y: H - 8,
        'text-anchor': 'middle', class: 'et-axis',
      }, Fmt.monthLabel(series[i].month).split(' ')[0].slice(0, 3)));
    }
    wrap.appendChild(svg);
    return wrap;
  }

  // -- Top-related list (top payees OR top categories) --------------
  // Each row: name + total + count. As of ISSUE-024 the caller may
  // pass `topList.onRowClick(row)` to make rows interactive — the
  // category detail wires it for top-payees rows (clicking a payee
  // drills into the payee detail) and the payee detail wires it
  // for top-categories rows (clicking a category drills into the
  // category detail). Rows without a handler are plain <div>s.
  function renderTopList(topList) {
    const list = el('div', { class: 'entity-detail-top-list' });
    if (!topList.rows.length) {
      list.appendChild(el('div', { class: 'entity-top-empty muted' }, '\u2014'));
      return list;
    }
    const max = Math.max(1, ...topList.rows.map(r => Math.abs(r.total)));
    const onRowClick = typeof topList.onRowClick === 'function' ? topList.onRowClick : null;
    topList.rows.forEach((r, i) => {
      const pct = (Math.abs(r.total) / max) * 100;
      const bar = el('div', { class: 'etl-bar' },
        el('div', { class: 'etl-bar-fill', style: { width: pct + '%' } }),
      );
      const name = r.category ? r.category.name : r.payeeName;
      const rowChildren = [
        el('div', { class: 'etl-rank' }, String(i + 1)),
        el('div', { class: 'etl-name' }, name || '\u2014'),
        bar,
        el('div', { class: 'etl-total' }, Fmt.money(r.total)),
        el('div', { class: 'etl-count' },
          el('span', { class: 'muted' }, '\u00d7'), String(r.count)),
      ];
      const row = onRowClick
        ? el('button', {
            class: 'etl-row etl-row--clickable',
            type: 'button',
            'data-payee-name': r.payeeName || undefined,
            'data-cat-id': r.category ? r.category.id : undefined,
            onclick: () => onRowClick(r),
          }, ...rowChildren)
        : el('div', { class: 'etl-row' }, ...rowChildren);
      list.appendChild(row);
    });
    return list;
  }

  // -- Recent transactions table ------------------------------------
  // Wraps `Transactions.renderTable` so we own the card chrome
  // (header + "view all" link) without forcing the transactions
  // view to know about our context. Falls back to the empty state
  // when there are no matching txns.
  function renderRecentCard(recent, viewAllLabel, viewAllHandler) {
    const card = el('div', { class: 'card entity-detail-recent' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' }, t('categoryDetail.recent')),
        viewAllHandler
          ? el('button', { class: 'btn btn-ghost btn-sm', onclick: viewAllHandler },
              viewAllLabel + ' \u2192')
          : null,
      ),
    );
    if (!recent.length) {
      card.appendChild(ViewHelpers.emptyState(t('entityDetail.recent.empty'), ''));
      return card;
    }
    card.appendChild(Transactions.renderTable(recent, { compact: true }));
    return card;
  }

  // -- Back button -------------------------------------------------
  // Prefer history.back() when the user got here via a navigation
  // (the dashboard click from ISSUE-022, the categories list from
  // ISSUE-023, the payee list, etc.). When there's no history entry
  // — e.g. a direct deep link from a CSV export — fall back to the
  // categories list. `fallback` is a Router.goTo callback the caller
  // supplies.
  function backHandler(fallback) {
    return () => {
      if (typeof window !== 'undefined' && window.history && window.history.length > 1) {
        try { window.history.back(); return; } catch (_) { /* fall through */ }
      }
      fallback();
    };
  }

  // -- Top-level render --------------------------------------------
  // opts: {
  //   kind:         'category' | 'payee'
  //   entity:       { id, name, color, icon } | string   (payee is just the name)
  //   totals:       { thisMonth, thisYear, count, percentOfExpenses }
  //   trend:        [{ month, amount }, ...]            (12 monthly bars)
  //   topList:      { title, rows: [{ payeeName?, category?, total, count }] }
  //   recent:       Transaction[]
  //   viewAllHref:  () => void          (click handler for "view all")
  //   backHref:     () => void          (fallback when history.back() is unavailable)
  //   extraActions: Element[]           (extra CTAs in the actions row, e.g. envelope)
  // }
  function render(opts) {
    const { kind, entity, totals, trend, topList, recent, viewAllHref, backHref, extraActions } = opts;

    // The header shape is shared: a swatch (or initial for payees) +
    // the entity name + this-month total big + this-year + count +
    // % of expenses. The this-month bar caps at 100% so overspends
    // read in the colour but not in a runaway width.
    const isCategory = kind === 'category';
    const name = isCategory ? entity.name : entity; // payee passes the name directly
    const swatch = isCategory
      ? el('div', { class: 'entity-swatch', style: { background: entity.color } }, entity.icon || '\u2726')
      : el('div', { class: 'entity-swatch entity-swatch--payee' },
          (name || '?').slice(0, 1).toUpperCase());

    const monthPct = totals.thisYear > 0
      ? Math.min(100, (totals.thisMonth / totals.thisYear) * 100)
      : 0;
    const monthFill = el('div', {
      class: 'edh-month-fill',
      style: { width: monthPct + '%' },
    });

    const header = el('div', { class: 'entity-detail-header card' },
      swatch,
      el('div', { class: 'edh-text' },
        el('div', { class: 'edh-name' }, name),
        el('div', { class: 'edh-sub muted' },
          el('span', { class: 'edh-tag' },
            isCategory ? t('categoryDetail.title', { name }) : t('payeeDetail.title', { name })),
        ),
      ),
      el('div', { class: 'edh-totals' },
        el('div', { class: 'edh-stat' },
          el('div', { class: 'edh-stat-lbl muted' }, t('categoryDetail.thisMonth')),
          el('div', { class: 'edh-stat-val' }, Fmt.money(totals.thisMonth)),
        ),
        el('div', { class: 'edh-stat' },
          el('div', { class: 'edh-stat-lbl muted' }, t('categoryDetail.thisYear')),
          el('div', { class: 'edh-stat-val' }, Fmt.money(totals.thisYear)),
        ),
        el('div', { class: 'edh-stat' },
          el('div', { class: 'edh-stat-lbl muted' }, t('categoryDetail.count', { count: totals.count })),
          el('div', { class: 'edh-stat-val' }, String(totals.count)),
        ),
        el('div', { class: 'edh-stat' },
          el('div', { class: 'edh-stat-lbl muted' }, t('categoryDetail.percentOfExpenses')),
          el('div', { class: 'edh-stat-val' },
            (totals.percentOfExpenses || 0).toFixed(0) + '%'),
        ),
        el('div', { class: 'edh-month-bar' },
          el('div', { class: 'edh-month-bar-fill-host' }, monthFill),
        ),
      ),
    );

    // Trend chart card.
    const trendCard = el('div', { class: 'card entity-detail-trend-card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' }, t('categoryDetail.trend')),
      ),
      renderTrendChart(trend),
    );

    // Top related list card. Title comes pre-translated by the
    // caller (top payees vs top categories use different keys).
    const topCard = el('div', { class: 'card entity-detail-top-card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' }, topList.title),
      ),
      renderTopList(topList),
    );

    // Recent transactions card.
    const recentCard = renderRecentCard(recent, t('categoryDetail.viewAll'), viewAllHref);

    // Actions row: back + optional extras (envelope CTA, edit, ...).
    const actionsChildren = [
      el('button', { class: 'btn btn-ghost', onclick: backHandler(backHref) },
        '\u2190 ' + t('categoryDetail.back')),
    ];
    if (extraActions && extraActions.length) actionsChildren.push(...extraActions);
    const actions = el('div', { class: 'entity-detail-actions' }, ...actionsChildren);

    return el('div', { class: 'entity-detail' },
      header,
      trendCard,
      topCard,
      recentCard,
      actions,
    );
  }

  return {
    render,
    // Exposed for tests / callers that want the chart standalone.
    renderTrendChart,
  };
})();
window.EntityDetail = EntityDetail;