#!/usr/bin/env python3
"""
Unit tests for ``flow_log_reader.py`` — JSONL parsing and active-flow detection.

Covers the acceptance criteria from issue #40:

  - Reads ``.maestro/logs/<flow>/<issue>.jsonl`` files.
  - Identifies active flows from the event log (unmatched phase_start).
  - Corrupt log lines are skipped, monitor does not crash.
  - Multiple active flows render in stable order (sorted by start time).
  - Missing fields produce ``?`` placeholders rather than crashing.

Run with: ``python3 tests/test_flow_log_reader.py`` (custom runner)
       or ``python3 -m pytest tests/test_flow_log_reader.py`` (pytest)
"""

from __future__ import annotations

import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ─── Path setup ──────────────────────────────────────────────────────────
MAESTRO_DIR = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(MAESTRO_DIR))
sys.path.insert(0, str(MAESTRO_DIR / "lib"))

from flow_log_reader import (  # noqa: E402
    FlowSnapshot,
    format_elapsed,
    format_tokens,
    get_current_phase_info,
    is_active_flow,
    parse_jsonl_file,
    scan_logs_dir,
)


# ─── Helpers ─────────────────────────────────────────────────────────────


def _now_iso() -> str:
    """Current time as ISO string."""
    return datetime.now(timezone.utc).isoformat()


def _ago(seconds: int) -> str:
    """ISO timestamp ``seconds`` ago."""
    dt = datetime.now(timezone.utc) - timedelta(seconds=seconds)
    return dt.isoformat()


def _event(kind: str, phase: str | None = None, message: str = "", tokens: dict | None = None, timestamp: str | None = None) -> dict:
    """Build a FlowEvent-like dict."""
    return {
        "kind": kind,
        "message": message,
        "timestamp": timestamp or _now_iso(),
        "phase": phase,
        "attempt": 1 if phase else None,
        "duration_s": None,
        "tokens": tokens,
    }


def _write_jsonl(path: Path, events: list[dict]) -> None:
    """Write a list of event dicts as JSONL."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for event in events:
            f.write(json.dumps(event) + "\n")


# ─── parse_jsonl_file tests ──────────────────────────────────────────────


def test_parse_jsonl_empty_file():
    """Empty file returns empty list."""
    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
        path = Path(f.name)
    try:
        result = parse_jsonl_file(path)
    finally:
        path.unlink()
    assert result == []


def test_parse_jsonl_valid_events():
    """Valid JSONL events are parsed correctly."""
    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False, mode="w") as f:
        path = Path(f.name)
        e1 = {"kind": "phase_start", "message": "hello"}
        e2 = {"kind": "phase_end", "message": "world"}
        f.write(json.dumps(e1) + "\n")
        f.write(json.dumps(e2) + "\n")
    try:
        result = parse_jsonl_file(path)
    finally:
        path.unlink()
    assert len(result) == 2
    assert result[0]["kind"] == "phase_start"
    assert result[1]["kind"] == "phase_end"


def test_parse_jsonl_skips_corrupt_lines():
    """Corrupt / truncated lines are silently skipped."""
    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False, mode="w") as f:
        path = Path(f.name)
        e1 = {"kind": "phase_start", "message": "good"}
        f.write(json.dumps(e1) + "\n")
        f.write("this is not json\n")  # corrupt line
        f.write('{"partial": true')     # truncated JSON (no newline)
    try:
        result = parse_jsonl_file(path)
    finally:
        path.unlink()
    assert len(result) == 1
    assert result[0]["kind"] == "phase_start"


def test_parse_jsonl_skips_empty_lines():
    """Blank lines are silently skipped."""
    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False, mode="w") as f:
        path = Path(f.name)
        e1 = {"kind": "phase_start"}
        f.write(json.dumps(e1) + "\n")
        f.write("\n")  # empty line
        f.write("   \n")  # whitespace-only line
    try:
        result = parse_jsonl_file(path)
    finally:
        path.unlink()
    assert len(result) == 1


# ─── is_active_flow tests ────────────────────────────────────────────────


def test_is_active_empty_events():
    """Empty event list is not active."""
    assert is_active_flow([]) is False


def test_is_active_phase_start_only():
    """A single phase_start makes the flow active."""
    events = [_event("phase_start", phase="builder")]
    assert is_active_flow(events) is True


def test_is_active_phase_start_then_end():
    """phase_start followed by phase_end means not active."""
    events = [
        _event("phase_start", phase="builder"),
        _event("phase_end", phase="builder"),
    ]
    assert is_active_flow(events) is False


def test_is_active_phase_start_then_rejected():
    """phase_start followed by phase_rejected means not active."""
    events = [
        _event("phase_start", phase="reviewer"),
        _event("phase_rejected", phase="reviewer"),
    ]
    assert is_active_flow(events) is False


def test_is_active_phase_start_then_approved():
    """phase_start followed by phase_approved means not active."""
    events = [
        _event("phase_start", phase="builder"),
        _event("phase_approved", phase="builder"),
    ]
    assert is_active_flow(events) is False


def test_is_active_intermediate_events_dont_block():
    """Non-terminal events between start and end don't affect status."""
    events = [
        _event("phase_start", phase="builder"),
        _event("diagnostic", message="checking..."),
        _event("tokens_recorded", tokens={"input": 100, "output": 50}),
        _event("phase_end", phase="builder"),
    ]
    assert is_active_flow(events) is False


