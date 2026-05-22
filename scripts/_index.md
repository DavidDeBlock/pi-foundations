# Scripts Index — Agent Tool Reference

## Overview

Executable TypeScript scripts that replace raw file-reading with structured, deterministic output. Every script follows the same contract:

| Rule | Constraint |
|------|-----------|
| **Input** | Zero or one argument (path) + optional flags |
| **Output** | Structured text (table/tree/JSON) — under 200 lines |
| **Speed** | Under 1 second execution |
| **Tokens** | Output fits in <500 tokens when pasted back to agent |
| **Help** | `--help` prints description, usage, flags, examples |
| **Flags** | `--json` for machine-readable output; `--help` for usage |

Run with: `tsx scripts/<path/to/script>.ts [args] [--json|--help]`

---

## Quick Reference — Intent → Command

| I want to... | Command | Category |
|---|---|---|
| **see folder structure** (categorized tree) | `tsx scripts/tree/code-tree.ts [dir] --depth 2 --max-files 60` | discovery |
| **list all API routes** (Hono-style) | `tsx scripts/tree/api-routes.ts [dir]` | discovery |
| **see what a file exports** (functions, classes, types) | `tsx scripts/extract/exports.ts <path>` | analysis |
| **see domain entities + relations** (from @entity/@relation tags) | `tsx scripts/synthesize/domain-model.ts [dir]` | synthesis |
| **see full API surface** (routes with handler signatures) | `tsx scripts/synthesize/api-surface.ts [dir]` | synthesis |
| **check test coverage** (which source files have tests) | `tsx scripts/validate/test-coverage.ts [dir]` | validation |
| **check layer boundary violations** (cross-layer imports) | `tsx scripts/validate/layer-boundaries.ts [dir]` | validation |

---

## Docs Management Scripts

These are used for the docs reorganization pipeline. Run them in order.

| Script | Purpose | Usage |
|--------|---------|-------|
| **scan-inventory.ts** | Scan `docs/` and produce `DOCS_INVENTORY.md` with file metadata (size, lines, preview) | `tsx scripts/scan-inventory.ts [docs-root]` |
| **parse-doc-file.ts** | Parse a single doc file: headings, sections, summaries, cross-references, flags | Import only — used by other scripts |
| **classify-inventory.ts** | Classify each inventory entry (canonical/stale/duplicate/archive/experiment/decision) with confidence and risk | `tsx scripts/classify-inventory.ts [inventory-path]` |
| **generate-questions.ts** | Generate reviewer questions for low-confidence classifications | `tsx scripts/generate-questions.ts [inventory-path]` |
| **migrate-docs.ts** | Move/archive/merge files per inventory decisions. Supports `--dry-run`. | `tsx scripts/migrate-docs.ts [docs-root] [--dry-run] [--batch-size=N]` |
| **cleanup-empty-dirs.ts** | Remove empty directories after migration (excludes `_system/`). Supports `--dry-run`. | `tsx scripts/cleanup-empty-dirs.ts [docs-root] [--dry-run]` |
| **verify-structure.ts** | Verify folder structure matches canonical numbering rules (`00-current` through `90-archive`) | `tsx scripts/verify-structure.ts [docs-root]` |
| **verify-inventory-drift.ts** | Compare `DOCS_INVENTORY.md` paths against actual filesystem; find orphaned files | `tsx scripts/verify-inventory-drift.ts [docs-root]` |
| **generate-indices.ts** | Auto-generate `_index.md` for every docs subfolder (titles, descriptions) | `tsx scripts/generate-indices.ts` |

---

## Shared Library (`_lib/`)

These are not meant to be run directly. They're imported by the scripts above.

| File | Purpose |
|------|---------|
| **ts-parser.ts** | ts-morph AST parsing — extract exports, signatures, JSDoc, script metadata from `.ts` files |
| **format.ts** | Output formatting — markdown tables, Unicode trees, JSON serialization |

---

## Catalog Entry Point

```bash
tsx scripts/                    # Human-readable catalog of all scripts
tsx scripts/ --list             # Explicit listing (same as above)
tsx scripts/ --json             # Machine-readable JSON of script metadata
tsx scripts/ --help             # Script contract and usage guide
```

> **Note:** The catalog scanner extracts `@category` and `@usage` JSDoc tags from each script. Scripts in subdirectories may not be fully categorized — check individual `--help` for details.
