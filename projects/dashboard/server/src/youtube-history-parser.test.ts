import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TakeoutHistoryFormatError,
  TakeoutHistorySizeError,
  TakeoutWatchHistoryParser,
} from './youtube-history-parser.js'

describe('TakeoutWatchHistoryParser', () => {
  it('parses a sanitized real-shape export and retains repeated and removed watches', async () => {
    const input = await readFile(resolve(process.cwd(), 'src/fixtures/youtube-watch-history.sanitized.json'))
    const result = new TakeoutWatchHistoryParser().parse(input)
    expect(result.totalCount).toBe(4)
    expect(result.events).toHaveLength(3)
    expect(result.malformed).toEqual([{ index: 3, reason: 'Entry has no valid watch timestamp.' }])
    expect(result.events[0]).toMatchObject({
      videoId: 'abc123XYZ_0', title: 'A useful talk',
      channelId: 'UCexample123', channelTitle: 'Example Learning',
      watchedAt: '2026-07-10T10:30:00.000Z',
    })
    expect(result.events[1]?.fingerprint).not.toBe(result.events[0]?.fingerprint)
    expect(result.events[2]).toMatchObject({
      videoId: null, title: 'a video that has been removed',
    })
    expect(result.uniqueVideoIds).toEqual(new Set(['abc123XYZ_0']))
    expect(result.oldestWatchedAt).toBe('2026-07-10T10:30:00.000Z')
    expect(result.newestWatchedAt).toBe('2026-07-12T08:00:00.000Z')
  })

  it('normalizes supported watch URL variants deterministically', () => {
    const entries = [
      ['https://youtu.be/abc123XYZ_0?t=2', '2026-01-01T00:00:00Z'],
      ['https://youtube.com/shorts/def456XYZ_1', '2026-01-02T00:00:00Z'],
      ['https://m.youtube.com/live/ghi789XYZ_2', '2026-01-03T00:00:00Z'],
    ].map(([titleUrl, time]) => ({ title: 'Watched Video', titleUrl, time }))
    expect(new TakeoutWatchHistoryParser().parse(JSON.stringify(entries)).events.map((event) => event.videoId))
      .toEqual(['abc123XYZ_0', 'def456XYZ_1', 'ghi789XYZ_2'])
  })

  it('isolates malformed entries but rejects malformed and unsupported documents', () => {
    const parser = new TakeoutWatchHistoryParser()
    const result = parser.parse(JSON.stringify([null, { title: 'Watched X', time: 'bad' }]))
    expect(result.malformed).toHaveLength(2)
    expect(() => parser.parse('{nope')).toThrow(TakeoutHistoryFormatError)
    expect(() => parser.parse('{}')).toThrow('expected a watch-history JSON array')
  })

  it('enforces its configured byte bound before parsing', () => {
    const parser = new TakeoutWatchHistoryParser({ maxBytes: 10 })
    expect(() => parser.parse(' '.repeat(11))).toThrow(TakeoutHistorySizeError)
  })
})
