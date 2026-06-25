/* ─────────────────────────────────────────────
   Pixel Poes – shop.js
   Catalog of 6 items for v1.

   Item kinds:
     - 'background' : tints the stage via a CSS class
     - 'deco'       : shows an emoji overlay on/near the cat
     - 'consumable' : one-shot use, applies `effect` on purchase

   Adding a new item:
     1. Pick a unique id.
     2. Choose kind and (for deco/background) a CSS class.
     3. For consumables, define `effect` as { stat, amount }.
     4. For consumables, add a short `desc`.
   ───────────────────────────────────────────── */

(function (global) {
  "use strict";

  const SHOP = [
    // 2 achtergrond-skins
    {
      id: "bg_beach",
      name: "Strand",
      emoji: "🏖️",
      cost: 15,
      kind: "background",
      cls: "bg-beach",
      desc: "Zacht zand en een koel briesje",
    },
    {
      id: "bg_forest",
      name: "Bos",
      emoji: "🌳",
      cost: 15,
      kind: "background",
      cls: "bg-forest",
      desc: "Tussen de bomen en vogeltjes",
    },

    // 2 outfits/decoraties voor de kat
    {
      id: "hat_party",
      name: "Feesthoed",
      emoji: "🎩",
      cost: 10,
      kind: "deco",
      cls: "hat",
      desc: "Hoera! Poes is jarig",
    },
    {
      id: "bow_pink",
      name: "Roze strik",
      emoji: "🎀",
      cost: 8,
      kind: "deco",
      cls: "bow",
      desc: "Een schattige strik om de nek",
    },

    // 2 speciale spullen (consumables)
    {
      id: "snack_fav",
      name: "Lievelingssnack",
      emoji: "🍰",
      cost: 12,
      kind: "consumable",
      effect: { stat: "hunger", amount: 60 },
      desc: "Vult heel veel honger in één keer",
    },
    {
      id: "toy_magic",
      name: "Magisch speeltje",
      emoji: "✨",
      cost: 18,
      kind: "consumable",
      effect: { stat: "happiness", amount: 60 },
      desc: "Maakt Poes heel erg blij",
    },
  ];

  global.SHOP = SHOP;
})(window);
