import type { VideoSort, VideoSortOrder } from './youtube-videos.js'

export interface VideoDiscoveryQuery {
  readonly sort: VideoSort
  readonly order: VideoSortOrder
  readonly publishedFrom?: string
  readonly publishedTo?: string
}

export type VideoDiscoveryQueryResult =
  | { readonly ok: true; readonly value: VideoDiscoveryQuery }
  | { readonly ok: false; readonly error: string }

const SORTS: ReadonlySet<string> = new Set([
  'discovered_at',
  'published_at',
  'channel',
  'title',
])

/** Parse the URL-facing YT-016 controls once for both JSON and HTML routes. */
export function parseVideoDiscoveryQuery(input: {
  readonly sort?: string
  readonly order?: string
  readonly publishedFrom?: string
  readonly publishedTo?: string
}): VideoDiscoveryQueryResult {
  const sort = input.sort ?? 'discovered_at'
  const order = input.order ?? 'desc'
  const publishedFrom = input.publishedFrom === '' ? undefined : input.publishedFrom
  const publishedTo = input.publishedTo === '' ? undefined : input.publishedTo
  if (!SORTS.has(sort)) {
    return { ok: false, error: 'sort must be one of: discovered_at, published_at, channel, title' }
  }
  if (order !== 'asc' && order !== 'desc') {
    return { ok: false, error: 'order must be asc or desc' }
  }
  if (publishedFrom !== undefined && !isCalendarDate(publishedFrom)) {
    return { ok: false, error: 'published_from must be a valid date in YYYY-MM-DD format' }
  }
  if (publishedTo !== undefined && !isCalendarDate(publishedTo)) {
    return { ok: false, error: 'published_to must be a valid date in YYYY-MM-DD format' }
  }
  if (publishedFrom && publishedTo && publishedFrom > publishedTo) {
    return { ok: false, error: 'published_from must be on or before published_to' }
  }
  return {
    ok: true,
    value: {
      sort: sort as VideoSort,
      order,
      ...(publishedFrom ? { publishedFrom } : {}),
      ...(publishedTo ? { publishedTo } : {}),
    },
  }
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= daysInMonth[month - 1]!
}
