// youtube-videos-view.test.ts — issue YT-005
//
// Server-rendered `/videos` page tests.
//
// Coverage:
//   * 401 unauthenticated
//   * 200 with the expected scaffold (heading, form, list, pagination)
//   * Filter dropdowns reflect URL state (channel/folder/tag selected)
//   * Empty-state copy: (a) zero videos; (b) filters cause empty result
//   * Pagination links preserve the active filters
//   * One row renders per video with title + channel + folder + tags
//   * HTML escaping for channel titles (XSS defence)

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { auth, type AuthVariables } from './auth.js'
import { InMemoryTokenStore } from './token-store.js'
import { youtubeVideosView } from './youtube-videos-view.js'
import { insertVideo, type VideoInsertInput } from './youtube-videos.js'
import { upsertSubscription } from './youtube-subscriptions.js'

const PASSWORD = 'secret'
const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

interface TestEnv {
  db: Database
  app: Hono<{ Variables: AuthVariables }>
  seed(overrides?: Partial<VideoInsertInput>): string
  raw(overrides?: Partial<VideoInsertInput>): VideoInsertInput
}

let env: TestEnv

beforeEach(async () => {
  const db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  db.run(
    `INSERT INTO youtube_accounts
       (id, provider, google_user_id, email_address,
        access_token_enc, refresh_token_enc, scopes)
     VALUES (?, 'youtube', 'g-1', 'd@example.com', 'x', 'y', 'youtube.readonly')`,
    ['acct-1'],
  )
  upsertSubscription(db, {
    googleAccountId: 'acct-1',
    channelId: 'UCaaaaaaa000000000000aab',
    channelTitle: 'Alpha',
    channelThumbnailUrl: null,
    subscribedAt: '2024-01-01T00:00:00.000Z',
  })
  upsertSubscription(db, {
    googleAccountId: 'acct-1',
    channelId: 'UCbbbbbbb000000000000bab',
    channelTitle: 'Beta',
    channelThumbnailUrl: null,
    subscribedAt: '2024-01-01T00:00:00.000Z',
  })

  const passwordHash = await bcrypt.hash(PASSWORD, 4)
  const tokenStore = new InMemoryTokenStore()
  const view = youtubeVideosView({ db })
  const app = new Hono<{ Variables: AuthVariables }>()
  app.use('*', auth({ passwordHash, tokenStore }))
  app.route('/videos', view)
  env = {
    db,
    app,
    raw(overrides: Partial<VideoInsertInput> = {}) {
      return {
        videoId: overrides.videoId ?? 'dQw4w9WgXcQ',
        channelId: overrides.channelId ?? 'UCaaaaaaa000000000000aab',
        title: overrides.title ?? 'Never Gonna Give You Up',
        publishedAt: overrides.publishedAt ?? '2009-10-25T06:57:33.000Z',
        thumbnailUrl:
          overrides.thumbnailUrl !== undefined
            ? overrides.thumbnailUrl
            : 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        link: overrides.link ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      }
    },
    seed(overrides: Partial<VideoInsertInput> = {}) {
      const r = insertVideo(db, this.raw(overrides))
      return r.id
    },
  }
})

afterEach(() => {
  env.db.close()
})

function basic(p: string): string {
  return `Basic ${Buffer.from(`david:${p}`).toString('base64')}`
}

async function get(
  app: Hono<{ Variables: AuthVariables }>,
  path: string,
): Promise<Response> {
  return app.request(path, {
    headers: { authorization: basic(PASSWORD) },
  })
}

async function getText(res: Response): Promise<string> {
  return res.text()
}

// ─── Auth ──────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('returns 401 unauthenticated', async () => {
    const res = await env.app.request('/videos')
    expect(res.status).toBe(401)
  })
})

// ─── Scaffold ──────────────────────────────────────────────────────────────

