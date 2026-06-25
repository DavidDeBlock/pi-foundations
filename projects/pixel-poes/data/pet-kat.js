/* ─────────────────────────────────────────────
   Pixel Poes – pet-kat.js
   Pixel-art data for the cat.

   Source: /mnt/ai-share/mini-games/pixelpoes/rework/pets.js
   (entry: POES). Ported here as the v1 single-pet
   dataset.

   The `sad` mood from the source is intentionally
   excluded (see ADR-002: no sad emotions).

   Frame convention:
     - 16 rows × 16 chars per frame
     - " " or "." = transparent
     - uppercase letter = palette color
   ───────────────────────────────────────────── */

(function (global) {
  "use strict";

  const PET = {
    id: "poes",
    name: "Poes",
    kind: "Kat",
    defaultName: "Poes",
    palette: {
      " ": "transparent",
      ".": "transparent",
      O: "#3a2a1f",  // outline
      B: "#ffb98a",  // body
      S: "#e08a55",  // shadow
      W: "#fff5e8",  // white (chest/cheeks)
      E: "#2a1a10",  // eye
      P: "#ff8aa0",  // pink (nose/ears)
    },
    // Per-mood Dutch messages. The bubble system
    // (F4) will pick from these.
    messages: {
      blij:     ["Miauw!", "Ik ben blij!", "Knuffel?", "Zachtjes spinnen…"],
      hongerig: ["Ik heb trek! Zal ik wat eten?", "Is er eten?", "Lekker hongerig!"],
      slaperig: ["Ik ben een beetje moe…", "Even rusten?", "Mag ik slapen?"],
      neutraal: ["Hallo!", "Ik ben hier.", "Zachtjes spinnen…"],
    },
    // 4 v1-moods × 2 frames each.
    // `neutraal` reuses `blij`'s frames — the mood
    // system (F4) chooses between them by game state.
    frames: {
      blij: [
        [
          "................",
          "..OOOOOOOOOOOO..",
          ".OPPOOOOOOOOPPO.",
          ".OPPOOOOOOOOPPO.",
          ".OOO........OOO.",
          ".OOO..E..E..OOO.",
          ".OOO..EEEE..OOO.",
          ".OOO..E..E..OOO.",
          ".OOO..PPPP..OOO.",
          ".OOO.OOPPOO.OOO.",
          ".OOO.OOOOOO.OOO.",
          ".OOO..WWWW..OOO.",
          ".OOO..WWWW..OOO.",
          ".OOOO..WW..OOOO.",
          ".SSS.........SSS",
          "..SS..........SS",
        ],
        [
          "................",
          "..OOOOOOOOOOOO..",
          ".OPPOOOOOOOOPPO.",
          ".OPPOOOOOOOOPPO.",
          ".OOO........OOO.",
          ".OOO..EEEE..OOO.",
          ".OOO..........OO",
          ".OOO..........OO",
          ".OOO..PPPP..OOO.",
          ".OOO.OOPPOO.OOO.",
          ".OOO.OOOOOO.OOO.",
          ".OOO..WWWW..OOO.",
          ".OOO..WWWW..OOO.",
          ".OOOO..WW..OOOO.",
          ".SSS.........SSS",
          "..SS..........SS",
        ],
      ],
      neutraal: [
        [
          "................",
          "..OOOOOOOOOOOO..",
          ".OPPOOOOOOOOPPO.",
          ".OPPOOOOOOOOPPO.",
          ".OOO........OOO.",
          ".OOO..E..E..OOO.",
          ".OOO..EEEE..OOO.",
          ".OOO..E..E..OOO.",
          ".OOO..PPPP..OOO.",
          ".OOO.OOPPOO.OOO.",
          ".OOO.OOOOOO.OOO.",
          ".OOO..WWWW..OOO.",
          ".OOO..WWWW..OOO.",
          ".OOOO..WW..OOOO.",
          ".SSS.........SSS",
          "..SS..........SS",
        ],
        [
          "................",
          "..OOOOOOOOOOOO..",
          ".OPPOOOOOOOOPPO.",
          ".OPPOOOOOOOOPPO.",
          ".OOO........OOO.",
          ".OOO..EEEE..OOO.",
          ".OOO..........OO",
          ".OOO..........OO",
          ".OOO..PPPP..OOO.",
          ".OOO.OOPPOO.OOO.",
          ".OOO.OOOOOO.OOO.",
          ".OOO..WWWW..OOO.",
          ".OOO..WWWW..OOO.",
          ".OOOO..WW..OOOO.",
          ".SSS.........SSS",
          "..SS..........SS",
        ],
      ],
      hongerig: [
        [
          "................",
          "..OOOOOOOOOOOO..",
          ".OPPOOOOOOOOPPO.",
          ".OPPOOOOOOOOPPO.",
          ".OOO........OOO.",
          ".OOO.E....E.OOO.",
          ".OOO.E....E.OOO.",
          ".OOO........OOO.",
          ".OOO..PPPP..OOO.",
          ".OOO.OOPPOO.OOO.",
          ".OOO.OOOOOO.OOO.",
          ".OOO..PPPP..OOO.",
          ".OOO..PPPP..OOO.",
          ".OOOO..PP..OOOO.",
          ".SSS.........SSS",
          "..SS..........SS",
        ],
        [
          "................",
          "..OOOOOOOOOOOO..",
          ".OPPOOOOOOOOPPO.",
          ".OPPOOOOOOOOPPO.",
          ".OOO........OOO.",
          ".OOO.E....E.OOO.",
          ".OOO..E..E..OOO.",
          ".OOO........OOO.",
          ".OOO..PPPP..OOO.",
          ".OOO.OOPPOO.OOO.",
          ".OOO.OOOOOO.OOO.",
          ".OOO..PPPP..OOO.",
          ".OOO..PPPP..OOO.",
          ".OOOO..PP..OOOO.",
          ".SSS.........SSS",
          "..SS..........SS",
        ],
      ],
      slaperig: [
        [
          "................",
          "..OOOOOOOOOOOO..",
          ".OPPOOOOOOOOPPO.",
          ".OPPOOOOOOOOPPO.",
          ".OOO........OOO.",
          ".OOO.EE...EE.OOO",
          ".OOO..........OO",
          ".OOO..........OO",
          ".OOO..PPPP..OOO.",
          ".OOO.OOPPOO.OOO.",
          ".OOO.OOOOOO.OOO.",
          ".OOO..WWWW..OOO.",
          ".OOO..WWWW..OOO.",
          ".OOOO..WW..OOOO.",
          ".SSS.........SSS",
          "..SS..........SS",
        ],
        [
          "................",
          "..OOOOOOOOOOOO..",
          ".OPPOOOOOOOOPPO.",
          ".OPPOOOOOOOOPPO.",
          ".OOO........OOO.",
          ".OOO..EEEE...OOO",
          ".OOO..........OO",
          ".OOO..........OO",
          ".OOO..PPPP..OOO.",
          ".OOO.OOPPOO.OOO.",
          ".OOO.OOOOOO.OOO.",
          ".OOO..WWWW..OOO.",
          ".OOO..WWWW..OOO.",
          ".OOOO..WW..OOOO.",
          ".SSS.........SSS",
          "..SS..........SS",
        ],
      ],
    },
  };

  global.PET = PET;
})(window);
