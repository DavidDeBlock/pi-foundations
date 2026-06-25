# [PRD] Pixel Poes v1 — Minimal Viable Play

**Labels**: `parent-prd`
**Date**: 2026-06-23
**Status**: Draft

## Problem Statement

Een vader wil een virtueel huisdier-spel maken voor zijn 11-jarige dochter. Ze heeft autisme en heeft het zwaar op school. Het spel moet een zachte, voorspelbare plek zijn waar ze graag terugkomt — niet schools, niet prestatiegericht, niet overweldigend.

Er ligt een werkend prototype in `/mnt/ai-share/mini-games/pixelpoes/` (Pixel Poes v1, ASCII) en een experimentele 16×16 pixel-versie in `rework/`. Geen van beide is af of speelbaar in de definitieve zin — het v1-prototype is te basaal (geen shop-uitbreiding, geen sticker-album, geen dag-nacht), de rework is nog niet af.

Het doel: een speelbare v1 die de kern-loop (verzorgen + winkeltje) werkend heeft, in pure HTML/JS zonder build, mobile-first, met de kat als enige dier.

## Solution

**Pixel Poes v1** — een single-page webapplicatie met:

- **Eén kat** als virtueel huisdier, weergegeven als 16×16 pixel-art met meerdere mood-frames
- **5 stats** die langzaam dalen over tijd: honger, blij, energie, schoon, slim
- **4 verzorg-acties** die stats verhogen: voeden, spelen, wassen, slapen
- **Een winkeltje** met 6 items: achtergronden, outfits, speciale spullen — dit is haar favoriete onderdeel
- **Een sticker-album** van 5 stickers als verzameldoel op middellange termijn
- **Dag/nacht-tint** als decoratieve achtergrond die meebeweegt met de klok
- **Een streak** die zachtjes terugkomst beloont, nooit straft
- **Settings** voor geluid-toggle en opnieuw beginnen
- **Alles in localStorage**, één save per browser

Thuis is anti-school. Geen timer, geen goed/fout, geen verdrietige emoties bij het dier. Het dier is altijd blij als ze terugkomt.

## User Stories

