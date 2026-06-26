// =====================================================================
// charts/balance-trajectory.js — Per-source / net-worth trajectory line
// =====================================================================
// Pure SVG builder. Caller supplies the pre-computed series list and
// the i18n strings. Each series is either:
//   { id, name, color, points: [{ date, balance }], today, flat? }
// where `today` is the user's typed current balance and `flat` is set
// for sources with no transactions in the visible window.
// =====================================================================

const BalanceTrajectory = (() => {
  const { CHART_W, TR_H, CHART_M_TR, NW_COLOR, colorForSource } = ChartHelpers;

  // opts: {
  //   series,                 // array (see header)
  //   isNetWorth,             // bool
  //   i18n: {
  //     titleSrc, titleNw,
  //     subSrc, subNw,
  //     emptySources, emptyTxns12,
  //     networthName, todayLabel,
  //   },
  // }
  // ISSUE-016: the range-toggle UI used to live here; the unified
  // PeriodSelector (mounted by the parent view, ISSUE-014) is now
  // the single source of truth for time range.
  function render(opts) {
    const { series: rawSeries, isNetWorth, i18n } = opts;
    const innerW = CHART_W - CHART_M_TR.left - CHART_M_TR.right;
    const innerH = TR_H - CHART_M_TR.top - CHART_M_TR.bottom;

    const wrap = el('div', { class: 'chart-section' },
      el('div', { class: 'chart-section-head' },
        el('span', { class: 'chart-section-title' },
          isNetWorth ? i18n.titleNw : i18n.titleSrc,
          el('span', { class: 'chart-section-sub' },
            isNetWorth ? i18n.subNw : i18n.subSrc),
        ),
      ),
    );

    if (!rawSeries.length) {
      wrap.appendChild(el('div', { class: 'balance-empty' },
        isNetWorth ? i18n.emptySources : i18n.emptyTxns12));
      return wrap;
    }

    // Resolve per-source colour now that we know the chart context.
    const series = rawSeries.map(s => ({
      ...s,
      color: s.id === '__networth__' ? NW_COLOR : colorForSource(s),
    }));

    const allDates = new Set();
    for (const s of series) for (const p of s.points) allDates.add(p.date);
    const dates = [...allDates].sort();
    const fromMs = Date.parse(dates[0]);
    const toMs = Date.parse(dates[dates.length - 1]);
    const xSpan = Math.max(toMs - fromMs, 86400000);

    const ys = [];
    for (const s of series) for (const p of s.points) ys.push(p.balance);
    for (const s of series) ys.push(s.today);
    let yMin = Math.min(...ys);
    let yMax = Math.max(...ys);
    if (yMin === yMax) { yMin -= 100; yMax += 100; }
    const yPad = (yMax - yMin) * 0.15;
    yMin -= yPad; yMax += yPad;

    const xToPx = (date) =>
      CHART_M_TR.left + ((Date.parse(date) - fromMs) / xSpan) * innerW;
    const yToPx = (bal) =>
      CHART_M_TR.top + (1 - (bal - yMin) / (yMax - yMin)) * innerH;

    const svg = el('svg', {
      class: 'balance-svg trajectory-svg',
      viewBox: `0 0 ${CHART_W} ${TR_H}`,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': 'Balance trajectory walking back from today',
    });

    for (let i = 0; i <= 4; i++) {
      const v = yMin + (yMax - yMin) * (i / 4);
      const y = yToPx(v);
      svg.appendChild(el('line', {
        x1: CHART_M_TR.left, x2: CHART_W - CHART_M_TR.right,
        y1: y, y2: y, class: 'bc-grid',
      }));
      svg.appendChild(el('text', {
        x: CHART_M_TR.left - 8, y: y + 4,
        'text-anchor': 'end', class: 'bc-axis',
      }, Fmt.moneyShort(v)));
    }

    const midIso = new Date((fromMs + toMs) / 2).toISOString().slice(0, 10);
    const xLabels = [
      { date: dates[0], anchor: 'start' },
      { date: midIso,   anchor: 'middle' },
      { date: dates[dates.length - 1], anchor: 'end' },
    ];
    for (const lbl of xLabels) {
      svg.appendChild(el('text', {
        x: xToPx(lbl.date), y: TR_H - 8,
        'text-anchor': lbl.anchor, class: 'bc-axis',
      }, Fmt.date(lbl.date)));
    }

    const todayX = CHART_W - CHART_M_TR.right - 4;
    for (const s of series) {
      const y = yToPx(s.today);
      const isFlat = !!s.flat;
      svg.appendChild(el('line', {
        x1: CHART_M_TR.left, x2: CHART_W - CHART_M_TR.right,
        y1: y, y2: y,
        class: 'bc-ref-today' + (isFlat ? ' bc-ref-flat' : ''),
        stroke: s.color,
        'stroke-dasharray': isFlat ? null : '3 4',
        'data-source': s.id,
      }));
      svg.appendChild(el('text', {
        x: todayX, y: y - 4,
        'text-anchor': 'end', class: 'bc-ref-label',
        fill: s.color,
      }, isFlat
        ? `${ViewHelpers.escapeText(s.name)} \u00b7 ${Fmt.moneyShort(s.today)}`
        : `${i18n.todayLabel} ${Fmt.moneyShort(s.today)}`));
    }

    for (const s of series) {
      if (s.flat) continue;
      const pts = s.points.map(p => [xToPx(p.date), yToPx(p.balance)]);
      if (pts.length === 1) {
        svg.appendChild(el('circle', {
          cx: pts[0][0], cy: pts[0][1], r: 4,
          fill: s.color, class: 'tr-end',
          'data-source': s.id,
        }));
        continue;
      }
      svg.appendChild(el('polyline', {
        class: 'tr-line' + (isNetWorth ? ' tr-nw' : ''),
        stroke: s.color, fill: 'none',
        'stroke-width': isNetWorth ? 2.5 : 1.6,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        'data-source': s.id,
        points: pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '),
      }));
      const last = pts[pts.length - 1];
      svg.appendChild(el('circle', {
        cx: last[0], cy: last[1],
        r: isNetWorth ? 4 : 3,
        fill: s.color, class: 'tr-end',
        'data-source': s.id,
      }));
    }

    const tooltip = el('div', { class: 'bc-tooltip', id: 'tr-tooltip' });
    svg.appendChild(tooltip);
    const overlay = el('rect', {
      x: CHART_M_TR.left, y: CHART_M_TR.top,
      width: innerW, height: innerH,
      fill: 'transparent', class: 'bc-overlay',
    });
    svg.appendChild(overlay);

    overlay.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const scaleX = rect.width ? rect.width / CHART_W : 1;
      const px = (e.clientX - rect.left) / scaleX;
      const ms = fromMs + ((px - CHART_M_TR.left) / innerW) * xSpan;
      let best = null, bestDist = Infinity;
      for (const s of series) {
        for (const p of s.points) {
          const d = Math.abs(Date.parse(p.date) - ms);
          if (d < bestDist) { bestDist = d; best = { point: p, source: s }; }
        }
      }
      if (!best) { tooltip.style.display = 'none'; return; }
      tooltip.innerHTML =
        (isNetWorth
          ? `<span class="bc-tt-name">${ViewHelpers.escapeText(i18n.networthName)}</span>`
          : `<span class="bc-tt-dot" style="background:${best.source.color}"></span>` +
            `<span class="bc-tt-name">${ViewHelpers.escapeText(best.source.name)}</span>`) +
        `<span class="bc-tt-date">${ViewHelpers.escapeText(Fmt.date(best.point.date))}</span>` +
        `<span class="bc-tt-bal">${ViewHelpers.escapeText(Fmt.money(best.point.balance))}</span>`;
      tooltip.style.display = 'flex';
      tooltip.style.left = (xToPx(best.point.date) / CHART_W * 100) + '%';
      tooltip.style.top = '8%';
    });
    overlay.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });

    wrap.appendChild(svg);
    return wrap;
  }

  return { render };
})();
window.BalanceTrajectory = BalanceTrajectory;
