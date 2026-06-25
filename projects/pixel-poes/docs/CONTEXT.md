# Pixel Poes — Project Context

## Wat is dit

Een virtueel huisdier-spel in de browser, gemaakt voor de dochter van de auteur (11 jaar). Het is een vervolg op een eerder prototype (`/mnt/ai-share/mini-games/pixelpoes/`) en richt zich op één dier: een pixel-art kat die je verzorgt, aankleedt en inricht.

## Voor wie

Eén kind — niet "kids" als abstracte doelgroep. Ze is 11, heeft autisme, en heeft het zwaar op school. Ze speelt het spel alleen, op een tablet en telefoon, in korte dagelijkse sessies. Kat is haar favoriete dier.

Dat stuurt elke ontwerpbeslissing in dit project:

- **Thuis is anti-school** — geen timer, geen goed/fout, geen prestatiedruk
- **Voorspelbaar > verrassend** — vaste momenten, geen willekeurige events
- **Altijd positief** — geen verdrietige emoties bij het dier, ook niet bij lage stats
- **Verzorging en winkeltje staan centraal** — dáár haalt ze plezier uit

## Kernprincipes

1. **Verzorging is de kern.** Voeden, spelen, wassen, slapen. Geen andere hoofdacties in v1.
2. **Inrichten is ook kern.** Een winkeltje met achtergronden, outfits en speciale spullen. Niet 4 hoedjes — een plek om terug te komen.
3. **Mild, altijd mild.** Decay is langzaam, offline cap is ruim, streak belooft nooit iets af te nemen.
4. **Stilte als standaard.** Geen achtergrondmuziek. Geluid is een opt-in.
5. **Puur HTML/JS.** Geen build, geen framework, geen dependencies. Werkt direct in de browser.

## Niet-doelen (voor v1)

- ❌ Andere dieren dan de kat
- ❌ "Mijn kamer"-scherm / kamers inrichten
- ❌ Leermini-games, "boek"-actie, quizzen
- ❌ Avontuur-mini-game
- ❌ Achtergrondmuziek
- ❌ Meerdere save-files
- ❌ Delen / leaderboards / achievements op cijfers

## Tech-stack

- **HTML/CSS/vanilla JavaScript** — geen build, geen framework
- **localStorage** voor save-state
- **16×16 pixel-art** voor het dier (afkomstig uit het eerdere `rework/` prototype)
- **Mobile-first** — werkt op 5" telefoon én 10" tablet, portrait
- **Geen externe dependencies**

## Taal

Alle UI-tekst is **Nederlands**. De kat praat Nederlands. Dat is de taal van de spelcontext.

## Bron-materiaal

Een werkend prototype (ASCII-versie) en een experimentele 16×16 pixel-versie staan in `/mnt/ai-share/mini-games/pixelpoes/`. Die dienen als referentie voor het gevoel, de taal, en de bestaande pixel-frames van de kat.
