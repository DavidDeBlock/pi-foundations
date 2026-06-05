---
name: codebase-explorer
description: >-
  Orchestrates structured codebase exploration using deterministic scripts in `scripts/`. 
  Follows a guided path: Map Territory → Understand Surface → Validate Health. Use when understanding 
  a new project, pre-implementation discovery, or architectural audit. Do not use for documentation management (use docs-manager skill instead).
---

# Codebase Explorer

Systematic codebase exploration using executable scripts in `scripts/`. Follows a **guided path** — execute phases sequentially to build a coherent mental model of the target project.

> ⚠️ **Scope**: Source code analysis only. For documentation management, use the `docs-manager` skill.

## Quick Start

Run phases in order. Each phase produces structured output you can present back to the user.

```bash
# Phase 1: Map territory
tsx scripts/tree/code-tree.ts [path] --depth 2 --max-files 60
tsx scripts/tree/api-routes.ts [path]

# Phase 2: Understand surface
tsx scripts/extract/exports.ts <file-path>
tsx scripts/synthesize/domain-model.ts [path]

# Phase 3: Validate health
tsx scripts/validate/layer-boundaries.ts [path]
tsx scripts/validate/test-coverage.ts [path]
```

---

## Phased Workflow

### Phase 1 — Map the Territory

**Goal**: Understand project structure, entry points, and layer organization.

| Script | Use When | Command |
|--------|----------|---------|
| **Code Tree** `tree/code-tree.ts` | First look at any directory | `tsx scripts/tree/code-tree.ts [dir] --depth 2 --max-files 60` |
| **API Routes** `tree/api-routes.ts` | Find web/API entry points | `tsx scripts/tree/api-routes.ts [dir]` |

**Output**: Categorized file tree (Source/Config/Docs) + route listing.

---

### Phase 2 — Understand the Surface

**Goal**: Identify what can be imported, called, or extended.

| Script | Use When | Command |
|--------|----------|---------|
| **Exports** `extract/exports.ts` | Analyze a specific file's public API | `tsx scripts/extract/exports.ts <file-path> [--json]` |
| **Domain Model** `synthesize/domain-model.ts` | Extract entities and relations from schema files | `tsx scripts/synthesize/domain-model.ts [dir]` |

**Output**: Export table (Name, Signature, JSDoc) + entity/relation graph.

---

### Phase 3 — Validate Architecture Health

**Goal**: Check for structural problems before implementing anything.

| Script | Use When | Command |
|--------|----------|---------|
| **Layer Boundaries** `validate/layer-boundaries.ts` | Cross-layer import violations | `tsx scripts/validate/layer-boundaries.ts [dir]` |
| **Test Coverage** `validate/test-coverage.ts` | Which source files have tests? | `tsx scripts/validate/test-coverage.ts [dir]` |

**Output**: Violation table (File, Import, Reason) + coverage report.

---

### Phase 4 — Deep Dive on Demand

Use these when specific questions emerge from Phases 1–3:

| Question | Script | Command |
|----------|--------|---------|
| "What's the full API surface?" | `synthesize/api-surface.ts` | `tsx scripts/synthesize/api-surface.ts [dir]` |
| "How does this function work?" | Raw file read + exports analysis | Read file → `tsx scripts/extract/exports.ts <path>` |

---

## Tips for the Agent

1. **Start small**: Phase 1 with a shallow depth (`--depth 2`) keeps output under 500 tokens.
2. **Use `--json` when needed**: For machine consumption (e.g., counting violations, iterating entries), always use `--json`.
3. **Present results to the user**: Don't just run scripts silently — summarize findings and ask what to explore next.
4. **Script catalog**: Run `tsx scripts/ --help` for a full list of available exploration scripts.
