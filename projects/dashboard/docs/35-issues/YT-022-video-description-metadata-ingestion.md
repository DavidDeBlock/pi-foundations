# YT-022 — YouTube video description metadata ingestion

**Labels**: `youtube`, `v3.4`, `api`, `needs-triage`
**Type**: AFK (YouTube API/manual smoke required)
**Parent**: [PRD-007](../35-prds/PRD-007-youtube-description-resources.md)

## What to build

Add the canonical storage and authenticated refresh path for raw YouTube video
descriptions. Every discovery source must converge on one bounded metadata
refresh service rather than fetching descriptions independently.

## Product rules

- RSS remains the discovery source; authenticated metadata enrichment follows
  through a bounded batch queue.
- Store the raw remote description, content fingerprint, lifecycle state, and
  refresh timestamps separately from locally editable video fields.
- A failed refresh preserves the last ready value as stale.
- Playlist, backfill, and RSS videos use the same canonical refresh path.
- Detail-page reads never fetch YouTube metadata implicitly.

## Acceptance criteria

- [ ] add a migration for `video_descriptions` with canonical video ownership,
  bounded lifecycle/error fields, timestamps, and cascade behavior
- [ ] implement a provider-isolated authenticated video metadata fetcher that
  batches IDs, validates response shape, bounds description length, times out,
  and returns typed per-video results
- [ ] implement an idempotent refresh service that fingerprints content and
  avoids rewriting unchanged descriptions
- [ ] missing, private, deleted, and no-description videos reach documented
  states without blocking other videos in the batch
- [ ] failed refresh retains the last ready description/fingerprint and exposes
  stale/error state rather than blanking it
- [ ] newly discovered videos can be queued for metadata enrichment with bounded
  concurrency/retry behavior and no duplicate active work
- [ ] playlist and subscription-backfill ingestion can request the same refresh
  without adding provider calls to their database transactions
- [ ] add authenticated read and explicit refresh endpoints with typed 404,
  pending, ready, stale, unavailable, and failure responses
- [ ] no route returns OAuth tokens or provider response internals
- [ ] tests cover migration preservation, batching, duplicate/missing response
  items, unchanged/changed fingerprints, timeout/auth/quota failure, restart
  behavior where applicable, auth, XSS-shaped descriptions, and secret-safe logs
- [ ] manual smoke refreshes the example video and confirms its full description
  is retained across restart and a forced refresh failure

## Blocked by

- [YT-008](./YT-008-canonical-youtube-library-foundation.md)