1. Als kind wil ik de kat een naam kunnen geven bij de eerste keer dat ik het spel open, zodat het voelt als mijn eigen huisdier.
2. Als kind wil ik de kat zien in het midden van het scherm, zodat ik altijd weet waar hij is.
3. Als kind wil ik op een "voeden"-knop kunnen tikken en zien dat de honger-bar stijgt, zodat ik weet dat het werkt.
4. Als kind wil ik op een "spelen"-knop kunnen tikken en zien dat de blij-bar stijgt, zodat spelen effect heeft.
5. Als kind wil ik op een "wassen"-knop kunnen tikken en zien dat de schoon-bar stijgt, zodat de kat schoner wordt.
6. Als kind wil ik op een "slapen"-knop kunnen tikken en zien dat de energie-bar stijgt, zodat de kat uitrust.
7. Als kind wil ik zien dat de stat-bars langzaam dalen als ik niks doe, zodat het dier levend voelt.
8. Als kind wil ik zien dat de kat een ander gezicht krijgt als een stat laag is, zodat ik weet wat hij nodig heeft.
9. Als kind wil ik een bubbel zien met een korte Nederlandse zin als ik op een knop tik, zodat de kat "terugpraat".
10. Als kind wil ik dat die bubbel positief is, ook als ik iets verkeerd doe, zodat ik me niet slecht voel.
11. Als kind wil ik zien dat de kat nooit verdrietig kijkt, ook niet als ik een tijd niet heb gespeeld, zodat ik me geen zorgen hoef te maken.
12. Als kind wil ik het spel kunnen openen op mijn tablet en op mijn telefoon, zodat ik overal kan spelen.
13. Als kind wil ik dat het spel op een klein scherm prettig speelt, zodat ik niet hoef te scrollen of te knijpen.
14. Als kind wil ik een winkeltje kunnen openen, zodat ik kan zien wat er te koop is.
15. Als kind wil ik items in het winkeltje kunnen kopen met munten, zodat ik kan sparen en besteden.
16. Als kind wil ik een outfit die ik koop direct op de kat zien, zodat het effect zichtbaar is.
17. Als kind wil ik een achtergrond die ik koop direct in de stage zien, zodat de kat in een andere setting staat.
18. Als kind wil ik speciale spullen kunnen kopen en gebruiken voor een groter effect, zodat ik een reden heb om munten te sparen.
19. Als kind wil ik zien hoeveel munten ik heb, zodat ik weet wat ik kan kopen.
20. Als kind wil ik zien wat ik vandaag al heb gedaan, zodat ik weet waar ik ben.
21. Als kind wil ik een sticker-album kunnen openen, zodat ik kan zien welke stickers ik al heb.
22. Als kind wil ik dat een sticker automatisch verschijnt als ik iets bijzonders heb gedaan, zodat ik niet hoef te "claimen".
23. Als kind wil ik zien dat de kat af en toe een level omhoog gaat, zodat er vooruitgang is.
24. Als kind wil ik een streak zien die optelt als ik elke dag terugkom, zodat terugkomen beloond wordt.
25. Als kind wil ik niet gestraft worden als ik een dag oversla, zodat het geen verplichting voelt.
26. Als kind wil ik het spel sluiten en de volgende dag terugkomen met mijn voortgang intact, zodat ik niet alles kwijt ben.
27. Als kind wil ik de achtergrond van kleur zien veranderen afhankelijk van het tijdstip, zodat het dag en nacht voelt.
28. Als kind wil ik in een instellingen-paneel geluid aan of uit kunnen zetten, zodat ik zelf kies of het spel geluid maakt.
29. Als kind wil ik in een instellingen-paneel opnieuw kunnen beginnen, zodat ik een nieuwe kat kan maken als ik dat wil.
30. Als kind wil ik dat het spel geen geluid maakt als ik het open, zodat het niet schrikt of stoort.
31. Als kind wil ik snappen wat elke knop doet zonder uitleg, zodat ik zelfstandig kan spelen.
32. Als ouder wil ik niet dat het spel schools aanvoelt, zodat mijn dochter thuis geen tweede "school" ervaart.
33. Als ouder wil ik niet dat het spel mijn dochter emotioneel belast, zodat het een veilige plek blijft.
34. Als ouder wil ik het spel kunnen testen in mijn browser zonder iets te installeren, zodat de drempel laag is.

## Implementation Decisions

- **Tech-stack**: pure HTML + CSS + vanilla JavaScript. Geen npm dependencies, geen bundler, geen framework. Eén `index.html` als entry point, `styles.css` voor alle styling, `app.js` voor state en rendering. Data-laag in `data/*.js` als gewone JS-bestanden (geen ES modules — vermijdt module-bundler). Zie ADR-004.

- **State-vorm**: één centraal `state`-object in `app.js`, gemirrord naar `localStorage` onder sleutel `pixelpoes.v1`. Migratie-strategie: bij het laden, merge met defaults zodat nieuwe velden niet breken op oude saves.

- **Render-loop**: tick elke 250ms. Past decay toe, muteert state, rendert. Niet requestAnimationFrame voor v1 — 4 fps is ruim voldoende en bespaart CPU op tablets.

- **Pixel-kat**: 16×16 frames uit `rework/pets.js` (palet `POES`). Frames als arrays van strings met characters per pixel-kleur. We exporteren minimaal 4 moods × 2 frames.

- **Mood-systeem**: deterministisch. Geen random. Het laagste stat (mits onder 50) bepaalt de mood. Boven 50: "happy". Bij slaap: "sleeping" override. Geen `sad` of `dirty` mood in de staat — zie ADR-002.

