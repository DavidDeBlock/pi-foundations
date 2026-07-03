# De Velomaker — Website Redesign Brief

> Brief for a designer or implementer. Local-first, service-led repositioning of an existing bike shop website in Gent. Audience: residents who already live nearby — the shop itself is the differentiator.

---

## Note on the brief input

The original request mentioned "Ville de Ville" as one of two brands. The actual brand is **Velo De Ville** (the shop is an exclusive dealer). The two brands are therefore **Velo De Ville** (custom / premium) and **Oxford** (budget / cargo utility). All references below use the correct brand names.

---

## Site inventory (current state)

What the inspection of `github.com/DavidDeBlock/develomaker` turned up:

**Hard facts (preserve as-is):**
- Address: Rooigemlaan 193, 9000 Gent (Brugse Poort)
- Phone: 09 233 45 95 — Email: info@develomaker.be
- BTW: BE0578.875.016
- Established 2011 → roughly 12+ years of trade
- Opening hours: Mon closed · Tue/Wed/Fri 09:30–12:30 & 13:30–18:30 · Thu closed · Sat 10:00–12:30 & 13:30–18:00 · Sun/holidays closed

**Current information architecture (header nav, in order):**
1. Ons aanbod (Our offerings) — dropdown with Fietsen op voorraad, Fietsen (Esprit / Sport / Allround / Configureer), E-bikes (Comfort / Compact / Allround / Sport / Esprit / Configureer), Bakfietsen, Cargofiets, Toebehoren
2. Promoties
3. Leasing / Lening
4. Blog
5. Service — dropdown with Herstellingen, Onderhoud, Een fiets kopen, Afspraak
6. Contact

**Current hero:** "Ontdek onze nieuwe Minifiets!" with price-bullet stack (€2199, Bosch Active Motor, etc.) — product-forward, salesy, generic slideshow.

**Current home page triple-box:** Herstellingen · Een nieuwe fiets kopen? · Volg ons op Facebook — last item is a weak trust signal.

**Current pages with placeholder content (Lorem ipsum, theme default):**
`/service`, `/service-herstellingen`, `/service-onderhoud`, `/service-eenfietskopen`, `/contact`, `/fietsen-overzicht`, `/promoties`, `/leasing`, almost all tag/category pages, plus the archived voorraad folder (8 old Velo De Ville listings, all stale).

**Current secondary sections worth keeping the *idea* of:**
- Callant fietsverzekering tab (insurance partnership)
- Velo De Ville configurator (custom builds)
- Abus helmets / veiligheid

**No existing section** addresses "why buy local", turnaround expectations, or years of experience explicitly.

---

## 1. Visual direction

**Tone target:** trustworthy neighbourhood workshop, not a sleek e-commerce store. Warm but precise — closer to an independent bookshop or a small-batch roaster than to a Decathlon or tech-startup landing page. Avoid gradients-on-white, glassmorphism, oversized hero typography, and SaaS-style illustration.

**Color:**
- Primary: a deep, slightly desaturated green or petrol blue (think workshop sign, not app store). Single solid colour, used for primary CTAs, header bar, section accents.
- Secondary: a warm off-white / cream for large background areas (page background, section dividers) instead of stark #fff. Cream reads "physical shop" more than pure white.
- Accent: one warm signal colour for trust-callouts (hours, "open now", appointment CTAs) — burnt orange or signal red, used sparingly.
- Avoid: black-on-black, neon, electric blue, the orange-on-white that screams theme template.

**Typography:**
- One humanist sans for body (e.g. Inter, Source Sans 3, or a paid alternative like Söhne / Untitled Sans).
- One slightly heavier weight of the same family for headings — do not introduce a second typeface.
- Avoid: condensed display faces, mono fonts in headings, anything with cycling-themed tails or pictorial "bike" letterforms.

**Imagery mood:**
- Photographs taken inside the shop, of the actual workshop, the actual owner/mechanic at the bench, real customer bikes mid-repair. No stock photos of cyclists in lycra on mountain passes.
- Lifestyle shots of customers picking up their bike or chatting at the counter, in street clothes.
- Close-ups of hands on tools, brake adjustments, e-bike batteries being swapped. Authentic workshop texture (slight grease, post-it notes on the wall, a real Pegboard) is a feature, not something to clean up.

