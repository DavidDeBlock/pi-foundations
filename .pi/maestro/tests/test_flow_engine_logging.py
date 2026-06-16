#!/usr/bin/env python3
"""
test_flow_engine_logging.py — Structured-logger event-sequence tests
for the close-phase helpers in :mod:`flow_engine`.

The scout and optional-phase tests that used to live in this file
have been removed (issue #34 — the ``_run_scout_phase`` function
moved to :mod:`scout_runner` and ``run_phase``/``_run_phase_inner``
moved to :mod:`phase_runner`). The new integration surface for
``run_flow`` is covered in :mod:`tests.test_run_flow`; the scout
helper is covered by :mod:`tests.test_flow_dispatcher` (with the
function patched at its new module location).

The remaining close-phase tests exercise the
:func:`flow_engine._close_phase_result` and
:func:`phase_runner.run_close_phase` pair: they drive the close
phase with a :class:`ListLogger` and assert the expected event
sequence lands in ``logger.events``.

Test surface:

  * Successful close phase with all evidence → no events
  * Missing evidence + warn_but_proceed policy → two ``evidence_warn``
  * ``block`` policy on missing evidence → no warn events (the close
    phase returns ``reject``)
  * ``ignore`` policy on missing evidence → no warn events (the
    close phase returns ``success``)

Run with: ``python3 tests/test_flow_engine_logging.py`` (custom runner)
       or ``python3 -m pytest tests/test_flow_engine_logging.py`` (pytest)
"""

import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

# Add lib + parent dir to path so we can import flow_engine
TEST_DIR = Path(__file__).parent
MAESTRO_DIR = TEST_DIR.parent
sys.path.insert(0, str(MAESTRO_DIR / "lib"))
sys.path.insert(0, str(MAESTRO_DIR))

import flow_engine  # noqa: E402
from phase_runner import run_close_phase  # noqa: E402  (issue #34: moved)
from flow_logger import ListLogger  # noqa: E402


# ─── Shared fixtures ────────────────────────────────────────────────────


def _make_close_flow(policy: str = "warn_but_proceed") -> dict:
    """Minimal flow config for close-phase tests."""
    return {
        "name": "test-flow",
        "phases": {
            "close": {
                "is_local": True,
                "command": "true",
                "retries": 1,
            },
        },
        "transitions": [],
        "evidence_policy": {
            "required_on_success": ["tested", "reviewed"],
            "on_missing_evidence": policy,
        },
    }


def _events_with_kind(events, kind: str) -> list:
    """Return all events with the given kind (in order)."""
    return [ev for ev in events if ev.kind == kind]


# ─── Tests: _close_phase_result ────────────────────────────────────────


def test_close_phase_no_events_when_evidence_present():
    """Happy path (all evidence verified) → no log events."""
    d = tempfile.mkdtemp()
    try:
        from evidence import EvidenceStore, make_reviewed_marker, make_tested_marker
        store = EvidenceStore(42, evidence_dir=Path(d))
        store.write(make_tested_marker(42, "pytest", 0, 5, 5))
        store.write(make_reviewed_marker(42, 0, 0, "human"))

        log = ListLogger()
        result = run_close_phase(
            _make_close_flow("warn_but_proceed"),
            42,
            evidence_dir=d,
            log=log,
        )

        assert result["status"] == "success"
        assert log.events == [], (
            f"Happy path should not emit log events; got {log.events}"
        )
    finally:
        import shutil
        shutil.rmtree(d, ignore_errors=True)


def test_close_phase_emits_two_evidence_warn_on_warn_policy():
    """Missing evidence + warn_but_proceed → exactly two ``evidence_warn`` events."""
    d = tempfile.mkdtemp()
    try:
        log = ListLogger()
        result = run_close_phase(
            _make_close_flow("warn_but_proceed"),
            42,
            evidence_dir=d,
            log=log,
        )

        assert result["status"] == "success"
        warns = _events_with_kind(log.events, "evidence_warn")
        assert len(warns) == 2, (
            f"Expected 2 evidence_warn events; got {len(warns)}: {warns}"
        )
        # First warns about the missing evidence; second warns about
        # the policy downgrade. Both have no phase prefix (memory_warn
        # is config-time, not phase-time).
        assert "Missing evidence" in warns[0].message
        assert "warn_but_proceed" in warns[1].message
        for w in warns:
            assert w.phase is None, (
                f"evidence_warn should not be phase-scoped; got phase={w.phase!r}"
            )
    finally:
        import shutil
        shutil.rmtree(d, ignore_errors=True)


def test_close_phase_no_events_on_block_policy():
    """Missing evidence + block policy → no log events (no warning, just rejection)."""
    d = tempfile.mkdtemp()
    try:
        log = ListLogger()
        result = run_close_phase(
            _make_close_flow("block"),
            42,
            evidence_dir=d,
            log=log,
        )

        assert result["status"] == "reject"
        # block policy returns the reject; no warn events fire.
        assert log.events == [], (
            f"block policy should not emit log events; got {log.events}"
        )
    finally:
        import shutil
        shutil.rmtree(d, ignore_errors=True)


def test_close_phase_no_events_on_ignore_policy():
    """Missing evidence + ignore policy → no log events."""
    d = tempfile.mkdtemp()
    try:
        log = ListLogger()
        result = run_close_phase(
            _make_close_flow("ignore"),
            42,
            evidence_dir=d,
            log=log,
        )

        assert result["status"] == "success"
        assert log.events == []
    finally:
        import shutil
        shutil.rmtree(d, ignore_errors=True)


# ─── Test runner ────────────────────────────────────────────────────────


def main() -> int:
    """Run all tests in this file and return exit code 0 iff all pass."""
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
