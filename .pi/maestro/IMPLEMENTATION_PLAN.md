# PRD: Robust RPC State System — Session Log Verdict Extraction

## Problem Statement

Maestro currently depends on agents writing `slice-result.json` to disk as the single source of truth for phase decisions. Additionally, the RPC client relies on an external script (`slices/rpc-client.py`) that lives outside Maestro's directory, breaking portability and creating hidden dependencies.

This creates fragile coupling between Maestro's execution engine and agent output behavior:

1. **Silent failures**: If an agent crashes mid-write, `read_result_file()` returns `{}`, defaulting to `rejected` with zero context about why it failed.
2. **Race conditions**: Parallel phase execution would corrupt the shared file.
3. **No real-time feedback**: Maestro is blind until the subprocess exits completely. Progress events (`agent_end`, `turn_end`) stream through RPC but are ignored for decision-making.
4. **Redundant I/O**: The session log (`.jsonl`) already contains the agent's final verdict in its last assistant message, but Maestro ignores it and requires an extra file-write hop.
5. **External dependency coupling**: `lib/rpc_client.py` delegates to `/slices/rpc-client.py`, making Maestro non-portable and fragile.

## Solution

Replace filesystem-based verdict extraction with direct `.jsonl` session log parsing, while maintaining backward compatibility during transition:

1. **Primary path**: After `pi --mode rpc` exits, apply a configurable safety delay (default 500ms), then read the last N lines of the session log file and extract the verdict using regex/structured pattern matching against assistant message text.
2. **Fallback chain**: If session log parsing fails or returns no verdict → fall back to `slice-result.json` → if both fail → route to `error` state (diagnostic pass).
3. **Corruption detection**: Validate each line of the `.jsonl` as JSON before processing. Malformed lines → treat entire session as `error`.
4. **Directory restructuring**: Group sessions by issue number (`sessions/<issue>/<flow>-<phase>-<timestamp>.jsonl`) for easier bulk analysis and debugging.

## User Stories

1. As a Maestro operator, I want phase verdicts extracted from the agent's own session log so that I don't rely on fragile file-write contracts between unrelated codebases.
2. As a Maestro operator, I want a graceful fallback to `slice-result.json` during transition so that existing flows continue working while I collect real pattern data.
3. As a developer debugging failed phases, I want sessions grouped by issue number in a predictable directory layout so I can quickly locate all runs for a specific ticket.
4. As an autonomous loop runner, I want corrupted or truncated session logs detected and routed to diagnostic passes rather than causing silent rejections.
5. As a system designer, I want the safety delay configurable via environment variable so I can tune it from 0ms (after testing) to higher values if needed.

## Implementation Decisions

### Module Boundaries & File Changes

| File | Change Type | Responsibility |
|------|-------------|----------------|
| `lib/rpc_client.py` | **Rewrite** | Remove external script dependency. Implement native Python `subprocess.Popen` with `pi --mode rpc`. Add JSON stdin protocol, session log path extraction, safety delay, and JSON validity check. |
| `lib/session_reader.py` | **Extend** | Add `extract_phase_verdict(session_path: str) -> dict` method that parses last N assistant messages from `.jsonl` |
| `flow_engine.py` | **Modify** | Replace direct call to `read_result_file()` with new `rpc_client.run_rpc_with_session_log()` output; update verdict extraction logic |
| `config.json` | **Add field** | Add `"session_safety_delay_ms": 500` configuration option (overrideable via `MAESTRO_SESSION_DELAY`) |
| `sessions/` | **Restructure** | New directory layout: `<issue>/<flow>-<phase>-<ISO8601>.jsonl` instead of flat or mixed naming |

### Verdict Extraction Logic

```python
def extract_phase_verdict(session_path: str, last_n_lines: int = 2) -> dict:
    """
    Parse the last N lines of a session log to extract phase verdict.
    
    Returns: { "status": "approved"|"rejected"|"no_gaps"|None, 
               "issues": [], "raw_text": "" }
    
    Strategy:
    1. Read file with safety delay (500ms default)
    2. Validate all lines are valid JSON → if any line fails, return error state
    3. Extract last N non-empty lines
    4. Search for verdict patterns in assistant message text fields
       - "approved", "STATUS: approved", "✅ APPROVED", etc.
       - "rejected", "STATUS: rejected", ❌ REJECTED", etc.
       - "no_gaps", "STATUS: no_gaps"
    5. Return structured dict if match found, else None
    """
```

### Fallback Chain (Order Matters)

