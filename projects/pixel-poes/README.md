# Pixel Poes

Een virtueel huisdier-spel in de browser, gemaakt voor een 11-jarig meisje met autisme. Pure HTML/CSS/JavaScript, geen build, geen dependencies.

## Wat is het?

Een kat die je verzorgt: voeden, spelen, wassen, slapen. Een winkeltje waar je spullen koopt. Een sticker-album om te vullen. Een streak die je terugkomst beloont.

Het is bewust simpel, voorspelbaar en zacht. Geen timer, geen "goed/fout", geen verdrietige emoties. Thuis is een veilige plek.

## Hoe draai je het

Open `index.html` in een moderne browser (Chrome, Safari, Firefox). Dat is alles — geen `npm install`, geen build, geen server.

**Voor de tablet/telefoon:** start een lokale server vanuit deze folder:

```
python3 -m http.server 8002
```

De dev-server draait dan op `http://localhost:8002` (pc) en `http://<ip-van-deze-pc>:8002` (andere apparaten op hetzelfde netwerk).

### Firewall (eenmalig, alleen voor tablet/telefoon)

Om de server vanaf een ander apparaat te bereiken moet poort 8002 open in UFW:

```
sudo ufw allow 8002/tcp comment "Pixel Poes dev server"
sudo ufw status
```

Alleen TCP — HTTP gebruikt geen UDP. De regel laat alleen verkeer op poort 8002 toe; al het andere op die poort is dicht. `ufw status` na afloop zou iets moeten tonen als:

```
8002/tcp                   ALLOW       Anywhere                   # Pixel Poes dev server
```

Verwijderen kan later met `sudo ufw delete allow 8002/tcp`.

## Status

**v1 in scaffolding.** De huidige staat is een werkend geraamte:

- ✅ Intro-scherm werkt (naam geven, doorgaan)
- ✅ Game-scherm toont de volledige layout (topbar, stage, stats, acties, dagoverzicht, winkeltje/stickers-knoppen, settings)
- ✅ Modals openen en sluiten
- ✅ Stats en dag-vinkjes worden gerenderd uit state
- ✅ Dag/nacht-tint past zich aan de klok aan
- ✅ localStorage slaat naam en progressie op
- ✅ Pixel-kat rendert (16×16, met blink)
- ⏳ Actie-knoppen tonen bubbels, muteren nog geen state
- ⏳ Winkeltje, stickers, streak-mechaniek volgen in de komende iteraties

Zie `docs/CONTEXT.md` voor het projectdoel, `docs/35-prds/PRD-001-v1-mvp.md` voor de v1-specificatie, en `docs/40-decisions/` voor de ontwerpkeuzes.

## Projectstructuur

```
pixel-poes/
├── index.html              entry point — alle UI
├── styles.css              alle styling, mobile-first
├── app.js                  state, render, flow (scaffold)
├── data/
│   ├── pet-kat.js          pixel-art kat (palet + frames — STUB)
│   ├── shop.js             winkel-catalogus (6 items)
│   ├── stickers.js         5 stickers + ontgrendel-voorwaarden
│   └── messages.js         Nederlandse bubbel-teksten
├── docs/
│   ├── CONTEXT.md          projectdoel & niet-doelen
│   ├── 30-plans/
│   │   └── v1.md           v1 feature-plan
│   ├── 35-prds/
│   │   └── PRD-001-v1-mvp.md
│   └── 40-decisions/
│       ├── 001-single-cat-v1.md
│       ├── 002-positive-mood-only.md
│       ├── 003-no-background-music.md
│       └── 004-no-build-step.md
└── README.md
```

## Taal

De UI is volledig **Nederlands**. Dat is de taal van de speelcontext.

## Bron-materiaal

Het visuele gevoel en de kat-frames komen voort uit een eerder prototype in `/mnt/ai-share/mini-games/pixelpoes/`. De pixel-art voor de kat staat in `/mnt/ai-share/mini-games/pixelpoes/rework/pets.js` (entry `POES`) en moet in de volgende iteratie naar `data/pet-kat.js` worden geport.
