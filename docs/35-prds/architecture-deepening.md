# Architecture Deepening — Consolidate Shallow Modules

**Status:** Draft  
**Date:** 2026-05-22  
**Type:** Architectural refactoring (no new features)  

---

## Context

The codebase has accumulated **shallow modules** — interfaces nearly as complex as their implementations. This creates friction in three ways:

1. **Duplication**: The same utility functions (`markdownTable`, `toJson`, directory scanning, CLI arg parsing) are reimplemented across 6+ files with subtle variations.
2. **No leverage**: Callers each maintain their own copies of formatting logic and file-walking boilerplate instead of benefiting from a deep shared module.
3. **Poor locality**: Fix a bug in one copy, the same bug silently persists in others. Tests cover only the individual callers, not the shared logic itself.

This PRD consolidates shallow modules into deep ones across five opportunities. Each is independently scoped and can be implemented in parallel by different agents (or sequentially if preferred).

---

## Opportunity Map

| # | Name | Files Affected | Risk | Effort |
|---|------|---------------|------|--------|
| 1 | Formatting deduplication | `_lib/format.ts` + 4 scripts | Low | Small |
| 2 | Shared file scanner | `scripts/**/*.ts`, `.pi/skills/docs-manager/scripts/*.ts` | Medium | Medium |
| 3 | CLI runner module | All 12 script entry points | Medium | Medium |
| 4 | Domain model AST extraction | `_lib/ts-parser.ts`, `scripts/synthesize/domain-model.ts` | Medium | Small-Medium |
| 5 | Session parser consolidation | `shared/lib/session-parser.ts`, `.pi/skills/session-parser/scripts/*.ts` | Low | Small |

---

## Opportunity 1: Formatting Deduplication

### Problem

`markdownTable()` and `toJson()` are defined in `_lib/format.ts` (the shared module) but **also reimplemented inline** in four scripts that should be importing from it. The duplication is mechanical — same function signatures, same edge-case handling, same output format.

**Affected files:**
- `scripts/synthesize/domain-model.ts` (inline `markdownTable`, `toJson`)
- `scripts/synthesize/api-surface.ts` (inline `markdownTable`, `toJson`)
- `scripts/validate/layer-boundaries.ts` (inline `markdownTable`, `toJson`)
- `scripts/validate/test-coverage.ts` (inline `markdownTable`, `toJson`)

### Solution

Remove all inline implementations. Have each script import from `_lib/format.ts`. No interface changes — the function signatures are identical.

### Acceptance Criteria

- [ ] All four scripts use `import { markdownTable, toJson } from '../../_lib/format.js'`
- [ ] Inline `markdownTable()` and `toJson()` definitions removed from all four files
- [ ] Existing tests still pass (they exercise the shared functions through the scripts)
- [ ] No behavioral changes — output format identical to before

### Benefits

- **One source of truth** for formatting logic
- **Fix once → fixed everywhere** (locality)
- Inline copies become testable through their callers rather than needing separate coverage

---

## Opportunity 2: Shared File Scanner

### Problem

Every script reimplements its own directory scanner with slightly different `SKIP_DIRS` configurations, sort orders, and edge-case handling. The function is small but **identical in structure** everywhere:

- `scanDirectory()` / `findTsFiles()` in `domain-model.ts`
- `findTsFiles()` / `scanApiSurface()` in `api-surface.ts`
- `findSourceFiles()` / `scanCoverage()` in `test-coverage.ts`
- `findTsFiles()` / `scanLayerBoundaries()` in `layer-boundaries.ts`
- Same pattern repeats in `.pi/skills/docs-manager/scripts/`

This is a **shallow module** — the interface (a list of files) is nearly as complex as the implementation. The real complexity should live in one place.

### Solution

Create `_lib/scanner.ts` that exports a configurable `scanDirectory(dirPath, options)` function:

