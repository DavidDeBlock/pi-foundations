# Information Waterfall — Documentation Loading Chain

**Date:** 2026-05-10  
**Status:** Read-only analysis (no modifications)

---

## Visual Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        STARTUP PHASE (Always Loaded)                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ~/.pi/agent/AGENTS.md ──────────────────────────────────── GLOBAL  │
│  • Agent definitions & task routing                                │
│  • Maps agents → skills                                            │
│  • Handoff patterns                                                │
│         │                                                          │
│         ▼                                                          │
│  .pi/SYSTEM.md ─────────────────────────────────────────── LOCAL    │
│  • Core runtime behavior rules                                     │
│  • Path conventions (WSL, prefix rules)                            │
│  • Execution gates & review rules                                  │
│  • Defines load order for downstream files                         │
│         │                                                          │
│         ▼                                                          │
└─────────┬───────────────────────────────────────────────────────────┘
          │
    ┌─────┴──────────────────────────────────────────────────────┐
    │                    CONDITIONAL LOAD PHASE                   │
    ├─────────────────────────────────────────────────────────────┤
    │                                                             │
    │  .pi/WORLD.md        ← Domain map & project structure       │
    │  .pi/INDEX.md        ← Skills quick reference               │
    │  .pi/FLOW.md         ← Workflow guide (referenced by        │
    │                         archivist but NOT in SYSTEM.md      │
    │                         load order — GAP)                   │
    │                                                             │
    │  CONTEXT.md            ← Domain glossary & business rules   │
    │  (repo root)             ← Written during grill sessions,   │
    │                           NEVER loaded at execution time     │
    │                           — CRITICAL GAP per analysis)       │
    │                                                             │
    └─────┬───────────────────────────────────────────────────────┘
          │
    ┌─────┴──────────────────────────────────────────────────────┐
    │                  ON-DEMAND LOAD PHASE                       │
    ├─────────────────────────────────────────────────────────────┤
    │                                                             │
    │  .pi/skills/<skill-name>/SKILL.md                           │
    │  • Loaded only when agent is invoked                        │
    │  • Each skill bundles its own supporting resources          │
    │    (e.g., grill-with-docs/CONTEXT-FORMAT.md)                │
    │                                                             │
    └─────┬───────────────────────────────────────────────────────┘
          │
    ┌─────┴──────────────────────────────────────────────────────┐
    │                  LAZY LOAD PHASE (Created on Demand)        │
    ├─────────────────────────────────────────────────────────────┤
    │                                                             │
    │  docs/agents/*.md            ← Created by setup-matt-pocock-│
    │                               skills when first used         │
    │  .pi/plans/active/*.md       ← Created by vertical-slice-   │
    │                               builder during feature work    │
    │  CONTEXT.md                  ← Created lazily by grill-with-│
    │                               docs on first term resolution  │
    │                                                             │
    └─────────────────────────────────────────────────────────────┘
```

---

## Layer-by-Layer Table

### Layer 1: Startup (Always Loaded)

| File | Path | Loaded By | Always? | Purpose |
|------|------|-----------|---------|---------|
| AGENTS.md | `~/.pi/agent/AGENTS.md` | Runtime init | ✅ Yes | Agent definitions, task routing, handoff patterns, skill mappings |
| SYSTEM.md | `.pi/SYSTEM.md` | Runtime init | ✅ Yes | Core runtime behavior, path conventions, execution gates, defines load order |

**Dependencies:** AGENTS.md references INDEX.md for detailed skill docs. SYSTEM.md references WORLD.md, INDEX.md, and skills directory.

---

### Layer 2: Project Context (Conditional Load)

| File | Path | Loaded By | Always? | Purpose |
|------|------|-----------|---------|---------|
| WORLD.md | `.pi/WORLD.md` | SYSTEM.md directive | ❌ Conditional | Domain map, project structure, entity definitions, layer boundaries, ADR references, testing strategy |
| INDEX.md | `.pi/INDEX.md` | SYSTEM.md directive | ❌ Conditional | Skills quick reference, project conventions, tech stack summary, directory structure overview |
| FLOW.md | `.pi/FLOW.md` | archivist skill (implicit) | ❌ Conditional ⚠️ | Standard workflow guide — **NOT listed in SYSTEM.md load order** but referenced by archivist |
| CONTEXT.md | `./CONTEXT.md` | grill-with-docs (writes), skills (should read) | ❌ Conditional ⚠️ | Domain glossary & business rules — **exists at repo root but NEVER loaded during execution** per agent-workflow-analysis.md |

**Dependencies:** WORLD.md references docs/02-architecture/adr/index.md, docs/04-operations/testing.md, docs/08-reference/tech-stack.md. INDEX.md references AGENTS.md for full details and docs/ folders for conventions/architecture/testing.

---

### Layer 3: Skills (On-Demand Load)

| File | Path | Loaded By | Always? | Purpose |
|------|------|-----------|---------|---------|
| SKILL.md files | `.pi/skills/<name>/SKILL.md` | Agent invocation | ❌ On-demand | Detailed instructions for each agent role (32 skills total) |

**Key skill cross-references:**

| Skill | References | Notes |
|-------|-----------|-------|
| archivist | SYSTEM.md, WORLD.md, FLOW.md, AGENTS.md, specific SKILL.md files | Only skill that explicitly references FLOW.md |
| typescript-implementer | docs/agents/issue-tracker.md (if exists), triage/AGENT-BRIEF.md | Gracefully skips if missing |
| reviewer | ADRs, conventions, planner brief | Expects context NOT provided by run-slices.sh |
| architect | CONTEXT.md, ADRs, domain notes | Required inputs include "domain notes" and "conventions" |
| tdd | tests.md, mocking.md, deep-modules.md, interface-design.md, refactoring.md (bundled) | References project glossary & ADRs but they're not loaded |
| grill-with-docs | CONTEXT-FORMAT.md, ADR-FORMAT.md (bundled), CONTEXT.md, docs/adr/ | Creates files lazily; updates CONTEXT.md inline |
| to-prd | CONTEXT.md, ADRs | Uses domain glossary vocabulary throughout PRD |
| triage | AGENT-BRIEF.md, OUT-SCOPE.md (bundled) | Explores codebase using domain glossary & respects ADRs |
| setup-matt-pocock-skills | issue-tracker templates, triage-labels.md, domain.md (bundled) | Creates docs/agents/*.md on first run |

---

### Layer 4: Documentation Folder (Referenced, Not Auto-Loaded)

The `docs/` folder is **never auto-loaded** by the runtime. It's referenced by WORLD.md and INDEX.md as a knowledge base that skills should load on-demand when needed.

```
docs/
├── index.md                    ← Master documentation index (referenced by WORLD.md, docs/index.md)
├── README.md                   ← Project-level readme
├── flows.md                    ← Business flow diagrams
├── temp.md                     ← Temporary/stale file ⚠️
│
├── 01-onboarding/              ← Developer onboarding
│   ├── quickstart.md           ← Setup guide (referenced by INDEX.md)
│   ├── full-setup.md
│   ├── conventions.md          ← Coding standards (referenced by WORLD.md, INDEX.md)
│   ├── glossary.md             ← Project terminology
│   └── README.md
│
├── 02-architecture/            ← System design & decisions
│   ├── overview.md             ← High-level system design (referenced by INDEX.md)
│   ├── backend-review.md
│   ├── prd/client-server-divergence-fix.md
│   ├── adr/                    ← Architecture Decision Records
│   │   ├── index.md            ← ADR registry (referenced by WORLD.md, INDEX.md)
│   │   ├── ADR-001-feature-folder-structure.md
│   │   ├── ADR-002-react-router-data-api.md
│   │   ├── ADR-003-zustand-state-management.md
│   │   ├── ADR-004-app-event-system.md
│   │   └── templates/adr-template.md
│   └── patterns/               ← Architectural patterns
│       ├── README.md
│       └── state-management.md (referenced by INDEX.md)
│
├── 03-features/                ← Feature documentation
│   ├── README.md
│   └── patterns/crud-pattern.md
│
├── 04-operations/              ← Dev/test/deploy workflows
│   ├── README.md
│   ├── development.md
│   ├── testing.md              ← Testing strategy (referenced by WORLD.md, INDEX.md)
│   ├── deployment.md
│   ├── troubleshooting.md
│   └── agent-workflow-analysis.md  ← Prior analysis of this very chain
│
├── 05-apis/                    ← API documentation
│   ├── README.md
│   ├── client-api.md
│   ├── server-api.md
│   └── contracts/              ← API contract definitions
│       ├── README.md
│       └── todo-api-contract.md
│
├── 06-templates/               ← Spec & checklist templates
│   ├── feature-contract-template.md
│   ├── app-contract-template.md
│   └── handover-checklist.md
│
├── 07-examples/                ← Code examples
│   ├── README.md
│   └── integration/todo-feature-example.md
│
├── 08-reference/               ← Reference material
│   ├── tech-stack.md           ← Tech choices (referenced by WORLD.md, INDEX.md)
│   ├── changelog.md
│   ├── migration-guide.md
│   └── tmux-cheatsheet.md
│
├── issues/                     ← Issue tracking files
├── prd/                        ← PRD documents
├── prds/                       ← More PRD documents
├── react-guides/               ← React-specific tutorials
├── react-router-tutorials/     ← React Router tutorials
├── review/                     ← Review templates & summaries
│   └── foundation/
├── roadmaps/                   ← Implementation roadmaps
└── slices/                     ← Feature slice definitions
```

---

### Layer 5: Lazy-Created Files (Created on First Use)

| File | Created By | Purpose |
|------|-----------|---------|
| `docs/agents/*.md` | setup-matt-pocock-skills | Issue tracker config, triage labels, domain doc layout |
| `.pi/plans/active/*.md` | vertical-slice-builder | Feature blueprints during implementation |
| `.pi/plans/archive/*.md` | vertical-slice-builder (Phase 3) | Archived completed feature plans |
| `CONTEXT.md` | grill-with-docs | Domain glossary (created lazily, updated inline) |

---

## Dependency Graph (File-to-File References)

```
AGENTS.md ──────────────► INDEX.md          (for detailed skill docs)
    │
    ├────────────────────► .pi/skills/*/SKILL.md  (skill definitions)
    │
    └────────────────────► .pi/FLOW.md        (workflow patterns)

