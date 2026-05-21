# System Design Spec — Meta-Workflow & Docs Gate

**Date:** 2026-05-16  
**Status:** Planning (Post-Grill Session)  
**Source:** Consensus from Grill-with-Docs session  

## 🎯 Objective
Build a robust system that builds features deterministically, solving the "Source of Truth" drift problem. The goal is to maintain `CONTEXT.md` as the living map without manual toil.

---

## 🔁 The Core Loops

### 1. Feature Loop (Implemented / In Progress)
The standard flow for creating new functionality:
1. **Grill & Define:** Use `grill-with-docs` to refine requirements and update context.
2. **Plan & Scope:** Create a PRD (`to-prd`) and break it into GitHub issues (`to-issues`).
3. **Implement (The Slice Loop):** Run `run-slices.sh`. The script fetches open issues and implements them one by one.

### 2. Documentation Gate (New)
An automatic checkpoint integrated into the Feature Loop to prevent drift:
*   **Trigger:** End of every batch in `run-slices.sh` (Batch-level gate).
*   **Action:** The system compares code against `CONTEXT.md`. If drift is found, it pauses the loop.
*   **Response:** Manual resolution required. You edit `CONTEXT.md` to match reality (or vice versa), then resume the script.

### 3. Bug Loop (Deferred)
*   *Scope:* Automated analysis of GitHub bug issues and re-planning.
*   *Status:* Deferred for now until core feature loops are solidified.

---

## 📚 Source of Truth Strategy

| Asset | Type | Behavior |
|-------|------|----------|
| **`CONTEXT.md`** | Living Map | Auto-checked by the Docs Gate. Human-edited to match code reality. |
| **ADRs (`docs/40-decisions/`)** | History | Immutable unless a decision is officially overturned. Not auto-updated. |

---

## 🛠️ Implementation Plan (Phases)

### Phase 1: The Gatekeeper (Audit Tooling)
*   Enhance `context-sync-audit` to be "Gate-Ready."
*   Must output a clear drift summary and return an exit code (`0` = clean, `1` = drift).

### Phase 2: The Orchestrator (Integrating into `run-slices.sh`)
*   Add `check_docs_gate()` function inside `run-slices.sh`.
*   Runs after every batch completes.
*   Implements "Pause & Resume" logic: waits for user input if drift is found.

### Phase 3: Testing & Polish
*   Verify flow end-to-end with a dummy feature (e.g., a "Counter" feature).
*   Ensure the system detects new code and pauses correctly.
