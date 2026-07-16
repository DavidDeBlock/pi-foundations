// news/news-weather-view.ts — issue NW-004
//
// The page body for `/news-weather`. Pure rendering module:
// no DB, no Hono, no auth. Inputs are pre-fetched by the
// route; output is a string of HTML (the `<main>` content).
// This split lets the route own "how to talk to the DB and
// the auth middleware" while this module owns "how to draw
// the page". Tests drive `render()` directly with fixture
// data, no fake HTTP layer required.
//
// Three concerns the module owns:
//   1. HTML escaping — every piece of user-controlled text
//      (titles, descriptions, source names, dates) is run
//      through `escapeHtml()` before interpolation, even
//      though `ArticleNormalizer` already strips HTML from
//      descriptions (ADR-010). Defense in depth.
//   2. WMO weather-code labels — the Open-Meteo `weather_code`
//      is a small integer that maps to a human-readable
//      condition. We keep the lookup local; no new deps.
//   3. Date formatting — relative when same-day, absolute
//      otherwise. No `Intl.RelativeTimeFormat` per call (kept
//      simple for v5.0).

import type { Article, Source, WeatherSnapshot } from './types.js'

// ─── Public surface ──────────────────────────────────────────────────────

/** The fixed display order of news categories on the page
 *  (per PRD-008). Weather is rendered separately and is
 *  NOT included in this list. Categories not present in
 *  this list are skipped (e.g. an unknown category in the
 *  DB will not appear on the page). */
export const CATEGORY_DISPLAY_ORDER: ReadonlyArray<string> = [
  'General',
  'Economy',
  'Local and Politics',
  'Technology and Cybersecurity',
]

/** Max articles shown per category. Matches the AC's
 *  "Top 20 articles per category" rule. The route enforces
 *  this when fetching; this is a render-time safety net. */
export const MAX_ARTICLES_PER_CATEGORY = 20

/** Inputs to `render()`. The route prepares everything
 *  here from `NewsStore` reads — the view stays pure. */
export interface NewsWeatherViewArgs {
  /** Latest weather snapshot, or `null` when no fetch has
   *  succeeded yet (cold start). */
  readonly weather: WeatherSnapshot | null
  /** Articles grouped by category, keyed by the exact
   *  category string from `news_sources.category`. The
   *  route guarantees:
   *    - Each category's array is already capped at
   *      `MAX_ARTICLES_PER_CATEGORY` and sorted newest-first.
   *    - Empty categories may be omitted OR included with
   *      `[]`. Either way the view skips empty categories. */
  readonly articlesByCategory: ReadonlyMap<string, ReadonlyArray<Article>>
  /** All enabled sources. Used by the empty-state footer
   *  ("Feeds will populate within 30 minutes") and the
   *  "X sources, last updated Y" line under the header. */
  readonly sources: ReadonlyArray<Source>
  /** When the snapshot was fetched, for the "last updated"
   *  line. Optional — page renders without it (the route
   *  fills from `weather.fetchedAt` if it has a snapshot). */
  readonly nowMs?: () => number
}

/** Render the page body. Returns a string of HTML for the
 *  `<main>` block (the route wraps it with the site header
 *  + sidebar + scripts). Always non-empty: even the
 *  all-empty state returns a single fallback line. */
export function render(args: NewsWeatherViewArgs): string {
  const nowMs = args.nowMs ?? (() => Date.now())
  const weatherBlock = renderWeatherBlock(args.weather, nowMs)
  const totalArticles = countArticles(args.articlesByCategory)
  const newsBlock =
    totalArticles === 0
      ? renderEmptyNews()
      : renderCategoryBlocks(args.articlesByCategory, args.sources, nowMs)
  const metaLine = renderMetaLine(args.sources, args.weather, nowMs)
  return `<main class="news-main">
    <header class="news-page-header">
      <span class="page-eyebrow">News & Weather</span>
      <h1>Today, at a glance</h1>
      <p>Belgian news and the Ghent weather forecast. Refreshes every minute; sources below.</p>
    </header>
    ${metaLine}
    ${weatherBlock}
    ${newsBlock}
  </main>`
}

// ─── Weather block ───────────────────────────────────────────────────────

/**
 * Render the top-of-page weather panel. Two states:
 *   * `snapshot === null` → "Weather data not yet available"
 *     fallback (cold start, scheduler hasn't fired yet).
 *   * `snapshot !== null` → current conditions card + 7-day
 *     forecast row.
 */
