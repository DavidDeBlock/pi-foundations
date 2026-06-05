# Functionality Tracking Plan — Scripts & Reference

> **Purpose:** Catalog of available scripts for generating/maintaining an editable functionality plan, plus a current-state snapshot.  
> **Last updated:** 2026-05-22  

---

## 📦 Available Scripts for Planning

All scripts live under `scripts/` and run via:
```bash
tsx scripts/<script-path>.ts [args] [--json|--help]
```

### 🔍 Discovery Scripts — Understand Codebase Layout

| Script | Command | What It Produces | How It Helps Planning |
|--------|---------|-----------------|----------------------|
| **code-tree.ts** | `tsx scripts/tree/code-tree.ts [dir] --depth 3` | Categorized directory tree (source/generated/config/docs) | Maps folder structure → identifies missing modules, orphaned folders, feature boundaries. Feed output into "Core Infrastructure" section for refactoring items. |
| **api-routes.ts** | `tsx scripts/tree/api-routes.ts [dir]` | All Hono-style API routes with methods and paths | Reveals which endpoints exist vs. what the schema defines. Spot gaps: e.g., repairs table exists but no `/repairs` routes → "Repairs CRUD API" item in plan. |

### 🧠 Analysis Scripts — Understand Module Boundaries

| Script | Command | What It Produces | How It Helps Planning |
|--------|---------|-----------------|----------------------|
| **exports.ts** | `tsx scripts/extract/exports.ts <path>` | Exported functions, classes, types from a .ts file | Audit specific modules for completeness. Run on suspected incomplete features to see what's actually exported vs. stubbed. |

### 🔗 Synthesis Scripts — Understand Domain & Architecture

| Script | Command | What It Produces | How It Helps Planning |
|--------|---------|-----------------|----------------------|
| **domain-model.ts** | `tsx scripts/synthesize/domain-model.ts [dir]` | Entities + relations parsed from `@entity` / `@relation` tags | Compare schema reality vs. code annotations. Reveals entities with no routes (repairs, quotes, orders) → major feature gap items. |
| **api-surface.ts** | `tsx scripts/synthesize/api-surface.ts [dir]` | Full API surface with route signatures and handler details | See which endpoints have full implementations vs. stubs. Cross-reference with roadmap categories to verify completeness claims. |

### ✅ Validation Scripts — Find Quality Gaps

| Script | Command | What It Produces | How It Helps Planning |
|--------|---------|-----------------|----------------------|
| **test-coverage.ts** | `tsx scripts/validate/test-coverage.ts [dir]` | Source files with/without tests, coverage % per module | Directly feeds "Testing & Quality" section. Identifies untested services → test coverage items. |
| **layer-boundaries.ts** | `tsx scripts/validate/layer-boundaries.ts [dir]` | Cross-layer import violations (e.g., routes importing from ui/) | Feeds "Refactoring" category — each violation is a concrete refactoring task. |

### 📋 Documentation Scripts — Maintain Plan Accuracy

| Script | Command | What It Produces | How It Helps Planning |
|--------|---------|-----------------|----------------------|
| **scan-inventory.ts** | `tsx scripts/scan-inventory.ts [docs-root]` | Full docs inventory with file metadata | Keep plan documentation organized. Run before planning sessions to know what docs already exist vs. need creation. |
| **verify-structure.ts** | `tsx scripts/verify-structure.ts [docs-root]` | Validates folder numbering rules (00-current → 90-archive) | Ensures plan doc structure stays canonical. |

### 🛠️ Utility Scripts

| Script | Command | What It Produces |
|--------|---------|-----------------|
| **index.ts** | `tsx scripts/ [--list|--json]` | Human-readable or JSON catalog of all scripts with categories and usage | Quick reference when you forget a script name. |

---

## 🔄 Recommended Planning Workflow

To generate/maintain an editable functionality plan:

```
1. tsx scripts/tree/code-tree.ts src/          → Map folder structure, spot missing modules
2. tsx scripts/tree/api-routes.ts server/src/  → List all routes, compare to schema
3. tsx scripts/synthesize/domain-model.ts src/ → Find entities without routes (gaps!)
4. tsx scripts/validate/test-coverage.ts src/  → Identify untested services
5. tsx scripts/validate/layer-boundaries.ts src/ → Find refactoring opportunities
6. gh issue list --state open                  → Pull active GitHub issues into plan
7. Merge all findings into editable plan (see below)
```

---

## 📋 Current State Snapshot (as of 2026-05-22)

### Existing Plan: `ROADMAP.md` (project root)

Already covers the requested format — **grouped by category, one-line items, editable checkboxes**. Categories present:

| Category | Items | Notes |
|----------|-------|-------|
| 🔧 Core Infrastructure & Refactoring | 7 | Architecture, cleanup, standardization |
| 🛒 Sales Flow (Direct Sale) | 5 | Active feature area, basic flow built |
| 📦 Catalog Management | 3 | CRUD mostly done, polish needed |
| 🔍 Product Finder | 4 | Active development, multi-supplier |
| 🔧 Repairs & Service Work | 4 | **Major gap** — schema exists, zero routes/UI |
| 📋 Quotes, Orders & Backorders | 4 | **Major gap** — schema exists, zero routes/UI |
| 💳 Payments & Invoicing | 3 | **Gap** — schema exists, no dedicated API/UI |
| 📊 Inventory & Stock Management | 3 | Partial — stock movements used internally only |
| 🏗️ Supplier Integration | 2 | Schema exists, no implementation |
| 🤖 Operations & Automation | 3 | Maestro pipeline work |
| 🧪 Testing & Quality | 3 | No tests for services yet |
| 📝 Documentation & Polish | 4 | Doc sync needed |
| 🗑️ Known Technical Debt | 4 items | Scattered across codebase |

**Total: ~45 tracked items across 13 categories.**

### Open GitHub Issues (3 active)

| # | Title | Category Link |
|---|-------|--------------|
| **#120** | Product Finder Detail Pages — Expandable Row Views | 🔍 Product Finder |
| **#106** | Autonomous Pipeline Engine for Maestro Orchestrator | 🤖 Operations & Automation |
| **#102** | Product Finder Table Generalization, Gransier Mapping | 🔍 Product Finder |

### TODOs in Source Code

**None found.** All tracking is done via `ROADMAP.md` and GitHub issues (not inline comments).

---

## ⚠️ Script Dependency Note

All scripts require **`ts-morph`** as a dependency. Install before running:
```bash
cd /home/david/projects/pi-pos-v1 && pnpm add -D ts-morph
# or for standalone use: npm install -g ts-morph
```

Without `ts-morph`, the AST-parsing scripts (exports, domain-model, api-surface, test-coverage, layer-boundaries) will fail. The file-system-only scripts (code-tree, scan-inventory, verify-structure) work without it.

---

## 📌 Where to Edit

| What | Location | Format |
|------|----------|--------|
| **Functionality plan** | `ROADMAP.md` (project root) | Markdown checkboxes, grouped by category |
| **Open issues** | GitHub issue tracker | `gh issue list --state open` |
| **Domain glossary** | `docs/10-domain/glossary.md` | Markdown definitions |
| **Schema analysis** | `docs/10-domain/schema-analysis.md` | Entity relationships + business rules |
| **Architecture decisions** | `docs/40-decisions/*.md` | ADR format |

---

*This document is a reference. The actual plan lives in `ROADMAP.md`. Use the scripts above to validate and update it.*