```typescript
// _lib/scanner.ts

export interface ScanOptions {
  skipDirs?: Set<string>
  extensions?: string[]      // e.g., ['.ts'] — excludes .d.ts and .test.ts automatically
  excludePatterns?: string[] // e.g., ['*.test.ts', '*.spec.ts']
}

/** Recursively find all matching files in a directory */
export function scanDirectory(dirPath: string, options: ScanOptions): string[]

/** Default options used by most scripts */
export const DEFAULT_SCAN_OPTIONS: ScanOptions
```

Each script passes its `SKIP_DIRS` and extension filters via an options object. One deep module replaces N shallow copies.

### Acceptance Criteria

- [ ] `_lib/scanner.ts` exists with `scanDirectory()` and `DEFAULT_SCAN_OPTIONS` exports
- [ ] All scripts that previously had inline scanners now import from `_lib/scanner.ts`
- [ ] Each script configures its own skip dirs via options (no hardcoded SKIP_DIRS in scripts)
- [ ] Existing tests still pass
- [ ] No behavioral changes — file discovery order and filtering identical to before

### Benefits

- **Leverage**: one scanner implementation serves all scripts (and docs-manager scripts too)
- Tests for scanning logic are centralized in `_lib/scanner.test.ts`
- Scripts become thinner — they focus on domain logic, not file-walking boilerplate (**locality**)

---

## Opportunity 3: CLI Runner Module

### Problem

Every script follows the same rigid pattern but re-implements argument parsing, CLI detection (`basename(process.argv[1]) === SCRIPT_NAME`), and output writing inline. The **interface** of a script is "a module that exports `generateOutput(path, json, help)`" — but the implementation layer (CLI wiring) is duplicated everywhere with subtle differences:

- Some use `console.log()`, some `process.stdout.write()`
- Some call `process.exit(0)`, some don't
- Help text format varies slightly between scripts

This creates friction when you want to add a new global flag, change output encoding, or test scripts programmatically.

### Solution

Create a thin runner module that standardizes the CLI pattern:

```typescript
// _lib/script-runner.ts (or scripts/run.ts)

import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

export interface ScriptModule {
  generateOutput(targetPath: string, json?: boolean, help?: boolean): string
}

/** Run a script module with standardized CLI handling */
export function runScript(
  module: ScriptModule,
  options: { name?: string; helpText?: string } = {}
): void {
  // Parse args, detect --json/--help, call generateOutput(), write to stdout
}
```

Each script exports its generator function and calls `runScript()` at the bottom. The interface contract becomes: "export `generateOutput(targetPath: string, json?: boolean, help?: boolean): string`."

### Acceptance Criteria

- [ ] Runner module exists with standardized arg parsing and output handling
- [ ] All scripts use the runner (no more inline CLI boilerplate)
- [ ] Help text format is consistent across all scripts
- [ ] `--json`, `--help`, positional path arguments work identically to before
- [ ] Existing tests still pass

### Benefits

- New scripts follow one template — zero friction to add
- Global flags (logging, encoding) can be added uniformly without touching every script
- Testing becomes trivial — import the generator function directly instead of spawning processes (**locality**)

---

## Opportunity 4: Domain Model AST Extraction

### Problem

`domain-model.ts` uses regex-based JSDoc parsing (`@entity`, `@relation`) to extract domain schema information, while `_lib/ts-parser.ts` already has a full ts-morph AST parser. These are **two parallel extraction paths** for the same source material — one robust (AST), one fragile (regex). The domain model script doesn't benefit from ts-morph despite having it as a dependency.

The regex approach has known edge cases:
- Brace-depth tracking for field extraction can misparse nested objects
- Field-name false positives (e.g., `uuid`, `varchar` skipped but other column names not)
- No understanding of TypeScript syntax — just pattern matching on text

### Solution

Add domain model extraction methods to `_lib/ts-parser.ts`:

```typescript
// _lib/ts-parser.ts additions

export function extractEntityTags(sourceFile: SourceFile): DomainEntity[]
export function extractRelationTags(sourceFile: SourceFile): DomainRelation[]
```

These operate on the AST rather than regex. The `domain-model.ts` script becomes a thin wrapper that calls these methods and formats output — no more brace-depth tracking or field-name filtering logic.

### Acceptance Criteria

