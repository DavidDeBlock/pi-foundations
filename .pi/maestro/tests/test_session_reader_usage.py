#!/usr/bin/env python3
"""
Unit tests for ``extract_phase_usage`` — the new session-reader extension
that surfaces per-phase token usage from a JSONL session log.

The session log JSONL already carries ``message.usage`` on each
assistant message (with fields ``input``, ``output``, ``cacheRead``,
``cacheWrite``, ``totalTokens``, and a nested ``cost`` object). The
reader is what was missing. These tests pin down its contract:

  - ``None`` when the log file does not exist
  - ``None`` when the log is empty (zero lines)
  - ``None`` when the log has lines but no assistant message has
    a ``message.usage`` field
  - Returns the ``usage`` dict of the **last** assistant message
    that has a ``usage`` field (assistant messages in a session
    are cumulative within a run, so the last one wins)
  - Skips malformed JSON lines gracefully (does not raise)
  - Walks only ``assistant`` role events — ``user``, ``tool``,
    ``system``, etc. are ignored
  - Accepts both ``str`` and ``pathlib.Path`` for ``log_path``

Per the issue acceptance criteria, this file has at least 5 tests.
It has 7 (one per bullet above) plus a couple of edge-case
sanity tests.

Run with: ``python3 tests/test_session_reader_usage.py`` (custom runner)
       or ``python3 -m pytest tests/test_session_reader_usage.py`` (pytest)
"""

import json
import sys
import tempfile
from pathlib import Path

# Add parent to path so ``from lib.session_reader import ...`` works
# without a package install.
sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from session_reader import extract_phase_usage  # noqa: E402


def _write_jsonl(path: Path, events: list) -> None:
    """Write a list of dicts to ``path`` as one JSON object per line."""
    with path.open("w", encoding="utf-8") as f:
        for ev in events:
            f.write(json.dumps(ev) + "\n")


def _assistant_event(usage: dict | None, role: str = "assistant", text: str = "hello") -> dict:
    """Build a synthetic session event for an assistant message."""
    msg: dict = {"role": role, "content": [{"type": "text", "text": text}]}
    if usage is not None:
        msg["usage"] = usage
    return {"type": "message", "message": msg}


# ─── 1. Missing log → None ───────────────────────────────────────────────


def test_missing_log_returns_none():
    """A nonexistent log path yields None (not an exception)."""
    nonexistent = Path("/tmp/does-not-exist-session-log-12345.jsonl")
    # Sanity: ensure it really doesn't exist
    if nonexistent.exists():
        nonexistent.unlink()

    result = extract_phase_usage(nonexistent)
    assert result is None


def test_missing_log_str_path_returns_none():
    """Same as above but with a str path (not a Path object)."""
    result = extract_phase_usage("/tmp/also-nonexistent-log-99999.jsonl")
    assert result is None


# ─── 2. Empty log → None ─────────────────────────────────────────────────


def test_empty_log_returns_none():
    """A log with zero lines (just an empty file) yields None."""
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "empty.jsonl"
        path.write_text("")
        assert extract_phase_usage(path) is None


# ─── 3. Log with no usage data → None ────────────────────────────────────


def test_log_with_no_usage_returns_none():
    """Assistant messages without ``message.usage`` → None."""
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "no-usage.jsonl"
        _write_jsonl(path, [
            _assistant_event(usage=None, text="first reply"),
            _assistant_event(usage=None, text="second reply"),
            # A non-assistant event to make sure we don't accidentally
            # treat something else as a usage source.
            {"type": "message", "message": {"role": "user", "content": []}},
        ])

        assert extract_phase_usage(path) is None


# ─── 4. Single usage → returns that usage dict ───────────────────────────