- **Winkeltje**: items gedefinieerd in `data/shop.js`. Catalog van 6 items, statisch in v1. Aankoop-flow: klik → als genoeg munten → muntjes af → in inventaris. Toepassen: klik op bezit item → toggle actief. Consumables (lievelingssnack, magisch speeltje) worden direct gebruikt bij aankoop (eenmalig effect).

- **Sticker-album**: voorwaarden zijn pure functies over state. Geen "claim"-knop. Bij elke state-mutatie herberekenen of een nieuwe sticker ontgrendeld is. Album is een tweede scherm (modal) met 5 vakken.

- **Dag/nacht**: pure CSS classes op de stage-container. `app.js` zet de class op basis van `Date.getHours()`. Vier zones, geen overlap met andere systemen.

- **Streak**: dag-key zoals `YYYY-MM-DD`. Bij eerste opening op een nieuwe dag: +1. Twee+ dagen overslaan → reset naar 1. Geen negatieve meldingen — zachte, altijd-vriendelijke teksten.

- **Settings**: kleine modal met drie items: geluid-toggle, opnieuw beginnen, over. Geen theme-switcher, geen accounts, niets anders.

- **Intro-scherm**: bij geen save → alleen naam-invoer. Bij bestaande save → "Doorgaan met [naam]" prominent + "Opnieuw beginnen" klein.

- **Mobile-first CSS**: één media query voor `min-width: 480px` om layout iets wijder te zetten op tablets. Verder alles fluid in `clamp()` of `vw`-eenheden. Touch-targets minimaal 48×48 px.

- **Kleurenpalet**: pastel-thema (warme room, zachte oranje, diep bruin voor tekst). Overgenomen van het bestaande prototype. Geen harde kleuren, geen puur wit, geen puur zwart.

## Testing Decisions

In v1 testen we **handmatig in de browser** — geen test-framework, geen CI. We testen door:

1. **Een schone browser-sessie openen** (incognito) en doorlopen: naam geven → kat verschijnt → acties werken → winkel kopen → sticker verdienen → refreshen → voortgang hersteld
2. **localStorage inspecteren** in DevTools: controleren dat de staat klopt na elke actie
3. **Een week lang dagelijks openen**: streak moet netjes doorlopen, dag-nacht moet op verschillende tijden andere tint tonen
4. **Testen op telefoon en tablet**: niets mag buiten het scherm vallen, knoppen moeten goed tappen
5. **Testen met geluid uit én aan**: alle interacties visueel duidelijk, ook zonder audio

Toekomstige v2+: als het project groeit, kan dit herzien worden naar Vitest + Playwright, vergelijkbaar met andere projecten in `pi-foundations`.

## Out of Scope

- Andere dieren dan de kat — pas in v2+
- "Mijn kamer"-scherm / kamers inrichten — pas in v2+
- "Boek"-actie / dierenweetjes / leermini-games — pas in v3
- Avontuur-mini-game — pas in v3
- Achtergrondmuziek — nooit
- Meerdere save-files — niet nodig
- Delen / screenshots / leaderboards — niet nodig
- Cloud-save / account-systeem — niet nodig
- Internationalisatie — Nederlandse UI is voldoende

## Further Notes

- Het prototype waar we op voortbouwen is `/mnt/ai-share/mini-games/pixelpoes/`. De pixel-frames van de kat staan in `/mnt/ai-share/mini-games/pixelpoes/rework/pets.js` (entry `POES`).
- Voor v2+ is de roadmap (los van deze PRD): tweede dier introduceren via "asiel"-flow, kamerscherm, sticker-album uitbreiden, "boek"-actie.
- De verzorg-mechaniek is een directe port vanuit `/mnt/ai-share/mini-games/pixelpoes/script.js`. Veel logica (DECAY constanten, mood-functie, actie-effecten) kan 1-op-1 overgenomen worden, met aanpassing: `sad`/`dirty` moods eruit (zie ADR-002), ASCII vervangen door pixel-rendering.
