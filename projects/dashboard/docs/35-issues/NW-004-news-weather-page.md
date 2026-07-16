# NW-004 — News & Weather page (`/news-weather`) + nav link

**Labels**: `news-weather`, `v5.0`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-008](../35-prds/PRD-008-news-weather.md)

## What to build

The user-facing page: `GET /news-weather`, server-rendered HTML, gated by HTTP Basic auth. Weather block on top, news grouped by category below. Plus a nav link in the existing top nav.

Depends on NW-002 (for `NewsStore` to read articles + weather snapshot). Does **not** depend on NW-003 — the page renders from DB state, independent of whether the scheduler is running.

## Acceptance criteria

### Route

- [ ] New Hono route: `GET /news-weather`. Gated by HTTP Basic auth (returns 401 without it).
- [ ] Renders 200 with HTML on success

### View module

- [ ] `NewsWeatherView` (in `server/src/news/news-weather-view.ts`): `render({ weather: WeatherSnapshot | null, articlesByCategory: Map<string, Article[]>, sources: Source[] }) → string`. Returns the page HTML body (the route wraps it with the existing layout/header/footer).
- [ ] **Weather block on top**:
  - Current temperature (large), apparent temperature
  - Current condition (WMO weather code → short label, e.g., `0 → "Clear"`, `61 → "Light rain"`, `95 → "Thunderstorm"`)
  - Rain / precipitation (mm)
  - Wind speed + gusts
  - Today's min/max
  - 7-day forecast as a row of small cards (icon-label + temp min/max + precipitation chance)
- [ ] **News block**:
  - One section per category, in this fixed order: General → Economy → Local and Politics → Technology and Cybersecurity
  - If a category has zero articles, the section header is **omitted entirely** (not "0 articles")
  - Top 20 articles per category, newest first by `published_at DESC NULLS LAST, fetched_at DESC`
  - Each article card: title (linked, target=_blank, rel=noopener), source name, publication date (relative if today, else absolute), short description (already plain text per ADR-010)
- [ ] **Empty states**:
  - No weather snapshot yet (cold start, scheduler not yet fired) → weather block shows "Weather data not yet available — refresh in a few seconds." instead of the breakdown
  - No articles in any category → news block shows a single line: "No news yet. Feeds will populate within 30 minutes."
- [ ] All user-controlled content (titles, descriptions, source names) rendered as text — no HTML interpretation. Defense in depth even though descriptions are plain text per ADR-010.

### Nav

- [ ] "News & Weather" link added to the existing top nav, pointing to `/news-weather`

### Tests

- [ ] `NewsWeatherView.render` with: empty weather + empty articles → shows both empty states; full weather + 4 categories of articles → renders all sections in correct order; partial weather (some fields missing) → missing fields render as "—"; one category empty → that category header omitted, others shown; 25 articles in one category → only 20 shown; HTML special chars in title/description are escaped (e.g., `<script>` shows as text)

### Manual smoke

- [ ] `pnpm start` and visit `http://localhost:8080/news-weather` (with HTTP Basic) → 200 + page renders
- [ ] Each news card click opens the original in a new tab
- [ ] Nav link visible in header, navigates to `/news-weather`

## Blocked by

- [NW-002](./NW-002-fetcher-dispatcher-and-normalizer.md) (needs `NewsStore`)

## Files to touch

- `server/src/news/news-weather-view.ts` (new)
- `server/src/news/news-weather-view.test.ts` (new)
- `server/src/news/news-weather-route.ts` (new) — or inline registration in `server/src/app.ts`
- `server/src/app.ts` (wire route + nav link)
