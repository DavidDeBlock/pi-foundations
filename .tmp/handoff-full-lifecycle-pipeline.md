# Handoff: Full-Lifecycle Pipeline Design (Maestro)

**Created:** 2026-05-31  
**Status:** Plan approved, awaiting implementation  

---

## Context

User has a Maestro orchestration system in `.pi/maestro/` with two working flows and one pipeline. They want to unify everything into a single deterministic pipeline that chains PRD review → build → test → review with label management handled by the pipeline (not skills).

### Existing Assets
| File | Path | Status |
|------|------|--------|
| `prd-to-issues-reviewer.json` | `.pi/maestro/flows/prd-to-issues-reviewer.json` | Working — issue-readiness → archivist loop |
| `builder-test-reviewer.json` | `.pi/maestro/flows/builder-test-reviewer.json` | Working — builder → test_runner (local cmd) → reviewer loop |
| `autonomous.py` | `.pi/maestro/pipelines/autonomous.py` | Partial — only runs builder-reviewer, no PRD review step |
| `context.py` | `.pi/maestro/pipelines/context.py` | Core data carrier — used by runner, autonomous, dummy_pipeline, 3 test files. **Do not remove.** |

### Label System
Defined in `docs/agents/triage-labels.md`. Current labels: `needs-triage`, `needs-info`, `ready-for-agent`, `implementing`, `testing`, `reviewing`, `awaiting-manual-check`, `failed-slice`.

---

## Decisions Locked (User Approved)

| # | Decision |
|---|----------|
| 1 | **Test failure:** Option A (test output → builder feedback) for retries 1-2, then Option B (diagnostic analyzes logs → builder gets analysis) on retry 3+ |
| 2 | **Single flow** (`full-lifecycle.json`) instead of chaining two separate flows |
| 3 | **Pipeline handles labels deterministically** based on phase outcomes — not skills. Phase callback hook fires after each phase completes in the flow engine |

---

## Approved Plan Summary

### Architecture: Phase Callback Hook

Add optional `phase_callback` parameter to `run_flow_on_issue()` in `flow_engine.py`. Pipeline registers a handler mapping `(phase, status)` → label transitions. Zero risk — backward-compatible (None by default).

### Label Lifecycle
```
needs-triage → needs-info → ready-for-agent → implementing → testing → awaiting-manual-check
                                                                                      ↓
                                                                    failed-slice (on any max-retry failure)
```

### Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `.pi/maestro/flows/full-lifecycle.json` | **Create** | Unified flow: prd-review → archivist → builder → test_runner → reviewer (+ diagnostic fallback). Includes `max_rejects_before_diagnostic: 2` on test_runner for escalation logic |
| `.pi/maestro/pipelines/full-lifecycle.py` | **Create** | Pipeline with label callback. Three modes: single issue, batch issues, auto (all needs-triage) |
| `.pi/maestro/flow_engine.py` | **Modify** | Add `phase_callback` param to `run_flow_on_issue()`. Track `test_fail_count` in context for test failure escalation (Option A → Option B after 2 retries) |
| `.pi/maestro/orchestrate.py` | **Modify** | Add `--issue`, `--issues`, `--auto` CLI flags |

### Test Failure Escalation Logic
- Track counter: `context["test_fail_count"]` (incremented on each test_runner reject)
- Counter ≤ 2: loop back to builder with test stderr in `previous_output` (Option A)
- Counter > 2: route to diagnostic instead of builder, then diagnostic → builder with analysis (Option B)

### Pipeline Modes
```bash
python3 orchestrate.py --pipeline full-lifecycle --issue 42       # single
python3 orchestrate.py --pipeline full-lifecycle --issues 42,43   # batch
python3 orchestrate.py --pipeline full-lifecycle --auto           # all needs-triage
```

---

## What Next Session Should Do

1. **Implement `full-lifecycle.json`** — merge PRD review + builder-test-reviewer phases into single flow config with test failure escalation field
2. **Modify `flow_engine.py`** — add phase callback hook + test_fail_count tracking in transition resolver
3. **Create `full-lifecycle.py` pipeline** — label transitions via callback, three input modes
4. **Update `orchestrate.py`** — CLI flags for single/batch/auto modes
5. **Test end-to-end** on a real issue with needs-triage label

---

## Suggested Skills

| Skill | When to Use |
|-------|-------------|
| `python-implementer` | Implementing the pipeline Python files and flow_engine changes |
| `reviewer` | Validating the phase callback hook doesn't break existing callers |
| `architect` | If structural decisions needed about callback interface or escalation logic |

---

## Key Paths (Absolute)

- Flow configs: `/home/david/projects/pi-pos-v1/.pi/maestro/flows/`
- Pipelines: `/home/david/projects/pi-pos-v1/.pi/maestro/pipelines/`
- Flow engine: `/home/david/projects/pi-pos-v1/.pi/maestro/flow_engine.py`
- CLI entry: `/home/david/projects/pi-pos-v1/.pi/maestro/orchestrate.py`
- Label definitions: `/home/david/projects/pi-pos-v1/docs/agents/triage-labels.md`
- GitHub client: `/home/david/projects/pi-pos-v1/.pi/maestro/lib/github_client.py`