function renderWeatherBlock(
  snapshot: WeatherSnapshot | null,
  nowMs: () => number,
): string {
  if (!snapshot) {
    return `<section class="news-weather" data-weather="empty">
      <div class="news-weather-empty" role="status">
        <span class="news-weather-empty-icon" aria-hidden="true">⛅</span>
        <h2>Weather data not yet available</h2>
        <p>Refresh in a few seconds — the first snapshot arrives within a minute of boot.</p>
      </div>
    </section>`
  }
  const current = snapshot.current
  const today = snapshot.daily[0] ?? null
  const condition = current.weather_code !== undefined
    ? wmoLabel(current.weather_code)
    : '—'
  return `<section class="news-weather" data-weather="ready">
    <div class="news-weather-current">
      <div class="news-weather-temperature">
        <span class="news-weather-temp-value">${formatTemperature(current.temperature_2m)}</span>
        <span class="news-weather-temp-unit">°C</span>
        <span class="news-weather-condition">${escapeHtml(condition)}</span>
      </div>
      <dl class="news-weather-stats">
        <div><dt>Feels like</dt><dd>${formatTemperature(current.apparent_temperature)}</dd></div>
        <div><dt>Rain</dt><dd>${formatMillimetres(current.precipitation)}</dd></div>
        <div><dt>Precipitation</dt><dd>${formatMillimetres(current.rain)}</dd></div>
        <div><dt>Wind</dt><dd>${formatWind(current.wind_speed_10m)}</dd></div>
        <div><dt>Gusts</dt><dd>${formatWind(current.wind_gusts_10m)}</dd></div>
        <div><dt>Today min/max</dt><dd>${formatTemperature(today?.temperature_2m_min)} / ${formatTemperature(today?.temperature_2m_max)}</dd></div>
      </dl>
    </div>
    <div class="news-weather-forecast" aria-label="7-day forecast">
      <h3>7-day forecast</h3>
      <ol class="news-weather-days">${snapshot.daily.map((day, i) => renderForecastDay(day, i === 0, nowMs)).join('')}</ol>
    </div>
  </section>`
}

/** Render a single day card in the 7-day forecast row. */
function renderForecastDay(
  day: WeatherSnapshot['daily'][number],
  isToday: boolean,
  nowMs: () => number,
): string {
  const label = forecastDayLabel(day.time, isToday, nowMs)
  const code = day.weather_code !== undefined ? wmoLabel(day.weather_code) : '—'
  const min = formatTemperature(day.temperature_2m_min)
  const max = formatTemperature(day.temperature_2m_max)
  const pop = day.precipitation_probability_max !== undefined
    ? `${Math.round(day.precipitation_probability_max)}%`
    : '—'
  return `<li class="news-weather-day" data-day="${escapeHtml(day.time)}">
    <span class="news-weather-day-label">${escapeHtml(label)}</span>
    <span class="news-weather-day-cond" title="${escapeHtml(code)}">${escapeHtml(code)}</span>
    <span class="news-weather-day-temps"><strong>${max}</strong>° / ${min}°</span>
    <span class="news-weather-day-pop">💧 ${escapeHtml(pop)}</span>
  </li>`
}

// ─── News block ──────────────────────────────────────────────────────────

/**
 * Render one section per category in the fixed display
 * order. Categories with zero articles are skipped
 * entirely (per AC: "the section header is omitted").
 * Within each section, render up to 20 cards.
 */
function renderCategoryBlocks(
  articlesByCategory: ReadonlyMap<string, ReadonlyArray<Article>>,
  sources: ReadonlyArray<Source>,
  nowMs: () => number,
): string {
  const sections = CATEGORY_DISPLAY_ORDER.flatMap((category) => {
    const articles = articlesByCategory.get(category) ?? []
    if (articles.length === 0) return []
    return [renderCategorySection(category, articles, sources, nowMs)]
  }).join('')
  return `<section class="news-categories" aria-label="News by category">${sections}</section>`
}

function renderCategorySection(
  category: string,
  articles: ReadonlyArray<Article>,
  sources: ReadonlyArray<Source>,
  nowMs: () => number,
): string {
  const sourceById = new Map(sources.map((s) => [s.id, s]))
  const cards = articles
    .slice(0, MAX_ARTICLES_PER_CATEGORY)
    .map((article) => renderArticleCard(article, sourceById, nowMs))
    .join('')
  return `<article class="news-category" data-category="${escapeHtml(category)}">
    <header class="news-category-header">
      <h2>${escapeHtml(category)}</h2>
      <span class="news-category-count">${articles.length} ${articles.length === 1 ? 'article' : 'articles'}</span>
    </header>
    <ol class="news-category-list">${cards}</ol>
  </article>`
}

