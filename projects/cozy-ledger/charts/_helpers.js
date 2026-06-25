// =====================================================================
// charts/_helpers.js — Shared SVG chart dimensions, palette, source colors
// =====================================================================
// All chart files (monthly-flow, balance-trajectory) share these so a
// colour tweak or layout change happens in one place.
// =====================================================================

const ChartHelpers = (() => {
  const CHART_W = 800;
  const HB_H = 200;
  const TR_H = 160;
  const CHART_M_HB = { top: 14, right: 16, bottom: 28, left: 56 };
  const CHART_M_TR = { top: 14, right: 16, bottom: 28, left: 56 };
  const NW_COLOR = '#3a3a3a'; // charcoal for net-worth trend line
  const POS_COLOR = '#5a7248'; // sage for income
  const NEG_COLOR = '#b85c4a'; // terra for expense

  // Stable palette for shared sources (assigned by position in the
  // in-scope list so colours stay stable across renders).
  const SHARED_PALETTE = ['#7a8b94', '#9a6b8a', '#c2714f', '#a4926b', '#8a6340'];

  // Pick a stable colour for a source: the owner's colour if there is
  // one, otherwise a position-based palette slot for shared sources.
  function colorForSource(src) {
    if (src.ownerId) {
      const u = App._state.users.find(x => x.id === src.ownerId);
      if (u && u.color) return u.color;
    }
    const shared = Selectors.sourcesInScope(App._state).filter(s => s.ownerId == null);
    const idx = shared.findIndex(s => s.id === src.id);
    return SHARED_PALETTE[Math.max(0, idx) % SHARED_PALETTE.length];
  }

  return {
    CHART_W, HB_H, TR_H,
    CHART_M_HB, CHART_M_TR,
    NW_COLOR, POS_COLOR, NEG_COLOR,
    SHARED_PALETTE,
    colorForSource,
  };
})();
window.ChartHelpers = ChartHelpers;
