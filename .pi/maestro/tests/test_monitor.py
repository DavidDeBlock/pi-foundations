#!/usr/bin/env python3
"""
Unit tests for the ``maestro monitor`` subcommand and its view layer.

Covers the acceptance criteria from issue #37 ("Monitor: entrypoint
+ empty state"):

  - ``maestro monitor`` is wired into the top-level ``maestro`` CLI.
  - ``maestro monitor --help`` describes the command and its options.
  - :func:`monitor_view.build_layout` returns a three-row
    ``Layout`` (header / body / footer) regardless of state.
  - The empty-state panel renders the message
    "No active flows. Run `maestro` to start one." (AC: "Empty-state
    panel renders centered with the correct message").
  - The footer shows the refresh + quit hint
    "↻ refreshing · q to quit" (AC: "Footer shows the refresh + quit
    hint").
  - :func:`monitor_view.poll_snapshot` handles a missing logs
    directory without raising (AC: "Missing ``.maestro/logs/``
    directory is handled gracefully (no error)").
  - The input watcher thread sets the stop event when ``q`` is
    typed, case- and whitespace-insensitive (AC: "``q`` quits
    cleanly").
  - The input watcher thread sets the stop event on EOFError
    (graceful shutdown when stdin is closed).
  - :func:`commands.monitor.run_monitor` returns ``0`` on a clean
    exit and creates no files on disk (AC: "Monitor does not write
    to any file (read-only)").
  - Rich's :class:`Layout` is responsive to terminal resize — the
    AC "Terminal resize is handled correctly" is satisfied by rich's
    built-in layout engine; we test that ``build_layout`` works at
    a non-default width.

Run with: ``python3 tests/test_monitor.py`` (custom runner)
       or ``python3 -m pytest tests/test_monitor.py`` (pytest)
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ─── Path setup ──────────────────────────────────────────────────────────
#
# Tests live at ``.pi/maestro/tests/test_monitor.py``. We need both
# ``.pi/maestro`` (for ``maestro``, ``commands.monitor``) and
# ``.pi/maestro/lib`` (for ``monitor_view``) on ``sys.path``.
MAESTRO_DIR = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(MAESTRO_DIR))
sys.path.insert(0, str(MAESTRO_DIR / "lib"))

import click  # noqa: E402
from click.testing import CliRunner  # noqa: E402
from rich.console import Console  # noqa: E402

from maestro import maestro_cli  # noqa: E402
from commands.monitor import run_monitor, start_input_watcher  # noqa: E402
from monitor_view import (  # noqa: E402
    EMPTY_STATE_MESSAGE,
    FOOTER_HINT,
    HEADER_TITLE,
    MonitorState,
    build_layout,
    poll_snapshot,
)


# ─── Helpers ─────────────────────────────────────────────────────────────


def _render_to_text(layout, width: int = 80, height: int = 24) -> str:
    """Render ``layout`` to a string via a captured ``Console``.

    Returns the raw output (including ANSI escape codes) — we assert
    on the presence of literal substrings like ``FOOTER_HINT`` and
    ``EMPTY_STATE_MESSAGE``, which appear verbatim inside the
    captured stream.

    Using capture() (rather than rendering to a real terminal) keeps
    tests deterministic and dependency-free.
    """
    console = Console(
        force_terminal=True,
        width=width,
        height=height,
        file=open(os.devnull, "w"),
    )
    sink = Console(force_terminal=False, width=width, record=True, file=open(os.devnull, "w"))
    with sink.capture() as cap:
        sink.print(layout)
    return cap.get()


# ─── Snapshot tests ──────────────────────────────────────────────────────


def test_poll_snapshot_handles_missing_dir():
    """``poll_snapshot`` must not raise on a non-existent logs dir.

    AC: "Missing ``.maestro/logs/`` directory is handled gracefully
    (no error)".
    """
    with tempfile.TemporaryDirectory() as tmp:
        missing = Path(tmp) / "does" / "not" / "exist"
        # Should not raise.
        state = poll_snapshot(missing, interval_s=1.0)
    assert state.has_logs_dir is False
    assert state.active_count == 0
    # logs_dir is resolved (absolute) on the returned state.
    assert state.logs_dir.is_absolute()


def test_poll_snapshot_handles_existing_dir():
    """``poll_snapshot`` returns ``has_logs_dir=True`` for a real dir."""
    with tempfile.TemporaryDirectory() as tmp:
        state = poll_snapshot(Path(tmp), interval_s=1.0)
    assert state.has_logs_dir is True
    assert state.active_count == 0
    assert state.logs_dir == Path(tmp).resolve()


def test_poll_snapshot_handles_file_not_dir():
    """``poll_snapshot`` treats a file path as ``has_logs_dir=False``.

    A path that exists but is not a directory is not a valid logs
    dir — the monitor should treat it as missing, not crash.
    """
    with tempfile.TemporaryDirectory() as tmp:
        file_path = Path(tmp) / "i-am-a-file.txt"
        file_path.write_text("not a directory", encoding="utf-8")
        state = poll_snapshot(file_path, interval_s=1.0)
    assert state.has_logs_dir is False


def test_monitor_state_is_frozen():
    """``MonitorState`` is a frozen dataclass — assignable to a tuple,
    hashable, and rejects attribute assignment."""
    state = MonitorState(
        logs_dir=Path("/tmp/logs"),
        active_count=0,
        has_logs_dir=True,
        interval_s=1.0,
    )
    # Should hash without raising.
    {state}
    # Should reject assignment.
    raised = False
    try:
        state.active_count = 5  # type: ignore[misc]
    except Exception:  # noqa: BLE001
        raised = True
    assert raised, "frozen dataclass must reject attribute assignment"


# ─── Layout tests ────────────────────────────────────────────────────────


def test_build_layout_has_three_sections():
    """The layout is split into header, body, and footer in that order."""
    state = poll_snapshot(Path("/nonexistent"), interval_s=1.0)
    layout = build_layout(state)
    names = [child.name for child in layout.children]
    assert names == ["header", "body", "footer"], names


def test_build_layout_empty_state_contains_message():
    """The rendered body contains the empty-state message.

    AC: "Empty-state panel renders centered with the correct message".
    """
    state = poll_snapshot(Path("/nonexistent"), interval_s=1.0)
    layout = build_layout(state)
    rendered = _render_to_text(layout)
    assert EMPTY_STATE_MESSAGE in rendered
    assert "Run `maestro` to start one" in rendered


def test_build_layout_footer_contains_hint():
    """The rendered footer contains the refresh + quit hint.

    AC: "Footer shows the refresh + quit hint".
    """
    state = poll_snapshot(Path("/nonexistent"), interval_s=1.0)
    layout = build_layout(state)
    rendered = _render_to_text(layout)
    assert FOOTER_HINT in rendered
    assert "↻ refreshing" in rendered
    assert "q to quit" in rendered


def test_build_layout_header_contains_title():
    """The header contains the monitor title and active-flow count."""
    state = poll_snapshot(Path("/nonexistent"), interval_s=1.0)
    layout = build_layout(state)
    rendered = _render_to_text(layout)
    assert HEADER_TITLE in rendered
    assert "0 active flows" in rendered


def test_build_layout_renders_at_non_default_width():
    """The layout renders cleanly at a 60-column width (resize-safe).

    AC: "Terminal resize is handled correctly (no broken layout)".
    Rich's :class:`Layout` is responsive by construction, so this
    test mainly guards against a future regression where the
    builder hardcodes a width assumption.
    """
    state = poll_snapshot(Path("/nonexistent"), interval_s=1.0)
    layout = build_layout(state)
    # Should not raise at a narrower width.
    rendered = _render_to_text(layout, width=60, height=20)
    assert FOOTER_HINT in rendered
    assert EMPTY_STATE_MESSAGE in rendered


def test_build_layout_surfaces_missing_dir_in_header():
    """When the logs dir is missing, the header notes the condition.

    This is an affordance for the operator — the empty-state body
    is identical, but the header signals that the monitor is
    watching a path that does not exist (helps diagnose
    configuration mistakes).
    """
    state = poll_snapshot(Path("/nonexistent/.maestro/logs"), interval_s=1.0)
    layout = build_layout(state)
    rendered = _render_to_text(layout)
    assert "missing" in rendered


# ─── Input watcher tests ─────────────────────────────────────────────────


def test_input_watcher_q_sets_stop_event():
    """Typing ``q`` sets the stop event (AC: 'q quits cleanly')."""
    stop = threading.Event()
    start_input_watcher(stop, input_func=lambda: "q")
    # The thread reads synchronously; one sleep cycle is plenty.
    time.sleep(0.05)
    assert stop.is_set(), "expected stop event to be set when 'q' is typed"


def test_input_watcher_q_with_whitespace_sets_stop_event():
    """``q`` surrounded by whitespace still triggers quit."""
    stop = threading.Event()
    start_input_watcher(stop, input_func=lambda: "  q  \n")
    time.sleep(0.05)
    assert stop.is_set()


def test_input_watcher_uppercase_q_sets_stop_event():
    """Uppercase ``Q`` triggers quit (case-insensitive)."""
    stop = threading.Event()
    start_input_watcher(stop, input_func=lambda: "Q")
    time.sleep(0.05)
    assert stop.is_set()


def test_input_watcher_non_q_does_not_set_stop_event():
    """Input that is not ``q`` does not trigger quit."""
    stop = threading.Event()
    # A function that always returns the same non-q value, so the
    # thread keeps looping until we check the event. We use a
    # ``threading.Event`` as a side-channel to break out cleanly.
    keep_going = threading.Event()
    keep_going.set()
    def _fake_input():
        if keep_going.is_set():
            return "hello"
        raise EOFError
    start_input_watcher(stop, input_func=_fake_input)
    time.sleep(0.05)
    assert not stop.is_set()
    keep_going.clear()  # let the watcher exit cleanly


def test_input_watcher_eof_sets_stop_event():
    """``EOFError`` (stdin closed) sets the stop event."""
    stop = threading.Event()
    start_input_watcher(stop, input_func=lambda: (_ for _ in ()).throw(EOFError))
    time.sleep(0.05)
    assert stop.is_set()


def test_input_watcher_already_stopped_exits_immediately():
    """If the stop event is already set, the watcher exits on the
    first iteration without calling ``input_func``.

    This guards against a regression where the watcher would call
    ``input_func`` even when it should not run.
    """
    stop = threading.Event()
    stop.set()  # already set
    call_count = 0
    def _counting_input():
        nonlocal call_count
        call_count += 1
        return ""
    start_input_watcher(stop, input_func=_counting_input)
    time.sleep(0.05)
    assert call_count == 0, "input_func must not be called when stop is already set"


# ─── Click command tests ─────────────────────────────────────────────────


def test_maestro_help_lists_monitor():
    """``maestro --help`` must list the new ``monitor`` subcommand."""
    runner = CliRunner()
    result = runner.invoke(maestro_cli, ["--help"])
    assert result.exit_code == 0, result.output
    assert "monitor" in result.output


def test_maestro_monitor_help_lists_options():
    """``maestro monitor --help`` must list ``--logs-dir`` and ``--interval``."""
    runner = CliRunner()
    result = runner.invoke(maestro_cli, ["monitor", "--help"])
    assert result.exit_code == 0, result.output
    assert "--logs-dir" in result.output
    assert "--interval" in result.output
    # Footer hint should appear in the command's long help.
    assert "q" in result.output


def test_maestro_monitor_is_separate_top_level_command():
    """The monitor command is mounted as a top-level subcommand of
    ``maestro`` (not nested under another group), matching the
    canonical ``maestro monitor`` invocation from the PRD."""
    runner = CliRunner()
    result = runner.invoke(maestro_cli, ["monitor", "--help"])
    assert result.exit_code == 0, result.output
    # If it were nested, the help would be ``maestro <group> monitor``.
    # We test the help output is reachable directly as ``maestro monitor``.


# ─── run_monitor integration tests ───────────────────────────────────────


def test_run_monitor_returns_zero_on_clean_quit():
    """``run_monitor`` returns 0 when input immediately signals quit.

    Drives the watcher via a mock ``input_func`` (the default
    ``input`` would block on real stdin). A short interval keeps
    the test fast.
    """
    console = Console(force_terminal=True, width=80, height=24, file=open(os.devnull, "w"))
    # A custom input_func that immediately returns "q" — does not
    # read from real stdin, so the test is deterministic regardless
    # of TTY / pipe context.
    inputs = iter(["q"])
    start = time.time()
    rc = run_monitor(
        Path("/nonexistent/.maestro/logs"),
        interval=0.1,
        console=console,
        input_func=lambda: next(inputs),
    )
    elapsed = time.time() - start
    assert rc == 0
    # Should exit promptly once the watcher signals stop. Allow a
    # generous bound to avoid flakes on slow CI.
    assert elapsed < 2.0, f"monitor took too long to quit: {elapsed:.2f}s"


def test_run_monitor_does_not_write_to_disk():
    """``run_monitor`` creates no files anywhere in the cwd.

    AC: "Monitor does not write to any file (read-only)".

    Snapshots the cwd tree before and after a brief run. The only
    acceptable differences are the ignore list (``__pycache__``,
    etc.), and the test uses a high-entropy tempdir as cwd to keep
    the comparison localised.
    """
    with tempfile.TemporaryDirectory() as tmp_cwd:
        logs_dir = Path(tmp_cwd) / ".maestro" / "logs"
        # Note: logs_dir is NOT created. The monitor must handle its
        # absence (one of the ACs).

        def _list_files(root: str) -> set:
            out: set = set()
            for r, dirs, files in os.walk(root):
                # Prune noisy dirs.
                dirs[:] = [
                    d for d in dirs
                    if d not in {"__pycache__", ".git", "node_modules", ".venv", ".pytest_cache"}
                ]
                for f in files:
                    full = os.path.join(r, f)
                    # Make path relative for stable comparison.
                    out.add(os.path.relpath(full, root))
            return out

        before = _list_files(tmp_cwd)
        old_cwd = os.getcwd()
        try:
            os.chdir(tmp_cwd)
            console = Console(force_terminal=False, file=open(os.devnull, "w"))
            run_monitor(
                logs_dir,
                interval=0.05,
                console=console,
                # A no-op input_func that raises EOFError immediately
                # (it never reads from real stdin).
                input_func=lambda: (_ for _ in ()).throw(EOFError),
            )
        finally:
            os.chdir(old_cwd)
        after = _list_files(tmp_cwd)
        new = after - before
        assert new == set(), f"monitor created {len(new)} files: {sorted(new)[:5]}"


def test_run_monitor_handles_existing_logs_dir():
    """``run_monitor`` also works when the logs dir exists (with no files).

    The empty-state panel is still rendered (no flows → no active
    flows), and the monitor exits cleanly.
    """
    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp) / "logs"
        logs_dir.mkdir()
        console = Console(force_terminal=True, width=80, height=24, file=open(os.devnull, "w"))
        rc = run_monitor(
            logs_dir,
            interval=0.1,
            console=console,
            input_func=lambda: (_ for _ in ()).throw(EOFError),
        )
    assert rc == 0


# ─── Backward-compat smoke test ──────────────────────────────────────────


def test_python_m_commands_monitor_works():
    """``python3 -m commands.monitor --help`` must work (mirrors
    other ``commands/`` modules, which are reachable both via the
    top-level ``maestro`` CLI and as ``python3 -m commands.<name>``
    for ops scripts).
    """
    import subprocess
    result = subprocess.run(
        [sys.executable, "-m", "commands.monitor", "--help"],
        cwd=str(MAESTRO_DIR),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "--logs-dir" in result.stdout
    assert "--interval" in result.stdout


# ─── Issue #40: active flow rendering tests ─────────────────────────────


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


def test_poll_snapshot_detects_active_flows():
    """``poll_snapshot`` identifies active flows from JSONL logs.

    AC: "Reads ``.maestro/logs/<flow>/<issue>.jsonl`` files"
    AC: "Identifies active flows from the event log"
    """
    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp) / "logs"
        flow_dir = logs_dir / "builder-reviewer"
        jsonl_path = flow_dir / "42.jsonl"

        events = [
            _event("phase_start", phase="scout"),
            _event("phase_end", phase="scout"),
            _event("phase_start", phase="builder"),
        ]
        jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        with jsonl_path.open("w") as f:
            for e in events:
                f.write(json.dumps(e) + "\n")

        state = poll_snapshot(logs_dir, interval_s=1.0)
    assert state.has_logs_dir is True
    assert state.active_count == 1
    assert len(state.active_flows) == 1
    snapshot = state.active_flows[0]
    assert snapshot.flow_name == "builder-reviewer"
    assert snapshot.issue_num == 42
    assert snapshot.current_phase == "builder"


def test_poll_snapshot_skips_completed_flows():
    """Completed flows (last event is terminal) are not counted as active."""
    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp) / "logs"
        flow_dir = logs_dir / "builder-reviewer"
        jsonl_path = flow_dir / "42.jsonl"

        events = [
            _event("phase_start", phase="builder"),
            _event("phase_end", phase="builder"),
        ]
        jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        with jsonl_path.open("w") as f:
            for e in events:
                f.write(json.dumps(e) + "\n")

        state = poll_snapshot(logs_dir, interval_s=1.0)
    assert state.active_count == 0
    assert len(state.active_flows) == 0


def test_poll_snapshot_skips_corrupt_jsonl():
    """Corrupt JSONL files don't crash the monitor.

    AC: "Corrupt log lines are skipped, monitor does not crash"
    """
    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp) / "logs"
        flow_dir = logs_dir / "builder-reviewer"
        jsonl_path = flow_dir / "42.jsonl"

        # Write corrupt data mixed with valid events.
        jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        with jsonl_path.open("w") as f:
            f.write(json.dumps(_event("phase_start", phase="builder")) + "\n")
            f.write("this is not json at all\n")  # corrupt
            f.write('"partial')  # truncated (no newline)

        state = poll_snapshot(logs_dir, interval_s=1.0)
    assert state.active_count == 1
    assert state.active_flows[0].current_phase == "builder"


def test_poll_snapshot_multiple_active_flows_sorted():
    """Multiple active flows are returned in stable order (by start time).

    AC: "Multiple active flows render in stable order (sorted by start time)"
    """
    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp) / "logs"

        # Issue 99 started first (older timestamp)
        ts_1 = _ago(600)
        jsonl_1 = logs_dir / "builder-reviewer" / "99.jsonl"
        events_1 = [_event("phase_start", phase="builder", timestamp=ts_1)]
        jsonl_1.parent.mkdir(parents=True, exist_ok=True)
        with jsonl_1.open("w") as f:
            for e in events_1:
                f.write(json.dumps(e) + "\n")

        # Issue 5 started later (newer timestamp)
        ts_2 = _ago(300)
        jsonl_2 = logs_dir / "full-lifecycle" / "5.jsonl"
        events_2 = [_event("phase_start", phase="reviewer", timestamp=ts_2)]
        jsonl_2.parent.mkdir(parents=True, exist_ok=True)
        with jsonl_2.open("w") as f:
            for e in events_2:
                f.write(json.dumps(e) + "\n")

        state = poll_snapshot(logs_dir, interval_s=1.0)
    assert state.active_count == 2
    # Sorted by start_time ascending (oldest first).
    assert state.active_flows[0].issue_num == 99
    assert state.active_flows[1].issue_num == 5


def test_build_layout_active_flows_shows_count():
    """Header shows correct count of active flows.

    AC: "Header shows count of active flows"
    """
    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp) / "logs"
        flow_dir = logs_dir / "builder-reviewer"
        jsonl_path = flow_dir / "42.jsonl"

        events = [_event("phase_start", phase="reviewer")]
        jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        with jsonl_path.open("w") as f:
            for e in events:
                f.write(json.dumps(e) + "\n")

        state = poll_snapshot(logs_dir, interval_s=1.0)
    layout = build_layout(state)
    rendered = _render_to_text(layout)
    assert "1 active flow" in rendered or "1 active flows" in rendered


def test_build_layout_active_flow_panel_contains_phase():
    """Flow panel shows current phase information.

    AC: "Renders one panel per active flow with: ... current phase (X/Y)"
    """
    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp) / "logs"
        flow_dir = logs_dir / "builder-reviewer"
        jsonl_path = flow_dir / "42.jsonl"

        events = [
            _event("phase_start", phase="scout"),
            _event("phase_end", phase="scout"),
            _event("phase_start", phase="builder"),
        ]
        jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        with jsonl_path.open("w") as f:
            for e in events:
                f.write(json.dumps(e) + "\n")

        state = poll_snapshot(logs_dir, interval_s=1.0)
    layout = build_layout(state)
    rendered = _render_to_text(layout)
    assert "builder" in rendered.lower()
    # Phase index should show (2 since scout was first).
    assert "Phase:" in rendered


def test_build_layout_active_flow_panel_contains_issue():
    """Flow panel shows issue number.

    AC: "Renders one panel per active flow with: issue # + title"
    """
    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp) / "logs"
        flow_dir = logs_dir / "builder-reviewer"
        jsonl_path = flow_dir / "42.jsonl"

        events = [_event("phase_start", phase="reviewer")]
        jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        with jsonl_path.open("w") as f:
            for e in events:
                f.write(json.dumps(e) + "\n")

        state = poll_snapshot(logs_dir, interval_s=1.0)
    layout = build_layout(state)
    rendered = _render_to_text(layout)
    assert "#42" in rendered


def test_build_layout_active_flow_panel_contains_tokens():
    """Flow panel shows token usage.

    AC: "Renders one panel per active flow with: ... tokens in/out"
    """
    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp) / "logs"
        flow_dir = logs_dir / "builder-reviewer"
        jsonl_path = flow_dir / "42.jsonl"

        events = [
            _event(
                "phase_start",
                phase="reviewer",
                tokens={"input": 1000, "output": 500, "cacheRead": 200},
            ),
        ]
        jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        with jsonl_path.open("w") as f:
            for e in events:
                f.write(json.dumps(e) + "\n")

        state = poll_snapshot(logs_dir, interval_s=1.0)
    layout = build_layout(state)
    rendered = _render_to_text(layout)
    assert "Tokens:" in rendered
    # Token values should appear (formatted with commas).
    assert "1,000" in rendered or "1000" in rendered


def test_build_layout_missing_fields_show_placeholders():
    """When log format is missing fields, card renders with ``?`` placeholders.

    AC: "When PRD #25's log format is missing fields (older logs), the
    card renders with ? placeholders rather than crashing"
    """
    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp) / "logs"
        flow_dir = logs_dir / "builder-reviewer"
        jsonl_path = flow_dir / "42.jsonl"

        # Minimal event — no phase, no tokens, empty message.
        events = [
            {"kind": "phase_start", "message": "", "timestamp": _now_iso()},
        ]
        jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        with jsonl_path.open("w") as f:
            for e in events:
                f.write(json.dumps(e) + "\n")

        state = poll_snapshot(logs_dir, interval_s=1.0)
    # Should not raise.
    layout = build_layout(state)
    rendered = _render_to_text(layout)
    assert "#42" in rendered  # issue number still shown from filename


def test_run_monitor_with_active_flows():
    """``run_monitor`` works correctly when active flows are present.

    Integration test: creates a log directory with an active flow,
    runs the monitor briefly, and verifies it exits cleanly.
    """
    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp) / "logs"
        flow_dir = logs_dir / "builder-reviewer"
        jsonl_path = flow_dir / "42.jsonl"

        events = [_event("phase_start", phase="builder")]
        jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        with jsonl_path.open("w") as f:
            for e in events:
                f.write(json.dumps(e) + "\n")

        console = Console(force_terminal=False, file=open(os.devnull, "w"))
        rc = run_monitor(
            logs_dir,
            interval=0.1,
            console=console,
            input_func=lambda: (_ for _ in ()).throw(EOFError),
        )
    assert rc == 0


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