SYSTEM.md ──────────────► AGENTS.md           (always loaded first)
    │                   ► WORLD.md            (conditional)
    │                   ► INDEX.md            (conditional)
    │                   ► skills/ directory   (on-demand)
    │
    └───────────────────► CONTEXT.md          (path reference only, not loaded)

WORLD.md ───────────────► docs/02-architecture/adr/index.md
    │                   ► docs/04-operations/testing.md
    │                   ► docs/08-reference/tech-stack.md
    │                   ► docs/01-onboarding/conventions.md
    │
    └───────────────────► CONTEXT.md          (domain entities)

INDEX.md ───────────────► AGENTS.md           (for full agent details)
    │                   ► WORLD.md            (for domain map)
    │                   ► docs/02-architecture/overview.md
    │                   ► docs/01-onboarding/conventions.md
    │                   ► docs/04-operations/testing.md
    │                   ► docs/08-reference/tech-stack.md

archivist ──────────────► SYSTEM.md           (core system files)
    │                   ► WORLD.md            (domain map)
    │                   ► FLOW.md             ← UNIQUE reference
    │                   ► AGENTS.md           (task routing)
    │                   ► specific SKILL.md   (planner, implementer, reviewer)

grill-with-docs ────────► CONTEXT.md          (read & write)
    │                   ► docs/adr/           (read existing ADRs)
    │                   ► CONTEXT-FORMAT.md   (bundled template)
    │                   ► ADR-FORMAT.md       (bundled template)

