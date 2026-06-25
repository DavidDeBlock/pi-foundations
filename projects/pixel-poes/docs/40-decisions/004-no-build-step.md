# ADR-004: Pure HTML/JS, geen build, geen framework

**Status**: Accepted
**Date**: 2026-06-23
**Authors**: David

## Context

Het project is een virtueel huisdier-spel voor één kind, dat speelt op een tablet en telefoon. De vader gaf aan: "html, js is goed" — een voorkeur voor eenvoud boven een build-pipeline.

Binnen `pi-foundations` staan projecten met verschillende aanpakken: `cozy-ledger` is pure HTML/JS, `ZaakOs` is Astro. De keuze voor pixel-poes is bewust low-tech.

## Decision Drivers

- Een kindergame heeft geen framework nodig — geen complexe state, geen routering, geen server
- Een build-pipeline betekent dat iemand (de vader) `npm install` en `npm run dev` moet draaien om te testen — dat is een drempel
- De kat is het enige dier in v1; de data-laag is klein genoeg om in vanilla JS te leven
- Het prototype waar we op voortbouwen was ook pure HTML/JS, dus consistentie

## Decision

**Pixel Poes is pure HTML + CSS + vanilla JavaScript.** Geen:
- npm dependencies
- bundlers (geen Vite, geen Webpack, geen Parcel)
- transpilers (geen TypeScript, geen Babel)
- frameworks (geen React, geen Vue, geen Svelte)

**Bestandsstructuur:**
- `index.html` — entry point
- `styles.css` — alle styling
- `app.js` — state, loop, rendering
- `data/*.js` — gescheiden data-bestanden (kat, winkel, stickers, berichten)
- `docs/` — PRD, ADRs, plannen

`data/*.js` zijn gewone JS-bestanden die objecten exporteren naar de global scope (of via `<script>` tags worden ingeladen). Ze zijn géén ES modules — geen `import`/`export` syntax — om geen module-bundler nodig te hebben.

## Consequences

**Positief:**
- Openen in de browser = werkt. Geen installatie, geen build
- Triviale deployment (statische files hosten, of zelfs file:// openen)
- Eenvoudiger te debuggen — wat je ziet in DevTools is wat er is
- Kleiner risico op breakage door toolchain-updates

**Negatief:**
- Geen type-safety — bugs moeten we via testing vangen
- Geen code-splitting — alle JS laadt in één keer (maar voor v1 is dat geen probleem)
- Lastiger om te refactoren naarmate het groeit — als v2/3 groter worden, kan dit herzien worden

## Follow-up

- Indien het project substantieel groeit (v3+): herevaluatie. Misschien alsnog een lichte build (Vite, geen TypeScript) om dev-ervaring te verbeteren zonder de deployment eenvoud te verliezen.