**Concrete recommendations:**
1. Lock a single primary colour (deep green or petrol) and a cream background before any layout work — every later section depends on this contrast being consistent.
2. Use shop-owned photography only for the hero and the repairs section; if stock images must stand in elsewhere, restrict them to clearly-photographed accessories and parts on neutral backgrounds.
3. Reserve the warm accent colour exclusively for operational signals: opening-status ("Open nu · sluit om 18u30"), appointment CTAs, and the phone number. It must not appear in the brand-positions for either Velo De Ville or Oxford.

---

## 2. Hero and above-the-fold

The above-the-fold area has one job: a passer-by on Rooigemlaan scanning their phone must understand within five seconds that this is *their local bike shop* and that *repairs come first*. The current hero — "Ontdek onze nieuwe Minifiets!" with price bullets — fails both tests.

**Headline (single H1):** a plain spoken line that names the neighbourhood and the service. Options to evaluate with the shop:
- *"Herstellingen en fietsen in de Brugse Poort — sinds 2011."*
- *"Uw fietsenmaker om de hoek. Herstellingen, onderhoud en verkoop."*
- *"Uwgemiste fiets herstellen? Breng ze binnen, meestal klaar binnen de week."*

Avoid sales-y verbs ("ontdek", "geniet van"), avoid the word "premium", and avoid vague locality ("Gent", "de stad") — the differentiator is *Brugse Poort*, not Gent in general.

**Subhead:** one short sentence stating what they fix and that you can walk in. Example: *"Stadsfiets, elektrische fiets, dagelijkse fiets — herstelling en onderhoud zonder afspraak voor kleine klussen."*

**Two CTAs in the hero (only two):**
1. **Primary:** "Bel voor een herstelling" → `tel:092334595` (signal-colour button)
2. **Secondary:** "Onze diensten" → scrolls to services section (text link with arrow)

**Operational strip directly below the hero** (full-width, single row, no decoration):
- Opening status (e.g. *"Vandaag open tot 18u30"* / *"Maandag gesloten"*) — auto-computed from the hours below, no manual edits required day-to-day.
- Address with one-tap maps link: *"Rooigemlaan 193, Gent"*.
- Phone, tappable.
- An appointment link as a text link (not a competing button).

**Hero image:** a wide, real photo of the workshop or counter — not a bike in a forest. The image can extend behind the headline, but the headline must remain readable on cream overlay (no busy photo behind white text).

**Concrete recommendations:**
1. Replace the auto-rotating slideshow with a single static hero photograph plus the headline above — sliders hide the message and read as generic e-commerce.
2. Move opening-status, address, and phone into a permanent utility strip below the hero so they appear on every scroll position once the user has scrolled past the hero (sticky on mobile after the hero scrolls out).
3. Remove price bullets, "Direct leverbaar" and any "Bosch Active Motor" specs from the hero — those belong on product pages, not the home page.

---

## 3. "Why buy local" section

The current site has nothing addressing *why* someone should walk into this shop instead of ordering a bike online. The section must be specific to the shop and avoid community-speak ("steun uw buurt", "wij zijn er voor elkaar") which reads as filler.

**Section title (working):** *"Waarom uw fietsmaker om de hoek."*

**Six advantages, in this order — each with a one-line proof and a one-line proof-source:**

1. **Snelle doorlooptijd** — kleine herstellingen vaak binnen 24–48 u klaar; grotere werken met realistische termijn gecommuniceerd bij ontvangst.
2. **Echt advies, in persoon** — u kan de fiets binnenbrengen, laten zien wat er scheelt, en meekijken terwijl we het bespreken.
3. **Warranty & garantie afhandeling in eigen huis** — defect onderdeel of garantiedossier? U brengt de fiets, wij regelen het papierwerk met de leverancier.
4. **Testrit vóór aankoop** — Velo De Ville modellen configureerbaar en Oxford modellen op voorraad om te proberen voor u beslist.
5. **Doorlopend onderhoud bij dezelfde maker** — u koopt niet bij ons en verdwijnt; u blijft klant voor service, bandenwissel, seizoensbeurt.
6. **Lokale economie** — een onafhankelijke fietsenmaker in de Brugse Poort, geen filiaal. BTW BE0578.875.016, eigenaar aanwezig.

