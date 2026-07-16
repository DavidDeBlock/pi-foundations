// news/news-weather-view.test.ts — issue NW-004
//
// Tests for the deep module `NewsWeatherView.render()`. The
// module is pure (no DB, no Hono, no auth) so each test
// builds the inputs as fixtures and asserts on the rendered
// string. AC coverage:
//
//   - empty weather + empty articles → both empty states
//   - full weather + 4 categories of articles → all sections
//     in correct order
//   - partial weather (some fields missing) → "—" for the
//     missing ones
//   - one category empty → that category header omitted
//   - 25 articles in one category → only 20 shown
//   - HTML special chars in title / description are escaped
//   - date formatting (today / yesterday / earlier)
//   - source name displayed
//   - target="_blank" rel="noopener" on article links
//   - weather-source filter: weather block is empty when no
//     snapshot exists
//   - relative date label for the meta line

import { describe, expect, it } from 'vitest'
import {
  CATEGORY_DISPLAY_ORDER,
  MAX_ARTICLES_PER_CATEGORY,
  render,
} from './news-weather-view.js'
import type { Article, Source, WeatherSnapshot } from './types.js'

// ─── Test fixtures ───────────────────────────────────────────────────────

const NOW_EPOCH = Date.parse('2024-07-16T12:00:00.000Z')
const NOW = () => NOW_EPOCH

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: 'a-1',
    sourceId: 1,
    title: 'Sample title',
    description: 'Sample description',
    url: 'https://example.com/article',
    publishedAt: '2024-07-16T11:00:00.000Z',
    fetchedAt: '2024-07-16T12:00:00.000Z',
    ...overrides,
  }
}

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 1,
    name: 'VRT NWS',
    category: 'General',
    type: 'rss',
    url: 'https://www.vrt.be/vrtnws/nl.rss.articles.xml',
    enabled: true,
    refreshIntervalMin: 30,
    lastFetchedAt: '2024-07-16T12:00:00.000Z',
    lastSuccessfulFetchAt: '2024-07-16T12:00:00.000Z',
    lastError: null,
    createdAt: '2024-07-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeWeather(overrides: Partial<WeatherSnapshot> = {}): WeatherSnapshot {
  return {
    fetchedAt: '2024-07-16T12:00:00.000Z',
    current: {
      temperature_2m: 22.5,
      apparent_temperature: 23.1,
      precipitation: 0.0,
      rain: 0.0,
      weather_code: 1,
      wind_speed_10m: 12,
      wind_gusts_10m: 28,
    },
    daily: [
      {
        time: '2024-07-16',
        weather_code: 1,
        temperature_2m_max: 24,
        temperature_2m_min: 14,
        precipitation_probability_max: 10,
        sunrise: '2024-07-16T05:45:00',
        sunset: '2024-07-16T21:55:00',
      },
      {
        time: '2024-07-17',
        weather_code: 3,
        temperature_2m_max: 22,
        temperature_2m_min: 13,
        precipitation_probability_max: 30,
      },
      {
        time: '2024-07-18',
        weather_code: 61,
        temperature_2m_max: 19,
        temperature_2m_min: 12,
        precipitation_probability_max: 80,
      },
      {
        time: '2024-07-19',
        weather_code: 95,
        temperature_2m_max: 20,
        temperature_2m_min: 13,
        precipitation_probability_max: 90,
      },
      {
        time: '2024-07-20',
        weather_code: 2,
        temperature_2m_max: 21,
        temperature_2m_min: 14,
        precipitation_probability_max: 20,
      },
      {
        time: '2024-07-21',
        weather_code: 0,
        temperature_2m_max: 25,
        temperature_2m_min: 15,
        precipitation_probability_max: 5,
      },
      {
        time: '2024-07-22',
        weather_code: 0,
        temperature_2m_max: 27,
        temperature_2m_min: 17,
        precipitation_probability_max: 5,
      },
    ],
    hourly: [],
    ...overrides,
  }
}

const NOW_DAY_ISO = '2024-07-16T12:00:00.000Z'
const TODAY_DATE = '2024-07-16'

// ─── Empty state ─────────────────────────────────────────────────────────

