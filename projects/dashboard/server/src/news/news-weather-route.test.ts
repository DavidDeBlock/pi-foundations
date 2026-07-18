// news/news-weather-route.test.ts — issue NW-004
//
// End-to-end coverage of the Hono route at `GET /news-weather`.
// Tests run via Hono's `app.request()` so we exercise auth,
// routing, and the full response shape without binding a port.
//
// Coverage map (per AC):
//   - 200 + HTML on success
//   - auth middleware gates the page (already proven by the
//     global middleware; this test confirms our mount point
//     doesn't accidentally bypass it)
//   - body includes the title + meta line
//   - empty DB: weather empty + news empty states
//   - populated DB: weather + per-category articles render
//   - empty articles store + a weather source: weather renders,
//     news shows fallback line

import bcrypt from 'bcryptjs'
import { describe, expect, it, beforeEach } from 'vitest'
import { resolve } from 'node:path'
import { Database } from '../db.js'
import { runMigrations } from '../migrations.js'
import { createApp } from '../app.js'
import { InMemoryTokenStore } from '../token-store.js'
import type { AuthVariables } from '../auth.js'
import type { Hono } from 'hono'

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../migrations')
const PASSWORD = 'correct horse battery staple'
const HASH = bcrypt.hashSync(PASSWORD, 10)

let db: Database
let app: Hono<{ Variables: AuthVariables }>

beforeEach(async () => {
  db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  // Wipe seed sources — tests use controlled fixtures.
  db.run('DELETE FROM news_sources')
  // The route relies on the global auth middleware. Tests
  // hash the password with bcrypt (the production path) and
  // use an in-memory token store — the route does NOT touch
  // tokens itself, only the shared middleware does.
  app = createApp({
    passwordHash: HASH,
    tokenStore: new InMemoryTokenStore(),
    db,
  })
})

const authHeader = (): string =>
  `Basic ${Buffer.from(`:${PASSWORD}`).toString('base64')}`

describe('GET /news-weather', () => {
  it('returns 200 with HTML on success', async () => {
    const res = await app.request('/news-weather', {
      headers: { authorization: authHeader() },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const body = await res.text()
    expect(body).toContain('<!doctype html>')
    expect(body).toContain('Today, at a glance')
  })

  it('returns 401 without HTTP Basic credentials', async () => {
    const res = await app.request('/news-weather')
    expect(res.status).toBe(401)
  })

  it('renders both empty states when DB has no data', async () => {
    const res = await app.request('/news-weather', {
      headers: { authorization: authHeader() },
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Weergegevens nog niet beschikbaar')
    expect(body).toContain('No news yet')
    expect(body).toContain('No sources enabled')
  })

  it('renders the weather block when a snapshot exists', async () => {
    db.run(
      `INSERT INTO news_sources
         (name, category, type, url, refresh_interval_min, enabled, created_at)
       VALUES ('Open-Meteo Ghent', 'Weather', 'json_api', 'https://api.example/weather', 30, 1, '2024-07-16T12:00:00.000Z')`,
    )
    const sourceId = db.get<{ id: number }>(`SELECT id FROM news_sources LIMIT 1`)!.id
    const current = { temperature_2m: 22, weather_code: 0, wind_speed_10m: 12 }
    const daily = [
      { time: '2024-07-16', temperature_2m_max: 24, temperature_2m_min: 14, precipitation_probability_max: 5 },
    ]
    db.run(
      `INSERT INTO weather_snapshots (source_id, fetched_at, current_json, daily_json, hourly_json)
       VALUES (?, ?, ?, ?, ?)`,
      [sourceId, '2024-07-16T12:00:00.000Z', JSON.stringify(current), JSON.stringify(daily), JSON.stringify([])],
    )
    const res = await app.request('/news-weather', {
      headers: { authorization: authHeader() },
    })
    const body = await res.text()
    expect(body).toContain('data-weather="ready"')
    // WMO code 0 → 'Helder' in Dutch.
    expect(body).toContain('Helder')
    // The temperature is rounded to whole degrees: 22 → 22
    expect(body).toContain('news-weather-temp-value">22<')
    // Current-condition icon is rendered.
    expect(body).toContain('class="news-weather-icon-current"')
    expect(body).toMatch(/<span class="news-weather-icon-current"[^>]*>\s*☀️/)
  })

  it('renders news cards when articles exist', async () => {
    db.run(
      `INSERT INTO news_sources
         (name, category, type, url, refresh_interval_min, enabled, created_at)
       VALUES ('VRT NWS', 'General', 'rss', 'https://www.vrt.be/vrtnws', 30, 1, '2024-07-16T12:00:00.000Z')`,
    )
    db.run(
      `INSERT INTO news_articles
         (id, source_id, title, description, url, published_at, fetched_at)
       VALUES ('a-1', 1, 'A news headline', 'A description', 'https://example.com/a-1', '2024-07-16T11:00:00.000Z', '2024-07-16T12:00:00.000Z')`,
    )
    const res = await app.request('/news-weather', {
      headers: { authorization: authHeader() },
    })
    const body = await res.text()
    expect(body).toContain('<h2>General</h2>')
    expect(body).toContain('A news headline')
    expect(body).toContain('A description')
    expect(body).toContain('href="https://example.com/a-1"')
    expect(body).toContain('target="_blank"')
  })

  it('includes the sidebar nav link to /news-weather', async () => {
    const res = await app.request('/news-weather', {
      headers: { authorization: authHeader() },
    })
    const body = await res.text()
    expect(body).toContain('href="/news-weather"')
    // Sidebar label + <title> are both interpolated raw
    // (they're controlled strings defined in view-shared.ts
    // and the route module respectively). The data attribute
    // is the stable identifier the JS uses to mark the active
    // space.
    expect(body).toContain('<span class="compartment-label">News & Weather</span>')
    expect(body).toContain('<title>News & Weather — Dashboard</title>')
    expect(body).toContain('data-sidebar-nav="news-weather"')
    // The space-active class on the link marks it as the
    // current page (the CSS targets this class).
    expect(body).toMatch(/<a class="compartment-button space-news-weather compartment-button-active"/)
  })
})
