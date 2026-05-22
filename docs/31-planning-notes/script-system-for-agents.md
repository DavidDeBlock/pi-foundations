# Script System for Agents — Plan

## Goal

Replace agent file-reading with **script execution**. Every exploratory `read` call should become a targeted script that outputs structured, deterministic data under 500 tokens. This reduces context burn and makes agent behavior predictable: *put X in → get Y out*.

---

## Principle

> An agent should never read source files to understand structure. It runs scripts that show trees, exports, types, routes, and relations — compact output it can act on immediately.

---

## Directory Structure

```
scripts/
├── _index.md              # Catalog: intent → script mapping
├── tree/                  # "Show me the shape" — structure without content
│   ├── code-tree.ts       # Directory tree with file types/sizes
│   └── api-routes.ts      # All routes + methods + handlers
├── extract/               # "Pull specific data from one file"
│   ├── exports.ts         # Functions/classes/types exported from a file
│   └── types.ts           # Interface/type definitions with fields
├── synthesize/            # "Combine and summarize across files"
│   ├── domain-model.ts    # Entities + relations from all models
│   └── api-surface.ts     # Full API contract from routes + types
├── validate/              # "Check correctness against rules"
│   ├── layer-boundaries.ts  # Cross-layer violations
│   └── test-coverage.ts     # Which files have tests, which don't
└── _lib/                  # Shared utilities (parsers, formatters)
    ├── ts-parser.ts       # Lightweight AST parsing for TypeScript
    └── format.ts          # Output formatting (table/tree/json)
```

---

## Script Contract

Every script must follow this contract:

| Rule | Constraint |
|------|-----------|
| **Input** | Zero or one argument (path, pattern, flag) |
| **Output** | Structured text (table/tree/JSON) — under 200 lines |
| **Speed** | Under 1 second execution |
| **Tokens** | Output fits in <500 tokens when pasted back to agent |
| **Deterministic** | Same input → same output structure every time |
| **Help** | `--help` prints: description, usage, flags, example output |
| **Exit code** | 0 on success, non-zero on error with message to stderr |

---

## Catalog (`scripts/_index.md`)

Self-documenting index that agents read once instead of scanning all scripts:

```markdown
# Scripts Index — Agent Tool Reference

| I want to... | Command | Output |
|---|---|---|
| see folder structure | `tsx scripts/tree/code-tree.ts [dir]` | tree with sizes/types |
| see what a file exports | `tsx scripts/extract/exports.ts <path>` | list of functions/classes/types |
| see all API routes | `tsx scripts/tree/api-routes.ts` | table: method, path, handler |
| see domain entities | `tsx scripts/synthesize/domain-model.ts` | entities + relations graph |
| see type definitions | `tsx scripts/extract/types.ts <path>` | interfaces with fields |
| check test coverage | `tsx scripts/validate/test-coverage.ts [dir]` | src vs. test file mapping |
```

---

## Implementation Plan — Phases

### Phase 1: Foundation (V0)

Build the shared library and first two high-value scripts. These replace ~60% of exploratory reads in a typical session.

| Script | Replaces Agent Behavior | Priority |
|--------|-------------------------|----------|
| `_lib/ts-parser.ts` | Shared AST parsing for TypeScript files | P0 |
| `_lib/format.ts` | Output formatting (table/tree/json) | P0 |
| `tree/code-tree.ts` | `find . -name "*.ts"` + manual scanning | P1 |
| `extract/exports.ts` | Reading files just to see what they export | P1 |

**Acceptance criteria:**
- Both scripts run under 1 second on the current codebase
- Output fits in <500 tokens
- `--help` works for both
- `_index.md` exists and is accurate

### Phase 2: Domain Understanding (V1)

Scripts that replace reading multiple files to understand the system.

| Script | Replaces Agent Behavior | Priority |
|--------|-------------------------|----------|
| `synthesize/domain-model.ts` | Reading all Prisma/model/entity files | P1 |
| `tree/api-routes.ts` | Reading route definitions scattered across files | P2 |
| `extract/types.ts` | Reading files just to see interface definitions | P2 |

**Acceptance criteria:**
- Domain model output shows entities, fields, and relations in <50 lines
- API routes table covers all defined endpoints

### Phase 3: Validation (V2)

Scripts that check correctness without reading source.

| Script | Replaces Agent Behavior | Priority |
|--------|-------------------------|----------|
| `validate/test-coverage.ts` | Checking which files have tests | P2 |
| `synthesize/api-surface.ts` | Reading routes + controllers + types for full contract | P3 |
| `validate/layer-boundaries.ts` | Checking cross-layer imports | P3 |

---

## Technical Decisions (Pending)

| Decision | Options | Recommendation |
|----------|---------|----------------|
| **AST library** | `@typescript-eslint/parser`, `ts-morph`, regex-based | Start with regex for V0 (fast, no deps). Upgrade to `@typescript-eslint/parser` if accuracy needed. |
| **Output format default** | Human-readable tables/trees vs JSON | Default: human-readable. `--json` flag for machine consumption. |
| **Script location** | Project root `scripts/` vs `.pi/scripts/` | Project root `scripts/` — these are project tools, not agent config. |

---

## Not In Scope (V0)

- Python scripts (TypeScript only for now)
- IDE integration or VS Code extensions
- CI pipeline integration
- Script testing framework (manual verification sufficient for V0)

---

## Open Questions

1. Should scripts be discoverable via a single entry point? (`tsx scripts/ --list`) YES
2. Do we need caching for expensive synthesize scripts? YES
3. Should the catalog `_index.md` be auto-generated from script `--help` output? YES
