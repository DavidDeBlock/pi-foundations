# [PRD] Dashboard v3.4 — YouTube description resources

**Labels**: `parent-prd`, `youtube`, `v3.4`
**Date**: 2026-07-16
**Status**: Draft

## Problem statement

YouTube descriptions often contain the most actionable material in a video:
source repositories, documentation, project websites, articles, datasets, and
community links. The dashboard currently stores canonical video metadata and
transcripts, but it does not retain video descriptions. David therefore has to
open YouTube, expand the description, and manually distinguish useful resources
from channel promotion, sponsor links, affiliate redirects, and social links.

This is especially costly for software and educational videos, where the links
may be more useful than watching the complete video. A raw list of every URL is
not enough: useful resources need to be prominent, promotional links should not
dominate the page, and uncertain links must not be silently discarded.

## Product outcome

Dashboard v3.4 turns a video description into a locally stored, explainable
resource collection:

- authenticated YouTube metadata refresh stores the raw description;
- deterministic extraction produces normalized HTTP(S) resources;
- repositories, documentation, tools, articles, and datasets are featured;
- social, promotional, affiliate, and uncertain links remain available behind
  progressive disclosure;
- manual corrections can become reusable channel or domain rules;
- MiniMax may classify ambiguous resources, but is not required for the core
  feature and never overrides an explicit user rule;
- optional guarded checks can resolve redirects and report stale links without
  turning arbitrary page content into trusted data;
- Insight Cards may reference persisted description resources separately from
  transcript timestamps and Serper research citations.

## User stories

1. As David, I can see useful links from a video's description without opening
   the normal YouTube page.
2. As David, I can quickly recognize a repository, documentation site, tool,
   article, dataset, community, social, creator, or promotional link.
3. As David, sponsor and affiliate links are collapsed by default but remain
   inspectable when I want them.
4. As David, I can open or copy a resource, feature it, hide it, or restore the
   automatic classification.
5. As David, I can apply a correction only to one resource or reuse it for a
   domain or channel.
6. As David, uncertain resources remain visible under Other links rather than
   being deleted by a low-confidence model decision.
7. As David, I can read the complete stored description and see when it was last
   refreshed.
8. As David, description and resource refreshes do not consume MiniMax or
   Serper capacity unless I explicitly enable the corresponding enrichment.
9. As David, an Insight Card can show resources mentioned by the creator without
   presenting them as independent web evidence.
10. As David, a broken or redirected link can be identified without allowing a
    remote URL to access services on my home network.

## Product decisions

### The raw description is the source record

Store the complete YouTube-owned description, its fetched timestamp, and a
content fingerprint on the canonical video. Extraction is derived data and can
be rebuilt when normalization or classification improves. A local resource
override is never destroyed when the remote description changes; it becomes
inactive only when its underlying resource is no longer present.

Descriptions are fetched through the existing authenticated YouTube connection.
RSS remains the low-cost discovery mechanism and does not need to grow a second
metadata parser. Newly discovered or metadata-incomplete videos enter a bounded
metadata-refresh queue that batches video IDs. Playlist and backfill imports use
the same canonical refresh path instead of implementing separate description
logic.

### Classification is layered and explainable

Classification precedence is:

1. explicit per-resource user override;
2. user domain/channel rule;
3. high-confidence deterministic rule;
4. optional MiniMax classification for ambiguous resources;
5. `other` with an uncertain state.

The UI records the winning source and a bounded reason such as “GitHub host,”
“affiliate parameter,” “sponsor wording nearby,” or “manual channel rule.” AI is
not used for obvious host/path/query rules and does not need to fetch the target
page.

### Promotional is visibility, not deletion

Resource categories are:

- `repository`
- `documentation`
- `tool`
- `article`
- `dataset`
- `community`
- `creator`
- `social`
- `promotional`
- `other`

Visibility is independent: `featured`, `normal`, or `hidden`. Default visibility
features repository/documentation/tool/article/dataset resources, places
community/creator/social/other under Other links, and collapses promotional
resources under Promotional links hidden. The user can override any result.

Affiliate indicators include explicit description wording and known query
parameters such as `ref`, `aff`, `affiliate`, and storefront-specific tags.
Ordinary analytics parameters such as `utm_*` are stripped from the canonical
display URL but retained in the original URL for provenance. A direct sponsor
URL with no affiliate parameter can still be promotional based on nearby text.

### Normalization preserves identity and provenance

Only `http:` and `https:` URLs are accepted. Extraction retains:

- original URL as written by the creator;
- normalized/canonical URL used for grouping;
- display domain and optional creator-supplied label;
- bounded text before/after the link for classification context;
- stable position in the description;
- category, visibility, confidence, classifier source, and reason.

Fragments and query parameters are not removed indiscriminately because they
may identify a document section or required project state. Tracking removal is
allow-listed and tested. Duplicate canonical URLs within one description render
once while retaining all source positions.

### AI is optional assistance, not a safety authority

MiniMax receives only a bounded resource URL, label, domain, nearby description
text, and the allow-listed classification schema. Description text and model
output are untrusted. The model may suggest a category, visibility, confidence,
and short reason. Low-confidence or invalid output falls back to `other`.

AI does not certify that a destination is safe, factual, or free of malware. It
cannot override manual rules, and ordinary page reads never trigger a provider
call. Settings expose whether ambiguous-resource classification is off, manual,
or automatic for selected subscriptions.

### Link checking is separately guarded

The initial core feature does not download linked pages. An optional checker may
later resolve redirects, obtain bounded response metadata, and record HTTP
status, final URL, title, content type, and checked timestamp. It must:

- resolve and reject loopback, private, link-local, and otherwise disallowed IP
  destinations before every request and redirect;