def test_is_active_new_phase_after_old_end():
    """A new phase_start after a previous phase_end makes it active again."""
    events = [
        _event("phase_start", phase="scout"),
        _event("phase_end", phase="scout"),
        _event("phase_start", phase="builder"),
    ]
    assert is_active_flow(events) is True


def test_is_active_only_diagnostic_events():
    """Events without phase_start or terminal kind are not active."""
    events = [
        _event("diagnostic", message="checking..."),
        _event("scout_complete", message="done"),
    ]
    assert is_active_flow(events) is False


# ─── get_current_phase_info tests ────────────────────────────────────────


def test_get_current_phase_info_basic():
    """Basic phase info extraction works."""
    events = [
        _event("phase_start", phase="builder", message="Writing code for issue 42"),
    ]
    result = get_current_phase_info(events, "builder-reviewer")
    assert result is not None
    assert result.current_phase == "builder"
    assert result.phase_index == 1
    assert result.agent_role == "builder"
    assert result.action_description == "Writing code for issue 42"


def test_get_current_phase_info_with_tokens():
    """Token data is extracted from the event."""
    events = [
        _event(
            "phase_start",
            phase="reviewer",
            tokens={"input": 1000, "output": 500, "cacheRead": 200},
        ),
    ]
    result = get_current_phase_info(events, "builder-reviewer")
    assert result is not None
    assert result.tokens_in == 1000
    assert result.tokens_out == 500
    assert result.cache_read == 200


def test_get_current_phase_info_missing_tokens():
    """Missing tokens produce None values."""
    events = [
        _event("phase_start", phase="builder"),
    ]
    result = get_current_phase_info(events, "builder-reviewer")
    assert result is not None
    assert result.tokens_in is None
    assert result.tokens_out is None
    assert result.cache_read is None


def test_get_current_phase_info_no_active_phase():
    """Returns None when there's no active phase."""
    events = [
        _event("phase_start", phase="builder"),
        _event("phase_end", phase="builder"),
    ]
    result = get_current_phase_info(events, "builder-reviewer")
    assert result is None


def test_get_current_phase_info_elapsed_time():
    """Elapsed time is computed from the timestamp."""
    ts = _ago(125)  # ~2 minutes ago
    events = [
        _event("phase_start", phase="reviewer", timestamp=ts),
    ]
    result = get_current_phase_info(events, "builder-reviewer")
    assert result is not None
    assert result.elapsed_s is not None
    assert 120 <= result.elapsed_s <= 130


