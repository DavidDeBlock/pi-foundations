import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { YouTubeSearchService } from './youtube-search.js'

describe('YouTube search', () => {
  let db: Database
  beforeEach(async () => { db=new Database(':memory:'); await runMigrations(db,{dir:resolve(process.cwd(),'migrations')}) })
  afterEach(() => db.close())
  function response(url: string | URL | Request): Response {
    const path = new URL(String(url)).pathname
    return Response.json(path.endsWith('/search') ? { items:[{id:{videoId:'dQw4w9WgXcQ'}}] } : { items:[{ id:'dQw4w9WgXcQ', snippet:{title:'Result',channelId:'UCaaaaaaaaaaaaaaaaaaaaaa',channelTitle:'Channel',publishedAt:'2026-01-01T00:00:00Z',description:'Useful',thumbnails:{medium:{url:'https://img.test/a.jpg'}}}, contentDetails:{duration:'PT3M12S'}, statistics:{viewCount:'1200'}, status:{embeddable:true} }] })
  }

  it('submits search once, hydrates details, and caches normalized queries', async () => {
    const fetchFn=vi.fn(async(input:string|URL|Request)=>response(input)) as unknown as typeof fetch
    const service=new YouTubeSearchService({db,accessToken:async()=> 'token',fetchFn,nowMs:()=>0})
    const first=await service.search('  Useful   Video ')
    const second=await service.search('useful video')
    expect(first.items[0]).toMatchObject({videoId:'dQw4w9WgXcQ',durationSeconds:192,embeddable:true})
    expect(second.cached).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('uses the server-side API key without sending an OAuth bearer token', async () => {
    const fetchFn = vi.fn(async (input:string|URL|Request, init?:RequestInit) => {
      expect(new URL(String(input)).searchParams.get('key')).toBe('developer-key')
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      return response(input)
    }) as unknown as typeof fetch
    const service = new YouTubeSearchService({ db, apiKey:'developer-key', fetchFn })
    await service.search('public search')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('promotes a selected result into the canonical video library', async () => {
    const service=new YouTubeSearchService({db,accessToken:async()=> 'token',fetchFn:async(input)=>response(input)})
    const id=await service.open('dQw4w9WgXcQ')
    expect(db.get<{id:string;video_id:string}>('SELECT id,video_id FROM videos')).toEqual({id,video_id:'dQw4w9WgXcQ'})
    expect(await service.open('dQw4w9WgXcQ')).toBe(id)
  })

  it('does not misreport an OAuth scope failure as quota exhaustion', async () => {
    const service = new YouTubeSearchService({
      db,
      accessToken: async () => 'token',
      fetchFn: async () => Response.json({
        error: {
          code: 403,
          message: 'Request had insufficient authentication scopes.',
          errors: [{ reason: 'insufficientPermissions', message: 'Insufficient Permission' }],
        },
      }, { status: 403 }),
    })
    await expect(service.search('scope failure')).rejects.toThrow(
      'YouTube search needs a server-side API key',
    )
  })

  it('gives an actionable setup error when no public-search credential exists', async () => {
    const service = new YouTubeSearchService({ db, fetchFn:vi.fn() })
    await expect(service.search('missing key')).rejects.toThrow(
      'Set YOUTUBE_API_KEY and restart the dashboard',
    )
  })
})
