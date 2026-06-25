// =====================================================================
// icons.js — Tiny inline SVG icon set + decorative illustrations
// All icons are 24x24 viewBox, 1.5–2px stroke, rounded.
// =====================================================================

const Icons = {
  // Navigation
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9.5"/></svg>`,
  list: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>`,
  tags: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 12.5 12.5 20.6a1.5 1.5 0 0 1-2.1 0L3 13.2V3h10.2l7.4 7.4a1.5 1.5 0 0 1 0 2.1Z"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/></svg>`,
  wallet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h11A2.5 2.5 0 0 1 19 7.5V9H5.5A2.5 2.5 0 0 0 3 11.5v-4Z"/><path d="M3 11.5A2.5 2.5 0 0 1 5.5 9H19a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5.5A2.5 2.5 0 0 1 3 16.5v-5Z"/><circle cx="16.5" cy="14" r="1.2" fill="currentColor"/></svg>`,
  users: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="8" r="2.5"/><path d="M16 20a5 5 0 0 1 5.5-5"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>`,
  // Actions
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 4.5a2.1 2.1 0 0 1 3 0l1 1a2.1 2.1 0 0 1 0 3L8 16l-4 1 1-4 6.5-8.5Z"/><path d="M9 7l4 4"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M5 6l1 14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-14"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  chevLeft: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"/></svg>`,
  chevRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`,
  arrowUp: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`,
  arrowDown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>`,
  menu: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
  // Decorative
  coin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M9 9.5c.5-1 1.5-1.5 3-1.5s2.5.5 2.5 1.8c0 1-1 1.5-2.5 2-1.5.5-2.5 1-2.5 2 0 1.3 1.2 1.7 2.5 1.7s2.5-.5 3-1.5M12 6.5v1.5M12 16v1.5"/></svg>`,
  leaf: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19c0-8 6-14 14-14 0 8-6 14-14 14Z"/><path d="M5 19c2-3 4-5 8-7"/></svg>`,
  receipt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21Z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>`,
  house: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10.5V20h5v-5h4v5h5v-9.5"/></svg>`,
  coffee: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h12v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9Z"/><path d="M16 11h2a2 2 0 0 1 0 4h-2"/><path d="M8 5c-1-1 0-2 0-2M11 5c-1-1 0-2 0-2"/></svg>`,
  piggy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 11a6 6 0 0 1 6-6h3a5 5 0 0 1 5 5v3a5 5 0 0 1-1 3l-1 1v2h-2v-1H8v1H6v-2l-1-1Z"/><circle cx="16" cy="11" r=".8" fill="currentColor"/><path d="M3 11v2M5 12H3"/></svg>`,
  // Status / scope
  globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2 2.5 3 5 3 8s-1 5.5-3 8c-2-2.5-3-5-3-8s1-5.5 3-8Z"/></svg>`,
  trend: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 9 12 13 15 20 6"/><polyline points="14 6 20 6 20 12"/></svg>`,
  user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12 10 17 19 7"/></svg>`,
  upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/><polyline points="8 8 12 4 16 8"/><line x1="12" y1="4" x2="12" y2="15"/></svg>`,
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7"/><polyline points="8 12 12 16 16 12"/><line x1="12" y1="4" x2="12" y2="16"/></svg>`,
  store: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9 4.5 4h15L21 9"/><path d="M3 9v11a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M9 21v-5a3 3 0 0 1 6 0v5"/></svg>`,
};

// Decorative background SVGs (used in `.deco-bg`)
const Deco = {
  leaf: `<svg viewBox="0 0 80 80" fill="none" stroke="#3d5230" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 70c0-30 25-55 60-55 0 30-25 55-60 55Z"/><path d="M10 70c8-12 18-20 35-28"/></svg>`,
  coin: `<svg viewBox="0 0 90 90" fill="none" stroke="#b8895c" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="45" cy="45" r="28"/><path d="M38 40c1-3 3-5 7-5s7 1 7 5-3 4-7 5-7 2-7 5 3 5 7 5 6-2 7-5M45 28v4M45 58v4"/></svg>`,
  receipt: `<svg viewBox="0 0 60 80" fill="none" stroke="#5a7248" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5h40v70l-7-5-7 5-6-5-7 5-6-5-7 5Z"/><path d="M20 22h20M20 32h20M20 42h14"/></svg>`,
  house: `<svg viewBox="0 0 100 80" fill="none" stroke="#3d5230" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 38 50 8l40 30"/><path d="M20 32v36h15V50h15v18h25V32"/></svg>`,
  dots: `<svg viewBox="0 0 60 60" fill="#5a7248"><circle cx="10" cy="10" r="3"/><circle cx="30" cy="10" r="3"/><circle cx="50" cy="10" r="3"/><circle cx="10" cy="30" r="3"/><circle cx="30" cy="30" r="3"/><circle cx="50" cy="30" r="3"/><circle cx="10" cy="50" r="3"/><circle cx="30" cy="50" r="3"/><circle cx="50" cy="50" r="3"/></svg>`,
  // Hero illustration for empty state
  emptyHero: `<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 80V45l30-22 30 22v35H20Z" />
    <path d="M40 80V60h20v20" />
    <circle cx="72" cy="30" r="9" fill="currentColor" fill-opacity=".15"/>
    <path d="M72 25v10M67 30h10" />
  </svg>`,
};

// Decorative icon set used by category icons (kept emoji-style for simplicity + personality)
const CategoryIcons = [
  '🧺', '🍞', '🎬', '📱', '📡', '🛟', '💧', '⚡', '🔥', '🏠',
  '🛠️', '🚌', '🚲', '🩺', '🧵', '🧸', '🐾', '🎁', '🌿', '✦',
  '💼', '🌱', '↺', '✨', '🎀', '🪴', '🛒', '🍎', '🥖', '☕',
  '🎵', '📚', '🧴', '🧼', '🪥', '💊', '🐶', '🐱', '🎨', '🎭',
  '🪑', '🛋️', '🪟', '🚪', '🔑', '💡', '📺', '💻', '🎮', '🪙',
];

// Logo mark
const Logo = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 10.5 12 3l9 7.5"/>
  <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>
  <circle cx="12" cy="13" r="1.5" fill="currentColor"/>
</svg>`;

// Expose to window for non-module scripts
window.Icons = Icons;
window.Deco = Deco;
window.CategoryIcons = CategoryIcons;
window.Logo = Logo;
