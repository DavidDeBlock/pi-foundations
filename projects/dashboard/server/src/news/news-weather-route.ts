// news/news-weather-route.ts — issue NW-004
//
// Hono route wiring for `GET /news-weather`. Thin glue
// between three modules:
//
//   * `NewsStore`         — DB reads for the snapshot and
//                            per-category articles
//   * `NewsWeatherView`   — pure rendering of the page body
//                            (the deep module — see
//                            news-weather-view.ts)
//   * `view-shared.ts`    — site header, sidebar, footer,
//                            and the COMMON_HEAD fragment
//
// The route is intentionally light. All it does:
//   1. Read the latest weather snapshot (or null on cold start).
//   2. Read up to MAX_ARTICLES_PER_CATEGORY articles per
//      category in the fixed display order.
//   3. Read the source list (for the empty-state and the
//      "X sources enabled" meta line).
//   4. Hand all of it to `render()` and wrap with the
//      standard layout + scripts.
//
// The auth middleware on `app.use('*', ...)` in `app.ts`
// already gates every route, so this module does NOT
// implement its own auth — it relies on the shared
// middleware to 401 unauthenticated requests.

import { Hono } from 'hono'
import type { AuthVariables } from '../auth.js'
import type { Database } from '../db.js'
import {
  COMMON_HEAD,
  HAMBURGER_SCRIPT_TAG,
  THEME_SCRIPT_TAG,
  renderAppNavigation,
  renderHeader,
  renderSidebarFooter,
} from '../view-shared.js'
import {
  CATEGORY_DISPLAY_ORDER,
  MAX_ARTICLES_PER_CATEGORY,
  NEWS_WEATHER_STYLES,
  render,
} from './news-weather-view.js'
import { NewsStore } from './news-store.js'
import type { Article } from './types.js'

export interface NewsWeatherRouteDeps {
  readonly db: Database
}

/**
 * Build a Hono app for the `/news-weather` route. The
 * returned app is mounted at `/news-weather` in `app.ts`,
 * so its only handler is `GET /` (the index page).
 */
export function newsWeatherRoute(deps: NewsWeatherRouteDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>()
  const store = new NewsStore(deps.db)

  app.get('/', (c) => {
    const weather = store.getLatestWeatherSnapshot()
    const articlesByCategory = new Map<string, ReadonlyArray<Article>>()
    for (const category of CATEGORY_DISPLAY_ORDER) {
      articlesByCategory.set(
        category,
        store.listArticlesByCategory(category, MAX_ARTICLES_PER_CATEGORY),
      )
    }
    const sources = store.listEnabledSources()
    const body = render({
      weather,
      articlesByCategory,
      sources,
    })
    return c.html(renderPage(body))
  })

  return app
}

// ─── Page wrapper ────────────────────────────────────────────────────────

function renderPage(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
${COMMON_HEAD}
  <title>News & Weather — Dashboard</title>
  <meta name="robots" content="noindex">
  <style>${NEWS_WEATHER_STYLES}</style>
</head>
<body class="space-news-page">
  ${renderHeader({ showSearch: false, showSidebarToggle: true })}
  <div class="layout">
    <aside class="sidebar" data-sidebar>
      ${renderAppNavigation({ active: 'news-weather' })}
      ${renderSidebarFooter('News & weather · Belgian feeds')}
    </aside>
    ${body}
  </div>
  ${THEME_SCRIPT_TAG}
  ${HAMBURGER_SCRIPT_TAG}
</body>
</html>`
}
