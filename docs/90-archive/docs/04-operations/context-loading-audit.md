# Info-Waterfall Verification Report

**Date:** 2026-05-10  
**Reference Document:** `docs/04-operations/info-waterfall.md`  
**Method:** Compared each claim in the waterfall against actual file contents and filesystem state

---

## Verified Claims (Accurate)

| # | Claim | Status |
|---|-------|--------|
| 1 | FLOW.md exists at `.pi/FLOW.md` but is **not listed in SYSTEM.md load order** | ✅ Confirmed — SYSTEM.md lists 5 files; FLOW.md absent |
| 2 | archivist SKILL.md references FLOW.md as a core system file | ✅ Confirmed — "Workflow → `.pi/FLOW.md`" in Documentation Sources table |
| 3 | CONTEXT.md exists at repo root with domain glossary content (11KB) | ✅ Confirmed — contains Bicycle Repair POS glossary, status lifecycle, editability rules |
| 4 | `docs/agents/` directory does not exist | ✅ Confirmed — `ls: No such file or directory` |
| 5 | typescript-implementer references `docs/agents/issue-tracker.md` with graceful skip | ✅ Confirmed — "Read `docs/agents/issue-tracker.md` (if it exists)" |
| 6 | INDEX.md skills table lists **9 skills** while `.pi/skills/` contains **32 SKILL.md files** | ✅ Confirmed — 9 in table, 32 on disk |
| 7 | `setup-matt-pocock-skills` not listed in INDEX.md | ✅ Confirmed — absent from both the skills table and directory structure section |
| 8 | `zoom-out` skill exists but has no references in `.pi/` root files | ✅ Confirmed — SKILL.md present, zero grep hits in `.pi/*.md` |
| 9 | reviewer SKILL.md expects "planner brief, architect guidance, conventions, ADRs" as input | ✅ Confirmed — listed verbatim in Quick Start section |
| 10 | tdd SKILL.md says "use the project's domain glossary" and "respect ADRs" | ✅ Confirmed — Planning section: "use the project's domain glossary so that test names...match the project's language, and respect ADRs" |
| 11 | run-slices.sh passes only issue body to Builder/Reviewer (no CONTEXT.md, no ADRs, no PRD parent) | ✅ Confirmed — `build_builder_prompt` and `run_reviewer` inject only `${issue_body}` + builder comment |
| 12 | CONTEXT.md is written by grill-with-docs but never loaded into run-slices.sh prompts | ✅ Confirmed — no `CONTEXT.md` reference in run-slices.sh |
| 13 | ADR files ADR-001 through ADR-004 exist at `docs/02-architecture/adr/` | ✅ Confirmed — all four present on disk |

---

## Inaccurate Claims (Need Correction)

### 1. temp.md file size is wrong

| Field | Detail |
|-------|--------|
| **Location** | Medium Gaps table, "temp.md is orphaned" row |
| **Waterfall says** | `docs/temp.md` is **19KB** |
| **Actual fact** | File is **92,167 bytes (~90KB)** — nearly 5× larger than stated |
| **Fix** | Update to "92KB" or remove size claim entirely |

---

### 2. run-slices.sh invokes `tdd`, not `typescript-implementer`

| Field | Detail |
|-------|--------|
| **Location** | Layer 3 skill cross-references table; Execution-Time Context Flow section ("run-slices.sh → typescript-implementer handoff") |
| **Waterfall says** | Builder uses typescript-implementer via run-slices.sh |
| **Actual fact** | `build_builder_prompt()` invokes `/skill:tdd` — confirmed at line 219 of run-slices.sh. The script never references typescript-implementer. |
| **Fix** | Replace all "typescript-implementer" references in execution context with "tdd". Significant because tdd's requirements (domain glossary, ADRs) differ from typescript-implementer's (planner brief, architect guidance). |

---

### 3. run-slices.sh path location not stated

| Field | Detail |
|-------|--------|
| **Location** | Throughout the document where `run-slices.sh` is referenced |
| **Waterfall says** | No explicit path given; implied to be discoverable |
| **Actual fact** | Located at `.pi/slices/run-slices.sh` (not `scripts/`, not root) |
| **Fix** | Add the actual path `.pi/slices/run-slices.sh` wherever it's referenced, or add a PATH REFERENCE entry |

---

### 4. Markdown file count in docs/ is wrong

| Field | Detail |
|-------|--------|
| **Location** | Footer: "docs/ tree (78 markdown files)" |
| **Waterfall says** | Analysis based on "78 markdown files" |
| **Actual fact** | `find docs/ -name "*.md"` returns **72** files |
| **Fix** | Update to "72 markdown files" or clarify the scope if counting beyond docs/ |

---

## Partially Accurate Claims (Need Nuance)

### 5. "CONTEXT.md never loaded at execution" — true for run-slices.sh, but incomplete

| Field | Detail |
|-------|--------|
| **Location** | Critical Gaps table; Execution-Time Context Flow section |
| **Waterfall says** | Terminology drifts unchecked because no execution agent loads it |
| **Nuance missing** | This is true for the *automated* pipeline (run-slices.sh), but when skills are invoked directly in an interactive session (e.g. `/skill:tdd` or `/skill:typescript-implementer`), the agent *can* choose to read CONTEXT.md since its SKILL.md instructs it to. The gap is specifically that **the orchestrator script doesn't inject it**, not that the skills themselves forbid reading it. |
| **Fix** | Clarify "never loaded by run-slices.sh" rather than "never loaded at execution time" |

---

### 6. "PRD parent context invisible to Builder" — accurate but could be more specific

| Field | Detail |
|-------|--------|
| **Location** | Critical Gaps table, first row |
| **Waterfall says** | run-slices.sh doesn't fetch parent issue |
| **Nuance missing** | The script does `gh issue view <number>` for the *current* issue but never resolves a "parent" reference. If to-issues links slices to their PRD via GitHub's "links" feature or a `Parent: #N` field, that data is available via API but simply not fetched. |
| **Fix** | Add specificity — "run-slices.sh fetches only the current issue body; no parent resolution step exists even if parent reference is present" |

---

## Summary of Required Corrections to info-waterfall.md

| Priority | Issue | Fix |
|----------|-------|-----|
| 🔴 High | run-slices.sh uses `tdd`, not `typescript-implementer` | Update all execution references from typescript-implementer → tdd; update affected gap descriptions accordingly |
| 🟡 Medium | temp.md is 92KB, not 19KB | Correct size in Medium Gaps table |
| 🟡 Medium | docs/ contains 72 .md files, not 78 | Update footer count |
| 🟢 Low | run-slices.sh path not stated | Add `.pi/slices/run-slices.sh` to PATH REFERENCE or inline references |
| 🟢 Low | "Never loaded at execution" overstates the case | Clarify that the gap is in the orchestrator script, not in skill definitions themselves |

---

**Bottom line:** The waterfall's structural analysis and gap identification are **substantively correct**. The core finding — context accumulates during planning (grill → PRD) but evaporates at execution (run-slices.sh) — is verified against the actual code. There are 2 factual errors (temp.md size, skill name), 1 count discrepancy (78 vs 72 files), and 2 claims that could be more precisely scoped.
