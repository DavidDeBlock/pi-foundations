# Agent Workflow — Information Flow Analysis

**Date:** 2026-05-10  
**Status:** Diagnostic (not yet redesigned)

## Overview

Maps information flow through the agent workflow and identifies where data is lost, degraded, or missing at each handoff.

### Current Workflow

```
Idea → Prompt Optimizer → Grill-with-docs → to-prd → to-issues → run-slices.sh
```

---

## Stage-by-Stage Handoff Table

| Stage | Input Available | Output Produced | Potential Gaps |
|-------|----------------|-----------------|----------------|
| **1 → 2**<br>Idea → Prompt Optimizer | Raw user idea (unstructured text, possibly vague) | Structured prompt: Task/Goal/Context/Scope/Non-goals/Output format/Stop condition | ⚠️ No codebase exploration. Domain context from `CONTEXT.md` is **not loaded or referenced**. If the raw idea uses imprecise domain language, it's preserved as-is without correction. The optimizer has no way to detect that "account" should be "customer" per glossary. |
| **2 → 3**<br>Optimized Prompt → Grill-with-docs | Structured prompt + conversation history + `CONTEXT.md` (loaded by skill) | Refined understanding; `CONTEXT.md` updated inline with sharpened terms; resolved ambiguities captured in domain language | ⚠️ The optimized prompt's structure (Scope/Non-goals/Stop condition) may be **dissolved into free-form Q&A**. There's no checkpoint confirming the grill session preserved all structural constraints from step 2. Good: CONTEXT.md captures terminology permanently. Bad: scope boundaries from the optimizer can drift during extended grilling. |
| **3 → 4**<br>Grilled Understanding → to-prd | Full conversation context (grill Q&A) + codebase state + `CONTEXT.md` (updated) | PRD published to issue tracker: Problem Statement, Solution, User Stories, Implementation Decisions, Testing Decisions, Out of Scope, Further Notes. Labelled `needs-triage`. | ⚠️ The PRD is synthesized from conversation — the optimizer's explicit **Scope/Non-goals** may not map cleanly into the PRD template's "Out of Scope" section (different framing). Risk: scope boundaries get softened during synthesis. Good: codebase exploration happens here, grounding decisions in reality. |
| **4 → 5**<br>PRD → to-issues | PRD body (fetched from issue tracker) + codebase context | Vertical slice issues published individually: Title, Type (HITL/AFK), Blocked by, User stories covered, Acceptance criteria, Parent reference. Each labelled `needs-triage`. | 🔴 **Implementation Decisions** from the PRD are at the parent level — they may not propagate into individual issue bodies. The issue template has no section for architectural constraints or domain terminology.<br>🔴 **Testing Decisions** from the PRD are lost — the issue template has no testing section.<br>⚠️ No validation that all user stories were covered by at least one slice. |
| **5 → 6a**<br>Issues → Builder (run-slices.sh) | Issue body fetched via `gh issue view` + previous reviewer critique (on retry) | Implemented code; result file (`slice-result.json`); `[BUILDER]` comment posted to GitHub issue; session log captured | 🔴 **PRD is never loaded.** Only the individual issue body reaches the Builder. Implementation Decisions, Testing Decisions, Problem Statement, and Out of Scope are all invisible.<br>🔴 `CONTEXT.md` is **not referenced** in the builder prompt. Domain glossary terms may drift — the Builder has no authoritative vocabulary source.<br>⚠️ `/skill:tdd` is invoked, which says "use domain glossary" and "respect ADRs" — but neither CONTEXT.md nor any ADR files are loaded into the prompt. The instruction exists without the data to execute it.<br>⚠️ Parent reference in issue body points to PRD issue number, but there's no `gh issue view` of the parent — it's dead context. |
| **6a → 6b**<br>Builder → Reviewer (run-slices.sh) | Issue body + Builder's `[BUILDER]` comment from GitHub | Verdict (`approved`/`rejected`) + critique; result file; reviewer comment posted to GitHub | 🔴 Reviewer skill expects: *"planner brief, architect guidance, conventions, ADRs, acceptance criteria"* — but receives only **issue body + builder summary**. Planner brief = missing. Architect guidance = missing. Conventions = not loaded. ADRs = not loaded.<br>🔴 Testing Decisions from PRD are invisible to the Reviewer — can't validate whether tests match the intended testing strategy.<br>⚠️ Reviewer's bash timeout rules (10-15s) may conflict with actual test suite duration, causing silent timeouts that degrade review quality. |
| **6b → 6a**<br>Reviewer Reject → Builder Retry | Previous critique (extracted from result file as plain text) + issue body | Revised implementation attempt (up to MAX_RETRIES=3) | ⚠️ Critique is passed as raw text — no structured format. If the reviewer identifies a structural/architectural issue, the Builder has no architect skill loaded to resolve it; it just re-attempts with the same constraints.<br>⚠️ After 3 failures, the slice is marked `failed-slice` and **aborts entirely** (exits). No escalation path to Architect or DB Engineer. |

