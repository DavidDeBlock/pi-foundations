# Issue 2: Inventory Script — `scan-inventory.ts`

**Labels:** `done` `docs-reorganization` `vertical-slice-2`  
**Parent PRD:** [Docs Reorganization System](../prd/docs-reorganization-system.md)  

## User Story

As a developer using AI agents, I want the agent to scan my docs folder without reading every file's full content, so that it can build an inventory efficiently without blowing context limits.

## Acceptance Criteria

- [x] Script recursively scans `docs/` (excluding `_system/`) and collects metadata: path, size in KB, line count, first 5 lines
- [x] Script applies heuristic flags: large file (>50KB), temp/draft name pattern, obvious duplicate basename across folders
- [x] Script outputs structured YAML blocks to `DOCS_INVENTORY.md` with stable IDs (F0001, F0002...) grouped by current folder
- [x] Each YAML block includes all required fields: id, path, folder, size_kb, lines, status (`scanned`), class (`null`), confidence (`null`), proposed_action (`null`), approval (`null`), risk (`null`), reason (`null`), questions (`[]`), related_files (`[]`), target_path (`null`), current_step (`null`), blocker (`null`), last_updated
- [x] Script generates folder-level summary table showing file count and total size per folder
- [x] Script handles large files with sampling strategy (first 5 lines only, no full read)
- [x] Script is runnable via `npx tsx scripts/scan-inventory.ts docs/`
- [x] Output format matches YAML block schema from design document

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `scripts/scan-inventory.ts` | Create | Recursive scanner: metadata collection, heuristic flags, YAML block output |

## Blocked by

None — can start immediately. Independent script that works on any docs/ layout.
