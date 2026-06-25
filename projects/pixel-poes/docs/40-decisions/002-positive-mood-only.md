# ADR-002: Geen verdrietige emoties bij het dier

**Status**: Accepted
**Date**: 2026-06-23
**Authors**: David

## Context

Het oorspronkelijke `script.js` prototype bevatte meerdere "negatieve" moods voor de kat: `hungry`, `tired`, `dirty`, `sad`. De state van het dier kon ook echt in een "verdrietig" gezicht resulteren, inclusief ASCII-art met hangende oogjes en een sippe mond.

Onze doelgroep is een kind van 11 met autisme dat het zwaar heeft op school. De spelcontext is **thuis**, niet school. Dat is precies de plek waar de wereld veilig en zacht moet zijn.

## Decision Drivers

- Thuis is anti-school — geen plek voor extra emotionele last
- Een huisdier-spel met verdrietige emoties kan onbedoeld spiegelen wat ze op school voelt
- Het spel moet een "zachte plek" zijn, geen extra bron van stress
- De feedback mag nog steeds duidelijk zijn (laat weten dat het dier aandacht nodig heeft), maar dan in positieve bewoordingen

## Decision

**Het dier toont nooit een verdrietig, bang, of boos gezicht.** Ook niet als een stat laag is. De states `sad` en `dirty` (met bijbehorende gezichten) worden geschrapt uit het mood-systeem.

In plaats daarvan, bij lage stats:
- Honger: bubbel "Poes heeft trek! Zal ik wat eten?" — uitnodiging, niet klacht
- Energie: bubbel "Poes is een beetje moe…" — neutraal observerend
- Schoon: bubbel "Tijd voor een badje!" — actie-gericht
- Blij: bubbel "Zullen we spelen?" — actie-gericht
- Slim: bubbel "Weet je wat? Ik wil wel iets nieuws leren." — actie-gericht

Het dier is altijd blij als ze terugkomt. Geen "ik heb je gemist!" met schuldgevoel. Geen "ben je boos op me?" als ze even weg was.

## Consequences

**Positief:**
- De spelcontext is consistent voorspelbaar en warm
- Geen risico op emotionele spiegeling van school-ervaringen
- Het dier voelt als een vriend die hulp vraagt, niet als een zeurend dier

**Negatief:**
- De variatie in pet-gezichten is kleiner — minder "dialoog" via het uiterlijk van het dier
- We moeten actiever via bubbels communiceren wat de kat nodig heeft

## Follow-up

- Bij fase 2/3 (boek-actie, avontuur): opnieuw evalueren of er "emoties" nodig zijn dieper dan blij/neutraal/slapend. Tot dan: alleen de zachte kant.