def test_get_current_phase_info_bad_timestamp():
    """Bad timestamp produces elapsed_s=None."""
    events = [
        _event("phase_start", phase="builder", timestamp="not-a-date"),
    ]
    result = get_current_phase_info(events, "builder-reviewer")
    assert result is not None
    assert result.elapsed_s is None


def test_get_current_phase_info_multi_phase_index():
    """Phase index counts distinct phases started before current one."""
    events = [
        _event("phase_start", phase="scout"),
        _event("phase_end", phase="scout"),
        _event("phase_start", phase="builder"),
        _event("phase_end", phase="builder"),
        _event("phase_start", phase="reviewer"),
    ]
    result = get_current_phase_info(events, "builder-reviewer")
    assert result is not None
    assert result.current_phase == "reviewer"
    assert result.phase_index == 3


def test_get_current_phase_info_action_truncated():
    """Long action descriptions are truncated to ~120 chars."""
    long_msg = "x" * 200
    events = [
        _event("phase_start", phase="builder", message=long_msg),
    ]
    result = get_current_phase_info(events, "builder-reviewer")
    assert result is not None
    assert len(result.action_description) <= 120


def test_get_current_phase_info_missing_phase_field():
    """Missing 'phase' field produces '?' placeholder."""
    events = [
        {"kind": "phase_start", "message": "", "timestamp": _now_iso()},
    ]
    result = get_current_phase_info(events, "builder-reviewer")
    assert result is not None
    assert result.current_phase == "?"


# ─── scan_logs_dir tests ────────────────────────────────────────────────


def test_scan_logs_dir_missing_directory():
    """Missing directory returns empty list without raising."""
    result = scan_logs_dir(Path("/nonexistent/.maestro/logs"))
    assert result == []


def test_scan_logs_dir_empty_directory():
    """Empty log directory returns empty list."""
    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp) / "logs"
        logs_dir.mkdir()
        result = scan_logs_dir(logs_dir)
    assert result == []


def test_scan_logs_dir_finds_active_flow():
    """Active flow is detected from JSONL file."""
    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp) / "logs"
        flow_dir = logs_dir / "builder-reviewer"
        jsonl_path = flow_dir / "42.jsonl"

        events = [
            _event("phase_start", phase="scout"),
            _event("phase_end", phase="scout"),
            _event("phase_start", phase="builder"),
        ]
        _write_jsonl(jsonl_path, events)

        result = scan_logs_dir(logs_dir)
    assert len(result) == 1
    snapshot = result[0]
    assert snapshot.flow_name == "builder-reviewer"
    assert snapshot.issue_num == 42
    assert snapshot.current_phase == "builder"


def test_scan_logs_dir_skips_completed_flow():
    """Completed flow (phase_end as last event) is not returned."""
    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp) / "logs"
        flow_dir = logs_dir / "builder-reviewer"
        jsonl_path = flow_dir / "42.jsonl"

        events = [
            _event("phase_start", phase="builder"),
            _event("phase_end", phase="builder"),
        ]
        _write_jsonl(jsonl_path, events)

        result = scan_logs_dir(logs_dir)
    assert len(result) == 0


def test_scan_logs_dir_multiple_active_flows():
    """Multiple active flows are all returned."""
    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp) / "logs"

        # Flow 1: builder-reviewer, issue 42
        jsonl_1 = logs_dir / "builder-reviewer" / "42.jsonl"
        ts_early = _ago(300)
        events_1 = [_event("phase_start", phase="builder", timestamp=ts_early)]
        _write_jsonl(jsonl_1, events_1)

        # Flow 2: full-lifecycle, issue 10
        jsonl_2 = logs_dir / "full-lifecycle" / "10.jsonl"
        ts_later = _ago(60)
        events_2 = [_event("phase_start", phase="reviewer", timestamp=ts_later)]
        _write_jsonl(jsonl_2, events_2)

        result = scan_logs_dir(logs_dir)
    assert len(result) == 2
    # Sorted by start_time ascending (oldest first).
    assert result[0].issue_num == 42  # older flow first
    assert result[1].issue_num == 10


