import { createHash } from 'node:crypto'

export const DEFAULT_TAKEOUT_MAX_BYTES = 64 * 1024 * 1024

export class TakeoutHistoryFormatError extends Error {}
export class TakeoutHistorySizeError extends Error {}

export interface ParsedWatchEvent {
  readonly videoId: string | null
  readonly watchedAt: string
  readonly title: string
  readonly channelId: string | null
  readonly channelTitle: string | null
  readonly fingerprint: string
  /** True only when Takeout retained an explicit /shorts/ source URL. */
  readonly knownShort: boolean
}

export interface MalformedWatchEntry {
  readonly index: number
  readonly reason: string
}

export interface TakeoutWatchHistoryResult {
  readonly format: 'json' | 'html'
  readonly totalCount: number
  readonly events: ReadonlyArray<ParsedWatchEvent>
  readonly malformed: ReadonlyArray<MalformedWatchEntry>
  readonly uniqueVideoIds: ReadonlySet<string>
  readonly oldestWatchedAt: string | null
  readonly newestWatchedAt: string | null
}

/**
 * Parser for Google Takeout's YouTube `watch-history.json` and legacy
 * `watch-history.html` exports.
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

    const source = typeof input === 'string' ? input : input.toString('utf8')
    if (/^\s*</.test(source)) return parseHtmlDocument(source)

    let value: unknown
    try {
      value = JSON.parse(source) as unknown
    } catch {
      throw new TakeoutHistoryFormatError('Takeout file is neither valid JSON nor supported Takeout HTML.')
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
      format: 'json',
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

  return { videoId, watchedAt, title, channelId, channelTitle, fingerprint, knownShort: isShortUrl(titleUrl) }
}

function parseHtmlDocument(source: string): TakeoutWatchHistoryResult {
  if (!/<title>My Activity History<\/title>/i.test(source) || !/class="outer-cell/i.test(source)) {
    throw new TakeoutHistoryFormatError('Unsupported HTML: expected a Google My Activity history export.')
  }

  const cards = source.split(/(?=<div class="outer-cell\b)/i).slice(1)
  const events: ParsedWatchEvent[] = []
  const malformed: MalformedWatchEntry[] = []
  const uniqueVideoIds = new Set<string>()
  let oldestWatchedAt: string | null = null
  let newestWatchedAt: string | null = null

  cards.forEach((card, index) => {
    const content = card.match(/<div class="content-cell[^>]*mdl-typography--body-1">([\s\S]*?)<\/div>/i)?.[1]
    if (!content) {
      malformed.push({ index, reason: 'Activity has no content cell.' })
      return
    }
    const action = htmlText(content.split(/<a\s/i, 1)[0] ?? '')
    if (action.toLowerCase() !== 'watched') {
      malformed.push({ index, reason: 'Activity is not a YouTube watch event.' })
      return
    }
    const anchors = [...content.matchAll(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    const titleUrl = decodeHtml(anchors[0]?.[1] ?? '')
    const title = htmlText(anchors[0]?.[2] ?? '')
    const videoId = normalizeVideoId(titleUrl)
    if (!title || !videoId) {
      malformed.push({ index, reason: !title ? 'Entry has no usable title snapshot.' : 'Entry has an unsupported YouTube watch URL.' })
      return
    }
    const watchedAt = parseHtmlTimestamp(content)
    if (!watchedAt) {
      malformed.push({ index, reason: 'Entry has no valid watch timestamp.' })
      return
    }
    const channelAnchor = anchors.slice(1).find((anchor) => normalizeChannelId(decodeHtml(anchor[1] ?? '')) !== null)
    const channelUrl = decodeHtml(channelAnchor?.[1] ?? '')
    const channelTitle = channelAnchor ? htmlText(channelAnchor[2] ?? '') || null : null
    const channelId = normalizeChannelId(channelUrl)
    const fingerprint = createHash('sha256')
      .update(`youtube-watch\nvideo:${videoId}\n${watchedAt}`)
      .digest('hex')
    const event: ParsedWatchEvent = {
      videoId, watchedAt, title, channelId, channelTitle, fingerprint,
      knownShort: isShortUrl(titleUrl),
    }
    events.push(event)
    uniqueVideoIds.add(videoId)
    if (oldestWatchedAt === null || watchedAt < oldestWatchedAt) oldestWatchedAt = watchedAt
    if (newestWatchedAt === null || watchedAt > newestWatchedAt) newestWatchedAt = watchedAt
  })

  return {
    format: 'html', totalCount: cards.length, events, malformed, uniqueVideoIds,
    oldestWatchedAt, newestWatchedAt,
  }
}

function parseHtmlTimestamp(content: string): string | null {
  const text = decodeHtml(content)
  const match = text.match(/(?:^|<br\s*\/?>)([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)\s+([A-Z]{2,5})(?=<br\s*\/?>|$)/i)
  if (!match) return null
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  }
  const month = months[capitalize(match[1]!)]
  const offsets: Record<string, number> = { UTC: 0, GMT: 0, CET: 60, CEST: 120 }
  const offset = offsets[match[8]!.toUpperCase()]
  if (month === undefined || offset === undefined) return null
  const hour = (Number(match[4]) % 12) + (match[7]!.toUpperCase() === 'PM' ? 12 : 0)
  const value = Date.UTC(Number(match[3]), month, Number(match[2]), hour, Number(match[5]), Number(match[6])) - offset * 60_000
  return Number.isFinite(value) ? new Date(value).toISOString() : null
}

function htmlText(value: string): string {
  return decodeHtml(value.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeHtml(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|quot|apos|#39|lt|gt|nbsp);/gi, (entity, code: string) => {
    const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", '#39': "'", lt: '<', gt: '>', nbsp: ' ' }
    const lower = code.toLowerCase()
    if (named[lower] !== undefined) return named[lower]
    const numeric = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10)
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : entity
  })
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase()
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

function isShortUrl(value: string): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    return (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) && /^\/shorts\//.test(url.pathname)
  } catch {
    return false
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
