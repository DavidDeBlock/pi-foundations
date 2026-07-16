import { createHash } from 'node:crypto'

export const DEFAULT_TAKEOUT_MAX_BYTES = 25 * 1024 * 1024

export class TakeoutHistoryFormatError extends Error {}
export class TakeoutHistorySizeError extends Error {}

export interface ParsedWatchEvent {
  readonly videoId: string | null
  readonly watchedAt: string
  readonly title: string
  readonly channelId: string | null
  readonly channelTitle: string | null
  readonly fingerprint: string
}

export interface MalformedWatchEntry {
  readonly index: number
  readonly reason: string
}

export interface TakeoutWatchHistoryResult {
  readonly totalCount: number
  readonly events: ReadonlyArray<ParsedWatchEvent>
  readonly malformed: ReadonlyArray<MalformedWatchEntry>
  readonly uniqueVideoIds: ReadonlySet<string>
  readonly oldestWatchedAt: string | null
  readonly newestWatchedAt: string | null
}

/**
 * Parser for Google Takeout's YouTube `watch-history.json` export.
 *
 * JSON parsing is intentionally protected by a hard input cap. This keeps the
 * process memory bounded even though Node's native JSON parser is not
 * streaming. Individual malformed activities are isolated; only an invalid
 * root document makes the entire preview fail.
 */
export class TakeoutWatchHistoryParser {
  readonly maxBytes: number

  constructor(options: { readonly maxBytes?: number } = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_TAKEOUT_MAX_BYTES
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new Error('Takeout maximum upload size must be a positive integer.')
    }
  }

  parse(input: Buffer | string): TakeoutWatchHistoryResult {
    const bytes = typeof input === 'string' ? Buffer.byteLength(input) : input.byteLength
    if (bytes > this.maxBytes) {
      throw new TakeoutHistorySizeError(`Takeout file exceeds the ${this.maxBytes}-byte upload limit.`)
    }

    let value: unknown
    try {
      value = JSON.parse(typeof input === 'string' ? input : input.toString('utf8')) as unknown
    } catch {
      throw new TakeoutHistoryFormatError('Takeout file is not valid JSON.')
    }
    if (!Array.isArray(value)) {
      throw new TakeoutHistoryFormatError('Unsupported Takeout format: expected a watch-history JSON array.')
    }

    const events: ParsedWatchEvent[] = []
    const malformed: MalformedWatchEntry[] = []
    const uniqueVideoIds = new Set<string>()
    let oldestWatchedAt: string | null = null
    let newestWatchedAt: string | null = null

    value.forEach((entry, index) => {
      const parsed = parseEntry(entry)
      if ('reason' in parsed) {
        malformed.push({ index, reason: parsed.reason })
        return
      }
      events.push(parsed)
      if (parsed.videoId) uniqueVideoIds.add(parsed.videoId)
      if (oldestWatchedAt === null || parsed.watchedAt < oldestWatchedAt) oldestWatchedAt = parsed.watchedAt
      if (newestWatchedAt === null || parsed.watchedAt > newestWatchedAt) newestWatchedAt = parsed.watchedAt
    })

    return {
      totalCount: value.length,
      events,
      malformed,
      uniqueVideoIds,
      oldestWatchedAt,
      newestWatchedAt,
    }
  }
}

function parseEntry(entry: unknown): ParsedWatchEvent | { readonly reason: string } {
  if (!isRecord(entry)) return { reason: 'Entry is not an object.' }

  const time = typeof entry.time === 'string' ? entry.time : ''
  const watchedMs = Date.parse(time)
  if (!time || !Number.isFinite(watchedMs)) return { reason: 'Entry has no valid watch timestamp.' }
  const watchedAt = new Date(watchedMs).toISOString()

  const rawTitle = typeof entry.title === 'string' ? entry.title.trim() : ''
  if (!rawTitle) return { reason: 'Entry has no title snapshot.' }
  const title = normalizeTitle(rawTitle)
  if (!title) return { reason: 'Entry has no usable title snapshot.' }

  const titleUrl = typeof entry.titleUrl === 'string' ? entry.titleUrl.trim() : ''
  const videoId = normalizeVideoId(titleUrl)
  // A normal watch URL that cannot be understood is malformed. Removed and
  // private activities commonly omit titleUrl entirely and remain useful as
  // snapshot-only history events.
  if (titleUrl && !videoId) return { reason: 'Entry has an unsupported YouTube watch URL.' }

  const subtitle = Array.isArray(entry.subtitles)
    ? entry.subtitles.find(isRecord)
    : undefined
  const channelTitle = subtitle && typeof subtitle.name === 'string' && subtitle.name.trim()
    ? subtitle.name.trim()
    : null
  const channelUrl = subtitle && typeof subtitle.url === 'string' ? subtitle.url : ''
  const channelId = normalizeChannelId(channelUrl)

  const identity = videoId
    ? `video:${videoId}`
    : `snapshot:${title}\n${channelId ?? ''}\n${channelTitle ?? ''}`
  const fingerprint = createHash('sha256')
    .update(`youtube-watch\n${identity}\n${watchedAt}`)
    .digest('hex')

  return { videoId, watchedAt, title, channelId, channelTitle, fingerprint }
}

function normalizeTitle(value: string): string {
  return value.replace(/^Watched\s+/i, '').trim()
}

function normalizeVideoId(value: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    let candidate: string | null = null
    if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
      if (url.pathname === '/watch') candidate = url.searchParams.get('v')
      else {
        const match = url.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)
        candidate = match?.[1] ?? null
      }
    } else if (hostname === 'youtu.be') {
      candidate = url.pathname.split('/').filter(Boolean)[0] ?? null
    }
    return candidate && /^[A-Za-z0-9_-]{6,64}$/.test(candidate) ? candidate : null
  } catch {
    return null
  }
}

function normalizeChannelId(value: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    if (hostname !== 'youtube.com' && !hostname.endsWith('.youtube.com')) return null
    const match = url.pathname.match(/^\/channel\/([^/?#]+)/)
    return match?.[1] && /^[A-Za-z0-9_-]{3,128}$/.test(match[1]) ? match[1] : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
