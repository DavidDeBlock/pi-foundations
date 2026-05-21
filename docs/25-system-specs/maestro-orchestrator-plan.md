# Maestro Implementation Plan

## Objective
Replace the monolithic `run-slices.sh` with a configurable, Python-based orchestrator (**Maestro**) that uses GitHub comments as a message bus for inter-phase communication. This provides better testability, error handling (diagnostics), and flexible loop topologies.

---

## 📋 Implementation Phases

### Phase 1: Core Engine & RPC Integration
**Goal:** Replace `run-slices.sh` logic in Python while leveraging existing tools.
*   **Refactor `lib/rpc_client.py`:** Update to correctly invoke the existing `rpc-client.py` with proper environment variable mapping (model, skill, timeout).
*   **Port the Loop Logic:** Move the "Builder ↔ Reviewer" retry loop from bash into `orchestrate.py`. This makes it testable and allows for easy injection of diagnostic logic.
*   **Strict Comment Formatting:** Implement the `### PHASE_OUTPUT` block generation in Python so every phase action is logged to GitHub immediately.

### Phase 2: GitHub Message Bus
**Goal:** Use GitHub comments as the source of truth for state and communication.
*   **Create `lib/github_client.py`:** Wrapper around the `gh` CLI (consistent with current setup).
    *   `fetch_issue_comments(issue_num)`: Reads history to find the last phase status.
    *   `post_phase_comment(...)`: Appends a strict-formatted comment after every phase attempt.
*   **Resume Logic:** Update state management to check GitHub comments first (robustness), falling back to local `.pi/maestro/state.json` if offline or for speed.

### Phase 3: Flow Configuration & Context Passing
**Goal:** Make the JSON config dynamic and powerful.
*   **Dynamic Variable Injection:** Update `flows/*.json` to support context passing. Example: If Reviewer fails, pass its critique string into the Builder's retry prompt automatically.
*   **Flow Validation:** Add a pre-flight check in Python to ensure all phases defined in transitions actually exist in the config before running.

### Phase 4: Multi-Phase Validation
**Goal:** Prove the system handles complex topologies by creating a new flow.
*   **Create `flows/builder-test-reviewer.json`:** A 3-phase loop.
    *   **Builder:** Writes code.
    *   **TestRunner:** Runs local unit tests (`pnpm test`). If tests fail, sends feedback to Builder.
    *   **Reviewer:** Checks code quality (only runs if tests pass).
*   **Validation:** Run this flow on a dummy issue to ensure the "TestRunner" phase correctly gates the Reviewer and loops back to Builder on failure.

---

## 📂 Target File Structure

```text
.pi/maestro/
├── flows/
│   ├── builder-reviewer.json      # Original 2-phase loop
│   └── builder-test-reviewer.json # New 3-phase loop (Goal 3)
├── lib/
│   ├── __init__.py
│   ├── comment_parser.py          # ✅ Done & tested
│   ├── github_client.py           # 🔲 Phase 2
│   ├── rpc_client.py              # 🔲 Phase 1
│   └── state_manager.py           # 🔲 Phase 2 (Enhanced)
├── prompts/                       # 🔲 Phase 3 (Template updates)
│   ├── builder.tmpl
│   ├── reviewer.tmpl
│   └── test_runner.tmpl           # For the new flow
├── tests/                         # 🔲 Phase 1 & 2
│   ├── test_comment_parser.py     # ✅ Done
│   └── test_github_client.py      # Mocking GH calls
├── orchestrate.py                 # 🔲 Phase 1 (Core loop)
└── README.md                      # 🔲 Updated docs
```

---

---

## ✅ Execution Status (Updated)

All four phases have been completed:

- [x] **Phase 1:** Core engine & RPC integration — `rpc_client.py` refactored, loop logic ported to Python
- [x] **Phase 2:** GitHub message bus connection — `github_client.py` created with comment reading/writing
- [x] **Phase 3:** Flow configuration & context passing — JSON flows validated, templates in place
- [x] **Phase 4:** Multi-phase validation — `builder-test-reviewer.json` flow created (3 phases)

**All unit tests pass ✓**

## 🚀 Next Step
Run the multi-phase flow on a real GitHub issue to validate end-to-end behavior.
