import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { getPlaybackState, savePlayback } from './youtube-playback.js'
import { upsertYouTubeVideo } from './youtube-video-upsert.js'

describe('embedded YouTube playback tracking', () => {
  let db: Database
  let videoId: string
  beforeEach(async () => {
    db = new Database(':memory:')
    await runMigrations(db, { dir: resolve(process.cwd(), 'migrations') })
    videoId = upsertYouTubeVideo(db, { videoId:'dQw4w9WgXcQ', channelId:'UCaaaaaaaaaaaaaaaaaaaaaa', channelTitle:'Channel', title:'Video', publishedAt:'2026-01-01T00:00:00Z', thumbnailUrl:null, link:'https://www.youtube.com/watch?v=dQw4w9WgXcQ', origin:{type:'manual'} }).id
  })
  afterEach(() => db.close())

  it('creates one watch event and play count per player session', () => {
    const now = () => new Date('2026-07-18T10:00:00Z')
    savePlayback(db, { videoId, sessionId:'session_12345678', event:'playing', source:'search', positionSeconds:0, durationSeconds:100, }, now)
    savePlayback(db, { videoId, sessionId:'session_12345678', event:'paused', source:'search', positionSeconds:42, durationSeconds:100, }, now)
    expect(getPlaybackState(db, videoId)).toMatchObject({ positionSeconds:42, playCount:1, completed:false, lastSource:'search' })
    expect(db.get<{count:number}>('SELECT COUNT(*) AS count FROM youtube_watch_events')!.count).toBe(1)
    expect(db.get<{source:string;history_import_id:string|null}>('SELECT source,history_import_id FROM youtube_watch_events')).toEqual({ source:'search', history_import_id:null })
  })

  it('marks videos completed at 90 percent or when ended', () => {
    savePlayback(db, { videoId, sessionId:'session_abcdefgh', event:'playing', source:'embedded_player', positionSeconds:0, durationSeconds:200 })
    const state = savePlayback(db, { videoId, sessionId:'session_abcdefgh', event:'progress', source:'embedded_player', positionSeconds:180, durationSeconds:200 })
    expect(state.completed).toBe(true)
  })

  it('rejects invalid positions without changing state', () => {
    expect(() => savePlayback(db, { videoId, sessionId:'session_abcdefgh', event:'progress', source:'embedded_player', positionSeconds:-1, durationSeconds:200 })).toThrow('Invalid playback position')
    expect(getPlaybackState(db, videoId)).toBeNull()
  })
})