describe('GET /videos', () => {
  it('renders 200 with the heading + filter form + list on a fresh dashboard', async () => {
    const res = await get(env.app, '/videos')
    expect(res.status).toBe(200)
    const html = await getText(res)
    expect(html).toContain('<h1>New videos</h1>')
    expect(html).toContain('data-videos-filters')
    expect(html).toContain('data-videos-channel')
    expect(html).toContain('data-videos-folder')
    expect(html).toContain('data-videos-tag')
    // Empty-state copy when there are no videos
    expect(html).toContain('No videos yet')
  })

  it('renders the YouTube sidebar with Videos active + links to /subscriptions + /settings/youtube', async () => {
    const html = await getText(await get(env.app, '/videos'))
    expect(html).toMatch(/class="context-link context-link-active"[^>]*href="\/videos"/)
    expect(html).toContain('href="/videos"')
    expect(html).toContain('href="/subscriptions"')
    expect(html).toContain('href="/settings/youtube"')
  })
})

// ─── Empty states ─────────────────────────────────────────────────────────

describe('GET /videos — empty states', () => {
  it('"no videos yet" with a "Poll now" CTA when DB is empty', async () => {
    const html = await getText(await get(env.app, '/videos'))
    expect(html).toContain('No videos yet')
    expect(html).toContain('data-videos-poll')
    expect(html).toContain('After YouTube is connected')
  })

  it('"no videos match" when filters exclude everything', async () => {
    env.seed({ videoId: 'aaaaaaaaaa1' })
    const html = await getText(
      await get(env.app, '/videos?channel_id=UCbbbbbbb000000000000bab'),
    )
    expect(html).toContain('No videos match those filters')
    expect(html).toContain('Clear filters')
  })

  it('"No videos match" path does NOT show the "Poll now" button', async () => {
    env.seed({ videoId: 'aaaaaaaaaa1' })
    const html = await getText(
      await get(env.app, '/videos?channel_id=UCbbbbbbb000000000000bab'),
    )
    expect(html).not.toContain('data-videos-poll')
  })
})

// ─── Rows ────────────────────────────────────────────────────────────────

