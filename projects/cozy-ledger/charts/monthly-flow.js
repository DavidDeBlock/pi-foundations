// =====================================================================
// charts/monthly-flow.js — Heartbeat: income vs expense bars per month
// =====================================================================
// Pure SVG builder. Caller supplies the pre-computed months array
// (`Selectors.monthlyNetFlow(state, trendMonths)`) and the active
// sources (for the per-source breakdown tooltip). Caller also supplies
// the i18n strings and the range-button DOM so the chart file stays
// free of router/Store coupling.
// =====================================================================

const MonthlyFlow = (() => {
  const { CHART_W, HB_H, CHART_M_HB, POS_COLOR, NEG_COLOR, colorForSource } = ChartHelpers;

  // Build the heart-beat chart inside a fresh wrapper element.
  // Returns the wrapper. Caller is responsible for appending it.
  //
  // opts: {
  //   months,                 // [{ month, income, expense, net, perSource }]
  //   sources,                // [{ id, name, ... }]
  //   isNetWorth,             // bool: hide per-source breakdown in tooltip
  //   i18n: {
  //     title, sub, empty,
  //     tooltipSaved, tooltipSpent, tooltipIn, tooltipOut,
  //   },
  //   rangeButtons,           // DOM element for the right side of the head
  // }
  function render(opts) {
    const { months, sources, isNetWorth, i18n, rangeButtons } = opts;
    const innerW = CHART_W - CHART_M_HB.left - CHART_M_HB.right;
    const innerH = HB_H - CHART_M_HB.top - CHART_M_HB.bottom;

    const wrap = el('div', { class: 'chart-section' },
      el('div', { class: 'chart-section-head' },
        el('span', { class: 'chart-section-title' },
          i18n.title,
          el('span', { class: 'chart-section-sub' }, i18n.sub),
        ),
        rangeButtons,
      ),
    );

    const hasAnyActivity = months.some(m => m.income !== 0 || m.expense !== 0);
    if (!hasAnyActivity) {
      wrap.appendChild(el('div', { class: 'balance-empty' }, i18n.empty));
      return wrap;
    }

    const N = months.length;
    const colW = innerW / N;

    let maxAbs = 1;
    for (const m of months) maxAbs = Math.max(maxAbs, Math.abs(m.net));
    const yMax = maxAbs;
    const yMin = -maxAbs;

    const xToPx = (i) => CHART_M_HB.left + (i + 0.5) * colW;
    const yToPx = (val) => CHART_M_HB.top + (1 - (val - yMin) / (yMax - yMin)) * innerH;
    const zeroY = yToPx(0);

    const svg = el('svg', {
      class: 'balance-svg monthly-flow-svg',
      viewBox: `0 0 ${CHART_W} ${HB_H}`,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': 'Income vs expenses per month',
    });

    svg.appendChild(el('line', {
      x1: CHART_M_HB.left, x2: CHART_W - CHART_M_HB.right,
      y1: zeroY, y2: zeroY, class: 'bc-zero',
    }));

    for (const v of [yMax, 0, yMin]) {
      svg.appendChild(el('text', {
        x: CHART_M_HB.left - 8, y: yToPx(v) + 4,
        'text-anchor': 'end', class: 'bc-axis',
      }, Fmt.moneyShort(v)));
    }

    const tickStep = N <= 6 ? 1
                   : N <= 12 ? 2
                   : N <= 24 ? 3
                   : N <= 48 ? 6
                   : 12;
    for (let i = 0; i < N; i += tickStep) {
      const m = months[i];
      svg.appendChild(el('text', {
        x: xToPx(i), y: HB_H - 8,
        'text-anchor': 'middle', class: 'bc-axis',
      }, Fmt.monthLabel(m.month)));
    }

    const BAR_GAP = 4;
    const barWidth = Math.max(8, colW - BAR_GAP);

    months.forEach((m, i) => {
      const cx = xToPx(i);
      const v = m.net;
      const color = v >= 0 ? POS_COLOR : NEG_COLOR;
      if (v >= 0) {
        const top = yToPx(v);
        svg.appendChild(el('rect', {
          x: cx - barWidth / 2, y: top,
          width: barWidth, height: zeroY - top,
          fill: color, class: 'mf-bar',
          'data-month': m.month, 'data-value': v,
        }));
      } else {
        const bottom = yToPx(v);
        svg.appendChild(el('rect', {
          x: cx - barWidth / 2, y: zeroY,
          width: barWidth, height: bottom - zeroY,
          fill: color, class: 'mf-bar',
          'data-month': m.month, 'data-value': v,
        }));
      }
    });

    const tooltip = el('div', { class: 'bc-tooltip', id: 'mf-tooltip' });
    svg.appendChild(tooltip);
    const overlay = el('rect', {
      x: CHART_M_HB.left, y: CHART_M_HB.top,
      width: innerW, height: innerH,
      fill: 'transparent', class: 'bc-overlay',
    });
    svg.appendChild(overlay);

    overlay.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const scaleX = rect.width ? rect.width / CHART_W : 1;
      const px = (e.clientX - rect.left) / scaleX;
      const col = Math.max(0, Math.min(N - 1, Math.floor((px - CHART_M_HB.left) / colW)));
      const m = months[col];
      if (!m) { tooltip.style.display = 'none'; return; }
      const sign = m.net >= 0 ? '+' : '\u2212';
      const signClass = m.net >= 0 ? 'hb-pos' : 'hb-neg';
      const verb = m.net >= 0 ? i18n.tooltipSaved : i18n.tooltipSpent;
      const detail = isNetWorth ? '' :
        Object.entries(m.perSource)
          .filter(([, v]) => v)
          .map(([id, v]) => {
            const src = sources.find(s => s.id === id);
            return `<span class="bc-tt-seg"><span class="bc-tt-dot" style="background:${colorForSource(src)}"></span>${ViewHelpers.escapeText(src.name)}: ${ViewHelpers.escapeText(Fmt.money(v))}</span>`;
          }).join('');
      tooltip.innerHTML =
        `<span class="bc-tt-name">${ViewHelpers.escapeText(Fmt.monthLabel(m.month))}</span>` +
        `<span class="bc-tt-date">${ViewHelpers.escapeText(Fmt.money(m.income))} ${ViewHelpers.escapeText(i18n.tooltipIn)} \u00b7 ${ViewHelpers.escapeText(Fmt.money(m.expense))} ${ViewHelpers.escapeText(i18n.tooltipOut)}</span>` +
        `<span class="bc-tt-bal ${signClass}">${ViewHelpers.escapeText(verb)} ${sign}${ViewHelpers.escapeText(Fmt.money(Math.abs(m.net)))}</span>` +
        (detail ? `<span class="bc-tt-detail">${detail}</span>` : '');
      tooltip.style.display = 'flex';
      tooltip.style.left = (xToPx(col) / CHART_W * 100) + '%';
      tooltip.style.top = '8%';
    });
    overlay.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });

    wrap.appendChild(svg);
    return wrap;
  }

  return { render };
})();
window.MonthlyFlow = MonthlyFlow;
