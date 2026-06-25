/* ─────────────────────────────────────────────
   Pixel Poes – stickers.js
   5 stickers, each with a pure-function condition.

   Conditions are checked automatically by app.js
   after every state mutation. There is no "claim"
   button — stickers appear when earned.

   Adding a new sticker:
     1. Pick a unique id.
     2. Write `unlocked(state)` as a pure function.
     3. Keep the description concrete and friendly.
   ───────────────────────────────────────────── */

(function (global) {
  "use strict";

  const STICKERS = [
    {
      id: "welcome",
      name: "Welkom",
      emoji: "👋",
      desc: "Je kat heeft een naam gekregen",
      unlocked: (state) => !!state.name && state.name !== "Poes" || (state.name === "Poes" && state.streak >= 1),
      // Note: 'Poes' counts as named if the player kept the default.
      // The condition above is intentionally generous: any saved name counts.
    },
    {
      id: "good_carer",
      name: "Goede verzorger",
      emoji: "💛",
      desc: "Alle 4 acties gedaan op één dag",
      unlocked: (state) => {
        const t = state.todayActions || {};
        return t.feed && t.play && t.wash && t.sleep;
      },
    },
    {
      id: "streak_3",
      name: "Drie-dagen-streak",
      emoji: "🔥",
      desc: "Drie dagen achter elkaar gespeeld",
      unlocked: (state) => (state.streak || 0) >= 3,
    },
    {
      id: "shining",
      name: "Stralend",
      emoji: "✨",
      desc: "Alle 5 stats boven 70 op één moment",
      unlocked: (state) => {
        const s = state.stats || {};
        return s.hunger    > 70
            && s.happiness > 70
            && s.energy    > 70
            && s.clean     > 70
            && s.learning  > 70;
      },
    },
    {
      id: "big_cat",
      name: "Grote kat",
      emoji: "🌟",
      desc: "Je kat is level 3",
      unlocked: (state) => (state.level || 0) >= 3,
    },
  ];

  global.STICKERS = STICKERS;
})(window);