describe('GET /videos — row rendering', () => {
  it('renders one <li data-videos-row> per video with a detail-page link', async () => {
    env.seed({ videoId: 'aaaaaaaaaa1', title: 'Title A' })
    env.seed({ videoId: 'aaaaaaaaaa2', title: 'Title B' })
    const html = await getText(await get(env.app, '/videos'))
    const matches = html.match(/data-videos-row /g) ?? []
    expect(matches.length).toBe(2)
    expect(html).toContain('href="/videos')
    expect(html).toContain('Title A')
    expect(html).toContain('Title B')
  })

  it('renders the title, channel, and published_at for each row', async () => {
    env.seed({ videoId: 'aaaaaaaaaa1', title: 'Title A' })
    const html = await getText(await get(env.app, '/videos'))
    expect(html).toContain('Title A')
    expect(html).toContain('videos-row-channel')
    // Date rendered via <time datetime="...">
    expect(html).toMatch(/<time datetime="2009-10-25/)
  })

  it('renders the folder name when present, "Unfoldered" otherwise', async () => {
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`)
    env.seed({ videoId: 'aaa-foldered' })
    env.seed({ videoId: 'bbb-not' })
    env.db.run(`UPDATE videos SET folder_id = 'f-1' WHERE video_id = 'aaa-foldered'`)
    const html = await getText(await get(env.app, '/videos'))
    expect(html).toContain('Work')
    expect(html).toContain('Unfoldered')
  })

  it('renders tag chips per attached tag', async () => {
    const id = env.seed({ videoId: 'aaa-tagged' })
    env.db.run(
      `INSERT INTO tags (id, name) VALUES ('tt-1', 'launch'), ('tt-2', 'queue')`,
    )
    env.db.run(
      `INSERT INTO video_tags (video_id, tag_id) VALUES (?, 'tt-1'), (?, 'tt-2')`,
      [id, id],
    )
    const html = await getText(await get(env.app, '/videos'))
    expect(html).toContain('launch')
    expect(html).toContain('queue')
    expect(html).toContain('data-videos-row-tag="tt-1"')
    expect(html).toContain('data-videos-row-tag="tt-2"')
  })

  it('HTML-escapes channel titles (XSS defence)', async () => {
    env.seed({
      videoId: 'aaaaaaaaaa1',
      title: '<script>alert(1)</script>',
    })
    const html = await getText(await get(env.app, '/videos'))
    // Raw tag in title is escaped.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('shows playlist badges once on canonical cards and supports playlist library filters', async () => {
    const id = env.seed({ videoId: 'playlist-card', title: 'Playlist card' })
    env.db.run(
      `INSERT INTO youtube_playlists
       (google_account_id, playlist_id, title, privacy_status, is_included)
       VALUES ('acct-1', 'PL-one', 'Research & notes', 'private', 1)`,
    )
    env.db.run(
      `INSERT INTO youtube_playlist_items
       (google_account_id, playlist_id, playlist_item_id, video_id, position, synced_at)
       VALUES ('acct-1', 'PL-one', 'item-one', ?, 0, '2026-07-16T00:00:00Z')`,
      [id],
    )
    const html = await getText(await get(env.app, '/videos?source=playlist&playlist_id=PL-one'))
    expect(html).toContain('Playlist card')
    expect(html).toContain('Research &amp; notes')
    expect(html).toContain('class="videos-row-playlist"')
    expect(html).toContain('value="playlist" selected')
    expect(html).toContain('value="PL-one" selected')
  })

  it('shows watched count/last-watch metadata and an unwatched-only persistent control', async () => {
    const id = env.seed({ videoId: 'watched-card', title: 'Watched card' })
    env.db.run(`INSERT INTO youtube_history_imports
      (id,file_hash,original_filename,staged_filename,status,total_count,new_event_count,duplicate_count,
       malformed_count,unique_video_count,new_video_count,committed_event_count,created_at,expires_at,committed_at)
      VALUES ('view-import','hash','history.json','gone.json','committed',2,2,0,0,1,0,2,
       '2026-07-16T00:00:00Z','2026-07-17T00:00:00Z','2026-07-16T00:00:00Z')`)
    for (const [eventId, watchedAt] of [['one','2026-07-15T00:00:00Z'],['two','2026-07-16T00:00:00Z']]) {
      env.db.run(`INSERT INTO youtube_watch_events
        (id,video_id,youtube_video_id,watched_at,title_snapshot,event_fingerprint,history_import_id,created_at)
        VALUES (?,?,?,?,?,?, 'view-import','2026-07-16T00:00:00Z')`,
      [eventId, id, 'watched-card', watchedAt, 'Watched card', `fp-${eventId}`])
    }
    const html = await getText(await get(env.app, '/videos'))
    expect(html).toContain('Watched · 2×')
    expect(html).toContain('Last watched 2026-07-16 00:00 UTC')
    expect(html).toContain('data-videos-unwatched')
    expect(html).toContain('dashboard.youtube.unwatched-only')
    const filtered = await getText(await get(env.app, '/videos?unwatched=true'))
    expect(filtered).not.toContain('Watched card')
    expect(filtered).toContain('name="unwatched" value="true" checked')
  })
})

// ─── Filter dropdown state ──────────────────────────────────────────────

describe('GET /videos — filter dropdowns', () => {
  it('channels listed in the dropdown come from included subscriptions only', async () => {
    // Add an excluded channel that must NOT appear in the dropdown.
    env.db.run(`UPDATE subscriptions SET is_included = 0 WHERE channel_id = 'UCbbbbbbb000000000000bab'`)
    const html = await getText(await get(env.app, '/videos'))
    expect(html).toContain('UCaaaaaaa000000000000aab') // included — should appear
    expect(html).not.toContain('UCbbbbbbb000000000000bab') // excluded — must NOT
  })

  it('channel dropdown marks the active option as selected', async () => {
    env.seed({ videoId: 'aaaaaaaaaa1' })
    const html = await getText(
      await get(env.app, '/videos?channel_id=UCaaaaaaa000000000000aab'),
    )
    expect(html).toContain(
      `<option value="UCaaaaaaa000000000000aab" selected>Alpha</option>`,
    )
  })

  it('folder dropdown includes All/Unfoldered + every folder', async () => {
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`)
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('f-2', NULL, 'Personal')`)
    const html = await getText(await get(env.app, '/videos'))
    expect(html).toContain('value="all"')
    expect(html).toContain('value="none"')
    expect(html).toContain('>Work (')
    expect(html).toContain('>Personal (')
  })

  it('folder dropdown marks the active option as selected', async () => {
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`)
    env.seed({ videoId: 'aaaaaaaaaa1' })
    const html = await getText(await get(env.app, '/videos?folder_id=f-1'))
    expect(html).toContain(`<option value="f-1" selected>Work`)
  })

  it('folder=none selects the Unfoldered option', async () => {
    const html = await getText(await get(env.app, '/videos?folder_id=none'))
    expect(html).toContain('value="none" selected')
  })

  it('tag dropdown marks the active option as selected', async () => {
    env.db.run(`INSERT INTO tags (id, name) VALUES ('tt-1', 'launch')`)
    env.seed({ videoId: 'aaaaaaaaaa1' })
    env.db.run(
      `INSERT INTO video_tags (video_id, tag_id) VALUES ((SELECT id FROM videos WHERE video_id = 'aaaaaaaaaa1'), 'tt-1')`,
    )
    const html = await getText(await get(env.app, '/videos?tag_id=tt-1'))
    expect(html).toContain(`<option value="tt-1" selected>launch</option>`)
  })
})