- [ ] `_lib/ts-parser.ts` exports `extractEntityTags()` and `extractRelationTags()`
- [ ] Both methods use ts-morph AST, not regex
- [ ] `domain-model.ts` imports from `_lib/ts-parser.ts` instead of having its own parsing logic
- [ ] Output format identical to before (markdown table + JSON)
- [ ] Existing tests pass; new tests added for entity/relation extraction edge cases

### Benefits

- One extraction path (AST) instead of two — no divergence risk
- Regex-based edge cases disappear entirely
- **Leverage**: any future script can extract @entity/@relation tags without reimplementing parsing (**locality**)

---

## Opportunity 5: Session Parser Consolidation

### Problem

`shared/lib/session-parser.ts` exists outside the main codebase structure — it's a self-contained module with no barrel export, no tests in the project test suite, and unclear ownership. Meanwhile, `.pi/skills/session-parser/scripts/` has three separate scripts (`list-sessions.ts`, `parse-session.ts`, `search-sessions.ts`) that presumably use similar parsing logic. There's ambiguity about whether `shared/lib/session-parser.ts` is meant to be the canonical implementation or just a leftover.

### Solution

1. Make `shared/lib/session-parser.ts` the canonical session parser
2. Add it to `shared/index.ts` barrel export
3. Update `.pi/skills/session-parser/scripts/` to import from `shared/lib/session-parser.ts` instead of duplicating parsing logic
4. Write integration tests covering the public interface and real-world usage patterns

### Acceptance Criteria

- [ ] `sessionParser.parseSessionLog()` is exported via `shared/index.ts` barrel
- [ ] `.pi/skills/session-parser/scripts/*.ts` import from `shared/` instead of having inline parsing
- [ ] Integration tests exist in the project test suite (not just inline usage)
- [ ] No behavioral changes — session summary output identical to before

### Benefits

- Clear ownership — no ambiguity about which implementation is authoritative
- Tests cover the actual seam (the exported functions) rather than internal parsing logic (**locality**)
- Future scripts can import without duplicating the parser

---

## Implementation Order & Dependencies

```
Opportunity 1 (Formatting dedup)  ──┐
                                     ├──→ Opportunity 2 (Scanner extraction)
Opportunity 4 (Domain model AST)  ──┘
                                      │
Opportunity 3 (CLI runner)  ─────────┼──→ All scripts updated
                                      │
Opportunity 5 (Session parser)      ──┘
```

**Phase 1 (Low risk, parallel):** Opportunities 1 and 5 — mechanical changes with no behavioral impact. Can be done by any agent.

**Phase 2 (Medium risk, sequential):** Opportunity 4 then Opportunity 3 — AST extraction depends on ts-parser stability; CLI runner touches every script so it's a good final sweep.

**Phase 3 (Independent):** Opportunity 2 (Scanner) can run in parallel with Phase 1 or after Phase 2 — no hard dependency either way, but benefits from the other changes being settled first.

---

## Constraints & Guardrails

- **No behavioral changes** — output format must be identical to before for all scripts
- **Existing tests must pass** — add new tests only where coverage gaps are created by consolidation
- **No `as` type assertions** in production code — use proper narrowing or shoehorn for partial data
- **Keep the deletion test in mind**: if deleting a module makes complexity vanish, it was a pass-through and shouldn't exist

---

## Definition of Done

All five opportunities are done when:

1. Every script imports from shared modules instead of duplicating logic
2. All existing tests pass with no behavioral changes
3. New tests cover consolidated modules where coverage gaps existed
4. No inline copies of `markdownTable`, `toJson`, directory scanning, CLI parsing, or session parsing remain in any script file

---

## Notes for Implementers

- Each opportunity is independently completable — you don't need to finish one before starting another (except the dependency noted above)
- Start with Opportunity 1 as a warm-up; it's purely mechanical and tests prove correctness immediately
- When consolidating, prefer **importing from existing shared modules** over creating new ones unless the consolidation itself is the goal (Opportunities 2, 3, 4)
- Use `pnpm test` to validate — all 175 existing tests must pass
