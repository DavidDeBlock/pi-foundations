# ADR-001: Eén dier (de kat) in v1

**Status**: Accepted
**Date**: 2026-06-23
**Authors**: David

## Context

Het oorspronkelijke prototype toonde meerdere dieren (in `zoo.html`: kat, hond, vis, vogel, konijn, vos, uil, draak) en in `rework/pets.js` was een multi-dier data-structuur voorbereid. Een natuurlijke vraag was dan ook: beginnen we v1 met één dier of meteen met meerdere?

De doelgroep is één specifiek kind van 11 met autisme, dat het leukst vindt om te verzorgen en in te richten. Ze speelt alleen, in korte dagelijkse sessies. Kat is haar favoriete dier.

## Decision Drivers

- Voorspelbaarheid is een kernprincipe — meerdere dieren tegelijk kan snel "te veel" worden voor een kind dat houdt van overzichtelijke loops
- Kat is háár favoriet — als we meerdere dieren als start-keuze presenteren, is de kat slechts één van de opties
- Verzorging + winkeltje is de kern — die kunnen prima met één dier werken
- Scope-discipline: één dier betekent minder code, minder sprites, minder edge-cases in v1

## Decision

**v1 bevat precies één dier: de kat.** De kat is niet een "keuze uit meerdere" — het is de kat, punt. Ze geeft de kat een naam en dat is haar huisdier.

Het winkeltje bevat wel meerdere aankopen (achtergronden, outfits, speciale spullen), maar geen "andere dieren kopen".

## Consequences

**Positief:**
- Voorspelbaar en gericht — geen keuzestress bij de start
- De kat is "haar" dier, niet één van de velen
- Minder code in v1: één palet, één set frames, één mood-set
- Sneller speelkaar

**Negatief:**
- "Dieren verzamelen" als motivatie valt weg voor v1 — komt pas in een latere fase
- Het oorspronkelijke multi-dier data-model uit `rework/pets.js` is niet 1-op-1 bruikbaar; we beginnen met één dier en ontwerpen de data-laag zó dat uitbreiding later mogelijk blijft

## Follow-up

- v2+: tweede dier introduceren, op een manier die voorspelbaar is (bijvoorbeeld "na X dagen streak komt er een nieuw dier in het asiel")
- De pixel-frames van andere dieren uit `rework/pets.js` (konijn, hamster) zijn beschikbaar als startpunt wanneer we uitbreiden
