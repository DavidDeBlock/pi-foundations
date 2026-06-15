You are helping me build a new Astro website for a business concept called **Flowmaker**.

The site must be in **Dutch**.

Flowmaker is a concept for helping small independent businesses improve their workflows with a combination of workflow analysis, practical software, automation and AI. The tone should not feel like a corporate SaaS website. It should feel handmade, practical, slightly rebellious, warm, clear and grounded in real small-business reality.

The core idea:

Small independent businesses often run on loose notes, WhatsApp messages, Excel files, old POS systems, paper, memory, and daily improvisation. Flowmaker maps those real-life workflows, finds the bottlenecks, and builds small practical tools that give the owner more control, overview and calm.

Think: “Andermans Zaken, but software-first and workflow-focused”, without copying or naming that show too prominently.

Build a clean Astro website with this structure:

Pages:

* `/` homepage / manifesto
* `/probleem` explains the problem small businesses have
* `/concept` explains what Flowmaker is
* `/aanpak` explains the process: workflow scan, quick wins, mini-software, AI support
* `/flows` shows example workflow maps
* `/cases/fietsenwinkel` shows the bicycle shop as the first real-world case/lab
* `/voor-wie` lists ideal customers
* `/lab` for ideas, experiments, notes and future concepts
* `/contact` simple contact page

Technical requirements:

* Use Astro with TypeScript.
* Use vanilla CSS with CSS variables. Do not use Tailwind unless absolutely necessary.
* Keep JavaScript minimal.
* Use reusable Astro components.
* Use content collections for repeatable content such as ideas, flows and cases.
* Make the site responsive and mobile-friendly.
* Add basic SEO metadata per page.
* Add accessible HTML: semantic sections, good heading order, readable contrast, focus states.
* Do not use placeholder lorem ipsum. Write real Dutch draft copy based on the concept.
* Use a handmade visual style using CSS: paper-like background, slightly imperfect cards, hand-drawn borders, arrows, labels, stamps, notes, subtle grid or notebook feel.
* Do not use stock photos. Use CSS shapes, simple inline SVG doodles, icons or placeholder sketch blocks instead.

Suggested visual identity:

* Background: warm off-white / paper.
* Text: dark ink.
* Accent colors: muted orange, faded blue, soft green or red stamp color.
* Typography: readable body font, headings may feel slightly hand-made but must remain readable.
* UI elements: cards like index cards, sticky notes, flow arrows, tags, labels, rough borders.

Components to create:

* `BaseLayout.astro`
* `SiteHeader.astro`
* `SiteFooter.astro`
* `Hero.astro`
* `SectionHeader.astro`
* `FlowCard.astro`
* `IdeaCard.astro`
* `CaseCard.astro`
* `HandmadeBox.astro`
* `ProcessSteps.astro`
* `Callout.astro`

Suggested project structure:

```txt
src/
  content/
    ideas/
    flows/
    cases/
  components/
  layouts/
  pages/
    index.astro
    probleem.astro
    concept.astro
    aanpak.astro
    flows.astro
    voor-wie.astro
    lab.astro
    contact.astro
    cases/
      fietsenwinkel.astro
  styles/
    global.css
  content.config.ts
public/
  favicon.svg
```

Content direction:

Homepage:

* Hero title: “Van dagelijkse chaos naar duidelijke werkstromen.”
* Subtitle: “Flowmaker helpt kleine zelfstandigen hun zaak slimmer organiseren met praktische software, workflow-denken en AI.”
* Sections:

  * “Niet meer werken op geheugen alleen”
  * “Eerst begrijpen, dan bouwen”
  * “Kleine tools, grote rust”
  * “Gebouwd vanuit een echte winkel”

Problem page:
Explain that many small businesses do not need huge enterprise software, but they do need structure, overview, repeatable processes and better follow-up.

Concept page:
Explain Flowmaker as a combination of:

* workflow analysis
* practical business diagnosis
* small custom tools
* automation
* AI-assisted content, reporting and decision support

Approach page:
Use four steps:

1. Workflow-scan
2. Quick wins
3. Mini-software
4. AI-assistent bovenop de data

Flows page:
Show example flows:

* Repair intake
* Work planning
* Customer communication
* Product ordering
* Quote to invoice
* Small service requests

Bicycle shop case:
Explain that the first lab is a real bicycle shop where repair intake, planning, POS, stock, customer communication and service rules are being mapped and improved.

Lab page:
Make it feel like an open notebook of ideas:

* service rules
* repair dashboard
* AI campaign generator
* workflow templates
* small business health check
* stock scan with phone camera
* customer follow-up assistant

Contact page:
Simple CTA:
“Heb je een kleine zaak en voelt je dagelijkse werking soms als losse eindjes? Dan wil ik graag eens meekijken.”

Important:

* Keep the first implementation simple and beautiful.
* Do not over-engineer.
* Build a static website first.
* No database.
* No authentication.
* No CMS.
* No complex animations.
* Prioritize structure, copy, visual identity and reusable components.
* After implementation, run the build and fix any errors.
* At the end, summarize the created files and how to run the site locally.
