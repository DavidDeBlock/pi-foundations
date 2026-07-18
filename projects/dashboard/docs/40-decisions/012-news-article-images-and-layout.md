# ADR-012: Feed-owned article images + structured text-first news layout

**Status**: Accepted  
**Date**: 2026-07-18

## Context

The News & Weather page is useful but visually flat. Some configured publishers expose article artwork through Media RSS, enclosures, or HTML feed content; others provide no item-level image. Scraping publisher pages would add latency, fragility, and new failure modes to the ingestion pipeline.

## Decision

- `news_articles.image_url` stores optional presentation metadata supplied by the feed.
- RSS/Atom fetchers may read Media RSS, image enclosures, and the first image in item content. Only absolute HTTP(S) URLs survive normalization.
- Article pages are not scraped for missing images. Text-only rows are the default UI state; no decorative image placeholders are rendered.
- Re-polling an existing article may fill a previously null image URL without changing its identity or insertion count.
- The page presents weather first, then a category jump bar and responsive, separated article rows. A thumbnail is added only when the article actually has an image URL.
- Images remain remote publisher assets and are lazy-loaded; the dashboard does not copy or proxy them.

## Consequences

Publishers such as HLN can provide richer rows immediately, while VRT, De Tijd, CCB, and any intermittently missing media remain fully usable without empty artwork. Remote images can fail or disappear. No additional article-page requests or image storage are introduced.

## Relation to ADR-010

This extends ADR-010's normalized article shape and presentation only. Source registry, article identity, retention, scheduling, and failure-isolation rules are unchanged.
