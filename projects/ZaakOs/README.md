# Flowmaker

Website voor **Flowmaker** — praktische workflow- en softwarehulp voor kleine zelfstandigen.

## Stack

- [Astro](https://astro.build/) (statisch)
- TypeScript
- Vanilla CSS (geen Tailwind)
- Content Collections voor `ideas`, `flows`, `cases`

## Lokaal draaien

```bash
pnpm install
pnpm dev      # http://localhost:4321
pnpm build    # productiebuild naar dist/
pnpm preview  # bekijk de build lokaal
```

## Structuur

```
src/
  content/
    ideas/      losse ideeën, experimenten, notities
    flows/      voorbeeldworkflows
    cases/      praktijkverhalen
  components/   herbruikbare UI-blokken
  layouts/      pagina-templates
  pages/        routes
  styles/       global.css
```