def test_single_usage_returns_dict():
    """A log with one assistant message carrying usage returns that dict."""
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "one-usage.jsonl"
        usage = {
            "input": 100,
            "output": 50,
            "cacheRead": 200,
            "cacheWrite": 0,
            "totalTokens": 350,
            "cost": {"input": 0.001, "output": 0.002, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.003},
        }
        _write_jsonl(path, [
            {"type": "session", "id": "abc"},
            _assistant_event(usage=usage, text="hi"),
        ])

        result = extract_phase_usage(path)
        assert result == usage
        assert result["input"] == 100
        assert result["output"] == 50
        assert result["cacheRead"] == 200


# ─── 5. Multiple cumulative usage entries → returns the LAST one ────────


def test_multiple_usage_entries_returns_last():
    """Cumulative usage within a session: the last assistant usage wins."""
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "cumulative.jsonl"
        first = {"input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 15}
        mid = {"input": 50, "output": 20, "cacheRead": 100, "cacheWrite": 0, "totalTokens": 170}
        last = {"input": 100, "output": 40, "cacheRead": 200, "cacheWrite": 5, "totalTokens": 345}

        _write_jsonl(path, [
            _assistant_event(usage=first, text="turn 1"),
            _assistant_event(usage=mid, text="turn 2"),
            _assistant_event(usage=last, text="turn 3"),
        ])

        result = extract_phase_usage(path)
        assert result == last
        assert result["input"] == 100
        assert result["cacheWrite"] == 5


# ─── 6. Malformed JSON lines are skipped ─────────────────────────────────


def test_malformed_lines_are_skipped():
    """Bad JSON lines are skipped silently; valid lines still produce a result."""
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "mixed.jsonl"
        usage = {"input": 42, "output": 7, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 49}
        # Manually mix malformed lines with valid ones
        with path.open("w", encoding="utf-8") as f:
            f.write('{"this is not": valid json}\n')  # broken — should be skipped
            f.write('\n')                              # empty line — skipped
            f.write(json.dumps(_assistant_event(usage=None, text="no usage")) + "\n")
            f.write('not even a json object\n')         # broken — skipped
            f.write(json.dumps(_assistant_event(usage=usage, text="has usage")) + "\n")
            f.write('{"unterminated":\n')               # broken — skipped

        result = extract_phase_usage(path)
        assert result == usage


# ─── 7. Only assistant role counts; user/tool/system are ignored ─────────


def test_only_assistant_role_counts():
    """``user``, ``toolResult`` and other non-assistant roles are ignored,
    even if they happen to have a ``usage`` key at the top level."""
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "mixed-roles.jsonl"
        assistant_usage = {"input": 1, "output": 2, "cacheRead": 3, "cacheWrite": 4, "totalTokens": 10}

        events = [
            # user message — should be ignored even with a top-level ``usage``
            {"type": "message", "message": {"role": "user", "content": [], "usage": {"input": 999}}},
            # tool result — should be ignored
            {"type": "message", "message": {"role": "toolResult", "toolCallId": "x", "content": []}},
            # assistant message with usage — this one wins
            _assistant_event(usage=assistant_usage, text="ok"),
        ]
        _write_jsonl(path, events)

        result = extract_phase_usage(path)
        assert result == assistant_usage
        # Defensive: ensure the user-side usage was NOT picked up
        assert result["input"] != 999


# ─── 8. str path is accepted (not only Path) ─────────────────────────────


def test_str_path_is_accepted():
    """The function accepts both str and pathlib.Path for log_path."""
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "str-path.jsonl"
        usage = {"input": 7, "output": 3, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 10}
        _write_jsonl(path, [_assistant_event(usage=usage)])

        # Pass as a plain string (the type annotation permits ``str | Path``)
        result = extract_phase_usage(str(path))
        assert result == usage


# ─── Custom test runner (matches the project convention) ────────────────


tests = [
    test_missing_log_returns_none,
    test_missing_log_str_path_returns_none,
    test_empty_log_returns_none,
    test_log_with_no_usage_returns_none,
    test_single_usage_returns_dict,
    test_multiple_usage_entries_returns_last,
    test_malformed_lines_are_skipped,
    test_only_assistant_role_counts,
    test_str_path_is_accepted,
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
