# ADR-003: Geen achtergrondmuziek, geluid is opt-in

**Status**: Accepted
**Date**: 2026-06-23
**Authors**: David

## Context

Veel kindergames bevatten continue achtergrondmuziek en vele geluidseffecten bij elke actie. Voor een kind met autisme kan dit overweldigend zijn — geluidsgevoeligheid is een veelvoorkomende comorbiditeit.

De vader gaf aan: "Don't overdo in sound." Dat is een directe aanwijzing dat we hier voorzichtig moeten zijn.

## Decision Drivers

- Zintuiglijke rust is een kernprincipe
- Geen aanname over geluidsgevoeligheid — we maken het niet standaard aanwezig
- Het spel speelt zich af in een thuis-context waar het geluid van anderen in het huishouden kan botsen met spelgeluid
- Als ze geluid wél wil, moet ze dat zelf kunnen aanzetten

## Decision

**Standaard: stil.** Geen achtergrondmuziek. Geen ambient-geluid. Het spel opent in stilte.

**Opt-in geluidspakket** (max 5-6 korte samples), alleen beschikbaar als ze het zelf aanzet:
- Zachte "pop" op knoppen
- Korte miauw bij voeden
- Korte "splash" bij wassen
- Zachte "zZ" bij slapen
- Korte fanfare bij level-up

Geen sample langer dan 1 seconde. Volume standaard op 50%. Een tandwiel-icoon rechtsboven opent een instellingen-paneel met de geluid-toggle.

## Consequences

**Positief:**
- Voorspelbaar en rustig — geen onverwachte audio-overlast
- Respecteert de thuis-context
- Geeft haar controle — als ze geluid wil, kan het, maar het is haar keuze

**Negatief:**
- Het spel voelt minder "levend" voor wie gewend is aan kindergames met veel audio
- We missen een emotie-laag die audio kan geven (bijv. een vrolijk deuntje bij level-up)

## Follow-up

- Evalueren na een paar weken spelen: heeft ze het geluid aangezet? Vindt ze de samples leuk? Op basis daarvan uitbreiden of juist minimaliseren
- In fase 2+ (boek, avontuur): per feature afzonderlijk bekijken of geluid zinvol is
