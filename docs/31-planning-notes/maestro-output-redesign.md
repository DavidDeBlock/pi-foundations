# Maestro Output Redesign — Implementation Plan

## 🎯 Goal
Replace the flat, verbose CLI output of `orchestrate.py` with a clean, structured tree layout that shows per-attempt metadata (model, duration, file ops), retry history, and issue details. Session log data from `session_reader.py` will be integrated inline.

---

## 📊 Current vs Target State

### 🔴 Current Output
```
🔍 Issue #9: Processing
[PHASE] Running 'builder' on issue #9
[rpc] Starting rpc-client.py (model=llama-cpp-3090/qwen-35b-a3b-118k-bf16, timeout=1800s)
[rpc] SUCCESS (phase: builder)
[rpc] Reading result from: .pi/state/slice-result.json
[PHASE] builder -> success
✓ builder approved
```

### 🟢 Target Output
```
🚀 Maestro — builder-reviewer
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

────────────────────────────────────────────────
🔍 Issue #9: Processing — "Add payment gateway" (3 comments, created 2024-01-15)

├─ Attempt 1/3 | Phase: Builder ⏳
│    • 🤖 Model: llama-cpp-3090/qwen-35b-a3b-118k-bf16
│    • ⏱️  Session lasted 2m 41s
│    • 📄 File Operations: 37 written, 4 failed

├─ Attempt 2/3 | Phase: Reviewer ⏳
│    • 🤖 Model: llama-cpp-3090/qwen-35b-a3b-118k-bf16
│    • ⏱️  Session lasted 45s

   ↺ Reviewer → Rejected
      └─ TS6059: server/src/... outside rootDir

├─ Attempt 3/3 | Phase: Builder (retry) ⏳
│    • 🤖 Model: llama-cpp-3090/qwen-35b-a3b-118k-bf16
│    • ⏱️  Session lasted 1m 12s
│    • 📄 File Operations: 42 written, 0 failed

✓ builder approved (retry)

✅ All 1 issue(s) completed successfully!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 🏗️ Architecture Changes

### Files Modified
| File | Change Scope | Purpose |
|------|--------------|---------|
| `.pi/maestro/orchestrate.py` | Core logic rewrite | Replace flat print loop with structured accumulator + renderer. Handle retry counters, GitHub comment gating, and issue metadata fetch. |
| `.pi/maestro/lib/terminal.py` | New methods | Add `issue_header()`, `attempt_block()`, `feedback_block()`, `success_line()`. Remove raw `[PHASE]` markers. |
| `.pi/maestro/lib/rpc_client.py` | Minor tweak | Ensure session log path extraction is robust. No major changes needed. |
| `.pi/maestro/lib/session_reader.py` | Read-only integration | Already parses model, duration, file ops. Will be called from `terminal.py` to extract inline metadata. |
| `flows/builder-reviewer.json` (and others) | Schema update | Add `"retries"` field per phase definition. |

### Key Design Decisions (Locked In)
1. **Layout**: One box per issue, stacked vertically. Hybrid rendering (header + first attempt immediately, retries stack below).
2. **Session Data**: Inline metadata only (`model`, `duration`, `file ops count`). Full log dump only on request/debug.
3. **State Persistence**: None for retry tracking. In-memory accumulation during run. GitHub issues are source of truth.
4. **Verbose Mode**: `--verbose` flag restores raw `[PHASE]`, `[rpc]` markers alongside formatted output.
5. **Issue Metadata**: Fetch title, comment count, created date via GitHub API at issue start.
6. **Retry Limits**: Configurable per-phase in flow JSON (`"retries": 3`).
7. **GitHub Comments**: Only on first rejection, final success, or fatal error. Intermediate retries stay silent.
8. **Visuals**: Distinct feedback block for rejections + per-phase attempt counters.

---

## 📝 Step-by-Step Implementation Plan

### Phase 1: Flow Config Schema Update
**Files:** `flows/builder-reviewer.json`, `flows/*.json`
- Add `"retries"` field to each phase object (default to 3 if missing for backward compatibility).
- Validate during flow load. Exit with clear error if retries < 1.

### Phase 2: Terminal Module Refactor
**Files:** `.pi/maestro/lib/terminal.py`
- Remove raw `[PHASE]`, `[rpc]`, `[github]` print helpers (move to `--verbose` fallback).
- Add new methods:
  - `issue_header(issue_num, title, meta)` → Prints boxed header with issue details.
  - `attempt_block(phase_name, attempt_num, max_retries, status_icon)` → Prints attempt row + metadata block.
  - `feedback_block(details)` → Prints rejection feedback indented under the attempt.
  - `success_line(phase_name, is_retry=False)` → Prints approval line with optional `(retry)` suffix.
- Add `_print_verbose()` helper that only fires when `term.verbose=True`.

### Phase 3: Session Data Integration
**Files:** `.pi/maestro/lib/session_reader.py` (unchanged), `.pi/maestro/lib/terminal.py`
- In `attempt_block()`, parse the session log path via `session_reader.parse_session_log()`.
- Extract only: `model`, `duration_seconds`, `file_operations` counts.
- Format inline as bullet points under the attempt header. Handle missing logs gracefully (skip metadata block).

### Phase 4: Orchestrator Core Rewrite
**Files:** `.pi/maestro/orchestrate.py`
- Replace flat execution loop with accumulator-based approach:
  - `issue_data = {"attempts": [], "feedback": []}`
  - On each phase completion, append to `issue_data["attempts"]`.
  - On rejection, append to `issue_data["feedback"]`.
- Integrate per-phase retry counters from flow config. Track current attempt count vs max retries.
- Gate GitHub comments: only post on first rejection, final success, or fatal error.
- Fetch issue metadata (`title`, `comments_count`, `created_at`) at loop start via `GithubClient.get_issue()`.
- Replace all raw prints with `term.issue_header()`, `term.attempt_block()`, etc.
- Add `--verbose` argparse flag to enable legacy debug output alongside new tree.

### Phase 5: Testing & Polish
**Files:** All modified files
- Test single-issue run (success, reject→retry→success, fatal error).
- Verify session log parsing handles missing/empty logs without crashing.
- Confirm `--verbose` flag shows raw markers + formatted tree simultaneously.
- Check flow config validation rejects invalid retry counts.
- Validate GitHub comment gating (no spam on retries, feedback appears once).

---

## ✅ Acceptance Criteria
- [ ] Output matches target layout structure for all phase transitions.
- [ ] Session metadata (model, duration, file ops) displays inline per attempt.
- [ ] Retry counters are per-phase and configurable in flow JSON.
- [ ] GitHub comments only appear on first rejection, final success, or fatal error.
- [ ] `--verbose` flag restores raw `[PHASE]`, `[rpc]`, `[github]` markers.
- [ ] Issue metadata (title, comment count, created date) shows in header.
- [ ] No state.json dependency for retry tracking — fully in-memory during run.
- [ ] Graceful handling of missing session logs or parse errors.

---

## 📌 Notes & Open Questions
- **Session log path extraction**: Currently relies on `SESSION_LOG=` line in RPC output. If rpc-client changes, this breaks. Consider passing log path as explicit return value from `run_rpc_with_session_log()` instead of parsing stdout.
- **Concurrency**: Currently processes one issue at a time. If batch mode is added later, the accumulator pattern will need to be keyed by issue number.
- **Terminal width**: Layout uses fixed-width separators (`━`, `─`). Should we calculate terminal width dynamically for wrapping? (Deferred — assume 80+ cols for now.)

---

## 🚀 Phase 4: Autonomous Loop & Gap Check

### Architecture: App Shell + Flow Engine Pattern
To cleanly separate concerns, Maestro was refactored into a layered architecture:
- **`app_shell.py`**: High-level workflow manager. Handles CLI args, loop mode, backlog fetching, PRD gap-checking, and flow switching.
- **`flow_engine.py`**: Core executor. Runs a single flow on a single issue (tree layout, retries, session parsing, GitHub gating).
- **`orchestrate.py`**: Thin CLI entry point that delegates to the App Shell.

### Logic Flow (`app_shell.py`)
1. **Entry:** If no `--issue` is provided, enter **Loop Mode**.
2. **Fetch Backlog:** Query GitHub for all open issues labeled `needs-triage`.
3. **Process Loop:** Iterate through the list:
   - Run the standard Builder/Reviewer flow (via `flow_engine.py`).
   - On success: Remove label and close the issue via GitHub API.
4. **Gap Check (Step D):** Once backlog is empty, run a final verification against the PRD.
   - **Source of Truth:** Find GitHub Issue with label `parent-prd`.
   - **Parsing:** Extract pending checkboxes (`- [ ]`) from the PRD body.
   - **Analysis:** Run an LLM pass comparing the PRD requirements vs. a snapshot of the project file tree (e.g., `find src/`).
   - **Action:** If gaps are found, parse the LLM JSON response and create new GitHub issues labeled `needs-triage` automatically.

### Acceptance Criteria
- [x] Running `orchestrate.py --flow <name>` without `--issue` triggers the autonomous loop.
- [x] Completed issues are automatically closed and their labels removed.
- [x] Gap Check logic correctly identifies missing features from the PRD checklist.
- [x] New issues generated by Gap Check are labeled `needs-triage` for future runs.
