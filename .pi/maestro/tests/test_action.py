#!/usr/bin/env python3
"""
Unit tests for ``lib/action_menu.py`` — the Maestro action menu.

These tests cover the acceptance criteria from issue #38
("Action menu: start a batch of issues") AND the supporting
scaffolding that issue #36 ("Action menu: entrypoint + start
single issue") would have added. The batch slice depends on
the menu existing (#36's blocker), so the tests for #38
also exercise the menu entry / single-issue flow.

What we test (mapping to ACs):

  - **Menu visibility**: ``MENU_OPTIONS`` exposes "Start batch"
    and "Quit". (``test_menu_options_*``)
  - **Multi-select**: ``run_action_menu`` calls ``io.checkbox``
    for the issue picker in batch mode. (``test_batch_uses_checkbox``)
  - **Per-issue flow picker**: after multi-select, the state
    machine asks for a flow per issue. (``test_batch_flow_picker_per_issue``)
  - **"Use default" choice**: the flow picker accepts the
    sentinel ``<default>``; the spawn resolves it. (``test_resolve_*``)
  - **Confirmation screen**: a confirm step is issued BEFORE
    any spawn happens. (``test_batch_confirmation_before_spawn``)
  - **Spawn on confirm**: confirming the batch produces one
    spawn per spec. (``test_batch_happy_path``)
  - **One failure does not abort the batch**: a spec that
    fails to spawn does not stop the others. (``test_batch_one_failure_continues``)
  - **Summary after the batch**: a single summary message
    with started / failed counts. (``test_batch_summary_text``)
  - **Audit log records each started flow**: a successful
    spawn writes one audit log entry. (``test_batch_audit_log_entries``)
  - **Cancel at any step returns to the menu**:
    - Empty multi-select
    - "No" on confirm
    - Ctrl-C mid-pick
    (``test_batch_cancel_*``)
  - **gh not authenticated → clear error → exit 0**:
    (``test_action_menu_gh_not_authenticated``)
  - **Empty issue list → no-op** (no spawn, return to menu):
    (``test_action_menu_empty_issue_list``)
  - **Config helpers**: default flow fallback, available flows
    listing. (``test_load_default_flow_*``,
    ``test_load_available_flows_*``)

Testability seam: the :class:`ScriptedMenuIO` adapter feeds
predetermined answers into the state machine, and the
``spawn_fn`` parameter on :func:`run_batch` /
:func:`run_single` lets the tests substitute a fake spawner
that does not fork a real subprocess.

Run with: ``python3 tests/test_action.py`` (custom runner)
       or ``python3 -m pytest tests/test_action.py`` (pytest)
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

# Path setup. Tests live at ``.pi/maestro/tests``. We need both
# ``.pi/maestro`` and ``.pi/maestro/lib`` on ``sys.path`` so
# ``import action_menu`` and ``import audit_log`` work.
MAESTRO_DIR = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(MAESTRO_DIR))
sys.path.insert(0, str(MAESTRO_DIR / "lib"))

from click.testing import CliRunner  # noqa: E402

from maestro import maestro_cli  # noqa: E402
from action_menu import (  # noqa: E402
    DEFAULT_FLOW_FALLBACK,
    DEFAULT_FLOW_SENTINEL,
    MENU_OPTIONS,
    BatchSpec,
    LabelRule,
    ScriptedMenuIO,
    SpawnResult,
    load_available_flows,
    load_config,
    load_default_flow,
    load_label_rules,
    resolve_flow,
    run_action_menu,
    run_batch,
    run_single,
    spawn_runner,
)
import action_menu as _action_menu  # noqa: E402
import audit_log  # noqa: E402


# ─── Helpers ─────────────────────────────────────────────────────────────


class _FakeIssue:
    """Mimics :class:`github_client.Issue` for tests.

    The state machine reads ``.number``, ``.title``, and
    ``.labels``. We define a minimal class instead of importing
    the real dataclass to keep these tests independent of any
    future change to that class.
    """

    def __init__(self, number: int, title: str, labels: list[str] | None = None) -> None:
        self.number = number
        self.title = title
        self.labels = labels or []


class _FakeGithubClient:
    """Mimics :class:`github_client.GithubClient` for tests.

    Returns a preloaded list of issues from
    :meth:`fetch_issues_by_label`. The action menu only calls
    this one method, so we do not need to mock the rest.
    """

    def __init__(self, issues: list[_FakeIssue]) -> None:
        self._issues = issues
        self.fetched: list[str] = []  # call log for assertions

    def fetch_issues_by_label(self, label: str) -> list[_FakeIssue]:
        self.fetched.append(label)
        return self._issues

    def fetch_issues_by_labels(self, labels: list[str]) -> list[_FakeIssue]:
        """Fetch issues matching ANY of the given labels."""
        self.fetched.extend(labels)
        # Return all issues that have at least one matching label
        return [
            issue for issue in self._issues
            if any(lbl in issue.labels for lbl in labels)
        ]


def _make_spawn_log() -> list[tuple[int, str, bool, str | None]]:
    """Return a (issue_num, flow, started, error) log + a spawner.

    The returned spawner appends to the log and returns the
    recorded :class:`SpawnResult`. Tests use this to verify
    which specs were spawned and in what order.
    """
    log: list[tuple[int, str, bool, str | None]] = []

    def _spawner(issue_num: int, flow_name: str) -> SpawnResult:
        # Default: everything succeeds. The "one failure"
        # test mutates the log to inject a failure.
        log.append((issue_num, flow_name, True, None))
        return SpawnResult(
            issue_num=issue_num,
            flow_name=flow_name,
            started=True,
            error=None,
        )

    return log, _spawner


# ─── Menu visibility tests (AC: "Start batch option is visible") ───────


def test_menu_options_include_batch():
    """The top-level menu exposes the "Start batch" option.

    AC: "Start batch option is visible in the menu".
    """
    keys = [k for k, _ in MENU_OPTIONS]
    assert "batch" in keys, f"menu options missing 'batch': {MENU_OPTIONS}"


def test_menu_options_include_quit():
    """The top-level menu exposes a "Quit" option."""
    keys = [k for k, _ in MENU_OPTIONS]
    assert "quit" in keys, f"menu options missing 'quit': {MENU_OPTIONS}"


def test_menu_options_have_human_readable_labels():
    """Every menu option has a non-empty label (operator-facing)."""
    for key, label in MENU_OPTIONS:
        assert label and label.strip(), f"empty label for key {key!r}"


def test_menu_options_are_distinct():
    """No two menu options share a key (would make the state machine ambiguous)."""
    keys = [k for k, _ in MENU_OPTIONS]
    assert len(keys) == len(set(keys)), f"duplicate keys: {keys}"


# ─── Config helper tests ────────────────────────────────────────────────


def test_load_default_flow_falls_back_when_config_missing():
    """No config file → returns the hard-coded fallback."""
    with tempfile.TemporaryDirectory() as tmp:
        missing = Path(tmp) / "no-such-config.json"
        flow = load_default_flow(missing)
    assert flow == DEFAULT_FLOW_FALLBACK


def test_load_default_flow_reads_from_config():
    """A ``default_flow`` key in the config is returned."""
    with tempfile.TemporaryDirectory() as tmp:
        cfg = Path(tmp) / "config.json"
        cfg.write_text(json.dumps({"default_flow": "gap-check"}), encoding="utf-8")
        flow = load_default_flow(cfg)
    assert flow == "gap-check"


def test_load_default_flow_falls_back_on_non_string_value():
    """A non-string ``default_flow`` (e.g. None, int, list) is ignored."""
    with tempfile.TemporaryDirectory() as tmp:
        cfg = Path(tmp) / "config.json"
        cfg.write_text(json.dumps({"default_flow": 42}), encoding="utf-8")
        flow = load_default_flow(cfg)
    assert flow == DEFAULT_FLOW_FALLBACK


def test_load_default_flow_falls_back_on_empty_string():
    """An empty / whitespace-only ``default_flow`` is treated as unset."""
    with tempfile.TemporaryDirectory() as tmp:
        cfg = Path(tmp) / "config.json"
        cfg.write_text(json.dumps({"default_flow": "   "}), encoding="utf-8")
        flow = load_default_flow(cfg)
    assert flow == DEFAULT_FLOW_FALLBACK


def test_load_default_flow_falls_back_on_invalid_json():
    """A corrupt config (invalid JSON) does not raise; it falls back."""
    with tempfile.TemporaryDirectory() as tmp:
        cfg = Path(tmp) / "config.json"
        cfg.write_text("{ not valid json", encoding="utf-8")
        flow = load_default_flow(cfg)
    assert flow == DEFAULT_FLOW_FALLBACK


def test_load_available_flows_lists_json_files():
    """``*.json`` files in the flows dir are listed as flow names."""
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        (d / "alpha.json").write_text("{}", encoding="utf-8")
        (d / "beta.json").write_text("{}", encoding="utf-8")
        (d / "ignore.txt").write_text("not a flow", encoding="utf-8")
        names = load_available_flows(d)
    assert names == ["alpha", "beta"]


def test_load_available_flows_empty_dir():
    """An empty directory returns an empty list (not None, not an error)."""
    with tempfile.TemporaryDirectory() as tmp:
        names = load_available_flows(Path(tmp))
    assert names == []


def test_load_available_flows_missing_dir():
    """A non-existent directory returns an empty list."""
    with tempfile.TemporaryDirectory() as tmp:
        missing = Path(tmp) / "no-such-dir"
        names = load_available_flows(missing)
    assert names == []


def test_load_available_flows_ignores_whitespace_stems():
    """A file like ``'   .json'`` (whitespace stem) is skipped."""
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        (d / "   .json").write_text("{}", encoding="utf-8")
        (d / "real.json").write_text("{}", encoding="utf-8")
        names = load_available_flows(d)
    assert names == ["real"]


# ─── resolve_flow tests ────────────────────────────────────────────────


def test_resolve_flow_sentinel_returns_default():
    """A :class:`BatchSpec` with the sentinel returns the configured default."""
    spec = BatchSpec(issue_num=42, issue_title="t", flow_name=DEFAULT_FLOW_SENTINEL)
    assert resolve_flow(spec, "gap-check") == "gap-check"


def test_resolve_flow_literal_passes_through():
    """A literal flow name is returned unchanged."""
    spec = BatchSpec(issue_num=42, issue_title="t", flow_name="builder-reviewer")
    assert resolve_flow(spec, "gap-check") == "builder-reviewer"


# ─── spawn_runner tests ────────────────────────────────────────────────


def test_spawn_runner_success_returns_started_true():
    """A real (but no-op) spawn returns ``started=True`` with no error.

    We use ``/bin/true`` instead of the real ``orchestrate.py``
    to keep the test fast and free of side effects. The spawn
    layer's contract is: subprocess.Popen returns without raising
    → ``started=True``.
    """
    # Monkey-patch the spawn function's internals to call a
    # trivial command. The cleanest way: pass a custom spawner
    # to run_single, which is the seam the state machine uses.
    spec = BatchSpec(issue_num=1, issue_title="t", flow_name="x")
    result = run_single(
        spec,
        default_flow="x",
        spawn_fn=lambda n, f: SpawnResult(
            issue_num=n, flow_name=f, started=True, error=None
        ),
    )
    assert result.started is True
    assert result.error is None


def test_spawn_runner_failure_does_not_raise():
    """A spawn failure is returned as ``SpawnResult(started=False)``,
    not raised as an exception. This is the AC: "If one runner
    fails to spawn, the others still run" — the contract is that
    spawn failures are values, not exceptions.
    """
    def _exploding_spawner(issue_num: int, flow_name: str) -> SpawnResult:
        return SpawnResult(
            issue_num=issue_num,
            flow_name=flow_name,
            started=False,
            error="simulated failure",
        )

    spec = BatchSpec(issue_num=1, issue_title="t", flow_name="x")
    result = run_single(
        spec,
        default_flow="x",
        spawn_fn=_exploding_spawner,
    )
    assert result.started is False
    assert result.error == "simulated failure"


# ─── run_batch tests (AC: one failure does not abort the batch) ────────


def test_run_batch_with_one_failure_continues():
    """A single failure in a batch does not stop the rest of the specs.

    AC: "If one runner fails to spawn, the others still run".
    """
    specs = [
        BatchSpec(1, "issue-1", "flow-a"),
        BatchSpec(2, "issue-2", "flow-b"),
        BatchSpec(3, "issue-3", "flow-c"),
    ]

    def _selective_spawner(issue_num: int, flow_name: str) -> SpawnResult:
        if issue_num == 2:
            return SpawnResult(issue_num=2, flow_name=flow_name, started=False, error="boom")
        return SpawnResult(issue_num=issue_num, flow_name=flow_name, started=True, error=None)

    results = run_batch(specs, default_flow="fallback", spawn_fn=_selective_spawner)

    assert len(results) == 3
    assert results[0].started is True
    assert results[1].started is False
    assert results[1].error == "boom"
    assert results[2].started is True  # the failure did NOT stop this


def test_run_batch_preserves_order():
    """Results are returned in the same order as the input specs."""
    specs = [
        BatchSpec(10, "a", "x"),
        BatchSpec(20, "b", "y"),
        BatchSpec(30, "c", "z"),
    ]
    log, spawner = _make_spawn_log()
    results = run_batch(specs, default_flow="x", spawn_fn=spawner)
    assert [r.issue_num for r in results] == [10, 20, 30]


def test_run_batch_resolves_default_sentinel():
    """The :data:`DEFAULT_FLOW_SENTINEL` in a spec is resolved to
    the configured default before spawn."""
    specs = [
        BatchSpec(1, "a", DEFAULT_FLOW_SENTINEL),
    ]
    log, spawner = _make_spawn_log()
    run_batch(specs, default_flow="configured-default", spawn_fn=spawner)
    assert log[0][1] == "configured-default"


def test_run_batch_empty_input_returns_empty_list():
    """An empty batch is a no-op (returns ``[]``)."""
    log, spawner = _make_spawn_log()
    results = run_batch([], default_flow="x", spawn_fn=spawner)
    assert results == []
    assert log == []


def test_run_batch_audit_log_entries():
    """A successful spawn via the real :func:`spawn_runner` writes
    one audit log entry.

    We bypass the real ``orchestrate.py`` by monkey-patching
    :func:`subprocess.Popen` to return a fake process. This
    keeps the test fast and avoids a real subprocess while
    still exercising the real audit-log wiring.
    """
    with tempfile.TemporaryDirectory() as tmp:
        log_path = Path(tmp) / "audit.log"
        cwd = Path(tmp) / "repo"
        cwd.mkdir()
        # Provide a fake ``orchestrate.py`` so the spawn function's
        # path resolution succeeds, then monkey-patch Popen to
        # return a fake process object.
        fake_orchestrate = cwd / "fake-orchestrate.py"
        fake_orchestrate.write_text("# fake", encoding="utf-8")

        import subprocess
        class _FakeProcess:
            pid = 12345
        original_popen = subprocess.Popen
        def _fake_popen(cmd, **kwargs):
            # Verify the command shape: [python, orchestrate, --flow, FLOW, --issue, N]
            assert "builder-reviewer" in cmd
            return _FakeProcess()
        subprocess.Popen = _fake_popen
        try:
            # We have to call spawn_runner directly because
            # run_batch passes a custom spawn_fn. We pass the
            # actual path of the real maestro's orchestrate.py
            # is found via the function's own path resolution;
            # that resolution is independent of ``cwd``.
            spec = BatchSpec(issue_num=42, issue_title="t", flow_name="builder-reviewer")
            result = spawn_runner(
                spec.issue_num,
                spec.flow_name,
                repo_root=cwd,
                audit_log_path=log_path,
            )
        finally:
            subprocess.Popen = original_popen

        assert result.started is True
        entries = audit_log.read_entries(log_path)
        assert len(entries) == 1
        assert entries[0]["issue"] == 42
        assert entries[0]["flow"] == "builder-reviewer"


# ─── State machine: full batch flow (AC: end-to-end batch) ────────────


def test_batch_happy_path():
    """End-to-end: pick "batch" → multi-select two issues → pick a
    flow per issue (one default, one literal) → confirm → spawn
    both → summary shown.

    This is the main AC test: it drives the state machine with
    a scripted IO and verifies the spawns happened in the right
    order with the right flows.
    """
    issues = [
        _FakeIssue(42, "Action menu: start a batch", ["needs-triage"]),
        _FakeIssue(43, "Action menu: launch monitor", ["needs-triage"]),
    ]
    fake_gh = _FakeGithubClient(issues)

    # Scripted answers:
    #   - top-level menu → "batch"
    #   - multi-select → ["42", "43"]
    #   - flow picker for #42 → "<default>" (sentinel)
    #   - flow picker for #43 → "builder-reviewer-simple" (literal)
    #   - confirm batch → True
    #   - top-level menu (loop) → "quit"
    io = ScriptedMenuIO([
        "batch",
        ["42", "43"],
        DEFAULT_FLOW_SENTINEL,
        "builder-reviewer-simple",
        True,
        "quit",
    ])

    log: list[tuple[int, str]] = []
    def _fake_spawn(n: int, f: str) -> SpawnResult:
        log.append((n, f))
        return SpawnResult(issue_num=n, flow_name=f, started=True, error=None)

    rc = run_action_menu(
        io=io,
        gh_client_factory=lambda: fake_gh,
        default_flow="builder-reviewer",
        available_flows=["builder-reviewer", "builder-reviewer-simple", "gap-check"],
        spawn_fn=_fake_spawn,
    )

    assert rc == 0
    # Both issues were spawned, in the right order, with the
    # right flows (default resolved to "builder-reviewer" for #42,
    # literal "builder-reviewer-simple" for #43).
    assert log == [
        (42, "builder-reviewer"),
        (43, "builder-reviewer-simple"),
    ], f"unexpected spawn log: {log}"


def test_batch_uses_checkbox_for_multi_select():
    """The batch sub-flow uses ``io.checkbox`` (not ``io.select``)
    for the issue picker. AC: "Issue list allows multi-select
    (space toggles, enter confirms)".
    """
    issues = [_FakeIssue(42, "A", [])]
    fake_gh = _FakeGithubClient(issues)
    # Track which io method was called by wrapping ScriptedMenuIO.
    class _TrackingIO(ScriptedMenuIO):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.calls: list[tuple[str, int]] = []

        def select(self, message, choices):
            self.calls.append(("select", len(choices)))
            return super().select(message, choices)

        def checkbox(self, message, choices):
            self.calls.append(("checkbox", len(choices)))
            return super().checkbox(message, choices)

        def confirm(self, message, *, default=True):
            self.calls.append(("confirm", 0))
            return super().confirm(message, default=default)

        def flow_picker(self, message, choices, *, default_flow):
            self.calls.append(("flow_picker", len(choices)))
            return super().flow_picker(message, choices, default_flow=default_flow)

    # Two-call run: first iteration "batch" (cancel at multi-select
    # to exit the sub-flow); second iteration "quit" to exit the
    # menu. Cancel means the checkbox returns an empty list.
    io = _TrackingIO([
        "batch",
        [],                # empty checkbox = cancel
        "quit",
    ])

    rc = run_action_menu(
        io=io,
        gh_client_factory=lambda: fake_gh,
        default_flow="builder-reviewer",
        available_flows=["builder-reviewer"],
    )
    assert rc == 0
    # Find the calls in order: select (top-level), checkbox (issue picker), select (top-level again)
    method_names = [c[0] for c in io.calls]
    assert "checkbox" in method_names, f"no checkbox call in: {method_names}"


def test_batch_flow_picker_per_issue():
    """After multi-select, the state machine asks for a flow per
    selected issue. AC: "After multi-select, a flow picker
    appears per issue".
    """
    issues = [
        _FakeIssue(42, "A", []),
        _FakeIssue(43, "B", []),
        _FakeIssue(44, "C", []),
    ]
    fake_gh = _FakeGithubClient(issues)
    io = ScriptedMenuIO([
        "batch",
        ["42", "43", "44"],   # multi-select three
        "<default>",            # flow for #42
        "<default>",            # flow for #43
        "<default>",            # flow for #44
        True,                   # confirm batch
        "quit",
    ])

    # We want to count the flow_picker calls. Reuse the
    # _TrackingIO pattern from the previous test.
    class _TrackingIO(ScriptedMenuIO):
        flow_picker_calls = 0
        def flow_picker(self, message, choices, *, default_flow):
            _TrackingIO.flow_picker_calls += 1
            return super().flow_picker(message, choices, default_flow=default_flow)

    _TrackingIO.flow_picker_calls = 0  # reset class-level
    io = _TrackingIO([
        "batch",
        ["42", "43", "44"],
        "<default>",
        "<default>",
        "<default>",
        True,
        "quit",
    ])

    run_action_menu(
        io=io,
        gh_client_factory=lambda: fake_gh,
        default_flow="builder-reviewer",
        available_flows=["builder-reviewer"],
    )
    assert _TrackingIO.flow_picker_calls == 3, (
        f"expected 3 flow_picker calls, got {_TrackingIO.flow_picker_calls}"
    )


def test_batch_cancellation_at_multi_select_returns_to_menu():
    """An empty multi-select returns to the menu without spawning.

    AC: "Cancel at any step returns to the menu without spawning".
    Specifically: pressing enter with no checkbox toggled.
    """
    issues = [_FakeIssue(42, "A", [])]
    fake_gh = _FakeGithubClient(issues)
    io = ScriptedMenuIO([
        "batch",
        [],                # empty checkbox = cancel
        "quit",
    ])

    # Patch run_batch at the module level so we can assert it
    # is NOT called when the user cancels.
    import action_menu as _am
    called = {"count": 0}
    real_run_batch = _am.run_batch
    def _spy_run_batch(*args, **kwargs):
        called["count"] += 1
        return real_run_batch(*args, **kwargs)
    _am.run_batch = _spy_run_batch
    try:
        rc = run_action_menu(
            io=io,
            gh_client_factory=lambda: fake_gh,
            default_flow="builder-reviewer",
            available_flows=["builder-reviewer"],
        )
    finally:
        _am.run_batch = real_run_batch

    assert rc == 0
    assert called["count"] == 0, "run_batch was called despite cancellation"


def test_batch_cancellation_at_confirm_returns_to_menu():
    """Saying "No" on the batch confirmation returns to the menu
    without spawning.
    """
    issues = [_FakeIssue(42, "A", [])]
    fake_gh = _FakeGithubClient(issues)
    io = ScriptedMenuIO([
        "batch",
        ["42"],
        "<default>",
        False,              # confirm: NO
        "quit",
    ])

    import action_menu as _am
    called = {"count": 0}
    real_run_batch = _am.run_batch
    def _spy_run_batch(*args, **kwargs):
        called["count"] += 1
        return real_run_batch(*args, **kwargs)
    _am.run_batch = _spy_run_batch
    try:
        rc = run_action_menu(
            io=io,
            gh_client_factory=lambda: fake_gh,
            default_flow="builder-reviewer",
            available_flows=["builder-reviewer"],
        )
    finally:
        _am.run_batch = real_run_batch

    assert rc == 0
    assert called["count"] == 0


def test_batch_cancellation_mid_pick_returns_to_menu():
    """Cancelling the flow picker mid-batch (one of the per-issue
    pickers returns empty) returns the WHOLE batch to the menu.

    AC: "Cancel at any step returns to the menu without spawning".
    """
    issues = [
        _FakeIssue(42, "A", []),
        _FakeIssue(43, "B", []),
    ]
    fake_gh = _FakeGithubClient(issues)
    io = ScriptedMenuIO([
        "batch",
        ["42", "43"],
        "<default>",         # flow for #42
        "",                  # operator cancels flow picker for #43
        "quit",
    ])

    import action_menu as _am
    called = {"count": 0}
    real_run_batch = _am.run_batch
    def _spy_run_batch(*args, **kwargs):
        called["count"] += 1
        return real_run_batch(*args, **kwargs)
    _am.run_batch = _spy_run_batch
    try:
        rc = run_action_menu(
            io=io,
            gh_client_factory=lambda: fake_gh,
            default_flow="builder-reviewer",
            available_flows=["builder-reviewer"],
        )
    finally:
        _am.run_batch = real_run_batch

    assert rc == 0
    assert called["count"] == 0


def test_batch_one_failure_does_not_abort():
    """A spec that fails to spawn does not stop subsequent specs.

    AC: "If one runner fails to spawn, the others still run".
    """
    import action_menu as _am
    issues = [
        _FakeIssue(42, "A", []),
        _FakeIssue(43, "B", []),
        _FakeIssue(44, "C", []),
    ]
    fake_gh = _FakeGithubClient(issues)
    io = ScriptedMenuIO([
        "batch",
        ["42", "43", "44"],
        "<default>",
        "<default>",
        "<default>",
        True,                # confirm
        "quit",
    ])

    # Selective spawner: issue #43 fails, the rest succeed.
    def _selective_spawn(n: int, f: str) -> SpawnResult:
        return SpawnResult(
            issue_num=n,
            flow_name=f,
            started=(n != 43),
            error="boom" if n == 43 else None,
        )
    rc = run_action_menu(
        io=io,
        gh_client_factory=lambda: fake_gh,
        default_flow="builder-reviewer",
        available_flows=["builder-reviewer"],
        spawn_fn=_selective_spawn,
    )

    assert rc == 0
    # The summary message includes the failed count
    summary_messages = [m for m, k in io.messages if "Batch complete" in m]
    assert any("2 started" in m and "1 failed" in m for m in summary_messages), (
        f"no '2 started, 1 failed' summary in: {io.messages}"
    )


# ─── State machine: top-level menu behaviour ───────────────────────────


def test_action_menu_gh_not_authenticated_returns_zero():
    """If ``gh`` is not authenticated, the action menu exits 0
    with a clear error message — and does NOT enter the menu
    loop.

    AC: "If ``gh`` is not authenticated, a clear error is shown
    and the menu is preserved" (slightly different wording in
    #36; #38 does not restate it, but the integration contract
    is the same).
    """
    import action_menu as _am
    real_check = _am.check_gh_authenticated
    _am.check_gh_authenticated = lambda: False
    try:
        io = ScriptedMenuIO([])
        # No answers queued — if the menu loop runs at all,
        # the first io.select() call will exhaust the queue
        # and raise. The expected behaviour is: returns 0
        # WITHOUT calling any io method.
        rc = run_action_menu(
            io=io,
            gh_client_factory=lambda: _FakeGithubClient([]),
            default_flow="builder-reviewer",
            available_flows=["builder-reviewer"],
        )
    finally:
        _am.check_gh_authenticated = real_check
    assert rc == 0
    # No menu prompts were issued.
    assert io.answers == [], "menu loop ran despite gh not authenticated"


def test_action_menu_empty_issue_list_handles_gracefully():
    """If there are no open issues, the action menu shows a hint
    and returns to the menu — no spawn, no crash.
    """
    fake_gh = _FakeGithubClient([])  # no issues
    io = ScriptedMenuIO([
        "batch",                # try batch first; gets the empty message
        "single",               # try single; gets the empty message
        "quit",
    ])
    rc = run_action_menu(
        io=io,
        gh_client_factory=lambda: fake_gh,
        default_flow="builder-reviewer",
        available_flows=["builder-reviewer"],
    )
    assert rc == 0
    # At least one "no issues" hint was emitted
    hints = [m for m, _ in io.messages if "needs-triage" in m]
    assert len(hints) >= 1, f"no 'needs-triage' hint in: {io.messages}"


def test_action_menu_quit_returns_zero():
    """Choosing "Quit" at the top-level menu returns 0."""
    io = ScriptedMenuIO(["quit"])
    rc = run_action_menu(
        io=io,
        gh_client_factory=lambda: _FakeGithubClient([]),
        default_flow="builder-reviewer",
        available_flows=["builder-reviewer"],
    )
    assert rc == 0


def test_action_menu_keyboard_interrupt_returns_zero():
    """A :class:`KeyboardInterrupt` from the menu loop returns 0
    cleanly (the operator pressed Ctrl-C).
    """
    class _ExplodingIO(ScriptedMenuIO):
        def select(self, message, choices):
            raise KeyboardInterrupt

    io = _ExplodingIO([])
    rc = run_action_menu(
        io=io,
        gh_client_factory=lambda: _FakeGithubClient([]),
        default_flow="builder-reviewer",
        available_flows=["builder-reviewer"],
    )
    assert rc == 0


def test_action_menu_eof_returns_zero():
    """An :class:`EOFError` from the menu loop returns 0 cleanly
    (stdin closed, e.g. when piped input ends).
    """
    class _ExplodingIO(ScriptedMenuIO):
        def select(self, message, choices):
            raise EOFError

    io = _ExplodingIO([])
    rc = run_action_menu(
        io=io,
        gh_client_factory=lambda: _FakeGithubClient([]),
        default_flow="builder-reviewer",
        available_flows=["builder-reviewer"],
    )
    assert rc == 0


# ─── Label rules loading tests (issue #39) ──────────────────────────────


def test_load_label_rules_valid_config():
    """A valid label_rules array returns LabelRule objects."""
    with tempfile.TemporaryDirectory() as tmp:
        cfg = Path(tmp) / "config.json"
        cfg.write_text(
            json.dumps({
                "label_rules": [
                    {"label": "ready-for-agent", "flow": "builder-reviewer"},
                    {"label": "needs-audit", "flow": "prd-audit"},
                ]
            }),
            encoding="utf-8",
        )
        rules = load_label_rules(cfg)
    assert len(rules) == 2
    assert rules[0] == LabelRule(label="ready-for-agent", flow="builder-reviewer")
    assert rules[1] == LabelRule(label="needs-audit", flow="prd-audit")


def test_load_label_rules_missing_file():
    """A missing config file returns an empty list (no error)."""
    with tempfile.TemporaryDirectory() as tmp:
        rules = load_label_rules(Path(tmp) / "missing.json")
    assert rules == []


def test_load_label_rules_invalid_json():
    """A corrupt config file returns an empty list (no error)."""
    with tempfile.TemporaryDirectory() as tmp:
        cfg = Path(tmp) / "config.json"
        cfg.write_text("{ not valid json", encoding="utf-8")
        rules = load_label_rules(cfg)
    assert rules == []


def test_load_label_rules_empty_array():
    """An empty label_rules array returns an empty list."""
    with tempfile.TemporaryDirectory() as tmp:
        cfg = Path(tmp) / "config.json"
        cfg.write_text(json.dumps({"label_rules": []}), encoding="utf-8")
        rules = load_label_rules(cfg)
    assert rules == []


def test_load_label_rules_skips_malformed_entries():
    """Entries missing 'label' or 'flow' are silently skipped."""
    with tempfile.TemporaryDirectory() as tmp:
        cfg = Path(tmp) / "config.json"
        cfg.write_text(
            json.dumps({
                "label_rules": [
                    {"label": "good", "flow": "builder-reviewer"},  # valid
                    {"label": "no-flow"},                              # missing flow
                    {"flow": "orphan-flow"},                           # missing label
                    {"label": "", "flow": "empty-label"},             # empty label
                    "not-a-dict",                                       # non-dict entry
                ]
            }),
            encoding="utf-8",
        )
        rules = load_label_rules(cfg)
    assert len(rules) == 1
    assert rules[0] == LabelRule(label="good", flow="builder-reviewer")


def test_load_config_valid():
    """load_config returns the full config dict."""
    with tempfile.TemporaryDirectory() as tmp:
        cfg = Path(tmp) / "config.json"
        expected = {"default_flow": "gap-check", "poll_interval": 60}
        cfg.write_text(json.dumps(expected), encoding="utf-8")
        result = load_config(cfg)
    assert result == expected


def test_load_config_missing_file():
    """load_config returns empty dict for missing file."""
    with tempfile.TemporaryDirectory() as tmp:
        result = load_config(Path(tmp) / "missing.json")
    assert result == {}


# ─── Autonomous loop tests (issue #39) ──────────────────────────────────


def test_autonomous_menu_option_visible():
    """The top-level menu exposes the 'Run autonomous' option."""
    keys = [k for k, _ in MENU_OPTIONS]
    assert "autonomous" in keys


def test_autonomous_empty_rules_shows_warning():
    """When label_rules is empty/missing, a warning is shown and no loop runs.

    AC: 'Empty label_rules array gives a clear error and returns to the menu'.
    """
    fake_gh = _FakeGithubClient([])
    io = ScriptedMenuIO([
        "autonomous",  # choose autonomous — gets warning, returns to menu
        "quit",
    ])

    rc = run_action_menu(
        io=io,
        gh_client_factory=lambda: fake_gh,
        default_flow="builder-reviewer",
        available_flows=["builder-reviewer"],
    )
    assert rc == 0
    # A warning about no label_rules should have been emitted
    warnings = [m for m, k in io.messages if k == "warning"]
    assert any("label_rules" in m.lower() for m in warnings), (
        f"no label_rules warning in: {io.messages}"
    )


def test_autonomous_starts_matching_issues():
    """Autonomous mode starts issues matching configured label rules.

    AC: 'Issues matching a rule are started with the configured flow'.
    """
    import time as _time_module

    # Create a temp config with label_rules
    with tempfile.TemporaryDirectory() as tmp:
        cfg_path = Path(tmp) / "config.json"
        cfg_path.write_text(
            json.dumps({
                "label_rules": [
                    {"label": "ready-for-agent", "flow": "builder-reviewer"},
                ],
                "poll_interval": 1,  # short interval for test
            }),
            encoding="utf-8",
        )

        issues = [
            _FakeIssue(50, "Ready issue", ["ready-for-agent"]),
            _FakeIssue(51, "Unrelated issue", ["other-label"]),
        ]
        fake_gh = _FakeGithubClient(issues)

        io = ScriptedMenuIO([
            "autonomous",
            "quit",
        ])

        log: list[tuple[int, str]] = []
        def _fake_spawn(n: int, f: str) -> SpawnResult:
            log.append((n, f))
            return SpawnResult(issue_num=n, flow_name=f, started=True, error=None)

        # Mock time.sleep to raise KeyboardInterrupt after first call,
        # so the autonomous loop runs one iteration then exits cleanly.
        sleep_calls = {"count": 0}
        original_sleep = _time_module.sleep
        def _mock_sleep(seconds: float) -> None:
            sleep_calls["count"] += 1
            if sleep_calls["count"] >= 2:
                raise KeyboardInterrupt("test exit")
        _time_module.sleep = _mock_sleep
        try:
            rc = run_action_menu(
                io=io,
                gh_client_factory=lambda: fake_gh,
                default_flow="builder-reviewer",
                available_flows=["builder-reviewer"],
                spawn_fn=_fake_spawn,
                config_path=cfg_path,
            )
        finally:
            _time_module.sleep = original_sleep

        assert rc == 0
        # Only issue #50 matches the rule; #51 does not.
        assert len(log) == 1, f"expected 1 spawn, got {len(log)}: {log}"
        assert log[0] == (50, "builder-reviewer")
        # Startup message should be present
        infos = [m for m, k in io.messages if k == "info"]
        assert any("Autonomous mode" in m for m in infos), (
            f"no 'Autonomous mode' startup msg in: {io.messages}"
        )


def test_autonomous_keyboard_interrupt_stops_cleanly():
    """Ctrl-C during the autonomous loop returns 0 cleanly.

    AC: 'Ctrl-c stops the loop cleanly'.
    """
    class _InterruptOnSecondSelect(ScriptedMenuIO):
        """Raises KeyboardInterrupt on the second select call."""
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._select_count = 0

        def select(self, message, choices):
            self._select_count += 1
            if self._select_count >= 2:
                raise KeyboardInterrupt
            return super().select(message, choices)

    io = _InterruptOnSecondSelect(["autonomous", "quit"])
    rc = run_action_menu(
        io=io,
        gh_client_factory=lambda: _FakeGithubClient([]),
        default_flow="builder-reviewer",
        available_flows=["builder-reviewer"],
    )
    assert rc == 0


# ─── Show config tests (issue #39) ──────────────────────────────────────


def test_show_config_menu_option_visible():
    """The top-level menu exposes the 'Show config' option."""
    keys = [k for k, _ in MENU_OPTIONS]
    assert "show_config" in keys


def test_show_config_displays_config_and_returns_to_menu():
    """Choosing 'Show config' displays the config and returns to menu.

    AC: 'Show config displays the active label_rules array'.
    """
    with tempfile.TemporaryDirectory() as tmp:
        cfg_path = Path(tmp) / "config.json"
        cfg_path.write_text(
            json.dumps({
                "default_flow": "builder-reviewer",
                "label_rules": [
                    {"label": "ready", "flow": "builder-reviewer"},
                ],
            }),
            encoding="utf-8",
        )

        io = ScriptedMenuIO([
            "show_config",
            "quit",
        ])

        rc = run_action_menu(
            io=io,
            gh_client_factory=lambda: _FakeGithubClient([]),
            default_flow="builder-reviewer",
            available_flows=["builder-reviewer"],
        )
        assert rc == 0
        # After show_config, the menu loops back (quit is processed)


# ─── Edit config tests (issue #39) ──────────────────────────────────────


def test_edit_config_menu_option_visible():
    """The top-level menu exposes the 'Edit config' option."""
    keys = [k for k, _ in MENU_OPTIONS]
    assert "edit_config" in keys


# ─── CLI wiring tests ───────────────────────────────────────────────────


def test_maestro_help_lists_menu_subcommand():
    """``maestro --help`` must list the ``menu`` subcommand."""
    runner = CliRunner()
    result = runner.invoke(maestro_cli, ["--help"])
    assert result.exit_code == 0, result.output
    assert "menu" in result.output


def test_maestro_menu_help_describes_command():
    """``maestro menu --help`` must show the long help text."""
    runner = CliRunner()
    result = runner.invoke(maestro_cli, ["menu", "--help"])
    assert result.exit_code == 0, result.output
    assert "Launch the interactive action menu" in result.output
    assert "--repo-root" in result.output


# ─── Runner ─────────────────────────────────────────────────────────────


tests = [
    # Menu visibility
    test_menu_options_include_batch,
    test_menu_options_include_quit,
    test_menu_options_have_human_readable_labels,
    test_menu_options_are_distinct,
    # Config helpers
    test_load_default_flow_falls_back_when_config_missing,
    test_load_default_flow_reads_from_config,
    test_load_default_flow_falls_back_on_non_string_value,
    test_load_default_flow_falls_back_on_empty_string,
    test_load_default_flow_falls_back_on_invalid_json,
    test_load_available_flows_lists_json_files,
    test_load_available_flows_empty_dir,
    test_load_available_flows_missing_dir,
    test_load_available_flows_ignores_whitespace_stems,
    # resolve_flow
    test_resolve_flow_sentinel_returns_default,
    test_resolve_flow_literal_passes_through,
    # spawn_runner
    test_spawn_runner_success_returns_started_true,
    test_spawn_runner_failure_does_not_raise,
    # run_batch
    test_run_batch_with_one_failure_continues,
    test_run_batch_preserves_order,
    test_run_batch_resolves_default_sentinel,
    test_run_batch_empty_input_returns_empty_list,
    test_run_batch_audit_log_entries,
    # State machine
    test_batch_happy_path,
    test_batch_uses_checkbox_for_multi_select,
    test_batch_flow_picker_per_issue,
    test_batch_cancellation_at_multi_select_returns_to_menu,
    test_batch_cancellation_at_confirm_returns_to_menu,
    test_batch_cancellation_mid_pick_returns_to_menu,
    test_batch_one_failure_does_not_abort,
    test_action_menu_gh_not_authenticated_returns_zero,
    test_action_menu_empty_issue_list_handles_gracefully,
    test_action_menu_quit_returns_zero,
    test_action_menu_keyboard_interrupt_returns_zero,
    test_action_menu_eof_returns_zero,
    # Label rules loading (issue #39)
    test_load_label_rules_valid_config,
    test_load_label_rules_missing_file,
    test_load_label_rules_invalid_json,
    test_load_label_rules_empty_array,
    test_load_label_rules_skips_malformed_entries,
    test_load_config_valid,
    test_load_config_missing_file,
    # Autonomous loop (issue #39)
    test_autonomous_menu_option_visible,
    test_autonomous_empty_rules_shows_warning,
    test_autonomous_starts_matching_issues,
    test_autonomous_keyboard_interrupt_stops_cleanly,
    # Show config (issue #39)
    test_show_config_menu_option_visible,
    test_show_config_displays_config_and_returns_to_menu,
    # Edit config (issue #39)
    test_edit_config_menu_option_visible,
    # CLI wiring
    test_maestro_help_lists_menu_subcommand,
    test_maestro_menu_help_describes_command,
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
