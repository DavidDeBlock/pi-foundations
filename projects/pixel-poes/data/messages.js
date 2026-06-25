/* ─────────────────────────────────────────────
   Pixel Poes – messages.js
   Dutch messages for bubbles, moods, and tips.

   All copy is intentionally short, concrete, and
   positive. There are no "sad" / "angry" / "guilt"
   messages — see ADR-002.
   ───────────────────────────────────────────── */

(function (global) {
  "use strict";

  // After-action bubbles, keyed by action name.
  const ACTIONS = {
    feed:  { msg: ["Lekker!", "Mmm, bedankt!", "Smullen!", "Dat smaakt!"] },
    play:  { msg: ["Haha, leuk!", "Nog een keer!", "Wat spannend!", "Jij bent grappig!"] },
    wash:  { msg: ["Heerlijk schoon!", "Spetter!", "Blink!", "Zo fris!"] },
    sleep: { msg: ["Droomland…", "Slaap lekker.", "Zzz…", "Tot zo!"] },
  };

  // Per-stat tips. The mood system picks `low` when
  // the stat is below 50, otherwise `ok`.
  const STAT_TIPS = {
    hunger:    { low: "Ik heb trek. Zal ik wat eten?", ok: "Lekker vol!" },
    happiness: { low: "Zullen we spelen?",            ok: "Wat ben ik blij!" },
    energy:    { low: "Ik ben een beetje moe…",       ok: "Vol energie!" },
    clean:     { low: "Tijd voor een badje!",         ok: "Blinkend schoon!" },
    learning:  { low: "Weet je wat? Ik wil iets nieuws leren.", ok: "Ik word slimmer!" },
  };

  // Random bubble phrases per mood.
  const MOOD_BUBBLES = {
    happy:   ["Hallo!", "Ik ben blij.", "Jij bent lief.", "Dankjewel!"],
    excited: ["Woehoe!", "Dit is leuk!", "Nog een keer!"],
    hungry:  ["Ik heb trek. Zal ik wat eten?", "Is er iets te eten?", "Mmm, snacken?"],
    tired:   ["Ik ben een beetje moe…", "Even rusten?", "Mag ik slapen?"],
    nudge:   ["Zullen we wat doen?", "Waar zin in?", "Kies maar!"],
    sleep:   ["Zzz…", "Slaap lekker…", "Droom zacht…"],
    levelup: ["Nieuw level!", "We worden groot!", "Trots op jou!"],
  };

  // Streak and welcome phrases.
  const STREAK = {
    continuing:  "Dag {n} streak! 🔥",
    welcomeBack: "Welkom terug! 🔥",
    firstTime:   "Welkom! 💛",
  };

  // Shop and stickers.
  const SHOP = {
    cantAfford:   "Nog niet genoeg 🪙",
    bought:       "{emoji} {name} is van jou!",
    equipped:     "{emoji} {name} aan!",
    unequipped:   "{name} uit",
    consumed:     "{emoji} {name} gebruikt!",
  };

  const STICKERS = {
    unlocked: "Nieuwe sticker: {emoji} {name}!",
  };

  global.MESSAGES = {
    ACTIONS, STAT_TIPS, MOOD_BUBBLES, STREAK, SHOP, STICKERS,
  };
})(window);
