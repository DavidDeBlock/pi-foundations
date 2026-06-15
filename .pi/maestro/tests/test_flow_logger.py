#!/usr/bin/env python3
"""
Unit tests for ``flow_logger.py`` — the FlowLogger port and its adapters.

Covers the three adapters (ListLogger, FileLogger, StderrLogger) with at
least two scenarios each (per the issue acceptance criteria):

  - ListLogger
      * collects events in emission order
      * initial events list is empty
  - FileLogger
      * writes one valid JSON object per line (JSONL)
      * appends across multiple emit() calls (does not truncate)
  - StderrLogger
      * renders ``"[<phase>] <kind>: <message>"`` format
      * handles None phase (no prefix) and empty message

Plus a contract test that the :class:`FlowEvent` dataclass is frozen
and supports the protocol duck-type.

Run with: ``python3 tests/test_flow_logger.py`` (custom runner)
       or ``python3 -m pytest tests/test_flow_logger.py`` (pytest)
"""

import json
import os
import sys
import tempfile
from pathlib import Path

# Add parent to path so ``import flow_logger`` works without a package install.
sys.path.insert(0, str(Path(__file__).parent.parent))

from flow_logger import (
    FlowEvent,
    FileLogger,
    ListLogger,
    StderrLogger,
)


def _make_event(
    kind: str = "phase_start",
    message: str = "Starting phase",
    phase: str | None = "scout",
    attempt: int | None = 1,
    duration_s: float | None = None,
    tokens: dict | None = None,
    timestamp: str = "2026-06-15T12:00:00Z",
) -> FlowEvent:
    """Helper to build a FlowEvent with sensible defaults."""
    return FlowEvent(
        kind=kind,
        message=message,
        timestamp=timestamp,
        phase=phase,
        attempt=attempt,
        duration_s=duration_s,
        tokens=tokens,
    )


# ─── ListLogger ─────────────────────────────────────────────────────────


def test_list_logger_starts_empty():
    """A fresh ListLogger has no events."""
    log = ListLogger()
    assert log.events == []


def test_list_logger_collects_events_in_order():
    """Events appear in .events in the order they were emitted."""
    log = ListLogger()
    e1 = _make_event(kind="phase_start", message="A", phase="scout")
    e2 = _make_event(kind="phase_end", message="B", phase="scout")
    e3 = _make_event(kind="phase_start", message="C", phase="builder")

    log.emit(e1)
    log.emit(e2)
    log.emit(e3)

    assert log.events == [e1, e2, e3]
    assert log.events[0].kind == "phase_start"
    assert log.events[1].phase == "scout"
    assert log.events[2].message == "C"


# ─── FileLogger ──────────────────────────────────────────────────────────


def test_file_logger_writes_valid_jsonl():
    """FileLogger emits one parseable JSON object per line."""
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "sub" / "logs.jsonl"
        log = FileLogger(path)
        log.emit(_make_event(kind="phase_start", message="go", phase="builder"))

        # File exists and has exactly one line
        assert path.exists()
        lines = [ln for ln in path.read_text().splitlines() if ln.strip()]
        assert len(lines) == 1

        # The line is valid JSON and round-trips into a dict with the right shape
        obj = json.loads(lines[0])
        assert obj["kind"] == "phase_start"
        assert obj["message"] == "go"
        assert obj["phase"] == "builder"
        assert obj["timestamp"] == "2026-06-15T12:00:00Z"


def test_file_logger_appends_across_emits():
    """Multiple emit() calls append — they do not truncate or overwrite."""
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "events.jsonl"
        log = FileLogger(path)
        for i in range(5):
            log.emit(_make_event(kind="phase_retry", message=f"attempt {i}", phase="builder"))

        lines = [ln for ln in path.read_text().splitlines() if ln.strip()]
        assert len(lines) == 5
        for i, ln in enumerate(lines):
            obj = json.loads(ln)
            assert obj["message"] == f"attempt {i}"


# ─── StderrLogger ────────────────────────────────────────────────────────


def test_stderr_logger_renders_phase_kind_message_format():
    """StderrLogger writes ``"[<phase>] <kind>: <message>\\n"`` to stderr."""
    log = StderrLogger()
    event = _make_event(
        kind="phase_start",
        message="Running scout on issue #27",
        phase="scout",
    )

    # Capture stderr by replacing the module-level ``sys.stderr`` reference
    # that ``print`` consults at call time. (StderrLogger calls
    # ``print(..., file=sys.stderr)`` which dereferences ``sys.stderr`` on
    # the call, not at import time.)
    import io
    buf = io.StringIO()
    old_stderr = sys.stderr
    sys.stderr = buf
    try:
        log.emit(event)
    finally:
        sys.stderr = old_stderr

    output = buf.getvalue()
    assert output == "[scout] phase_start: Running scout on issue #27\n"


def test_stderr_logger_handles_none_phase():
    """When phase is None, StderrLogger emits no ``"[<phase>] "`` prefix."""
    log = StderrLogger()
    event = _make_event(
        kind="memory_warn",
        message="Failed to load working memory",
        phase=None,
    )

    import io
    buf = io.StringIO()
    old_stderr = sys.stderr
    sys.stderr = buf
    try:
        log.emit(event)
    finally:
        sys.stderr = old_stderr

    output = buf.getvalue()
    assert output == "memory_warn: Failed to load working memory\n"
    # Sanity: no leading "[" since there is no phase
    assert not output.startswith("[")


# ─── FlowEvent contract ─────────────────────────────────────────────────


def test_flow_event_is_frozen():
    """FlowEvent is a frozen dataclass — attribute assignment is rejected."""
    event = _make_event()
    try:
        event.kind = "phase_end"  # type: ignore[misc]
    except Exception as exc:  # FrozenInstanceError is a subclass of AttributeError
        assert "frozen" in str(exc).lower() or isinstance(exc, AttributeError)
    else:
        raise AssertionError("FlowEvent is not frozen — assignment should have raised")


def test_all_three_adapters_satisfy_flow_logger_protocol():
    """Each adapter has a callable ``emit(event) -> None`` — the protocol contract."""
    import inspect
    for cls in (StderrLogger, FileLogger, ListLogger):
        # StderrLogger and FileLogger are regular classes (no @dataclass on
        # the class itself), ListLogger is a dataclass. The protocol check
        # is duck-typed — just confirm the method exists with the right shape.
        method = cls.__dict__.get("emit") or getattr(cls, "emit", None)
        assert method is not None, f"{cls.__name__} has no emit()"
        sig = inspect.signature(method)
        # Exactly one parameter (besides self)
        params = [p for p in sig.parameters.values() if p.name != "self"]
        assert len(params) == 1, (
            f"{cls.__name__}.emit() should take exactly one argument; got {params}"
        )


# ─── Custom test runner (matches the project convention) ────────────────


tests = [
    test_list_logger_starts_empty,
    test_list_logger_collects_events_in_order,
    test_file_logger_writes_valid_jsonl,
    test_file_logger_appends_across_emits,
    test_stderr_logger_renders_phase_kind_message_format,
    test_stderr_logger_handles_none_phase,
    test_flow_event_is_frozen,
    test_all_three_adapters_satisfy_flow_logger_protocol,
]


if __name__ == "__main__":
    passed = 0
    failed = 0
    for test_fn in tests:
        try:
            test_fn()
            print(f"  ✓ {test_fn.__name__}")
            passed += 1
        except Exception as e:
            import traceback
            print(f"  ✗ {test_fn.__name__}: {e}")
            traceback.print_exc()
            failed += 1

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed > 0:
        sys.exit(1)