/** Render one article card. Title is a link to the original
 *  article (`target="_blank" rel="noopener"`). Source name
 *  + relative-or-absolute date are rendered below. */
function renderArticleCard(
  article: Article,
  sourceById: ReadonlyMap<number, Source>,
  nowMs: () => number,
): string {
  const source = sourceById.get(article.sourceId)
  const sourceName = source?.name ?? 'Unknown source'
  const dateLabel = formatPublishedDate(article.publishedAt, nowMs)
  const description = article.description && article.description.trim() !== ''
    ? `<p class="news-card-description">${escapeHtml(article.description)}</p>`
    : ''
  return `<li class="news-card">
    <a class="news-card-link" href="${escapeHtml(article.url)}" target="_blank" rel="noopener">
      <h3 class="news-card-title">${escapeHtml(article.title)}</h3>
    </a>
    <p class="news-card-meta">
      <span class="news-card-source">${escapeHtml(sourceName)}</span>
      <span class="news-card-date" title="${escapeHtml(article.publishedAt ?? 'unknown')}">${escapeHtml(dateLabel)}</span>
    </p>
    ${description}
  </li>`
}

function renderEmptyNews(): string {
  return `<section class="news-categories" data-news="empty">
    <p class="news-empty-line" role="status">No news yet. Feeds will populate within 30 minutes.</p>
  </section>`
}

// ─── Header / meta ───────────────────────────────────────────────────────

function renderMetaLine(
  sources: ReadonlyArray<Source>,
  weather: WeatherSnapshot | null,
  nowMs: () => number,
): string {
  const sourceCount = sources.length
  const parts: string[] = []
  if (sourceCount === 0) {
    parts.push('No sources enabled')
  } else if (sourceCount === 1) {
    parts.push('1 source enabled')
  } else {
    parts.push(`${sourceCount} sources enabled`)
  }
  if (weather) {
    parts.push(`weather updated ${formatRelativeFromNow(weather.fetchedAt, nowMs)}`)
  } else {
    parts.push('weather pending first fetch')
  }
  const errs = sources.filter((s) => s.lastError !== null).length
  if (errs > 0) {
    parts.push(
      `<span class="news-meta-errors">${errs} source${errs === 1 ? '' : 's'} erroring</span>`,
    )
  }
  return `<p class="news-meta">${parts.map(escapeHtml).join(' · ')}</p>`
}

// ─── WMO weather codes ───────────────────────────────────────────────────

/**
 * Map Open-Meteo's `weather_code` integer to a short,
 * human-readable label. Codes are documented at
 * https://open-meteo.com/en/docs (WMO Weather interpretation
 * codes). Anything not in the table renders as "Unknown".
 */
function wmoLabel(code: number): string {
  // Index by code. Keep this list local; it's stable per WMO.
  switch (code) {
    case 0: return 'Clear'
    case 1: return 'Mainly clear'
    case 2: return 'Partly cloudy'
    case 3: return 'Overcast'
    case 45: return 'Fog'
    case 48: return 'Depositing rime fog'
    case 51: return 'Light drizzle'
    case 53: return 'Moderate drizzle'
    case 55: return 'Dense drizzle'
    case 56: return 'Light freezing drizzle'
    case 57: return 'Dense freezing drizzle'
    case 61: return 'Light rain'
    case 63: return 'Moderate rain'
    case 65: return 'Heavy rain'
    case 66: return 'Light freezing rain'
    case 67: return 'Heavy freezing rain'
    case 71: return 'Light snow'
    case 73: return 'Moderate snow'
    case 75: return 'Heavy snow'
    case 77: return 'Snow grains'
    case 80: return 'Light rain showers'
    case 81: return 'Moderate rain showers'
    case 82: return 'Violent rain showers'
    case 85: return 'Light snow showers'
    case 86: return 'Heavy snow showers'
    case 95: return 'Thunderstorm'
    case 96: return 'Thunderstorm with light hail'
    case 99: return 'Thunderstorm with heavy hail'
    default: return 'Unknown'
  }
}

// ─── Formatters ──────────────────────────────────────────────────────────

