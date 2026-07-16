# YT-023 — Description resource extraction and deterministic classification

**Labels**: `youtube`, `v3.4`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-007](../35-prds/PRD-007-youtube-description-resources.md)

## What to build

Turn each stored description into normalized, explainably classified resources.
The deterministic pipeline must deliver a useful result without MiniMax and
must preserve enough provenance to rebuild derived data later.

## Product rules

- Accept only HTTP(S) URLs and use URL primitives for validation.
- Keep original and canonical forms; strip only allow-listed tracking fields.
- Deduplicate canonical URLs for display while retaining source positions and
  bounded surrounding text.
- Categories and visibility follow PRD-007; uncertain resources fall back to
  `other`, never silent deletion.
- Promotional detection may use URL parameters, known hosts, and nearby sponsor
  wording, and must expose its reason.

## Acceptance criteria

- [ ] add `video_description_resources` storage with stable IDs, canonical
  uniqueness per video, provenance/context, automatic/effective classification,
  presence state, confidence/source/reason, and timestamps
- [ ] extract Markdown-style, plain, punctuation-adjacent, multiline, and
  Unicode-adjacent URLs without admitting non-HTTP(S) schemes
- [ ] normalize host casing/default ports, safe percent encoding, YouTube redirect
  wrappers, allow-listed tracking parameters, fragments, and trailing punctuation
  according to documented rules
- [ ] avoid destructive normalization of meaningful query parameters or document
  fragments; retain original URL verbatim within configured bounds
- [ ] deterministically identify common repository, documentation, tool, article,
  dataset, creator/community/social, affiliate, sponsor, and storefront patterns
- [ ] store a bounded nearby-text window and creator label suitable for UI and
  later optional model classification
- [ ] re-extraction is transactional/idempotent, marks disappeared resources
  inactive, restores reappearing canonical resources, and never deletes an
  override-capable identity during ordinary refresh
- [ ] a changed description reclassifies automatic fields while preserving room
  for later manual precedence
- [ ] expose a read service/API representation grouped by effective visibility
  with stable ordering and no external calls
- [ ] tests cover malformed/oversized URLs, duplicates, redirect wrappers,
  affiliate parameters, UTM stripping, sponsor language, false positives,
  international domains, XSS, changed/removed/reappearing links, and rollback
- [ ] manual fixture for the example video demonstrates repositories/docs/tools
  separated from promotional and other links

## Blocked by

- [YT-022](./YT-022-video-description-metadata-ingestion.md)