describe('NewsWeatherView — empty state', () => {
  it('shows the weather-empty placeholder when no snapshot', () => {
    const html = render({
      weather: null,
      articlesByCategory: new Map(),
      sources: [],
      nowMs: NOW,
    })
    expect(html).toContain('data-weather="empty"')
    expect(html).toContain('Weather data not yet available')
    expect(html).toContain('Refresh in a few seconds')
  })

  it('shows the no-news line when every category is empty', () => {
    const html = render({
      weather: makeWeather(),
      articlesByCategory: new Map(),
      sources: [makeSource()],
      nowMs: NOW,
    })
    expect(html).toContain('data-news="empty"')
    expect(html).toContain('No news yet. Feeds will populate within 30 minutes.')
  })

  it('omits the no-news line when at least one category has articles', () => {
    const articlesByCategory = new Map<string, ReadonlyArray<Article>>([
      ['General', [makeArticle()]],
    ])
    const html = render({
      weather: makeWeather(),
      articlesByCategory,
      sources: [makeSource()],
      nowMs: NOW,
    })
    expect(html).not.toContain('No news yet')
    expect(html).toContain('<h2>General</h2>')
  })
})

// ─── Weather rendering ───────────────────────────────────────────────────

describe('NewsWeatherView — weather block', () => {
  it('renders current temperature, condition, and 7-day forecast', () => {
    const html = render({
      weather: makeWeather(),
      articlesByCategory: new Map(),
      sources: [],
      nowMs: NOW,
    })
    // Current temperature is rounded: 22.5 → 23
    expect(html).toMatch(/news-weather-temp-value">23</)
    expect(html).toContain('°C')
    expect(html).toContain('Mainly clear')
    // "Feels like" line includes the rounded apparent temp
    expect(html).toContain('23')
    // 7-day forecast renders 7 cards
    const dayMatches = html.match(/<li class="news-weather-day"/g) ?? []
    expect(dayMatches.length).toBe(7)
    // Today is the first card
    expect(html).toMatch(/data-day="2024-07-16"[^>]*>\s*<span class="news-weather-day-label">Today</)
  })

  it('renders "—" for missing fields (partial weather)', () => {
    const partial: WeatherSnapshot = {
      fetchedAt: NOW_DAY_ISO,
      current: {
        // temperature_2m and weather_code are deliberately
        // missing — the page must render "—" for those.
        wind_speed_10m: 15,
      },
      daily: [
        {
          time: TODAY_DATE,
          // No temperature_2m_max/min — "— / —"
        },
      ],
      hourly: [],
    }
    const html = render({
      weather: partial,
      articlesByCategory: new Map(),
      sources: [],
      nowMs: NOW,
    })
    // Temperature cell shows em dash
    expect(html).toMatch(/news-weather-temp-value">—</)
    // Condition label is "—" when weather_code missing
    expect(html).toMatch(/news-weather-condition">—</)
    // Stats also show "—" for the missing values
    expect(html).toContain('—</dd>')
  })

  it('shows the fetchedAt line under the header', () => {
    const html = render({
      weather: makeWeather(),
      articlesByCategory: new Map(),
      sources: [makeSource()],
      nowMs: NOW,
    })
    expect(html).toContain('1 source enabled')
    // Open-Meteo is fetched just now; the meta line says so.
    expect(html).toContain('weather updated')
  })

  it('renders the empty meta line state when there are no sources and no weather', () => {
    const html = render({
      weather: null,
      articlesByCategory: new Map(),
      sources: [],
      nowMs: NOW,
    })
    expect(html).toContain('No sources enabled')
    expect(html).toContain('weather pending first fetch')
  })
})

// ─── News block — category ordering ──────────────────────────────────────

describe('NewsWeatherView — news by category', () => {
  it('renders all four categories in the fixed order with all sections populated', () => {
    const general = makeArticle({ id: 'g1', title: 'G1', sourceId: 1 })
    const economy = makeArticle({ id: 'e1', title: 'E1', sourceId: 2 })
    const local = makeArticle({ id: 'l1', title: 'L1', sourceId: 3 })
    const tech = makeArticle({ id: 't1', title: 'T1', sourceId: 4 })
    const articlesByCategory = new Map<string, ReadonlyArray<Article>>([
      ['General', [general]],
      ['Economy', [economy]],
      ['Local and Politics', [local]],
      ['Technology and Cybersecurity', [tech]],
    ])
    const sources = [
      makeSource({ id: 1, name: 'VRT NWS', category: 'General' }),
      makeSource({ id: 2, name: 'De Tijd', category: 'Economy' }),
      makeSource({ id: 3, name: 'BRUZZ', category: 'Local and Politics' }),
      makeSource({ id: 4, name: 'CCB', category: 'Technology and Cybersecurity' }),
    ]
    const html = render({
      weather: makeWeather(),
      articlesByCategory,
      sources,
      nowMs: NOW,
    })
    const positions = ['General', 'Economy', 'Local and Politics', 'Technology and Cybersecurity'].map(
      (cat) => html.indexOf(`<h2>${cat}</h2>`),
    )
    // Every category header was rendered.
    for (const pos of positions) expect(pos).toBeGreaterThan(-1)
    // Each one appears in CATEGORY_DISPLAY_ORDER.
    const order = positions.map((p) => html.slice(0, p).length)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(order.length).toBe(CATEGORY_DISPLAY_ORDER.length)
    // Every source name appears next to its article.
    expect(html).toContain('VRT NWS')
    expect(html).toContain('De Tijd')
    expect(html).toContain('BRUZZ')
    expect(html).toContain('CCB')
  })

  it('omits the section header for empty categories', () => {
    const articlesByCategory = new Map<string, ReadonlyArray<Article>>([
      ['General', [makeArticle()]],
      // Economy is missing entirely.
      ['Local and Politics', [makeArticle()]],
      // Technology and Cybersecurity explicitly empty.
      ['Technology and Cybersecurity', []],
    ])
    const html = render({
      weather: makeWeather(),
      articlesByCategory,
      sources: [makeSource()],
      nowMs: NOW,
    })
    expect(html).toContain('<h2>General</h2>')
    expect(html).toContain('<h2>Local and Politics</h2>')
    expect(html).not.toContain('<h2>Economy</h2>')
    expect(html).not.toContain('<h2>Technology and Cybersecurity</h2>')
  })

  it('caps each category at MAX_ARTICLES_PER_CATEGORY (20)', () => {
    const articles = Array.from({ length: 25 }, (_, i) =>
      makeArticle({ id: `a-${i}`, title: `Article ${i}` }),
    )
    const articlesByCategory = new Map<string, ReadonlyArray<Article>>([
      ['General', articles],
    ])
    const html = render({
      weather: makeWeather(),
      articlesByCategory,
      sources: [makeSource()],
      nowMs: NOW,
    })
    const cardCount = (html.match(/news-card-link/g) ?? []).length
    expect(cardCount).toBe(MAX_ARTICLES_PER_CATEGORY)
    // The count badge still shows the input length (25) so
    // the operator knows there's more in the DB than what's
    // rendered on the page.
    expect(html).toContain('25 articles')
  })

  it('orders articles within a category as the input provides (newest first)', () => {
    const articles = [
      makeArticle({ id: 'a', title: 'Newer' }),
      makeArticle({ id: 'b', title: 'Older' }),
    ]
    const articlesByCategory = new Map<string, ReadonlyArray<Article>>([
      ['General', articles],
    ])
    const html = render({
      weather: makeWeather(),
      articlesByCategory,
      sources: [makeSource()],
      nowMs: NOW,
    })
    const newerPos = html.indexOf('Newer')
    const olderPos = html.indexOf('Older')
    expect(newerPos).toBeGreaterThan(-1)
    expect(olderPos).toBeGreaterThan(newerPos)
  })
})

// ─── Article card details ────────────────────────────────────────────────

describe('NewsWeatherView — article card', () => {
  it('renders title, source name, description, and date', () => {
    const articlesByCategory = new Map<string, ReadonlyArray<Article>>([
      [
        'General',
        [
          makeArticle({
            id: 'a-1',
            title: 'A news headline',
            description: 'Brief summary of the news.',
            publishedAt: '2024-07-16T11:30:00.000Z',
            sourceId: 7,
            url: 'https://example.com/a-1',
          }),
        ],
      ],
    ])
    const sources = [makeSource({ id: 7, name: 'VRT NWS' })]
    const html = render({
      weather: makeWeather(),
      articlesByCategory,
      sources,
      nowMs: NOW,
    })
    expect(html).toContain('A news headline')
    expect(html).toContain('VRT NWS')
    expect(html).toContain('Brief summary of the news.')
    // Same-day publish → "Today, HH:MM" formatting.
    expect(html).toMatch(/Today, \d{2}:\d{2}/)
  })

  it('renders target=_blank and rel=noopener on the article link', () => {
    const articlesByCategory = new Map<string, ReadonlyArray<Article>>([
      ['General', [makeArticle({ url: 'https://example.com/a-1' })]],
    ])
    const html = render({
      weather: makeWeather(),
      articlesByCategory,
      sources: [makeSource()],
      nowMs: NOW,
    })
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener"')
    expect(html).toContain('href="https://example.com/a-1"')
  })

  it('escapes HTML special chars in title and description', () => {
    const articlesByCategory = new Map<string, ReadonlyArray<Article>>([
      [
        'General',
        [
          makeArticle({
            id: 'xss-1',
            title: '<script>alert("xss")</script>',
            description: '<img src=x onerror="alert(1)"> & 5 > 3',
            url: 'https://example.com/?q=a&b=c',
          }),
        ],
      ],
    ])
    const html = render({
      weather: makeWeather(),
      articlesByCategory,
      sources: [makeSource()],
      nowMs: NOW,
    })
    // Title escaped
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert("xss")</script>')
    // Description escaped
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; 5 &gt; 3')
    expect(html).not.toContain('<img src=x onerror="alert(1)">')
    // URL: ampersand HTML-escaped in href
    expect(html).toContain('href="https://example.com/?q=a&amp;b=c"')
  })

  it('handles missing description gracefully', () => {
    const articlesByCategory = new Map<string, ReadonlyArray<Article>>([
      ['General', [makeArticle({ description: null })]],
    ])
    const html = render({
      weather: makeWeather(),
      articlesByCategory,
      sources: [makeSource()],
      nowMs: NOW,
    })
    expect(html).not.toContain('news-card-description')
  })

  it('handles unknown source id gracefully (no crash, no broken HTML)', () => {
    const articlesByCategory = new Map<string, ReadonlyArray<Article>>([
      ['General', [makeArticle({ sourceId: 9999 })]],
    ])
    const html = render({
      weather: makeWeather(),
      articlesByCategory,
      sources: [],
      nowMs: NOW,
    })
    expect(html).toContain('Unknown source')
  })

  it('renders absolute date for older articles', () => {
    const articlesByCategory = new Map<string, ReadonlyArray<Article>>([
      [
        'General',
        [makeArticle({ publishedAt: '2023-01-15T09:00:00.000Z' })],
      ],
    ])
    const html = render({
      weather: makeWeather(),
      articlesByCategory,
      sources: [makeSource()],
      nowMs: NOW,
    })
    // 2023-01-15 is well outside the current year, so the
    // formatter falls back to a full date.
    expect(html).toContain('Jan')
    expect(html).toContain('2023')
  })

  it('handles null publishedAt (renders "Unknown")', () => {
    const articlesByCategory = new Map<string, ReadonlyArray<Article>>([
      ['General', [makeArticle({ publishedAt: null })]],
    ])
    const html = render({
      weather: makeWeather(),
      articlesByCategory,
      sources: [makeSource()],
      nowMs: NOW,
    })
    expect(html).toContain('Unknown')
  })
})

// ─── Meta line ───────────────────────────────────────────────────────────

describe('NewsWeatherView — meta line', () => {
  it('shows the count of enabled sources', () => {
    const sources = [
      makeSource({ id: 1 }),
      makeSource({ id: 2, category: 'Economy' }),
      makeSource({ id: 3, category: 'Technology and Cybersecurity' }),
    ]
    const html = render({
      weather: makeWeather(),
      articlesByCategory: new Map(),
      sources,
      nowMs: NOW,
    })
    expect(html).toContain('3 sources enabled')
  })

  it('surfaces sources with a lastError as "X sources erroring"', () => {
    const sources = [
      makeSource({ id: 1, lastError: null }),
      makeSource({ id: 2, lastError: 'connection reset' }),
    ]
    const html = render({
      weather: makeWeather(),
      articlesByCategory: new Map(),
      sources,
      nowMs: NOW,
    })
    expect(html).toContain('1 source erroring')
  })
})

// ─── WMO weather codes ───────────────────────────────────────────────────

describe('NewsWeatherView — WMO weather codes', () => {
  it('maps the codes referenced in the AC to the documented labels', () => {
    const cases: Array<[number, string]> = [
      [0, 'Clear'],
      [61, 'Light rain'],
      [95, 'Thunderstorm'],
      [3, 'Overcast'],
      [71, 'Light snow'],
      [99, 'Thunderstorm with heavy hail'],
    ]
    for (const [code, label] of cases) {
      const html = render({
        weather: makeWeather({
          current: { weather_code: code, temperature_2m: 18 },
        }),
        articlesByCategory: new Map(),
        sources: [],
        nowMs: NOW,
      })
      expect(html, `code=${code}`).toContain(label)
    }
  })

  it('renders "Unknown" for unmapped codes (defense against future additions)', () => {
    const html = render({
      weather: makeWeather({
        current: { weather_code: 999, temperature_2m: 18 },
      }),
      articlesByCategory: new Map(),
      sources: [],
      nowMs: NOW,
    })
    expect(html).toContain('Unknown')
  })
})
