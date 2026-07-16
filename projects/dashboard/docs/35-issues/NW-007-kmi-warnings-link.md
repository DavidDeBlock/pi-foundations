# NW-007 — KMI warnings configurable link

**Labels**: `news-weather`, `v5.1`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-009](../35-prds/PRD-009-news-weather-extended.md)

## What to build

A "Official weather warnings (KMI) →" link in the weather block of the News & Weather page. The URL is configurable via a new `KMI_WARNINGS_URL` env var (default `https://www.meteo.be/en/weather/warnings`). Small change, but it touches `env.ts`, the page route, and the view.

## Acceptance criteria

### Env var wiring

- [ ] `server/src/env.ts` reads `KMI_WARNINGS_URL` from the environment
- [ ] Missing env var → falls back to default `https://www.meteo.be/en/weather/warnings` (no error, no warning)
- [ ] Empty string env var (`KMI_WARNINGS_URL=`) → falls back to default (treat empty as missing)
- [ ] Exported constant `KMI_WARNINGS_URL_DEFAULT` in `env.ts` for documentation / tests
- [ ] `server/src/env.test.ts` extended to cover: env var present → uses it; missing → default; empty → default

### Route

- [ ] The `GET /news-weather` route reads the configured KMI URL via `env.ts` and passes it into `NewsWeatherView.render(...)` as a new `kmiWarningsUrl: string` field on its input object
- [ ] Route does **not** pass any other weather-block-affecting config (single-purpose)

### View

- [ ] `NewsWeatherView.render` accepts `kmiWarningsUrl: string` on its input
- [ ] Renders the KMI link in the weather block: `<a href={kmiWarningsUrl} target="_blank" rel="noopener">Official weather warnings (KMI) →</a>`
- [ ] URL is HTML-escaped on render (defense in depth — even though we control the value today, future contributors shouldn't need to remember)
- [ ] Link is rendered even when `weather === null` (the weather block still shows the empty-state message + the KMI link — useful even when no forecast data is available yet)
- [ ] `NewsWeatherView.test.ts` extended to assert: link present with correct URL, href is HTML-escaped when given a URL containing `&`, link rendered in cold-start (no weather) case

### Tests

- [ ] Unit: `NewsWeatherView` with the new field — link rendered with the configured URL
- [ ] Unit: env var fallback (missing, empty, set)
- [ ] Manual smoke: `pnpm start` (no env var) → visit `/news-weather` → KMI link points to `https://www.meteo.be/en/weather/warnings`
- [ ] Manual smoke: `KMI_WARNINGS_URL=https://example.com pnpm start` → link points to `https://example.com` after restart

## Blocked by

- [NW-004](./NW-004-news-weather-page.md) (needs `NewsWeatherView` and the `/news-weather` route to exist)

## Files to touch

- `server/src/env.ts` (add `KMI_WARNINGS_URL` reader + default constant)
- `server/src/env.test.ts` (extend coverage)
- `server/src/news/news-weather-view.ts` (add `kmiWarningsUrl` field, render link)
- `server/src/news/news-weather-view.test.ts` (extend coverage)
- `server/src/news/news-weather-route.ts` (or wherever the route is registered — pass `kmiWarningsUrl` to the view)
- `server/env.example` (document the new env var with comment + default)