- allow only HTTP(S), cap redirects, response bytes, duration, and concurrency;
- avoid authentication, cookies, script execution, and arbitrary page parsing;
- treat status as freshness information, not a security guarantee;
- preserve the original creator URL and clearly show redirects.

### Resources have a dedicated place in video detail

Place **Resources from this video** directly below the focus player and above
Folder/Tags. This is where the user moves from watching to acting. The section
shows a compact Featured group first, followed by collapsible Other links,
Promotional links hidden, and Full description groups.

Each resource shows category, useful label, domain, nearby description context,
and Open/Copy/Feature/Hide actions. Empty, loading, unavailable, stale, and
refresh-failed states must not displace the player or Insight Card.

### Insight Card sources remain distinct

Description resources can appear as a **Mentioned resources** section. They are
creator-provided references and must not be labeled as independent verification.
They are visually and structurally distinct from:

- transcript timestamp citations, which identify what the video says;
- Serper web sources, which provide external search context.

Summary generation may select only persisted visible resources. It snapshots
the resource IDs and canonical URLs used so later description refreshes do not
silently rewrite a historical run.

## Data model

### `video_descriptions`

| Column | Meaning |
|---|---|
| `video_id` | Canonical video FK and primary key |
| `description` | Raw remote description |
| `fingerprint` | Content hash used to detect changes |
| `status` | `pending`, `ready`, `failed`, or `unavailable` |
| `fetched_at`, `updated_at` | Refresh lifecycle timestamps |
| `error_message` | Bounded operational failure detail |

### `video_description_resources`

| Column | Meaning |
|---|---|
| `id` | Stable dashboard resource ID |
| `video_id` | Canonical video FK |
| `original_url`, `canonical_url` | Creator value and normalized identity |
| `domain`, `label` | Display metadata |
| `context_before`, `context_after` | Bounded description context |
| `first_position` | Stable source ordering |
| `category`, `visibility` | Effective classification |
| `confidence` | Nullable bounded classifier confidence |
| `classification_source`, `classification_reason` | Explainability metadata |
| `is_present` | Whether the latest description still contains the resource |
| `created_at`, `updated_at` | Audit timestamps |

The implementation may store automatic and effective classification separately
if that prevents refreshes from overwriting user intent.

### `video_resource_rules`

| Column | Meaning |
|---|---|
| `id` | Rule ID |
| `scope_type` | `domain` or `channel` |
| `scope_value` | Normalized domain or channel ID |
| `category`, `visibility` | Nullable forced values |
| `enabled` | Soft enable/disable state |
| `created_at`, `updated_at` | Audit timestamps |

Per-resource overrides may live on the resource row or in a separate audit
table. The chosen representation must make “restore automatic” lossless.

### Optional check metadata

Guarded checking records final URL, status code, content type, bounded title,
check status/error, and checked timestamp. It does not store response bodies.

## API contracts

All routes use existing dashboard authentication.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/videos/:id/description` | Read description state and refresh metadata |
| POST | `/api/videos/:id/description/refresh` | Queue authenticated metadata refresh |
| GET | `/api/videos/:id/resources` | Read effective grouped resources |
| PATCH | `/api/videos/:id/resources/:resourceId` | Feature, hide, recategorize, or restore automatic |
| POST | `/api/videos/:id/resources/classify` | Explicitly classify ambiguous resources when configured |
| POST | `/api/videos/:id/resources/check` | Queue guarded checks for selected visible resources |
| GET/POST/PATCH | `/api/youtube/resource-rules` | Manage reusable domain/channel rules |

Description refresh, AI classification, and network checking are distinct
actions and report independent state. Reads are side-effect free.

## Non-functional requirements

- Description and context lengths are bounded before persistence and prompts.
- All displayed remote text, labels, URLs, model reasons, and page titles are
  escaped against HTML/script injection.
- URL parsing uses platform URL primitives, not regex-only validation.
- Background refresh/classification/check jobs are bounded, idempotent,
  observable, and restart-safe where persisted queues are introduced.
- Provider keys, OAuth tokens, descriptions, and arbitrary target responses are
  not written to logs.
- Failed metadata refresh preserves the last ready description and resources as
  stale rather than erasing useful data.
- Resource reads and normal detail-page loads make no YouTube, MiniMax, Serper,
  or target-site request.

## Delivery slices

1. [YT-022](../35-issues/YT-022-video-description-metadata-ingestion.md) —
   description metadata storage and refresh.
2. [YT-023](../35-issues/YT-023-description-resource-extraction-classification.md)
   — deterministic extraction, normalization, and classification.
3. [YT-024](../35-issues/YT-024-video-resources-panel.md) — resources panel and
   full-description UX.
4. [YT-025](../35-issues/YT-025-resource-overrides-and-rules.md) — manual
   overrides and reusable domain/channel rules.
5. [YT-026](../35-issues/YT-026-ai-resource-classification-insight-integration.md)
   — optional MiniMax classification and Insight Card integration.
6. [YT-027](../35-issues/YT-027-guarded-resource-link-checks.md) — guarded link
   metadata and freshness checks.

## Out of scope

- Executing or rendering arbitrary linked pages inside the dashboard.
- Treating AI classification or HTTP status as a malware/safety guarantee.
- Automatically cloning repositories or downloading linked files.
- Replacing Serper research sources with creator-provided links.
- Shared/multi-user moderation or public resource curation.

## Success criteria

- For software/educational videos with descriptions, useful repositories and
  documentation are visible from the detail page without opening YouTube.
- Promotional resources are collapsed by default with no silent deletion.
- Deterministic classification works without MiniMax configuration.
- A manual correction survives description refresh and can optionally affect
  future videos through an explicit rule.
- Refresh failures preserve previously useful resources and are observable.
- No ordinary page read performs an external request.

