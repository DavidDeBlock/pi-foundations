# Issue 3: Deep Analysis Script — `parse-doc-file.ts`

**Labels:** `needs-triage` `docs-reorganization` `vertical-slice-3`  
**Parent PRD:** [Docs Reorganization System](../prd/docs-reorganization-system.md)  

## User Story

As a developer, I want the agent to classify each doc file with a confidence level and reason, so that I can trust or challenge its judgment before any changes happen. This script provides on-demand deep analysis when shallow scan is insufficient during classification.

## Acceptance Criteria

- [ ] Script accepts a single file path as argument: `npx tsx scripts/parse-doc-file.ts <path>`
- [ ] Script extracts section headers (markdown headings) with line numbers
- [ ] Script generates content summary from first N lines of each section (sampling strategy for large files)
- [ ] Script identifies cross-references to other docs paths within the file
- [ ] Script outputs structured analysis suitable for agent consumption during Phase 2 classification or work-sessions
- [ ] Script handles edge cases: binary files, empty files, extremely large files (>50KB with sampling)
- [ ] Output includes: section list, content summary per section, cross-references found, estimated word count, file type detection

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `scripts/parse-doc-file.ts` | Create | On-demand deep analysis of single files: section extraction, content summary, cross-reference detection |

## Blocked by

None — can start immediately. Independent script that takes a file path as input and produces structured output.
