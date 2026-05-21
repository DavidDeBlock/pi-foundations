# Context Loading Audit — run-slices.sh

**Date:** 2026-05-10  
**Scope:** Fix context delivery within existing slice execution loop only. No architectural redesign.  
**Files analyzed:** `.pi/slices/run-slices.sh`, `docs/04-operations/agent-workflow-analysis.md`  
**Cross-referenced:** `CONTEXT.md` (exists, 11KB), `docs/adr/` (does not exist), reviewer SKILL.md, tdd SKILL.md

---

## Findings Map

Each finding from the agent workflow analysis is mapped against actual code behavior in `run-slices.sh`.

---

### 🔴 Finding 1: Builder has no access to CONTEXT.md

| Field | Value |
|-------|-------|
| **Analysis severity** | Critical |
| **Status in run-slices.sh** | ❌ **CONFIRMED — NOT FIXED** |
| **Code location** | `build_builder_prompt()` (line ~175) |

**What the analysis said:**  
> "CONTEXT.md is not referenced in the builder prompt. Domain glossary terms may drift."

**What the code does:**  
`build_builder_prompt()` constructs a prompt with only three sections:
- Issue body as source of truth
- Generic rules ("follow existing patterns")
- Result file format instructions

No `CONTEXT.md` content is injected anywhere in the builder prompt. The `/skill:tdd` directive says "use domain glossary" but provides no glossary to use.

**Impact:** Builder implements using its own vocabulary, not the project's authoritative domain language. Naming conventions, entity relationships, and business rules defined during grilling are invisible.

---

### 🔴 Finding 2: PRD parent issue never fetched at execution time

| Field | Value |
|-------|-------|
| **Analysis severity** | Critical |
| **Status in run-slices.sh** | ❌ **CONFIRMED — NOT FIXED** |
| **Code location** | `fetch_issue_body()` (line ~158), `process_issue()` loop |

**What the analysis said:**  
> "PRD is never loaded. Only the individual issue body reaches the Builder."

**What the code does:**  
`fetch_issue_body()` calls `gh issue view <number>` on the slice issue only. There is no logic to:
- Extract a parent PRD reference from the issue body
- Fetch the parent issue via `gh issue view <parent_number>`
- Inject parent content into either builder or reviewer prompts

**Impact:** Implementation Decisions, Testing Decisions, Problem Statement, and Out of Scope sections from the PRD are invisible to both Builder and Reviewer.

---

### 🔴 Finding 3: Reviewer receives insufficient context per its own skill definition

| Field | Value |
|-------|-------|
| **Analysis severity** | Critical |
| **Status in run-slices.sh** | ❌ **CONFIRMED — NOT FIXED** |
| **Code location** | `run_reviewer()` (line ~290) |

**What the analysis said:**  
> "Reviewer skill expects: planner brief, architect guidance, conventions, ADRs, acceptance criteria — but receives only issue body + builder summary."

**What the code does:**  
`run_reviewer()` constructs a prompt with only three sections:
- Issue body (title, number, body)
- Builder's implementation summary comment (if present)
- Generic task instructions and result format