/** Format a temperature in °C, or "—" when undefined. */
function formatTemperature(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value)}`
}

/** Format a millimetre value, or "—" when undefined. */
function formatMillimetres(value: number | undefined): string {
  return value === undefined ? '—' : `${value.toFixed(1)} mm`
}

/** Format a wind speed in km/h, or "—" when undefined. */
function formatWind(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value)} km/h`
}

/** Day label for the 7-day forecast row. "Today" / "Tomorrow"
 *  for the first two days (when in the right relative
 *  position), else a weekday short-name. */
function forecastDayLabel(
  iso: string,
  isToday: boolean,
  nowMs: () => number,
): string {
  if (isToday) return 'Today'
  const today = startOfLocalDay(new Date(nowMs()))
  const target = startOfLocalDay(parseLocalDay(iso))
  if (!today || !target) return iso
  const oneDayMs = 86_400_000
  const diffDays = Math.round((target.getTime() - today.getTime()) / oneDayMs)
  if (diffDays === 1) return 'Tomorrow'
  return weekdayShort(target)
}

function weekdayShort(date: Date): string {
  return date.toLocaleDateString('en', { weekday: 'short' })
}

function startOfLocalDay(date: Date): Date | null {
  if (Number.isNaN(date.getTime())) return null
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

/** Parse the local-date string `YYYY-MM-DD` Open-Meteo emits
 *  in `daily.time`. Build the date as local-noon so DST
 *  transitions don't shift it to a neighbouring day. */
function parseLocalDay(iso: string): Date {
  // The daily `time` strings are `YYYY-MM-DD` (date-only).
  // Split and construct from parts so timezone math doesn't
  // shift the day.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return new Date(iso)
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0)
}

/** Format a publication date for the article card. Same-day
 *  shows "Today, HH:MM"; different-year shows
 *  "Mon DD YYYY"; otherwise "Mon DD, HH:MM". Returns
 *  "Unknown" when the date is null / unparseable. */