1. **Session log parsing** → parse last N lines of `.jsonl` for verdict patterns
2. **File fallback** → `read_result_file()` reads `slice-result.json` as-is (backward compat)
3. **Error state** → if both fail, return `{"status": "error", "details": "No verdict extracted from session log or result file"}`

### Directory Structure

```
.pi/maestro/sessions/
├── <issue_number>/                    # Group all runs for one issue together
│   ├── builder-reviewer-builder-20260526T143022.jsonl
│   ├── builder-reviewer-reviewer-20260526T143045.jsonl
│   └── gap-check-analyze-20260527T090011.jsonl
├── _analysis/                         # Future: extracted verdicts go here
│   ├── verdicts.jsonl                 # Machine-readable: one line per session
│   └── patterns.md                    # Human-readable pattern analysis
```

## Testing Decisions

| Module | Test Type | Scope | Prior Art |
|--------|-----------|-------|-----------|
| `session_reader.py` (new method) | Unit tests | Parse synthetic `.jsonl` files with known verdicts, verify regex extraction works across multiple phrasing patterns | `tests/test_session_reader.py` |
| `rpc_client.py` (native subprocess + delay) | Unit/Integration tests | Mock `subprocess.Popen` to test JSON stdin protocol, 500ms safety delay behavior, and session log path extraction. Verify no external script dependency remains. | `tests/test_rpc_client.py` |
| `flow_engine.py` (fallback chain) | Integration tests | Run mock flow with session log present/absent/malformed, verify correct routing through fallback → error states | `tests/test_integration_data_layer.py` |
| Directory restructuring | Manual verification | Confirm new layout matches spec, all existing sessions migrate correctly | N/A |

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| External script dependency (`/slices/rpc-client.py`) | **High** | Critical — Maestro fails to spawn if external file is missing or path changes | Eliminate entirely by implementing native `subprocess.Popen` with `pi --mode rpc` directly in `lib/rpc_client.py`. |
| JSONL format changes in future `pi` releases | Medium | High — regex extraction breaks on new schema | Extract verdicts from `message.content[*].text` fields only (stable across versions). Add version check in session_reader. |
| Prompt templates drift over time | Low (Phase 1) → Medium (later) | Verdict patterns become unrecognizable | Phase 1: collect raw data without hardening prompts. Phase 2: analyze `_analysis/verdicts.jsonl` to identify dominant phrasing, then update `.tmpl` files with canonical suffix directive |
| Safety delay too short/long on different hardware | Low | Medium — truncated logs or unnecessary latency | Make configurable via `MAESTRO_SESSION_DELAY_MS` env var. Default 500ms is conservative; users can tune to 0 after testing |
| Backward compatibility breaks existing flows during transition | Low | High — phased rollout with fallback chain prevents this | Fallback to `slice-result.json` ensures zero downtime during Phase 1 data collection |

## Out of Scope (Phase 1)

- Real-time event streaming (`agent_end`, `turn_end`) for live progress updates in terminal
- Hardened prompt templates enforcing canonical verdict suffixes (deferred to Phase 2 after pattern analysis)
- Parallel phase execution (would require distributed session directories, not addressed here)
- Automatic `_analysis/verdicts.jsonl` population (manual extraction tool added in Phase 2)

## Acceptance Criteria

1. [ ] **Session log parsing works**: `extract_phase_verdict()` successfully extracts verdict from the last N lines of a valid `.jsonl` file containing assistant messages with verdict text
2. [ ] **Fallback chain functions correctly**: When session log is missing/malformed, system falls back to `slice-result.json`; when both fail, routes to error state
3. [ ] **Safety delay configurable**: `MAESTRO_SESSION_DELAY_MS` env var overrides default 500ms; value of 0 disables delay after testing confirms reliability
4. [ ] **JSON validity check implemented**: Malformed JSON lines in session log trigger error state rather than silent parsing failures
5. [ ] **Directory restructuring complete**: New layout `sessions/<issue>/<flow>-<phase>-<timestamp>.jsonl` is created and documented; existing sessions remain accessible during migration
6. [ ] **No regression on existing flows**: All current flow configurations (`builder-reviewer.json`, `gap-check.json`, etc.) continue to work with new extraction logic
7. [ ] **Documentation updated**: `README.md` and `OUTPUTS.md` reflect new session log as primary verdict source, file fallback as secondary
8. [ ] **Maestro is self-contained**: `lib/rpc_client.py` no longer references external scripts (`/slices/rpc-client.py`). All RPC communication uses native Python `subprocess.Popen` with `pi --mode rpc` and JSON stdin protocol.

---

**Labels**: `parent-prd`  
**Status**: Draft — awaiting approval before splitting into implementation issues
