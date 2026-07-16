import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { upsertYouTubeVideo } from './youtube-video-upsert.js'
import {
  extractVideoDescriptionResources,
  getVideoDescriptionResources,
  normalizeResourceUrl,
  reconcileVideoDescriptionResources,
} from './youtube-description-resources.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

describe('description resource extraction', () => {
  it('extracts Markdown, plain, multiline, punctuation- and Unicode-adjacent URLs', () => {
    const description = `Resources:
[Source code](https://GitHub.com/Owner/Repo). Plain <https://docs.example.com/guide>，
Next line
https://工具.example/开始。 Duplicate https://github.com/Owner/Repo`
    const resources = extractVideoDescriptionResources(description)

    expect(resources).toHaveLength(3)
    expect(resources[0]).toMatchObject({
      label: 'Source code', canonicalUrl: 'https://github.com/Owner/Repo',
      category: 'repository', visibility: 'featured', sourcePositions: expect.any(Array),
    })
    expect(resources[0]?.sourcePositions).toHaveLength(2)
    expect(resources[1]?.canonicalUrl).toBe('https://docs.example.com/guide')
    expect(resources[2]?.canonicalUrl).toContain('xn--')
    expect(resources[2]?.canonicalUrl).not.toContain('。')
  })

  it('accepts only HTTP(S), skips malformed and oversized values, and treats scripts as inert text', () => {
    const huge = `https://example.com/${'a'.repeat(4_100)}`
    const resources = extractVideoDescriptionResources(
      `javascript:alert(1) ftp://example.com data:text/html,x ${huge} ` +
      `<script>bad()</script> https://safe.example/path?q=%zz`,
    )
    expect(resources).toHaveLength(1)
    expect(resources[0]?.canonicalUrl).toBe('https://safe.example/path?q=%25zz')
    expect(JSON.stringify(resources)).not.toContain('javascript:')
  })

  it('unwraps YouTube redirects, strips allow-listed tracking, and preserves identity parameters and fragments', () => {
    const wrapped = 'https://www.youtube.com/redirect?event=video_description&q=' +
      encodeURIComponent('https://Example.COM:443/docs?id=42&utm_source=youtube&ref=creator#install')
    const normalized = normalizeResourceUrl(wrapped)?.url.toString()
    expect(normalized).toBe('https://example.com/docs?id=42&ref=creator#install')
  })

  it.each([
    ['https://github.com/acme/project', 'repository', 'GitHub repository host'],
    ['https://docs.python.org/3/', 'documentation', 'Documentation host or path'],
    ['https://pypi.org/project/httpx/', 'tool', 'Software tool host or nearby label'],
    ['https://medium.com/@a/post', 'article', 'Article host or path'],
    ['https://huggingface.co/datasets/acme/data', 'dataset', 'Dataset host or path'],
    ['https://discord.gg/example', 'community', 'Community host or path'],
    ['https://patreon.com/creator', 'creator', 'Creator profile host'],
    ['https://x.com/creator', 'social', 'Social network host'],
    ['https://example.com/deal?aff_id=7', 'promotional', 'Affiliate parameter: aff_id'],
    ['https://例え.テスト/thing', 'other', 'No deterministic category matched'],
  ])('classifies %s explainably', (url, category, reason) => {
    expect(extractVideoDescriptionResources(url)[0]).toMatchObject({ category, reason })
  })

  it('uses nearby sponsor wording and does not silently remove unknown links', () => {
    const [sponsor, unknown] = extractVideoDescriptionResources(
      'Sponsor: use my code at https://vendor.example/product\nUnrelated https://unknown.example/page',
    )
    expect(sponsor).toMatchObject({ category: 'promotional', visibility: 'hidden' })
    expect(unknown).toMatchObject({ category: 'other', visibility: 'normal' })
  })

  it('separates the manual software-video fixture into useful, promotional, and other groups', () => {
    const resources = extractVideoDescriptionResources(`
      Code https://github.com/acme/widget
      Docs https://docs.acme.example/start
      Install https://pypi.org/project/widget
      Sponsor link https://vendor.example/buy?ref=channel
      Slides https://conference.example/slides
    `)
    expect(resources.map((resource) => resource.category)).toEqual([
      'repository', 'documentation', 'tool', 'promotional', 'other',
    ])
  })
})

describe('description resource reconciliation', () => {
  let db: Database
  let videoId: string

  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: MIGRATIONS_DIR })
    videoId = upsertYouTubeVideo(db, {
      videoId: 'resource-video', channelId: 'UCresources', channelTitle: 'Resources',
      title: 'Resource video', publishedAt: '2026-07-16T00:00:00.000Z',
      thumbnailUrl: null, link: 'https://youtube.com/watch?v=resource-video',
      origin: { type: 'manual' },
    }).id
  })

  afterEach(() => db.close())

  it('is idempotent, preserves stable IDs, marks removals inactive, and restores reappearances', () => {
    const description = 'Code https://github.com/acme/project and https://example.com/info'
    const first = reconcileVideoDescriptionResources(db, videoId, description, '2026-07-16T00:00:00Z')
    const repositoryId = first[0]!.id
    const repeated = reconcileVideoDescriptionResources(db, videoId, description, '2026-07-16T01:00:00Z')
    expect(repeated[0]?.id).toBe(repositoryId)

    reconcileVideoDescriptionResources(db, videoId, 'Only https://example.com/info', '2026-07-16T02:00:00Z')
    const inactive = getVideoDescriptionResources(db, videoId, true).find((resource) => resource.id === repositoryId)
    expect(inactive?.present).toBe(false)

    reconcileVideoDescriptionResources(db, videoId, description, '2026-07-16T03:00:00Z')
    expect(getVideoDescriptionResources(db, videoId).find((resource) => resource.id === repositoryId)?.present).toBe(true)
  })

  it('reclassifies automatic fields without overwriting a future non-deterministic effective decision', () => {
    const [resource] = reconcileVideoDescriptionResources(db, videoId, 'https://example.com/page')
    db.run(
      `UPDATE video_description_resources SET effective_category = 'documentation',
       effective_visibility = 'featured', effective_source = 'manual',
       effective_reason = 'My choice' WHERE id = ?`,
      [resource!.id],
    )
    reconcileVideoDescriptionResources(db, videoId, 'Sponsor: https://example.com/page')
    const changed = getVideoDescriptionResources(db, videoId)[0]!
    expect(changed).toMatchObject({
      id: resource!.id, automaticCategory: 'promotional',
      effectiveCategory: 'documentation', effectiveSource: 'manual',
    })
  })

  it('rolls back disappearance changes and inserts if reconciliation fails', () => {
    reconcileVideoDescriptionResources(db, videoId, 'https://example.com/keep')
    db.exec(`CREATE TRIGGER reject_resource BEFORE INSERT ON video_description_resources
      WHEN NEW.canonical_url = 'https://example.com/fail'
      BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`)
    expect(() => reconcileVideoDescriptionResources(db, videoId, 'https://example.com/fail')).toThrow('fixture failure')
    expect(getVideoDescriptionResources(db, videoId)).toHaveLength(1)
    expect(getVideoDescriptionResources(db, videoId)[0]?.canonicalUrl).toBe('https://example.com/keep')
  })
})
