# ADR-004: Folders + tags, unified for bookmarks and YouTube

**Status**: Accepted
**Date**: 2026-06-28
**Authors**: David

## Context

The user wants to "organize" and "categorize" both Chrome bookmarks and saved YouTube videos. Real-world organization rarely fits a single axis — a video about Postgres might be `Tech/Backend/Postgres` AND tagged `reference` and `sql`.

## Decision Drivers

- Chrome's bookmark model is folder-based (hierarchical, one parent per bookmark)
- The user explicitly wants "categories" — implies flexible organization
- A blog post and a YouTube video about the same topic should be able to share a location
- Single-axis organization loses cross-cutting relationships

## Decision

**Folders + tags, unified across bookmarks and YouTube.**

- **Folders** are hierarchical. A bookmark or video lives in exactly one folder (mirrors Chrome's model for clean sync back).
- **Tags** are flat. A bookmark or video can have any number of tags (cross-cutting labels: `reference`, `sql`, `watch-later`).
- One shared category tree across both content types. A `Tech/Backend/Postgres` folder can hold a blog post and a conference talk.
- Tags are dashboard-only metadata. When pushed back to Chrome, only the folder is used (Chrome has no tag UI).

## Consequences

**Positive:**
- Multi-axis organization fits real-world tagging patterns
- Clean sync to Chrome (folder maps 1:1 to Chrome bookmark folder)
- Cross-content-type organization (search "Postgres", see blog + video together)
- Flexible enough to evolve with the user's mental model

**Negative:**
- Two metadata surfaces to maintain (folder picker + tag input)
- Tags don't sync to Chrome — invisible in Chrome's UI (acceptable trade-off)
- Schema needs both `folder_id` and a `tags` table with a many-to-many relation
- UI must show tags inline (chips) and offer a tag picker for edit