**Layout guidance:** six numbered cards in a 3×2 grid (desktop) / 2×3 (tablet) / single column (mobile). Each card has the number prominent, the advantage as the title (≤ 5 words), and one proof sentence. No icons that all look the same (six identical wrench icons is the trap).

**Placement:** directly below the operational strip, before any product or service section. This is the page's hinge — it justifies the entire site.

**Concrete recommendations:**
1. Replace the existing "Herstellingen / Een nieuwe fiets kopen? / Volg ons op Facebook" triple-box on the home page with this six-card section — Facebook is not a peer of two core services.
2. Each card must cite one concrete number or fact (turnaround window, BTW, brand availability) — adjectives alone ("snel", "vriendelijk", "professioneel") are not allowed in this section.
3. Add one final CTA card under the six: *"Vraag een herstelling aan of kom langs."* → splits to appointment form and directions.

---

## 4. Services-first hierarchy

The current navigation puts **Ons aanbod** (products) before **Service**. For a service-led business where repairs are the primary offering, this is reversed. The IA must be rebuilt so a first-time visitor on a phone finds repairs, maintenance, and appointments before any product page.

**New top-level nav (in order, max six items):**

1. **Herstellingen** — Repairs landing page. Subsections (not nav children, page-internal): small repairs (band, rem, ketting), e-bike service (diagnose, accu, motor), seasonal tune-up, pricing principles (no hidden fees, parts itemised).
2. **Onderhoud** — Maintenance plans: one-off tune-up, yearly subscription-style beurt, winter storage check.
3. **Afspraak maken** — Appointment booking, prominently. This is the highest-intent action on the site.
4. **Fietsen** — Bikes landing, demoted from first to fourth. Subsections: Velo De Ville (custom), Oxford (stock), e-bikes overzicht, op voorraad.
5. **Info & Contact** — Address, hours, routebeschrijving, veelgestelde vragen. Contact is a page, not a separate top-level item.
6. **Blog** — demoted to last (currently third). Kept because it indexes for search, but never above the fold on desktop.

**Visual hierarchy rules:**
- The nav item **Herstellingen** uses the same primary colour and slightly heavier weight than the others. It is the marquee item.
- The **Afspraak maken** item is always reachable in two taps from any page: top nav + a floating action on mobile ("Bel of maak afspraak") that lives at the bottom edge and dismisses once the user scrolls to the contact section.

**Home page section order (services first):**
1. Hero (Section 2)
2. Operational strip
3. Why-buy-local (Section 3)
4. **Herstellingen spotlight** — three concrete services with turnaround: band/plak binnen het uur, e-bike diagnose binnen 48 u, grote herstelling met vaste termijn.
5. Onderhoud — single tune-up and yearly plan, with price anchors.
6. Appointment CTA strip
7. (then, demoted) Fietsen — Velo De Ville & Oxford, side by side, with clear distinction (Section 5)
8. Info & Contact

