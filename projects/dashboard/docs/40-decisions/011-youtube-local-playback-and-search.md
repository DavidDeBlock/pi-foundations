# ADR-011 — Local YouTube playback tracking and search

**Status:** Accepted  
**Date:** 2026-07-18

## Context

Google does not expose a normal API for complete YouTube watch history. The
dashboard already imports Takeout watch events and embeds videos, but the
embedded player previously did not update local watch state. Discovery was
also limited to videos already ingested from subscriptions, playlists, or
Takeout.

## Decision

The dashboard records playback that occurs inside its embedded YouTube player
through the IFrame Player API. Imported and in-app starts share the canonical
`youtube_watch_events` event log and carry an explicit source. Mutable resume,
duration, completion, and play-count state lives separately in
`youtube_playback_state`; a unique player session creates at most one watch
event and one play-count increment. Completion defaults to 90 percent or an
ended event.

YouTube Data API search uses a restricted server-side developer key, runs only
on form submission, and is cached locally for one hour. OAuth remains limited
to `youtube.readonly` for private account data rather than expanding to a
broader scope merely to search public videos. Search results remain transient until the user chooses Play, at which
point the existing canonical video upsert promotes the selected result into
the library with manual/search provenance.

The local database is the source of truth for dashboard playback state. No
state is written back to YouTube, and activity outside dashboard embeds remains
available only through later Takeout imports.

## Consequences

- Continue/resume and watched filters can use reliable local state for embeds.
- Imported and embedded watches remain distinguishable without parallel video
  records.
- Search quota is consumed only by explicit submissions and cache misses.
- Embed-disabled, private, age-restricted, regional, or authentication-bound
  videos still require the explicit YouTube fallback.
- In-app history is necessarily incomplete for viewing on youtube.com, mobile,
  television, and other external devices.