---

## Cross-Cutting Gaps

| Gap | Affected Stages | Severity |
|-----|----------------|----------|
| **CONTEXT.md written but never read at execution time** | Updated in stage 3, invisible in stages 5→6 | 🔴 Critical |
| **PRD published but parent content never fetched during execution** | Created in stage 4, referenced in stage 5, ignored in stage 6 | 🔴 Critical |
| **ADR lifecycle incomplete** — skills reference ADRs but no ADR directory exists and none are created during the workflow | All stages that mention ADRs (grill-with-docs, to-prd, to-issues, tdd, reviewer) | 🟡 Medium |
| **Session logs captured but never consumed** — builder/reviewer RPC logs saved to JSON but not fed into retries or future slices | Stage 6 (retry loop) | 🟡 Medium |
| **No user story coverage check** — PRD lists extensive user stories; no validation that every story maps to at least one issue | Stages 4→5 handoff | 🟡 Medium |

---

## Ranked Gaps to Address

1. 🔴 **Builder/Reviewer have no access to CONTEXT.md** — The domain glossary is the single source of truth for terminology, but neither execution agent loads it. This means naming conventions, entity relationships, and business rules defined in grilling are invisible during implementation. *Fix would be: inject `CONTEXT.md` content into both builder and reviewer prompts.*

2. 🔴 **PRD parent issue never fetched at execution time** — Implementation Decisions and Testing Decisions live only in the PRD. Individual issues carry acceptance criteria but not the architectural context or testing strategy that informed them. *Fix would be: fetch parent issue body and include it in builder/reviewer prompts.*

3. 🔴 **Reviewer receives insufficient context per its own skill definition** — The reviewer SKILL.md explicitly lists "planner brief, architect guidance, conventions, ADRs" as expected input. None of these are provided by `run-slices.sh`. *Fix would be: enrich the reviewer prompt with PRD content and project conventions.*

4. 🟡 **No user story → issue coverage validation** — The to-prd skill produces "extensive" user stories, but to-issues has no mechanism to verify complete coverage. Stories can silently fall through the cracks. *Fix would be: add a coverage matrix step in to-issues that maps each story to its slice.*

5. 🟡 **ADR lifecycle is referenced but non-functional** — Multiple skills say "respect ADRs" but `docs/adr/` doesn't exist and no ADRs are created during the workflow. grill-with-docs offers ADRs sparingly, but there's no guarantee they'll be surfaced to downstream stages. *Fix would be: either create ADRs when architectural decisions crystallize in grilling, or remove ADR references from execution skills.*

6. 🟡 **Retry loop has no escalation path** — After 3 builder attempts with reviewer critique, the slice hard-exits with `failed-slice`. There's no handoff to Architect for structural issues or DB Engineer for schema problems — both of which are defined as valid reviewer handoffs in the reviewer skill. *Fix would be: add an escalation step that routes specific failure types to specialist agents.*

7. 🟡 **Session logs not used for learning** — Builder and reviewer RPC sessions are logged but never analyzed or fed back. A pattern of repeated failures on the same slice type could be detected and surfaced, but isn't. *Fix would be: analyze session-logs.json before retrying to detect recurring failure patterns.*

---

## Visual Summary

```
Idea → [Optimizer] → [Grill] → [PRD] → [Issues] → [Builder/Reviewer Loop]
         │              │          │          │            │
         ✗ no context   ✓ updates  ✓ published ✗ decisions  ✗ no PRD
         ✗ no glossary  ✓ updates  ✓ user     ✗ testing    ✗ no CONTEXT.md
                         CONTEXT.md stories    lost         ✗ no ADRs
                                                    ↓
                                              [Execution blind to
                                               parent context]
```

**Core pattern:** Context accumulates in stages 2–4 but evaporates at stage 6. The execution loop (Builder/Reviewer) operates with only the narrowest slice of information — the individual issue body — while all the architectural reasoning, domain terminology, and testing strategy that informed those issues lives in files and parent issues it never reads.