**Concrete recommendations:**
1. Reorder the header navigation today: Herstellingen, Onderhoud, Afspraak, Fietsen, Info & Contact, Blog. Do not add a seventh item.
2. Move product categories (currently the Ons aanbod dropdown's six e-bike sub-items) out of the header — they belong on the Fietsen landing page as inline cards. The header dropdown should not exceed four items per menu.
3. Add a persistent "Bel of maak afspraak" element on mobile below the fold of every non-appointment page — this is the single most important conversion path for a service-led shop.

---

## 5. Brand positioning (Velo De Ville vs Oxford)

The current site mixes the two brands inside the same "Fietsen" and "E-bikes" dropdowns, where a Velo De Ville AEB800 sits next to an Oxford Cargo at the same visual weight. That signals "two roughly equivalent brands", which contradicts the brief: Velo De Ville is custom-built and premium, Oxford is budget-friendly utility. Each brand needs its own lane.

**Lane rule:**
- **Velo De Ville** gets its own page under `/fietsen/velo-de-ville`. Position: *custom-built in Germany, fully configurable, premium finish*. Lead with the configurator. Lead with price-floor language ("vanaf €649 voor een eigen configuratie").
- **Oxford** gets its own page under `/fietsen/oxford`. Position: *direct leverbaar, degelijke stads-en-cargofietsen, scherpe prijs*. Lead with the fact that they are in stock and testable today. Do not put the word "premium" anywhere near Oxford.
- The two pages must not link to each other as "alternatives" — they answer different purchase intents.

**Visual distinction:**
- Velo De Ville page: brand colours allowed (their visual identity, configurable frame preview imagery, configurator CTA prominent).
- Oxford page: stock-listings feel (cards with price, available-now tag, testrit CTA). Functional photography, no configurator.
- Never place the two side-by-side on the same card or the same row of the homepage — except in a single "Twee merken, twee keuzes" two-column section that explicitly contrasts positioning (custom-build vs in-stock).

**Surface rules:**
- Velo De Ville is mentioned only: on the Fietsen landing page, on its own brand page, and on the configurator tab. Never inside repair, maintenance, or appointment flows.
- Oxford is mentioned only: on the Fietsen landing page, on its own brand page, and in the voorraad listing. Never inside a service-section call-out.

**Concrete recommendations:**
1. Build two separate landing pages (`/fietsen/velo-de-ville` and `/fietsen/oxford`) instead of one shared `/fietsen-overzicht` — and remove the Lorem ipsum placeholder that currently lives at `/fietsen-overzicht/_index.md`.
2. On the home page, demote both brands to a single "Twee merken, twee manieren om een fiets te kopen" section appearing *after* all service sections (Herstellingen, Onderhoud, Afspraak) — never above them.
3. Audit and remove every Oxford listing that does not correspond to a currently-stocked model; the `voorraad_archive/old` folder (eight stale Velo De Ville entries) and any out-of-date Oxford listings must be deleted from the published site, not just moved.

---

## 6. Repair specialism

The brief is explicit: the shop's expertise is repairs for **commuter bikes, daily-use city bikes, and e-bikes**. The current site does not state this anywhere — it talks about "herstellingen" generically and buries the e-bike service inside a product dropdown. The redesign must make the specialism unmistakable.

**Landing page `/herstellingen` (renamed from `/service-herstellingen`):**

**Top of page — three explicit specialism pillars, named plainly:**
1. **Stads-en pendelfietsen** — daily driver, ketting, remmen, versnellingen, banden, verlichting.
2. **Elektrische fietsen** — diagnose, accu-onderhoud, motor-service, firmware, garantie-dossiers met de fabrikant.
3. **Gewone fietsen, alle merken** — geen vereiste dat u de fiets bij ons kocht.

**Trust signals — placed directly under the three pillars, in this order:**

| Signal | Source / proof |
|---|---|
| Jaren ervaring | "Sinds 2011" — derived from the BTW record and the 2011 subfooter date on the current site. |
| Meest voorkomende herstellingen | A short list of common fixes: lekke band, versleten remblokken, ketting vervangen, e-bike accu-check, e-bike diagnose, fietsbel afstellen. Real services, not "general maintenance". |
| Doorlooptijden | Concrete windows: kleine herstelling zelfde dag of 24 u; e-bike diagnose binnen 48 u; grote werken met termijn bij ontvangst. No vague "afhankelijk van het onderdeel". |
| Merkonafhankelijk | "U brengt ze binnen, ongeacht het merk — wij herstellen wat u binnenbrengt." This is the single sharpest trust signal for a service-led shop. |

**Service pricing principle (page section, not a price table):**
- No hidden fees.
- Parts and labour itemised on the receipt.
- Estimate given before work begins; you are called if the estimate moves.
- This belongs in writing because it is what differentiates the shop from anonymous web shops that bundle services into a new-bike sale.

**Onderhoud (`/onderhoud`):**
- **Eenmalige beurt** with explicit inclusions (remmencheck, versnellingen, bandenspanning, ketting, licht).
- **Jaarlijks onderhoudsplan** with one annual price anchor and what it includes. (Even if the shop doesn't yet offer a subscription-style plan, this section is the place to start that conversation.)

**Afspraak (`/afspraak`):**
- Single page, no separate "afspraak" and "afspraak-new" duplicate. (The current repo has both — a legacy artifact to clean up.)
- Form fields: naam, telefoon, fiets (merk + type — free text), korte omschrijving van het probleem, gewenste periode.
- After submission: an SMS or call confirmation within opening hours. State the response time on the page itself ("Wij bellen u binnen de openingsuren terug").

**Concrete recommendations:**
1. Replace the `/service-herstellingen` and `/service-onderhoud` Lorem ipsum pages with the structure above — the placeholder content must not ship.
2. Make "merkonafhankelijk" visible on every repair-related page as a single sentence near the heading. It is the trust signal that no product page can provide.
3. Publish three explicit turnaround windows (same-day/24h, 48h, termijn-bij-ontvangst) and link them from the hero's primary CTA micro-copy so the promise is consistent from first tap to confirmation page.

---

## 7. Existing content — preserve, relocate, drop

**Preserve verbatim (legal / operational facts):**
- Address: Rooigemlaan 193, 9000 Gent.
- Phone: 09 233 45 95. Email: info@develomaker.be.
- BTW: BE0578.875.016.
- Opening hours table (move from footer partial to a dedicated, structured `/contact` block with the days as a definition list — current rendered list is correct in content but buried in a Bootstrap partial).
- Brand names: Velo De Ville (exclusive dealer) and Oxford.

**Relocate:**
- Callant fietsverzekering tab — keep, but move from the home-page tab strip to a small mention on the Fietsen landing page and on the Velo De Ville page. It is a real offering but not a peer of repairs.
- Velo De Ville configurator — keep as a section on the Velo De Ville landing page, not on the home page tabs.
- Abus helmets / veiligheid — keep as a small sub-section under Toebehoren, not as a home-page tab.
- Testrit-aanbod — already mentioned in the Oxford cargo page copy ("Maak gerust een afspraak om de Oxford cargobike eens te testen"). Lift this exact phrasing into the `/fietsen/oxford` page and into the Why-buy-local section.

**Drop:**
- All Lorem ipsum blocks under `## SCHOLARSHIPS NEWS` headings in `/service`, `/service-herstellingen`, `/service-onderhoud`, `/service-eenfietskopen`, `/contact`, `/fietsen-overzicht`, `/promoties`, `/leasing`, and all tag/category pages.
- The auto-rotating slideshow hero ("De nieuwe collectie 2023 elektrische fietsen…" → "Ontdek onze nieuwe Minifiets!…") — replaced by the static hero in Section 2.
- The "Volg ons op Facebook" home-page triple-box — Facebook is fine as a footer link, not as a primary action.
- The "Life is like riding a bicycle" Einstein quote section at the bottom of the home page — decorative, no conversion or trust value.
- The `voorraad_archive/old` folder and all eight stale Velo De Ville entries — these are not published anyway, but delete them to avoid confusion during future edits.
- The duplicate `service-afspraak` and `service-afspraak-new` content trees — keep one (the `-new` version), delete the other.
- The "Exclusieve verdeler van Velo De Ville" suffix in the home page `<title>` if it cannibalises clicks from the repairs-led value prop — replace with a title that leads on locality and repairs, e.g. *"De Velomaker — Fietsenmaker in de Brugse Poort, Gent — Herstellingen en onderhoud"*.

**Concrete recommendations:**
1. Run a `grep -rl "Lorem ipsum\|SCHOLARSHIPS NEWS"` against `content/` and replace every match with real copy before launch — these placeholders are the single biggest trust-killer on the current site.
2. Remove the duplicate appointment page tree (`/service-afspraak` vs `/service-afspraak-new`) and consolidate on one `/afspraak` route that does what the form currently does in two files.
3. Move opening hours, address, and phone out of the Bootstrap footer partial into a structured `/contact` page that is reachable in one tap from the home-page operational strip — they are too important to live only in a footer.

---

## Deliverable checklist

For the implementer, every scope item above must produce an artefact on the new site before launch:

- [ ] Single static hero with the new H1, subhead, two CTAs, and the operational strip (Section 2).
- [ ] Why-buy-local section with six numbered, sourced cards (Section 3).
- [ ] Reordered header navigation (Section 4).
- [ ] Two separate brand landing pages with no cross-linking (Section 5).
- [ ] `/herstellingen`, `/onderhoud`, `/afspraak` pages with the trust-signal table, pricing principle, and turnaround windows (Section 6).
- [ ] All Lorem ipsum replaced; archived and duplicate content removed; hours/address in a structured contact block (Section 7).
- [ ] Visual direction locked (Section 1) before any of the above is laid out.

---

*Brief complete. Ready for handoff to designer and implementer.*