def test_scan_logs_dir_skips_corrupt_jsonl():
    """Corrupt JSONL files are skipped without crashing."""
    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp) / "logs"
        flow_dir = logs_dir / "builder-reviewer"

        # Corrupt file
        corrupt_path = flow_dir / "42.jsonl"
        corrupt_path.parent.mkdir(parents=True, exist_ok=True)
        with corrupt_path.open("w") as f:
            f.write("not json at all\n{{broken\n")

        result = scan_logs_dir(logs_dir)
    assert len(result) == 0


def test_scan_logs_dir_skips_non_jsonl_files():
    """Non-JSONL files in the flow directory are ignored."""
    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp) / "logs"
        flow_dir = logs_dir / "builder-reviewer"

        # Active JSONL file
        jsonl_path = flow_dir / "42.jsonl"
        events = [_event("phase_start", phase="builder")]
        _write_jsonl(jsonl_path, events)

        # Non-JSONL files (should be ignored)
        (flow_dir / "readme.txt").write_text("ignore me")
        (flow_dir / "data.csv").write_text("a,b,c\n1,2,3")

        result = scan_logs_dir(logs_dir)
    assert len(result) == 1


def test_scan_logs_dir_stable_order():
    """Results are sorted by start_time for deterministic ordering."""
    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp) / "logs"
        flow_dir = logs_dir / "builder-reviewer"

        # Issue 99 started first (older timestamp)
        ts_1 = _ago(600)
        events_1 = [_event("phase_start", phase="builder", timestamp=ts_1)]
        _write_jsonl(flow_dir / "99.jsonl", events_1)

        # Issue 5 started later (newer timestamp)
        ts_2 = _ago(300)
        events_2 = [_event("phase_start", phase="reviewer", timestamp=ts_2)]
        _write_jsonl(flow_dir / "5.jsonl", events_2)

        # Issue 1 started most recently
        ts_3 = _ago(60)
        events_3 = [_event("phase_start", phase="scout", timestamp=ts_3)]
        _write_jsonl(flow_dir / "1.jsonl", events_3)

        result = scan_logs_dir(logs_dir)
    assert len(result) == 3
    # Oldest first.
    assert result[0].issue_num == 99
    assert result[1].issue_num == 5
    assert result[2].issue_num == 1


# ─── format_elapsed tests ────────────────────────────────────────────────


def test_format_elapsed_none():
    """None produces '?'."""
    assert format_elapsed(None) == "?"


def test_format_elapsed_seconds_only():
    """Seconds < 60 shows only seconds."""
    assert format_elapsed(45.9) == "0m 45s"


def test_format_elapsed_minutes_and_seconds():
    """Minutes + seconds shown correctly."""
    assert format_elapsed(125.0) == "2m 5s"


def test_format_elapsed_hours():
    """Hours shown when >= 3600 seconds."""
    assert format_elapsed(3725.0) == "1h 2m 5s"


# ─── format_tokens tests ────────────────────────────────────────────────


def test_format_tokens_none():
    """None produces '?'."""
    assert format_tokens(None) == "?"


def test_format_tokens_value():
    """Integer value is formatted with commas."""
    assert format_tokens(12345) == "12,345"


def test_format_tokens_with_label():
    """Label prefix is prepended."""
    assert format_tokens(100, label="in: ") == "in: 100"


# ─── Runner ──────────────────────────────────────────────────────────────


def main() -> int:
    """Run all tests in this file and return 0 iff all pass."""
    import inspect

    failures: list[tuple[str, str]] = []
    tests = sorted(
        (name, fn)
        for name, fn in inspect.getmembers(sys.modules[__name__], inspect.isfunction)
        if name.startswith("test_")
    )

    for name, fn in tests:
        try:
            fn()
        except AssertionError as e:
            failures.append((name, f"AssertionError: {e}"))
        except Exception as e:  # noqa: BLE001
            failures.append((name, f"{type(e).__name__}: {e}"))

    total = len(tests)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        print("\nFAILURES:")
        for name, msg in failures:
            print(f"  - {name}: {msg}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