function formatPublishedDate(
  iso: string | null | undefined,
  nowMs: () => number,
): string {
  if (!iso) return 'Unknown'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Unknown'
  const now = new Date(nowMs())
  const sameDay = startOfLocalDay(d)?.getTime() === startOfLocalDay(now)?.getTime()
  if (sameDay) return `Today, ${formatTime(d)}`
  if (d.getFullYear() !== now.getFullYear()) return formatFullDate(d)
  return `${formatMonthDay(d)}, ${formatTime(d)}`
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function formatMonthDay(d: Date): string {
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' })
}

function formatFullDate(d: Date): string {
  return d.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' })
}

/** "3 minutes ago" / "2 hours ago" / "Yesterday" / "5 days
 *  ago" / absolute date for older. Used for the meta line. */
function formatRelativeFromNow(iso: string | null | undefined, nowMs: () => number): string {
  if (!iso) return 'unknown'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'unknown'
  const diffMs = nowMs() - then
  if (diffMs < 0) return 'in the future'
  const minutes = Math.round(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes === 1) return '1 minute ago'
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours === 1) return '1 hour ago'
  if (hours < 24) return `${hours} hours ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return formatFullDate(new Date(then))
}

function countArticles(
  articlesByCategory: ReadonlyMap<string, ReadonlyArray<Article>>,
): number {
  let total = 0
  for (const articles of articlesByCategory.values()) total += articles.length
  return total
}

// ─── HTML escape ─────────────────────────────────────────────────────────

/** Escape every character with HTML metacharacter
 *  semantics. Mirrors the helper used elsewhere in the
 *  codebase — kept local because this module is the
 *  defense-in-depth boundary for user-controlled content. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// ─── Styles ──────────────────────────────────────────────────────────────

/**
 * Inline CSS for the news page. Lives in this module (not
 * the global stylesheet) so the page is self-contained —
 * the boot wiring / smoke can mount the route without
 * touching the asset pipeline. Loaded via `<style>` in the
 * route's `<head>`. Uses the project's design tokens
 * (`--accent-news-weather`, `--surface`, `--border`, etc.)
 * so light/dark themes flow through.
 */
export const NEWS_WEATHER_STYLES = `
.news-main{max-width:1180px;margin:0 auto;padding:36px 42px 72px;width:100%}
.news-page-header{margin-bottom:14px}
.news-page-header h1{font-size:clamp(2rem,4vw,3.2rem);letter-spacing:-.055em;margin:4px 0 8px}
.news-page-header p{color:var(--muted);margin:0;max-width:680px}
.page-eyebrow{text-transform:uppercase;letter-spacing:.16em;font:600 .72rem "JetBrains Mono", monospace;color:var(--accent-news-weather)}
.news-meta{color:var(--muted);font-size:.82rem;margin:0 0 22px;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.news-meta-errors{color:#f87171}
.news-weather{background:linear-gradient(145deg,color-mix(in srgb,var(--surface) 88%,var(--accent-news-weather) 12%),var(--surface));border:1px solid var(--border);border-radius:20px;padding:22px 24px;box-shadow:var(--shadow);margin-bottom:32px}
.news-weather-empty{display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;padding:18px 0}
.news-weather-empty-icon{font-size:2.2rem}
.news-weather-empty h2{margin:0;font-size:1.2rem}
.news-weather-empty p{color:var(--muted);margin:0}
.news-weather-current{display:flex;gap:32px;align-items:center;flex-wrap:wrap;margin-bottom:18px}
.news-weather-temperature{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.news-weather-temp-value{font:600 3.6rem "Inter",sans-serif;letter-spacing:-.04em}
.news-weather-temp-unit{font:600 1.2rem "Inter",sans-serif;color:var(--muted)}
.news-weather-condition{font-size:1.1rem;color:var(--muted);margin-left:10px;padding:4px 10px;border-radius:999px;background:color-mix(in srgb,var(--accent-news-weather) 16%,transparent);color:var(--accent-news-weather);font-weight:600}
.news-weather-stats{display:grid;grid-template-columns:repeat(3,minmax(140px,1fr));gap:8px 22px;margin:0;flex:1;min-width:300px}
.news-weather-stats>div{display:flex;justify-content:space-between;border-bottom:1px dashed var(--border);padding:6px 0}
.news-weather-stats dt{color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.08em;font-weight:600}
.news-weather-stats dd{margin:0;font-weight:600}
.news-weather-forecast h3{font-size:.82rem;text-transform:uppercase;letter-spacing:.16em;color:var(--muted);margin:0 0 12px;font-weight:600}
.news-weather-days{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;list-style:none;padding:0;margin:0}
.news-weather-day{display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 6px;border-radius:14px;background:color-mix(in srgb,var(--surface-2) 90%,transparent);border:1px solid var(--border);text-align:center;min-width:0}
.news-weather-day-label{font-weight:600;font-size:.85rem}
.news-weather-day-cond{color:var(--muted);font-size:.72rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.news-weather-day-temps{font-size:.82rem;color:var(--muted)}
.news-weather-day-temps strong{color:var(--text);font-weight:600}
.news-weather-day-pop{font-size:.72rem;color:#60a5fa}
.news-categories{display:flex;flex-direction:column;gap:30px}
.news-category{background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:18px 22px;box-shadow:var(--shadow)}
.news-category-header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px}
.news-category-header h2{font-size:1.3rem;letter-spacing:-.03em;margin:0}
.news-category-count{color:var(--muted);font-size:.78rem}
.news-category-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:14px}
.news-card{padding:12px 0;border-bottom:1px solid var(--border)}
.news-card:last-child{border-bottom:0}
.news-card-link{color:var(--text);text-decoration:none;display:inline-block}
.news-card-link:hover .news-card-title{color:var(--accent-news-weather)}
.news-card-title{font-size:1.05rem;font-weight:600;line-height:1.35;margin:0}
.news-card-meta{display:flex;gap:10px;font-size:.78rem;color:var(--muted);margin:4px 0 0;flex-wrap:wrap}
.news-card-source{font-weight:600;color:var(--muted)}
.news-card-date{color:var(--muted)}
.news-card-description{margin:8px 0 0;font-size:.92rem;line-height:1.5;color:color-mix(in srgb,var(--text) 85%,var(--muted))}
.news-empty-line{text-align:center;padding:46px 24px;color:var(--muted);font-size:.95rem;border:1px dashed var(--border);border-radius:16px;background:color-mix(in srgb,var(--surface) 90%,transparent)}
@media(max-width:800px){.news-main{padding:24px 18px 60px}.news-weather-stats{grid-template-columns:repeat(2,1fr)}.news-weather-days{grid-template-columns:repeat(4,1fr)}}
@media(max-width:520px){.news-weather-days{grid-template-columns:repeat(3,1fr)}.news-weather-current{flex-direction:column;align-items:flex-start}.news-weather-stats{grid-template-columns:1fr;min-width:0}}`
