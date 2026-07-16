import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { auth, type AuthVariables } from './auth.js'
import { InMemoryTokenStore } from './token-store.js'
import { youtubeHistoryView } from './youtube-history-view.js'
import { youtubeHistoryApi } from './youtube-history-api.js'
import { YouTubeHistoryImports } from './youtube-history-imports.js'
import { upsertYouTubeVideo } from './youtube-video-upsert.js'
import { attachTagByNameToSubscription, upsertSubscription } from './youtube-subscriptions.js'

const PASSWORD = 'secret'
const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')
let db: Database
let app: Hono<{ Variables: AuthVariables }>

beforeEach(async () => {
  db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  const passwordHash = await bcrypt.hash(PASSWORD, 4)
  const imports = new YouTubeHistoryImports({ db, dataDir: `/tmp/dashboard-history-view-${crypto.randomUUID()}` })
  app = new Hono<{ Variables: AuthVariables }>()
  app.use('*', auth({ passwordHash, tokenStore: new InMemoryTokenStore() }))
  app.route('/history', youtubeHistoryView({ db }))
  app.route('/api/youtube/history', youtubeHistoryApi({ db, imports }))
})

afterEach(() => db.close())

function headers(): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`david:${PASSWORD}`).toString('base64')}` }
}

function importRow(): void {
  db.run(`INSERT INTO youtube_history_imports
    (id,file_hash,original_filename,staged_filename,status,total_count,new_event_count,
     duplicate_count,malformed_count,unique_video_count,new_video_count,committed_event_count,
     created_at,expires_at,committed_at)
    VALUES ('import-1','abcdef1234567890','history.json','gone.json','committed',3,3,0,0,2,1,3,
      '2026-07-16T00:00:00Z','2026-07-17T00:00:00Z','2026-07-16T00:01:00Z')`)
}

function event(id: string, videoId: string | null, watchedAt: string, title: string): void {
  db.run(`INSERT INTO youtube_watch_events
    (id,video_id,youtube_video_id,watched_at,title_snapshot,channel_title_snapshot,event_fingerprint,history_import_id,created_at)
    VALUES (?,?,?,?,?,?,?,'import-1','2026-07-16T00:01:00Z')`,
  [id, videoId, videoId ? 'knownVideo1' : null, watchedAt, title, '<script>channel()</script>', `fp-${id}`])
}

describe('History UI and API', () => {
  it('requires dashboard authentication', async () => {
    expect((await app.request('/history')).status).toBe(401)
    expect((await app.request('/api/youtube/history')).status).toBe(401)
  })

  it('renders an actionable no-import state', async () => {
    const response = await app.request('/history', { headers: headers() })
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('No watch history imported')
    expect(html).toContain('/settings/youtube#watch-history-import')
  })

  it('lists reverse-chronological events, repeat counts, canonical links, UTC dates, and escaped snapshots', async () => {
    importRow()
    db.run(`INSERT INTO youtube_accounts
      (id,provider,google_user_id,email_address,access_token_enc,refresh_token_enc,scopes)
      VALUES ('account-1','youtube','google-1','d@example.com','x','y','youtube.readonly')`)
    const subscriptionId = upsertSubscription(db, {
      googleAccountId: 'account-1', channelId: 'UC-history-only', channelTitle: 'History channel',
      channelThumbnailUrl: null, subscribedAt: '2026-01-01T00:00:00Z',
    }).id
    attachTagByNameToSubscription(db, subscriptionId, 'research')
    const video = upsertYouTubeVideo(db, {
      videoId: 'knownVideo1', channelId: 'UC-history-only', channelTitle: 'History channel',
      title: 'Canonical title', publishedAt: '2026-07-01T00:00:00Z', thumbnailUrl: null,
      link: 'https://youtube.com/watch?v=knownVideo1', origin: null,
    }).id
    event('event-old', video, '2026-07-10T08:00:00Z', 'Old snapshot')
    event('event-new', video, '2026-07-15T09:30:00Z', 'New snapshot')
    event('event-gone', null, '2026-07-12T10:00:00Z', '<img src=x onerror=alert(1)>')

    const html = await (await app.request('/history', { headers: headers() })).text()
    expect(html.indexOf('Jul 15, 2026')).toBeLessThan(html.indexOf('Jul 12, 2026'))
    expect(html).toContain('↻ 2×')
    expect(html).toContain(`href="/videos/${video}"`)
    expect(html).toContain('UTC')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).toContain('&lt;script&gt;channel()&lt;/script&gt;')
    expect(html).toContain('↳research')
    expect(html).toContain('Inherited from subscription')
    expect(html).toContain('Your viewing archive')
    expect(html).toContain('Replay moments')
    expect(html).toContain('In your library')
    expect(html).toContain('id="history-q"')
    expect(html).toContain('id="history-channel"')
    expect(html).toContain('id="history-tag"')
    expect(html).toContain('class="history-grid"')
    expect(html).toContain('src="https://i.ytimg.com/vi/knownVideo1/hqdefault.jpg"')
    expect(html).toContain('loading="lazy" decoding="async"')
    expect(html).toContain("onerror=\"this.style.display='none'\"")
    expect(html).toContain('class="history-thumb-fallback"')
    expect(html).toContain('.history-main { display:block;')
    expect(html).toContain('grid-template-columns:repeat(auto-fill,minmax(min(270px,100%),1fr))')

    const snapshots = await (await app.request('/history?availability=snapshot', { headers: headers() })).text()
    expect(snapshots).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(snapshots).not.toContain('Canonical title')

    const tagged = await (await app.request('/history?tag_id=' + encodeURIComponent(
      db.get<{ id: string }>("SELECT id FROM tags WHERE name = 'research'")!.id,
    ), { headers: headers() })).text()
    expect(tagged).toContain('Canonical title')
    expect(tagged).not.toContain('&lt;img src=x onerror=alert(1)&gt;')

    const oldest = await (await app.request('/history?sort=oldest', { headers: headers() })).text()
    expect(oldest.indexOf('Jul 10, 2026')).toBeLessThan(oldest.indexOf('Jul 15, 2026'))

    const searched = await (await app.request('/history?q=canonical&watched_from=2026-07-13', { headers: headers() })).text()
    expect(searched).toContain('Jul 15, 2026')
    expect(searched).not.toContain('Jul 10, 2026')
    expect(searched).not.toContain('&lt;img src=x onerror=alert(1)&gt;')

    const body = await (await app.request('/api/youtube/history', { headers: headers() })).json() as { items: Array<{ watch_count: number; video_id: string | null }> }
    expect(body.items).toHaveLength(3)
    expect(body.items.filter((item) => item.video_id === video).map((item) => item.watch_count)).toEqual([2, 2])
  })
})