typescript-implementer ─► docs/agents/issue-tracker.md  (if exists)
    │                   ► triage/AGENT-BRIEF.md         (bundled)

reviewer ───────────────► ADRs, conventions, planner brief  (expected but not provided)

tdd ────────────────────► tests.md, mocking.md, deep-modules.md   (all bundled in skill dir)
    │                   ► interface-design.md, refactoring.md     (bundled)
    │                   ► domain glossary (CONTEXT.md — should be loaded)
    │                   ► ADRs (should be loaded but aren't)

setup-matt-pocock-skills ─► AGENTS.md or CLAUDE.md (writes into)
    │                       ► docs/agents/*.md       (creates)
    │                       ► issue-tracker templates, triage-labels.md, domain.md (bundled)
```

---

## Identified Gaps & Issues

### 🔴 Critical Gaps

| Gap | Description | Affected Files/Skills |
|-----|-------------|----------------------|
| **CONTEXT.md never loaded at execution** | Domain glossary is written during grill sessions but never read by Builder, Reviewer, TDD, or any execution-time skill. Terminology drifts unchecked. | typescript-implementer, reviewer, tdd, triage (all reference "domain glossary" in their instructions) |
| **PRD parent context invisible to Builder** | Implementation Decisions and Testing Decisions live only in the PRD issue body; individual issues don't carry this context. | run-slices.sh → typescript-implementer handoff |
| **Reviewer receives insufficient context** | reviewer SKILL.md expects "planner brief, architect guidance, conventions, ADRs" — none of these are provided by the execution pipeline. | reviewer skill definition vs actual input |

### 🟡 Medium Gaps

| Gap | Description | Affected Files/Skills |
|-----|-------------|----------------------|
| **FLOW.md not in SYSTEM.md load order** | archivist explicitly references FLOW.md, but SYSTEM.md's "Runtime Initialization" section doesn't list it. It exists and is loaded implicitly. | archivist skill, SYSTEM.md |
| **docs/agents/ directory missing** | setup-matt-pocock-skills creates this lazily on first run. typescript-implementer references `docs/agents/issue-tracker.md` but it doesn't exist yet. | typescript-implementer, setup-matt-pocock-skills |
| **ADR lifecycle incomplete** | Multiple skills reference ADRs ("respect ADRs") and grill-with-docs can create them, but there's no mechanism to ensure ADRs created during grilling are visible to downstream execution stages. | tdd, reviewer, architect, grill-with-docs |
| **temp.md is orphaned** | `docs/temp.md` (19KB) — appears to be a stale working file with no references from any other document. | docs/ directory cleanliness |

### 🟢 Minor Observations

| Observation | Description |
|-------------|-------------|
| **Skill count mismatch** | INDEX.md lists 9 skills in its table, but `.pi/skills/` contains 32 SKILL.md files. The index is outdated. |
| **setup-matt-pocock-skills not in INDEX.md** | This bootstrap skill isn't listed in the INDEX.md skills table despite being a critical setup dependency. |
| **zoom-out skill exists but undocumented** | `.pi/skills/zoom-out/SKILL.md` exists (32 total) but isn't referenced anywhere in the core chain. |
| **CONTEXT.md at repo root** | The project has a well-maintained CONTEXT.md with full domain glossary, but it's treated as an output file by grill-with-docs rather than a loaded input during execution. |

---

## Load Order Summary (Corrected)

The SYSTEM.md states this load order:

```
1. ~/.pi/agent/AGENTS.md  — Always first
2. .pi/SYSTEM.md          — Current file (self-referencing)
3. .pi/WORLD.md           — When needed
4. .pi/INDEX.md           — For skill lookups
5. Skill SKILL.md files   — On-demand per agent
```

**Correction:** FLOW.md should be added to this list as Layer 2 (conditional), since archivist explicitly depends on it:

```
1. ~/.pi/agent/AGENTS.md  — Always first
2. .pi/SYSTEM.md          — Current file (self-referencing)
3. .pi/WORLD.md           — When needed
4. .pi/FLOW.md            — When archivist is invoked ⚠️ NOT in current list
5. .pi/INDEX.md           — For skill lookups
6. Skill SKILL.md files   — On-demand per agent
```

---

## Execution-Time Context Flow (vs. Design Intent)

| What Skills Say They Need | What They Actually Receive | Gap Severity |
|---------------------------|---------------------------|--------------|
| Domain glossary (CONTEXT.md) | Nothing — not loaded | 🔴 Critical |
| ADRs from docs/adr/ | Nothing — not loaded | 🟡 Medium |
| Project conventions | Only if explicitly injected | 🟡 Medium |
| PRD parent issue body | Only individual issue body | 🔴 Critical |
| Planner brief | Only in direct agent sessions, not via run-slices.sh | 🔴 Critical |
| Architect guidance | Only in direct agent sessions | 🔴 Critical |

**Core pattern:** Context accumulates during planning stages (optimizer → grill → PRD) but evaporates at execution time. The Builder and Reviewer operate with only the narrowest slice of information — the individual issue body — while all architectural reasoning, domain terminology, and testing strategy lives in files they never read.

---

*Generated: 2026-05-10 | Based on analysis of .pi/SYSTEM.md, AGENTS.md, WORLD.md, INDEX.md, FLOW.md, CONTEXT.md, 32 skill SKILL.md files, docs/ tree (78 markdown files), and prior agent-workflow-analysis.md*
