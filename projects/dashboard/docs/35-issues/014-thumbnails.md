# 014 — Favicons + YouTube thumbnails

**Labels**: `v1`, `needs-triage`, `styling`
**Type**: AFK
**Parent**: [PRD-001](../35-prds/PRD-001-v1-chrome-bookmarks.md), [30-plans/styling-pass.md](../30-plans/styling-pass.md)

## What to build

Add visual identity to each card via favicon (normal bookmarks) or YouTube thumbnail (YouTube URLs). Helper function in `activity-feed.ts` populates the thumb slot left empty in slice 3.

### Helper: `getCardThumbnail(url)`

```ts
type Thumbnail =
  | { type: 'youtube'; src: string; alt: string }
  | { type: 'favicon'; src: string; alt: string }
  | null  // when URL parsing fails or we choose to hide

function getCardThumbnail(url: string): Thumbnail {
  const parsed = new URL(url)
  // YouTube detection
  const ytMatch = url.match(
    /^https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  )
  if (ytMatch) {
    return {
      type: 'youtube',
      src: `https://img.youtube.com/vi/${ytMatch[1]}/hqdefault.jpg`,
      alt: 'YouTube video thumbnail',
    }
  }
  // Generic favicon
  return {
    type: 'favicon',
    src: `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=64`,
    alt: `${parsed.hostname} favicon`,
  }
}
```

### Markup update

In `renderFeedItem`, populate the `.feed-item-thumb-slot`:

- YouTube: `<img class="feed-item-thumb feed-item-thumb-youtube" src="..." alt="..." loading="lazy">`
- Favicon: `<img class="feed-item-thumb feed-item-thumb-favicon" src="..." alt="..." loading="lazy">`
- `onerror="this.style.display='none'"` for graceful degradation when the image 404s (common for sites without favicons)

### CSS in `styles.css`

- `.feed-item-thumb-favicon { width: 32px; height: 32px; border-radius: 0.25rem; flex-shrink: 0; }`
- `.feed-item-thumb-youtube { width: 80px; height: 45px; border-radius: 0.375rem; object-fit: cover; flex-shrink: 0; }`
- `.feed-item-header` flex layout adjusts: `[source-badge] [spacer] [thumb]` for favicons, or `[source-badge] [thumb]` for YouTube (thumb bigger)

### Tests

- Unit test for `getCardThumbnail`:
  - YouTube watch URL → `type: 'youtube'` with correct video ID
  - youtu.be URL → `type: 'youtube'` with correct video ID
  - Generic URL → `type: 'favicon'` with hostname
  - Malformed URL → returns null (caller handles)

## Acceptance criteria

- [ ] `getCardThumbnail` helper exported and tested
- [ ] YouTube videos in feed render with the YouTube thumbnail (80×45px)
- [ ] All other bookmarks render with a 32×32 favicon
- [ ] Missing favicons gracefully hide (no broken-image icons)
- [ ] Images use `loading="lazy"` (don't block initial paint)
- [ ] Existing tests pass

## Blocked by

- 012 (card layout) — provides the `.feed-item-thumb-slot` container