// ─── Counts line ────────────────────────────────────────────────────────

describe('GET /videos — counts line', () => {
  it('"0 videos — nothing matches" when filters exclude everything', async () => {
    env.seed({ videoId: 'aaaaaaaaaa1' })
    const html = await getText(
      await get(env.app, '/videos?channel_id=UCbbbbbbb000000000000bab'),
    )
    expect(html).toMatch(/<strong>0<\/strong> videos\s*\u2014 nothing matches/)
  })

  it('"N videos" plural form', async () => {
    env.seed({ videoId: 'aaaaaaaaaa1' })
    env.seed({ videoId: 'aaaaaaaaaa2' })
    const html = await getText(await get(env.app, '/videos'))
    expect(html).toMatch(/<strong>2<\/strong> videos/)
  })

  it('"1 video" singular form', async () => {
    env.seed({ videoId: 'aaaaaaaaaa1' })
    const html = await getText(await get(env.app, '/videos'))
    expect(html).toMatch(/<strong>1<\/strong> video\b/)
  })
})

// ─── Pagination ─────────────────────────────────────────────────────────

describe('GET /videos — pagination', () => {
  it('hides pagination when total ≤ limit', async () => {
    env.seed({ videoId: 'aaaaaaaaaa1' })
    const html = await getText(await get(env.app, '/videos'))
    // The CSS class on its own appears in the <style> block; check
    // the markup element, not the class selector string.
    expect(html).not.toMatch(/<nav class="videos-pagination"/)
  })

  it('renders Previous/Next with filter params preserved when total > limit', async () => {
    for (let i = 0; i < 5; i++) env.seed({ videoId: 'aaaaaaaaaa' + i })
    const html = await getText(
      await get(env.app, '/videos?channel_id=UCaaaaaaa000000000000aab&limit=2'),
    )
    expect(html).toMatch(/<nav class="videos-pagination"/)
    expect(html).toContain('Page 1 of 3')
    // Filter params must survive on the next/prev links
    expect(html).toContain('channel_id=UCaaaaaaa000000000000aab')
  })
})