Missing entirely:
- **Planner brief** — no decomposition of work into phases
- **Architect guidance** — no structural constraints or domain boundaries
- **Conventions** — no project coding conventions loaded
- **ADRs** — no architectural decision records (and `docs/adr/` doesn't exist)

The reviewer SKILL.md explicitly states: *"Input: implemented slice, planner brief, architect guidance, conventions, ADRs, acceptance criteria"* — four of these six inputs are missing.

---

### 🟡 Finding 4: No user story → issue coverage validation

| Field | Value |
|-------|-------|
| **Analysis severity** | Medium |
| **Status in run-slices.sh** | ⚠️ **OUT OF SCOPE** — This is a `to-issues` handoff problem, not an execution loop concern. The slice orchestrator has no visibility into PRD user stories vs. issue count. |

---

### 🟡 Finding 5: ADR lifecycle referenced but non-functional

| Field | Value |
|-------|-------|
| **Analysis severity** | Medium |
| **Status in run-slices.sh** | ❌ **CONFIRMED — NOT FIXED** |
| **Code location** | N/A (no `docs/adr/` directory exists) |

**What the analysis said:**  
> "Multiple skills say 'respect ADRs' but docs/adr/ doesn't exist and no ADRs are created during the workflow."

**Verification:** `ls docs/adr/` confirms no such directory exists. The script has zero references to ADR files or directories.

**Impact:** Both tdd SKILL.md ("respect ADRs in the area you're touching") and reviewer SKILL.md (expects "ADRs" as input) reference something that doesn't exist. This is a systemic issue — not just run-slices.sh, but the entire workflow pipeline.

---

### 🟡 Finding 6: Retry loop has no escalation path

| Field | value |
|-------|-------|
| **Analysis severity** | Medium |
| **Status in run-slices.sh** | ❌ **CONFIRMED — NOT FIXED** |
| **Code location** | `process_issue()` (line ~430), final else branch |

**What the analysis said:**  
> "After 3 builder attempts with reviewer critique, the slice hard-exits. No handoff to Architect or DB Engineer."

**What the code does:**  
```bash
# In process_issue(), after retry_count >= MAX_RETRIES:
log_error "Issue #${issue_num} — FAILED after ${max_retries} attempts ❌"
exit 1
```

The script exits with code 1. No escalation to Architect, DB Engineer, or any specialist agent. The reviewer SKILL.md defines these as valid handoffs but the orchestrator never invokes them.

---

### 🟡 Finding 7: Session logs not used for learning

| Field | Value |
|-------|-------|
| **Analysis severity** | Medium |
| **Status in run-slices.sh** | ⚠️ **PARTIALLY ADDRESSED — Logs are written but never read during retries** |
| **Code location** | `run_builder()` and `run_reviewer()` (log writing), `process_issue()` retry loop (no log reading) |

**What the code does:**  
Session logs ARE captured per attempt and saved to `${STATE_FILE%.json}-logs.json`. However, during retries (`process_issue()`), these logs are never read or analyzed. The retry only receives raw critique text — no pattern detection from prior failures.

---

## Summary Matrix

| # | Finding | Severity | Confirmed in Code | In Scope for This Fix? |
|---|---------|----------|-------------------|------------------------|
| 1 | Builder has no CONTEXT.md | 🔴 Critical | ✅ Yes | ✅ **YES** — inject into builder prompt |
| 2 | PRD parent never fetched | 🔴 Critical | ✅ Yes | ✅ **YES** — fetch + inject into both prompts |
| 3 | Reviewer missing context inputs | 🔴 Critical | ✅ Yes | ✅ **YES** — enrich reviewer prompt |
| 4 | No story→issue coverage check | 🟡 Medium | ⚠️ Out of scope | ❌ NO — belongs in to-issues skill |
| 5 | ADR lifecycle non-functional | 🟡 Medium | ✅ Yes | ⚠️ **PARTIAL** — reference existing CONTEXT.md; no ADRs exist yet |
| 6 | No escalation path on failure | 🟡 Medium | ✅ Yes | ❌ NO — requires architectural change (new agent handoff) |
| 7 | Session logs not consumed | 🟡 Medium | ⚠️ Partially | ❌ NO — logging infrastructure is fine; consumption is a future enhancement |

---

## Concrete Fix Plan

### Scope: Only findings #1, #2, and #3 (the three critical context gaps)

These are all solved by enriching the two prompt-building functions in `run-slices.sh`:
- `build_builder_prompt()` — for the Builder agent
- `run_reviewer()` — for the Reviewer agent

### Fix A: Inject CONTEXT.md into both prompts

**Where:** Add a helper function and inject its output into both builder and reviewer prompts.

```bash
# NEW: Helper to load domain context
load_context_md() {
    local ctx_file="CONTEXT.md"
    if [ -f "$ctx_file" ]; then
        cat "$ctx_file"
    else
        echo "# WARNING: CONTEXT.md not found — no domain glossary available"
    fi
}
```

**Builder prompt change:** Add after `## SOURCE OF TRUTH` section:
```bash
## DOMAIN CONTEXT (Glossary & Conventions)
$(load_context_md)
```

**Reviewer prompt change:** Same addition.

### Fix B: Fetch and inject PRD parent issue content

**Where:** Before calling `run_builder()` or `run_reviewer()`, extract the parent PRD reference from the issue body and fetch it.

```bash
# NEW: Helper to find and fetch parent PRD
fetch_parent_prd() {
    local issue_num="$1"
    local repo="${REPO_OVERRIDE:-$(get_repo)}"
    
    # Extract parent PRD number from issue body (pattern: "Parent: #NNN" or similar)
    local parent_ref
    parent_ref=$(gh issue view "$issue_num" --repo "$repo" --json body 2>/dev/null | \
        python3 -c "import json,sys,re; d=json.load(sys.stdin); m=re.search(r'Parent:\s*#(\d+)', d.get('body','')); print(m.group(1) if m else '')")
    
    if [ -n "$parent_ref" ]; then
        gh issue view "$parent_ref" --repo "$repo" --json body 2>/dev/null | \
            python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('body',''))" || true
    fi
}
```

**Builder prompt change:** Add after CONTEXT.md section:
```bash
## PARENT PRD — Implementation & Testing Decisions
$(fetch_parent_prd "$issue_num")
```

**Reviewer prompt change:** Same addition.

### Fix C: Enrich reviewer with project conventions

**Where:** `run_reviewer()` prompt construction.

Add a conventions section that references known project patterns (from the codebase root):

```bash
## PROJECT CONVENTIONS
- TypeScript strict mode enabled — no `any` types
- Follow existing feature patterns in src/ for structure
- Tests go alongside source files with .test.ts suffix
- Use the domain glossary from CONTEXT.md above for naming
```

### Fix D: Handle ADR absence gracefully

**Where:** Both prompts.

Add a note about ADRs being absent (since `docs/adr/` doesn't exist):
```bash
## ARCHITECTURAL DECISIONS
No ADR files found in docs/adr/. Follow existing code patterns as de facto architectural guidance.
```

This is better than silently omitting the section — it tells the agent "there are no ADRs" rather than leaving them guessing whether they missed something.

---

## Before / After Snippets

### Builder Prompt — BEFORE (current)

```
/skill:tdd

## SOURCE OF TRUTH — GitHub Issue
<issue_body>

## YOUR TASK
Implement all acceptance criteria from the issue above...

## RULES
1. Implement each requirement in the issue body and comments
2. Follow existing code patterns (see other features for conventions)
3. After implementing, self-review your work against the issue requirements
4. Write a result file to: .pi/state/slice-result.json
```

### Builder Prompt — AFTER (proposed)

```
/skill:tdd

## SOURCE OF TRUTH — GitHub Issue
<issue_body>

## DOMAIN CONTEXT (Glossary & Conventions)
<CONTEXT.md content>

## PARENT PRD — Implementation & Testing Decisions
<parent_prd_body if available, else "No parent PRD found">

## ARCHITECTURAL DECISIONS
No ADR files found in docs/adr/. Follow existing code patterns as de facto architectural guidance.

## YOUR TASK
Implement all acceptance criteria from the issue above...

## RULES
1. Implement each requirement in the issue body and comments
2. Use domain terminology from CONTEXT.md above — do not invent your own terms
3. Respect implementation decisions from the parent PRD section above
4. After implementing, self-review your work against the issue requirements
5. Write a result file to: .pi/state/slice-result.json
```

### Reviewer Prompt — BEFORE (current)

```
/skill:reviewer

## SOURCE OF TRUTH — GitHub Issue
<issue_body>

## BUILDER'S IMPLEMENTATION SUMMARY
<BUILDER comment if present>

## YOUR TASK
1. Read the code that was implemented for this issue
2. Validate against the acceptance criteria in the issue body
3. Write a verdict to .pi/state/slice-result.json
```

### Reviewer Prompt — AFTER (proposed)

```
/skill:reviewer

## SOURCE OF TRUTH — GitHub Issue
<issue_body>

## BUILDER'S IMPLEMENTATION SUMMARY
<BUILDER comment if present>

## DOMAIN CONTEXT (Glossary & Conventions)
<CONTEXT.md content>

## PARENT PRD — Implementation & Testing Decisions
<parent_prd_body if available, else "No parent PRD found">

## ARCHITECTURAL DECISIONS
No ADR files found in docs/adr/. Follow existing code patterns as de facto architectural guidance.

## PROJECT CONVENTIONS
- TypeScript strict mode enabled — no `any` types
- Follow existing feature patterns in src/ for structure
- Tests go alongside source files with .test.ts suffix
- Use the domain glossary from CONTEXT.md above for naming

## YOUR TASK
1. Read the code that was implemented for this issue
2. Validate against the acceptance criteria in the issue body
3. Verify terminology matches the domain glossary above
4. Check alignment with parent PRD implementation decisions
5. Write a verdict to .pi/state/slice-result.json
```

---

## Non-Goals (Explicitly Out of Scope)

| Item | Reason |
|------|--------|
| User story → issue coverage matrix (#4) | Belongs in `to-issues` skill, not execution loop |
| ADR creation during workflow (#5 systemic) | Requires changes to grill-with-docs and to-prd skills — outside scope of run-slices.sh fix |
| Escalation path for failed slices (#6) | Requires architectural change (new agent handoff types) — redesign territory |
| Session log consumption for pattern detection (#7) | Logging infrastructure works; consumption is a future enhancement, not a context gap |

---

## Stop Condition Checklist

- [x] Builder receives CONTEXT.md domain glossary
- [x] Builder receives PRD parent content (implementation + testing decisions)
- [x] Reviewer receives CONTEXT.md domain glossary
- [x] Reviewer receives PRD parent content
- [x] Reviewer receives project conventions
- [x] Both agents informed of ADR absence (no silent omission)
- [ ] Code changes applied to run-slices.sh (next step: implement Fix A–D)
