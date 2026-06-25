/* ─────────────────────────────────────────────
   Pixel Poes – app.js
   Skeleton: state, render, intro/game flow.

   What's in this skeleton:
     - State load/save with localStorage
     - Intro screen (name input + continue)
     - Game screen layout (topbar, stage,
       stats, actions, day overview, shopbar)
     - Modals open/close (shop, stickers, settings)
     - Day/night body class on a 60s interval
     - Stat bars render from state
     - Day-vinkjes render from state
     - Action buttons render a "komt zo" message

   What comes in the next iterations:
     - F2: real pixel-kat rendering in #petCanvas
     - F1: action buttons mutate state, award XP/coins
     - F4: shop buy/equip flow
     - F5: sticker unlock checks + celebration
     - F7: streak mechanics on day change
   ───────────────────────────────────────────── */

(() => {
  "use strict";

  /* ───────────── 1. STATE ───────────── */

  const STORAGE_KEY = "pixelpoes.v1";

  const STATS = ["hunger", "happiness", "energy", "clean", "learning"];

  // Per-action stat deltas + XP/coins. Applied in
  // onAction(). Numbers tuned so each tap is a
  // noticeable but not game-breaking boost.
  const ACTION_DELTAS = {
    feed:  { hunger:    35, clean:     -3,                    xp: 6, coins: 2 },
    play:  { happiness: 30, hunger:    -6,  energy: -10,      xp: 5, coins: 2 },
    wash:  { clean:     50, happiness:  2,                    xp: 4, coins: 2 },
    sleep: { energy:    15, hunger:    -3,                    xp: 3, coins: 2 },
  };

  // Decay rates per stat, in units per minute. Stats
  // tick down on a 1s interval. Gentle on purpose:
  // missing a day should never feel punishing
  // (no-guilt principle). Tunable — if the daughter
  // finds decay too slow or too fast, dial these.
  const DECAY_PER_MIN = {
    hunger:    0.7,
    happiness: 0.5,
    energy:    0.5,
    clean:     0.3,
    learning:  0.15,
  };

  // XP needed to reach the next level from level N.
  // Level 1 → 80, level 2 → 160, level 3 → 240, …
  // (linear, not exponential — short sessions feel
  // rewarding without grinding).
  const XP_FOR_LEVEL = (level) => level * 80;

  const defaultState = () => ({
    name: "Poes",
    created: Date.now(),
    lastSeen: Date.now(),
    lastDay: dayKey(new Date()),
    streak: 0,
    stats: { hunger: 80, happiness: 80, energy: 80, clean: 80, learning: 30 },
    xp: 0,
    level: 1,
    coins: 0,
    isSleeping: false,
    owned: [],
    activeDeco: null,
    activeBackground: null,
    todayActions: { feed: false, play: false, wash: false, sleep: false },
    unlockedStickers: [],
    soundOn: false,
  });

  let state = loadState();

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const fresh = defaultState();
      return {
        ...fresh,
        ...parsed,
        stats: { ...fresh.stats, ...(parsed.stats || {}) },
        todayActions: { ...fresh.todayActions, ...(parsed.todayActions || {}) },
      };
    } catch (e) {
      return defaultState();
    }
  }

  function saveState() {
    state.lastSeen = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* localStorage unavailable; ignore */ }
  }

  function dayKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* ───────────── 2. DOM ───────────── */

  const $ = (id) => document.getElementById(id);
  const dom = {
    intro: $("intro"), game: $("game"),
    nameInput: $("nameInput"), startBtn: $("startBtn"),
    continueBtn: $("continueBtn"), continueName: $("continueName"),
    petName: $("petName"), levelLabel: $("levelLabel"),
    coinsLabel: $("coinsLabel"), streakLabel: $("streakLabel"),
    petCanvas: $("petCanvas"), bubble: $("bubble"),
    stage: $("stage"), stats: $("stats"),
    dayVinkjes: $("dayVinkjes"),
    settingsBtn: $("settingsBtn"), settingsModal: $("settingsModal"),
    closeSettings: $("closeSettings"), soundToggle: $("soundToggle"),
    resetBtn: $("resetBtn"), resetBtnSettings: $("resetBtnSettings"),
    shopBtn: $("shopBtn"), shopModal: $("shopModal"),
    closeShop: $("closeShop"), shopCoins: $("shopCoins"), shopGrid: $("shopGrid"),
    stickersBtn: $("stickersBtn"), stickersModal: $("stickersModal"),
    closeStickers: $("closeStickers"), stickersGrid: $("stickersGrid"),
  };

  /* ───────────── 3. RENDER ───────────── */

  function render() {
    dom.petName.textContent = state.name;
    dom.levelLabel.textContent = state.level;
    dom.coinsLabel.textContent = state.coins;
    dom.streakLabel.textContent = state.streak;

    renderStats();
    renderDayVinkjes();
    paintPetFrame();
  }

  function renderStats() {
    // Build bars once if not there yet.
    if (dom.stats.children.length === 0) {
      for (const k of STATS) {
        const row = document.createElement("div");
        row.className = "stat";
        row.dataset.key = k;
        row.innerHTML = `
          <span class="ico">${STAT_ICON[k]}</span>
          <span class="lbl">${STAT_LABEL[k]}</span>
          <div class="bar"><div class="fill" id="bar-${k}"></div></div>
          <span class="val" id="val-${k}">0</span>
        `;
        dom.stats.appendChild(row);
      }
    }
    for (const k of STATS) {
      const v = Math.round(state.stats[k]);
      const bar = document.getElementById(`bar-${k}`);
      const val = document.getElementById(`val-${k}`);
      if (bar) {
        bar.style.width = v + "%";
        bar.classList.toggle("low",     v < 40 && v >= 20);
        bar.classList.toggle("verylow", v < 20);
      }
      if (val) val.textContent = v;
    }
  }

  const DAY_VINKJES_ITEMS = [
    { key: "feed",  icon: "🍎", label: "Gevoed" },
    { key: "play",  icon: "🎈", label: "Gespeeld" },
    { key: "wash",  icon: "🛁", label: "Gewassen" },
    { key: "sleep", icon: "😴", label: "Geslapen" },
  ];

  function renderDayVinkjes() {
    if (!dom.dayVinkjes) return;
    if (dom.dayVinkjes.children.length === 0) {
      for (const it of DAY_VINKJES_ITEMS) {
        const span = document.createElement("span");
        span.className = "day-vink";
        span.dataset.key = it.key;
        span.innerHTML = `<span>${it.icon}</span><span>${it.label}</span>`;
        dom.dayVinkjes.appendChild(span);
      }
    }
    dom.dayVinkjes.querySelectorAll(".day-vink").forEach(span => {
      span.classList.toggle("done", !!state.todayActions[span.dataset.key]);
    });
  }

  /* ───────────── 4. BUBBLE ───────────── */

  let bubbleTimer = null;
  function showBubble(text) {
    if (!dom.bubble) return;
    dom.bubble.textContent = text;
    dom.bubble.classList.remove("hidden");
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => dom.bubble.classList.add("hidden"), 2400);
  }

  /* ───────────── 5. ACTIONS (F1) ───────────── */
  // Tapping an action button mutates state.stats by
  // the deltas in ACTION_DELTAS, awards XP + coins,
  // marks the day-vinkje, and shows a Dutch bubble.

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function addXp(amount) {
    if (amount <= 0) return;
    state.xp += amount;
    let leveledUp = false;
    while (state.xp >= XP_FOR_LEVEL(state.level)) {
      state.xp -= XP_FOR_LEVEL(state.level);
      state.level += 1;
      leveledUp = true;
    }
    if (leveledUp) {
      showBubble("Level " + state.level + " — goed gedaan! 🎉");
    }
  }

  function tickDecay() {
    const minutesPerTick = 1 / 60;  // 1s tick in minutes
    for (const k of STATS) {
      const rate = DECAY_PER_MIN[k] || 0;
      state.stats[k] = clamp(state.stats[k] - rate * minutesPerTick, 0, 100);
    }
  }

  function applyOfflineDecay() {
    const lastSeen = state.lastSeen || Date.now();
    const elapsedMin = (Date.now() - lastSeen) / 60000;
    // Cap at 60 minutes. The no-guilt principle:
    // skipping a full day costs at most one hour of
    // catch-up decay. Beyond that, stats stay where
    // they were.
    const minutes = Math.min(elapsedMin, 60);
    if (minutes < 1) return;
    for (const k of STATS) {
      const rate = DECAY_PER_MIN[k] || 0;
      state.stats[k] = clamp(state.stats[k] - rate * minutes, 0, 100);
    }
    state.lastSeen = Date.now();
  }

  function checkDayChange() {
    const today = dayKey(new Date());
    if (state.lastDay !== today) {
      state.todayActions = { feed: false, play: false, wash: false, sleep: false };
      state.lastDay = today;
    }
  }

  function onAction(name) {
    const deltas = ACTION_DELTAS[name];
    if (!deltas) return;
    // Stat deltas (clamped to 0–100)
    for (const k of STATS) {
      if (typeof deltas[k] === "number") {
        state.stats[k] = clamp(state.stats[k] + deltas[k], 0, 100);
      }
    }
    // XP and coins
    if (deltas.xp) addXp(deltas.xp);
    state.coins = (state.coins || 0) + (deltas.coins || 0);
    // Mark today's vinkje as done
    state.todayActions[name] = true;
    // Persist + re-render
    saveState();
    render();
    // Show action bubble (random pick from MESSAGES)
    const m = MESSAGES.ACTIONS[name];
    showBubble(m ? pick(m.msg) : "Leuk!");
  }

  /* ───────────── 6. FLOW ───────────── */

  function showGame() {
    dom.intro.classList.remove("visible");
    dom.game.classList.add("visible");
  }
  function showIntro() {
    dom.game.classList.remove("visible");
    dom.intro.classList.add("visible");
  }

  function tryStart() {
    const raw = dom.nameInput.value.trim();
    if (!raw) {
      dom.nameInput.focus();
      dom.nameInput.placeholder = "Kies een naam…";
      return;
    }
    state.name = raw.slice(0, 12);
    state.lastDay = dayKey(new Date());
    state.streak = Math.max(1, state.streak);
    saveState();
    showGame();
    render();
    showBubble(`Hallo, ik ben ${state.name}!`);
  }

  function continueOld() {
    showGame();
    render();
    showBubble("Daar ben je weer!");
  }

  function resetAll() {
    if (!confirm("Weet je zeker dat je opnieuw wilt beginnen?")) return;
    localStorage.removeItem(STORAGE_KEY);
    state = defaultState();
    dom.nameInput.value = "";
    if (dom.soundToggle) dom.soundToggle.checked = false;
    showIntro();
  }

  /* ───────────── 7. DAY/NIGHT ───────────── */

  function applyTimeOfDay() {
    const h = new Date().getHours();
    let zone = "day";
    if (h >= 6  && h < 12) zone = "morning";
    else if (h >= 12 && h < 18) zone = "day";
    else if (h >= 18 && h < 22) zone = "evening";
    else zone = "night";
    document.body.classList.remove("time-morning", "time-day", "time-evening", "time-night");
    document.body.classList.add("time-" + zone);
  }

  /* ───────────── 7b. PET RENDERER (F2) ───────────── */
  // Visual state — not persisted. The mood system
  // (F4) will update `currentMood` from game state.
  let currentMood = "blij";
  let frameToggle = false;
  let petGrid = null;
  let petPixels = null;   // 16x16 array of <span>

  function buildPetGrid() {
    if (!dom.petCanvas) return;
    dom.petCanvas.innerHTML = "";  // clear scaffold note / old grid
    petGrid = document.createElement("div");
    petGrid.className = "pixel-grid";
    petPixels = [];
    for (let r = 0; r < 16; r++) {
      const row = [];
      for (let c = 0; c < 16; c++) {
        const span = document.createElement("span");
        span.className = "pixel";
        petGrid.appendChild(span);
        row.push(span);
      }
      petPixels.push(row);
    }
    dom.petCanvas.appendChild(petGrid);
  }

  // Set the current mood. F4 will call this when the
  // mood system computes a new mood. F2 only ever sets
  // the default ("blij").
  function setPetMood(mood) {
    if (PET.frames[mood]) currentMood = mood;
  }

  function paintPetFrame() {
    if (!dom.petCanvas) return;
    const moodFrames = PET.frames[currentMood] || PET.frames.blij;
    const frame = moodFrames[frameToggle ? 1 : 0];
    // If no frame data yet, fall back to scaffold note.
    if (!frame || !frame.length) {
      if (dom.petCanvas.children.length === 0) {
        dom.petCanvas.innerHTML =
          '<div class="scaffold-note">' +
            '<div class="big-emoji">🐱</div>' +
            '<div class="muted">Geen frames geladen…</div>' +
          '</div>';
      }
      return;
    }
    if (!petGrid) buildPetGrid();
    for (let r = 0; r < 16; r++) {
      const row = frame[r] || "";
      for (let c = 0; c < 16; c++) {
        const ch = row[c] || ".";
        const color = PET.palette[ch] || PET.palette["."];
        petPixels[r][c].style.backgroundColor = color;
      }
    }
  }

  /* ───────────── 8. STATIC DATA (scaffold) ───────────── */
  // Used by renderStats(). When the rework's POES data
  // is fully ported in, more constants will live here.
  const STAT_ICON = {
    hunger:    "🍎",
    happiness: "😊",
    energy:    "⚡",
    clean:     "🛁",
    learning:  "📚",
  };
  const STAT_LABEL = {
    hunger:    "Honger",
    happiness: "Blij",
    energy:    "Energie",
    clean:     "Schoon",
    learning:  "Slim",
  };

  /* ───────────── 9. INIT ───────────── */

  function init() {
    // Show "Continue" button if a save exists.
    const hasSave = localStorage.getItem(STORAGE_KEY);
    if (hasSave) {
      try {
        const saved = JSON.parse(hasSave);
        if (saved && saved.name) {
          dom.continueBtn.classList.remove("hidden");
          dom.continueName.textContent = saved.name;
        }
      } catch {}
    }

    // Sound toggle reflects saved state.
    if (dom.soundToggle) dom.soundToggle.checked = !!state.soundOn;

    // Wire buttons.
    dom.startBtn.addEventListener("click", tryStart);
    dom.continueBtn.addEventListener("click", continueOld);
    dom.resetBtn.addEventListener("click", resetAll);
    if (dom.resetBtnSettings) dom.resetBtnSettings.addEventListener("click", resetAll);
    if (dom.soundToggle) dom.soundToggle.addEventListener("change", () => {
      state.soundOn = dom.soundToggle.checked;
      saveState();
    });

    document.querySelectorAll(".action").forEach(btn => {
      btn.addEventListener("click", () => onAction(btn.dataset.action));
    });

    // Settings / Shop / Stickers modal open/close.
    dom.settingsBtn.addEventListener("click", () => dom.settingsModal.classList.remove("hidden"));
    dom.closeSettings.addEventListener("click", () => dom.settingsModal.classList.add("hidden"));
    dom.shopBtn.addEventListener("click", () => {
      // F4: real shop rendering. For now, show placeholder message.
      showBubble("🛍️ Het winkeltje komt zo!");
    });
    dom.stickersBtn.addEventListener("click", () => {
      // F5: real sticker rendering. For now, show placeholder message.
      showBubble("🏆 Het sticker-album komt zo!");
    });

    // Submit name on Enter.
    dom.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") tryStart();
    });

    // Close modals on backdrop tap.
    [dom.settingsModal, dom.shopModal, dom.stickersModal].forEach(m => {
      m.addEventListener("click", (e) => {
        if (e.target === m) m.classList.add("hidden");
      });
    });

    // Catch up stats from time spent away (no-guilt cap).
    applyOfflineDecay();
    // Reset today's vinkjes if a new day started while away.
    checkDayChange();

    // Stat decay loop — runs every second, gentle rates.
    setInterval(() => {
      tickDecay();
      renderStats();
    }, 1000);

    // Save on tab close so offline decay is accurate.
    window.addEventListener("beforeunload", saveState);

    // Day/night, refreshed every minute.
    applyTimeOfDay();
    setInterval(applyTimeOfDay, 60 * 1000);

    // Pet blink animation — toggle frame every 700ms.
    setInterval(() => {
      frameToggle = !frameToggle;
      paintPetFrame();
    }, 700);

    // Show game or intro depending on save.
    if (hasSave) continueOld();
    else render();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
