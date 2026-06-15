# Pi Foundations — Context

> ⚠️ **Placeholder.** This file was rewritten on 2026-06-15 after the Pi POS V1 codebase was removed. The original Pi POS context (customers, parts, direct sales, VAT, etc.) is no longer applicable.
>
> Pi Foundations is now a **meta-project**: a software build engine based on Pi agent + the Maestro orchestrator, and a home for downstream projects. The new `CONTEXT.md` will describe that purpose once it's been scoped (see `docs/31-planning-notes/` for in-flight planning).

## What this project is (working definition)

| Layer | Role |
|-------|------|
| **`.pi/maestro/`** | The build engine. Configurable loop orchestrator with flows, pipelines, evidence gates, retrospective, and a Textual dashboard. Drives `builder → test_runner → reviewer → close → retrospective` loops on GitHub issues. |
| **`.pi/skills/`** | Agent skill library. Each skill (e.g. `planner`, `architect`, `typescript-implementer`, `reviewer`, `to-prd`, `to-issues`, `prd-auditor`) is a self-contained Markdown guide the LLM loads on demand. |
| **`docs/`** | Documentation system. Numbered folders encode trust level (00–50 = current truth, 90-archive = reference only). ADRs in `40-decisions/`, PRDs in `35-prds/`, system specs in `25-system-specs/`. |
| **`scripts/`** | Codebase + doc analysis toolkit (TS-parser, scanner, code-tree, layer-boundaries, inventory, etc.). Reusable across projects. |
| **`shared/`** | Skeleton template for downstream projects' shared types/validations package. Currently empty — populated when a new project copies this template. |
| **`e2e/`** | Skeleton template for downstream projects' Playwright + Page Object Model E2E suite. Currently empty — populated when a new project needs it. |
| **`library/`** | General engineering book library (DDD, Clean Code, TDD, etc.). |
| **`projects/`** | Home for downstream projects (e.g. `ZaakOs/` is the first one). |

## Stack (the build engine itself)

| Layer | Technology |
|-------|-----------|
| Orchestrator | Python 3 (Maestro) |
| Skills | Markdown + YAML frontmatter (declared tool allowlists) |
| Issue tracker | GitHub Issues (via `gh` CLI) |
| Message bus | GitHub comments with strict `PHASE_OUTPUT` blocks |
| Working memory | Per-issue JSON in `.maestro/tasks/active/` |
| Evidence | SHA256-hashed marker files in `.maestro/evidence/` |
| Dashboard | Textual TUI |

## Conventions (to be expanded)

- **Numbered folders = authority.** `00–50` is current truth, `90-archive` is reference only.
- **Index-first loading.** Always read `<folder>/_index.md` before scanning raw files.
- **No `as` type assertions** in TypeScript code.
- **Atomic writes** for all persisted state (`.tmp` + `os.rename`).
- **Tool allowlists enforced at the RPC layer**, not in prompts.

## Development Workflow

1. **Plan** — `grill-with-docs` to refine an idea, then `to-prd` to publish, then `to-issues` to slice.
2. **Build** — `maestro orchestrate --flow builder-reviewer --issue N` runs the loop.
3. **Audit** — `prd-auditor` and `context-sync-audit` catch drift between docs and code.

## Status

🚧 This file is a **stub**. After the cleanup pass completes and `docs-manager` regenerates the inventory, this `CONTEXT.md` will be rewritten from scratch to describe the build engine's actual shape.
