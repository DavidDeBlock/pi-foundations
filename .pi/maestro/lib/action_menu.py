#!/usr/bin/env python3
"""
action_menu.py — Pure logic for the ``maestro`` interactive action menu.

The action menu is the operator's primary way to start flows from
the terminal. It presents a top-level menu, dispatches to "Start
single issue" / "Start batch" / "Quit", and shells out to the
existing runner when the operator confirms.

The module is split into three layers:

  1. **State machine** (:func:`run_action_menu`) — top-level loop
     that reads operator choices and walks the menu. Pure: takes
     a :class:`MenuIO` (the I/O adapter) and returns ``0`` /
     ``1`` / ``2`` for ``quit`` / ``success`` / ``error``. The
     state machine never imports InquirerPy or calls subprocess
     directly — both go through the IO / spawn layers.

  2. **Spawn layer** (:func:`spawn_runner`, :func:`run_batch`) —
     turns a :class:`BatchSpec` into a running subprocess. The
     spawn function is the only place that touches ``subprocess``
     or :mod:`audit_log`, which keeps the failure modes
     (``OSError``, ``FileNotFoundError``) localised.

  3. **Config helpers** (:func:`load_default_flow`,
     :func:`load_available_flows`, :func:`resolve_flow`) — read
     the maestro config and the ``flows/`` directory, and apply
     the ``"use default"`` sentinel in a :class:`BatchSpec`.

Testability:

  The :class:`MenuIO` protocol is the seam between the state
  machine and the operator's keyboard. In production the
  :class:`InquirerPyMenuIO` adapter wraps the real
  :mod:`InquirerPy` prompts (arrow-key navigation, multi-select
  with space-to-toggle, etc.). In tests the
  :class:`ScriptedMenuIO` adapter returns a scripted sequence of
  answers, so the state machine can be driven end-to-end with no
  TTY and no interactive prompts.

Public surface:

  - :class:`BatchSpec`, :class:`SpawnResult` — value objects for
    spec-in / result-out.
  - :class:`MenuIO` — protocol for the I/O adapter.
  - :class:`InquirerPyMenuIO`, :class:`ScriptedMenuIO` — concrete
    adapters (the InquirerPy one is the production implementation;
    the scripted one is the test seam).
  - :func:`run_action_menu` — the top-level state machine.
  - :func:`spawn_runner`, :func:`run_batch` — the spawn layer.
  - :func:`load_default_flow`, :func:`load_available_flows`,
    :func:`resolve_flow` — the config helpers.

Non-goals:

  - Autonomous mode (label-driven polling) — separate slice (#39).
  - Filter issues by label — separate slice (#41).
  - Launch the monitor from the menu — separate slice (#42).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Optional, Protocol, runtime_checkable

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from audit_log import record_start as _audit_record_start
from github_client import check_gh_authenticated, GithubClient


# ─── Constants ───────────────────────────────────────────────────────────

#: Hard-coded fallback for the default flow. Used when
#: ``.maestro/config.json`` has no ``default_flow`` key, or the
#: config file is missing. Pinned here (not derived) so the value
#: is stable across runs and easy to find.
DEFAULT_FLOW_FALLBACK: str = "builder-reviewer"

#: Sentinel value for a :class:`BatchSpec` whose ``flow_name``
#: field is the "use default" choice. Resolved by
#: :func:`resolve_flow` into the configured default flow.
DEFAULT_FLOW_SENTINEL: str = "<default>"

#: Path to the ``flows/`` directory containing flow JSON files.
#: Resolved relative to the maestro package root. The default
#: assumes the package layout used in this repo; tests pass a
#: custom directory.
DEFAULT_FLOWS_DIR: Path = Path(__file__).resolve().parent.parent / "flows"

#: Top-level menu options. Each entry is ``(key, label)``; the
#: order is the order shown to the operator. The keys are
#: stable identifiers used by the state machine and tests.
MENU_OPTIONS: list[tuple[str, str]] = [
    ("single", "Start single issue"),
    ("batch", "Start batch"),
    ("quit", "Quit"),
]


# ─── Value objects ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class BatchSpec:
    """A single (issue, flow) pair to be spawned.

    The :attr:`flow_name` is either a real flow name (e.g.
    ``"builder-reviewer"``) or the :data:`DEFAULT_FLOW_SENTINEL`
    sentinel. :func:`resolve_flow` turns the sentinel into the
    configured default at spawn time so the audit log records the
    *actual* flow that ran, not the sentinel.

    The dataclass is frozen so a :class:`BatchSpec` is safe to
    share between threads (the spawn layer is single-threaded
    today, but a future slice might run spawns in parallel).
    """

    issue_num: int
    issue_title: str
    flow_name: str


@dataclass(frozen=True)
class SpawnResult:
    """The outcome of a single :func:`spawn_runner` call.

    Fields:

      - ``issue_num``: The issue that was (attempted to be) started.
      - ``flow_name``: The flow that was attempted. Already
        resolved (no sentinel) — the audit log and the summary
        show the actual flow name.
      - ``started``: ``True`` iff the subprocess was launched
        successfully (``Popen`` returned without raising). A
        ``True`` does NOT mean the flow completed — the runner
        runs in the background and may fail later; the action
        menu does not wait for completion.
      - ``error``: A short human-readable error string when
        ``started`` is ``False``. ``None`` on success. Used in
        the batch summary.
    """

    issue_num: int
    flow_name: str
    started: bool
    error: Optional[str] = None


# ─── I/O adapter protocol ───────────────────────────────────────────────


@runtime_checkable
class MenuIO(Protocol):
    """The seam between the state machine and the operator's keyboard.

    The state machine (:func:`run_action_menu`) only talks to
    this protocol. Production wires :class:`InquirerPyMenuIO`
    (real InquirerPy prompts); tests wire :class:`ScriptedMenuIO`
    (predetermined answer sequence). Adding a new prompt type
    means adding a method here and an implementation in each
    concrete adapter.

    Method contracts:

      - :meth:`select` — show a single-choice list, return the
        chosen key (``str``). The choices are ``(key, label)``
        tuples; the operator sees the labels but the state
        machine sees the keys.
      - :meth:`checkbox` — show a multi-choice list with
        space-to-toggle / enter-to-confirm, return the chosen
        keys (``list[str]``). An empty list means "no
        selection" (which the state machine treats as
        "cancel and return to menu" per the AC).
      - :meth:`flow_picker` — show a list of flows plus the
        "use default" option, return the chosen flow name
        (``str``). The "use default" sentinel is returned as
        :data:`DEFAULT_FLOW_SENTINEL`; the state machine
        resolves it via :func:`resolve_flow` at spawn time.
      - :meth:`confirm` — ask a yes/no question, return ``True``
        or ``False``. The state machine uses this for the
        single-issue and batch confirmation screens.
      - :meth:`notify` — surface a short message to the
        operator (success / error / hint). Implementation can
        use ``rich`` styling, a plain ``print``, or both.

    Cancellation:

      A :class:`KeyboardInterrupt` (operator pressed ``Ctrl-C``)
      is propagated by all methods. The state machine catches
      it once at the top of the loop and returns ``0`` cleanly
      so the operator does not see a stack trace.

      An :class:`EOFError` (stdin closed) is also propagated
      and treated the same way.
    """

    def select(self, message: str, choices: list[tuple[str, str]]) -> str:
        ...

    def checkbox(self, message: str, choices: list[tuple[str, str]]) -> list[str]:
        ...

    def flow_picker(
        self,
        message: str,
        choices: list[str],
        *,
        default_flow: str,
    ) -> str:
        ...

    def confirm(self, message: str, *, default: bool = True) -> bool:
        ...

    def notify(self, message: str, *, kind: str = "info") -> None:
        ...


# ─── Scripted adapter (test seam) ───────────────────────────────────────


@dataclass
class ScriptedMenuIO:
    """A :class:`MenuIO` that returns predetermined answers.

    The constructor takes a single iterable of answers. Each
    :meth:`select` / :meth:`checkbox` / :meth:`flow_picker` /
    :meth:`confirm` call pops the next answer from the queue
    and returns it. ``notify`` calls are recorded (but do not
    consume an answer) so tests can assert on what was shown.

    A ``RuntimeError`` is raised if the queue is exhausted —
    this surfaces "the test asked for more prompts than the
    state machine actually issued" as a test failure with a
    clear message, not a silent ``StopIteration`` from deep
    inside the menu loop.

    The :attr:`messages` list captures every :meth:`notify` call
    as a tuple ``(message, kind)`` for assertion in tests.

    Example::

        io = ScriptedMenuIO([
            "batch",                  # top-level menu
            ["42", "43"],             # multi-select
            "<default>",              # flow for #42
            "builder-reviewer-simple",  # flow for #43
            True,                     # confirm batch
        ])
        run_action_menu(io=io, repo_root=tmp)
        assert any("started" in m for m, _ in io.messages)
    """

    answers: list[Any] = field(default_factory=list)
    messages: list[tuple[str, str]] = field(default_factory=list)

    def _next(self, expected: str) -> Any:
        if not self.answers:
            raise RuntimeError(
                f"ScriptedMenuIO exhausted: expected {expected} but no "
                f"answers remain. Add more entries to the answers list."
            )
        return self.answers.pop(0)

    def select(self, message: str, choices: list[tuple[str, str]]) -> str:
        return self._next("select")

    def checkbox(self, message: str, choices: list[tuple[str, str]]) -> list[str]:
        return list(self._next("checkbox"))

    def flow_picker(
        self,
        message: str,
        choices: list[str],
        *,
        default_flow: str,
    ) -> str:
        return self._next("flow_picker")

    def confirm(self, message: str, *, default: bool = True) -> bool:
        return bool(self._next("confirm"))

    def notify(self, message: str, *, kind: str = "info") -> None:
        self.messages.append((message, kind))


# ─── Production adapter (InquirerPy) ────────────────────────────────────


class InquirerPyMenuIO:
    """The production :class:`MenuIO` implementation.

    Wraps :mod:`InquirerPy` for ``select`` / ``checkbox`` /
    ``confirm`` prompts, and uses :class:`rich.console.Console`
    for the flow picker (which needs custom rendering to show the
    "use default → <flow>" hint) and for ``notify``.

    The class is intentionally cheap to construct — the
    underlying :class:`rich.console.Console` is created lazily so
    a test that imports the module but never instantiates the
    adapter does not open a terminal handle.
    """

    def __init__(self, console: Optional[Console] = None) -> None:
        self._console = console or Console()

    def select(self, message: str, choices: list[tuple[str, str]]) -> str:
        # Import lazily so tests that only use ``ScriptedMenuIO``
        # do not pay the InquirerPy import cost.
        from InquirerPy import inquirer
        # InquirerPy expects ``{name: ..., value: ...}`` dicts OR
        # a flat list. We pass dicts so the display label is the
        # human-readable text and the value is the stable key.
        result = inquirer.select(
            message=message,
            choices=[
                {"name": label, "value": key} for key, label in choices
            ],
        ).execute()
        return str(result)

    def checkbox(self, message: str, choices: list[tuple[str, str]]) -> list[str]:
        from InquirerPy import inquirer
        result = inquirer.checkbox(
            message=message,
            choices=[
                {"name": label, "value": key} for key, label in choices
            ],
            # ``mandatory=False`` lets the operator press enter
            # with nothing selected (= "cancel and return to
            # menu" per the AC). The state machine treats an
            # empty result the same as a Ctrl-C.
            mandatory=False,
            validate=lambda result: True,  # any selection OK, incl. empty
        ).execute()
        return list(result or [])

    def flow_picker(
        self,
        message: str,
        choices: list[str],
        *,
        default_flow: str,
    ) -> str:
        from InquirerPy import inquirer
        # Show the default as the first option so the operator
        # can pick it with one keystroke. InquirerPy's
        # ``inquirer.select`` does not natively support a
        # separator, so we bake the default into the first
        # choice's display name. The returned value is the raw
        # flow name (or the sentinel).
        ordered_choices = [DEFAULT_FLOW_SENTINEL] + [
            f for f in choices if f != DEFAULT_FLOW_SENTINEL
        ]
        result = inquirer.select(
            message=message,
            choices=[
                {
                    "name": (
                        f"Use default ({default_flow})"
                        if c == DEFAULT_FLOW_SENTINEL
                        else c
                    ),
                    "value": c,
                }
                for c in ordered_choices
            ],
        ).execute()
        return str(result)

    def confirm(self, message: str, *, default: bool = True) -> bool:
        from InquirerPy import inquirer
        return bool(inquirer.confirm(message=message, default=default).execute())

    def notify(self, message: str, *, kind: str = "info") -> None:
        style = {
            "info": "",
            "success": "[green]",
            "error": "[bold red]",
            "warning": "[yellow]",
        }.get(kind, "")
        end = "[/]" if style else ""
        self._console.print(f"{style}{message}{end}")


# ─── Config helpers ─────────────────────────────────────────────────────


def load_default_flow(config_path: Optional[Path] = None) -> str:
    """Read the default flow from ``.maestro/config.json``.

    Looks for a top-level ``default_flow`` key. Falls back to
    :data:`DEFAULT_FLOW_FALLBACK` if the key is missing, the file
    is missing, the file is not valid JSON, or the value is not
    a non-empty string.

    Args:
        config_path: Path to ``config.json``. ``None`` uses
            ``.pi/maestro/config.json`` (resolved relative to
            the maestro package root). Tests pass a custom
            path.

    Returns:
        The configured default flow, or
        :data:`DEFAULT_FLOW_FALLBACK` if no default is set.
    """
    if config_path is None:
        config_path = Path(__file__).resolve().parent.parent / "config.json"
    if not config_path.exists():
        return DEFAULT_FLOW_FALLBACK
    try:
        with open(config_path) as f:
            cfg = json.load(f)
    except (OSError, json.JSONDecodeError):
        return DEFAULT_FLOW_FALLBACK
    val = cfg.get("default_flow") if isinstance(cfg, dict) else None
    if isinstance(val, str) and val.strip():
        return val.strip()
    return DEFAULT_FLOW_FALLBACK


def load_available_flows(flows_dir: Optional[Path] = None) -> list[str]:
    """List the flow names available in the ``flows/`` directory.

    A flow is any ``*.json`` file whose stem is a valid flow
    identifier (non-empty, no whitespace). The function does not
    validate the JSON contents — that is the runner's job at
    load time. The action menu only needs the names to populate
    the flow picker; the actual flow is loaded by
    :func:`flow_engine.load_flow` at spawn time.

    Args:
        flows_dir: Path to the ``flows/`` directory. ``None``
            uses :data:`DEFAULT_FLOWS_DIR`.

    Returns:
        Sorted list of flow names (e.g.
        ``["builder-reviewer", "builder-reviewer-simple", ...]``).
        Empty list if the directory does not exist.
    """
    target = (flows_dir or DEFAULT_FLOWS_DIR).resolve()
    if not target.exists() or not target.is_dir():
        return []
    names: list[str] = []
    for entry in sorted(target.glob("*.json")):
        stem = entry.stem
        if stem and not stem.isspace():
            names.append(stem)
    return names


def resolve_flow(spec: BatchSpec, default_flow: str) -> str:
    """Resolve the :attr:`BatchSpec.flow_name` to a real flow name.

    If ``spec.flow_name`` is the :data:`DEFAULT_FLOW_SENTINEL`,
    returns ``default_flow``. Otherwise returns
    ``spec.flow_name`` unchanged.

    This is the one place the sentinel is interpreted, so the
    audit log always records the actual flow that ran.
    """
    if spec.flow_name == DEFAULT_FLOW_SENTINEL:
        return default_flow
    return spec.flow_name


# ─── Spawn layer ────────────────────────────────────────────────────────


def spawn_runner(
    issue_num: int,
    flow_name: str,
    *,
    repo_root: Optional[Path] = None,
    audit_log_path: Optional[Path] = None,
) -> SpawnResult:
    """Spawn the existing runner for one issue.

    The runner is launched as a detached subprocess via
    :func:`subprocess.Popen`. The action menu does not wait for
    the flow to complete — it returns as soon as the process is
    launched, and the runner runs in the background until it
    finishes (or hits its own timeout). The
    ``maestro monitor`` command is the tool for watching the
    background run.

    The function is intentionally non-raising. Any failure to
    spawn (orchestrate.py missing, Python missing, OS error) is
    returned as a :class:`SpawnResult` with ``started=False``
    and a human-readable ``error``. The action menu surfaces
    these in the batch summary so one failure does not abort the
    rest of the batch.

    On a successful spawn, the audit log is written before the
    function returns. An audit-log write failure does NOT mark
    the spawn as failed — the spawn is the critical step; the
    audit log is a best-effort record. The error is reported
    via the console (stderr) and the :class:`SpawnResult` still
    reports ``started=True``.

    Args:
        issue_num: The issue to start.
        flow_name: The flow to run. Must already be resolved
            (no sentinel).
        repo_root: Where the subprocess runs. ``None`` uses the
            current working directory. Tests pass a temp dir.
        audit_log_path: Where to write the audit log entry.
            ``None`` uses the default. Tests pass a temp path.

    Returns:
        A :class:`SpawnResult`. ``started`` is ``True`` iff the
        subprocess was launched without error.
    """
    cwd = str(repo_root) if repo_root is not None else os.getcwd()
    maestro_dir = Path(__file__).resolve().parent.parent
    orchestrate = maestro_dir / "orchestrate.py"

    cmd = [
        sys.executable,
        str(orchestrate),
        "--flow", flow_name,
        "--issue", str(int(issue_num)),
    ]

    try:
        # ``Popen`` returns once the child is forked. We do NOT
        # wait — the action menu returns immediately so the
        # operator can keep using it (or quit). stdout / stderr
        # are redirected to DEVNULL so a misbehaving runner does
        # not pollute the action menu's terminal output. The
        # runner writes its own structured log to
        # ``.maestro/logs/`` — the action menu's terminal is
        # not its log destination.
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            # Detach into its own process group so the action
            # menu can quit without taking the runner down.
            start_new_session=True,
        )
    except FileNotFoundError as e:
        return SpawnResult(
            issue_num=issue_num,
            flow_name=flow_name,
            started=False,
            error=f"orchestrate.py not found: {e}",
        )
    except OSError as e:
        return SpawnResult(
            issue_num=issue_num,
            flow_name=flow_name,
            started=False,
            error=f"spawn failed: {e}",
        )

    # Audit log is best-effort. A failure here does not undo the
    # successful spawn.
    try:
        _audit_record_start(issue_num, flow_name, log_path=audit_log_path)
    except OSError as e:
        print(
            f"[maestro] WARNING: could not write audit log: {e}",
            file=sys.stderr,
        )

    return SpawnResult(
        issue_num=issue_num,
        flow_name=flow_name,
        started=True,
        error=None,
    )


def run_batch(
    specs: Iterable[BatchSpec],
    *,
    default_flow: str,
    spawn_fn: Optional[Callable[[int, str], SpawnResult]] = None,
    repo_root: Optional[Path] = None,
    audit_log_path: Optional[Path] = None,
) -> list[SpawnResult]:
    """Spawn a batch of flows, one :class:`BatchSpec` at a time.

    Iterates the specs in order. For each spec, resolves the
    flow name (turning the :data:`DEFAULT_FLOW_SENTINEL` into the
    configured default) and calls ``spawn_fn`` (default
    :func:`spawn_runner`). One failure does NOT abort the batch
    — the loop continues with the next spec and the failed
    spawn is recorded in the returned list as
    ``SpawnResult(started=False, error=...)``.

    The ``spawn_fn`` parameter exists for tests: the test
    substitutes a fake that returns predetermined
    :class:`SpawnResult` values, so the batch loop can be
    exercised without forking a real subprocess. The default
    spawner is :func:`spawn_runner`.

    Args:
        specs: The batch to run, in spawn order.
        default_flow: The flow to use when a spec has the
            :data:`DEFAULT_FLOW_SENTINEL`.
        spawn_fn: Optional callable ``(issue_num, flow_name) ->
            SpawnResult``. ``None`` uses :func:`spawn_runner`.
        repo_root: Forwarded to :func:`spawn_runner`. Ignored
            when ``spawn_fn`` is provided.
        audit_log_path: Forwarded to :func:`spawn_runner`.
            Ignored when ``spawn_fn`` is provided.

    Returns:
        A list of :class:`SpawnResult`, one per spec, in the
        same order. Each ``started`` flag is independent — a
        single failure does not affect the others.
    """
    results: list[SpawnResult] = []
    spawn = spawn_fn or (
        lambda n, f: spawn_runner(
            n, f, repo_root=repo_root, audit_log_path=audit_log_path
        )
    )
    for spec in specs:
        flow = resolve_flow(spec, default_flow)
        results.append(spawn(spec.issue_num, flow))
    return results


# ─── Single-issue flow (used by "Start single issue") ───────────────────


def run_single(
    spec: BatchSpec,
    *,
    default_flow: str,
    spawn_fn: Optional[Callable[[int, str], SpawnResult]] = None,
    repo_root: Optional[Path] = None,
    audit_log_path: Optional[Path] = None,
) -> SpawnResult:
    """Spawn a single issue — a 1-element batch.

    Provided as a convenience wrapper so the state machine can
    call a single function for the single-issue path. Behaviour
    is identical to ``run_batch([spec])[0]``; the wrapper
    exists so the call site reads as a one-issue operation.

    Args:
        spec: The (issue, flow) pair to run.
        default_flow: The flow to use when ``spec.flow_name`` is
            the :data:`DEFAULT_FLOW_SENTINEL`.
        spawn_fn: Optional fake spawner for tests.
        repo_root: Forwarded to :func:`spawn_runner`.
        audit_log_path: Forwarded to :func:`spawn_runner`.

    Returns:
        The :class:`SpawnResult` for the single spawn.
    """
    return run_batch(
        [spec],
        default_flow=default_flow,
        spawn_fn=spawn_fn,
        repo_root=repo_root,
        audit_log_path=audit_log_path,
    )[0]


# ─── Top-level state machine ────────────────────────────────────────────


def _format_batch_summary(results: list[SpawnResult]) -> str:
    """Format a one-line summary of a batch's spawn results.

    Used by the state machine after a batch confirm. The format
    is intentionally stable: ``"Batch complete: 3 started, 1
    failed to start."`` — operators and ops scripts can grep
    this line out of the action menu's stdout.
    """
    started = sum(1 for r in results if r.started)
    failed = len(results) - started
    if failed == 0:
        return f"Batch complete: {started} started, 0 failed to start."
    return f"Batch complete: {started} started, {failed} failed to start."


def _render_batch_table(specs: list[BatchSpec], default_flow: str) -> Table:
    """Build a :class:`rich.table.Table` for the batch confirm screen.

    The table has three columns: ``#``, ``Title``, ``Flow``. The
    Flow column shows the resolved flow name (the sentinel is
    replaced with the configured default so the operator sees
    what will actually run).
    """
    table = Table(title="Confirm batch", show_lines=False, header_style="bold")
    table.add_column("#", justify="right", style="cyan", no_wrap=True)
    table.add_column("Title", style="white")
    table.add_column("Flow", style="green", no_wrap=True)
    for spec in specs:
        flow_display = resolve_flow(spec, default_flow)
        marker = " ← default" if spec.flow_name == DEFAULT_FLOW_SENTINEL else ""
        table.add_row(
            f"#{spec.issue_num}",
            spec.issue_title,
            f"{flow_display}{marker}",
        )
    return table


def run_action_menu(
    *,
    io: MenuIO,
    repo_root: Optional[Path] = None,
    gh_client_factory: Optional[Callable[[], GithubClient]] = None,
    default_flow: Optional[str] = None,
    available_flows: Optional[list[str]] = None,
    spawn_fn: Optional[Callable[[int, str], SpawnResult]] = None,
    console: Optional[Console] = None,
) -> int:
    """Run the top-level action menu loop.

    The state machine:

      1. Show the top-level menu.
      2. Dispatch to "Start single issue" / "Start batch" /
         "Quit".
      3. After a single or batch operation, return to step 1.
      4. On ``Quit`` (or :class:`KeyboardInterrupt` /
         :class:`EOFError`), return ``0``.

    The function takes a :class:`MenuIO` (the I/O seam) and a
    handful of optional dependencies so tests can drive the
    state machine with no real I/O. In production the defaults
    are sensible (``InquirerPyMenuIO``, ``GithubClient()``).

    Args:
        io: The :class:`MenuIO` adapter. Production wires
            :class:`InquirerPyMenuIO`; tests wire
            :class:`ScriptedMenuIO`.
        repo_root: Where spawned runners should run. ``None``
            uses the cwd. Tests pass a temp dir.
        gh_client_factory: Optional callable that returns a
            :class:`GithubClient`. ``None`` uses
            ``GithubClient()``. Tests pass a fake.
        default_flow: The default flow name. ``None`` reads it
            from config via :func:`load_default_flow`. Tests
            pass a literal.
        available_flows: The list of available flow names.
            ``None`` reads it from the ``flows/`` directory via
            :func:`load_available_flows`. Tests pass a literal.

    Returns:
        ``0`` on a clean exit (operator chose Quit, or pressed
        Ctrl-C). The state machine does not return a non-zero
        code today — error conditions (e.g. ``gh`` not
        authenticated) are surfaced via :meth:`MenuIO.notify`
        and the operator stays in the menu.

    Notes:
        The state machine is robust to all the cancellation
        paths:

          - Ctrl-C at any prompt → caught, menu exits cleanly.
          - EOFError (stdin closed) → caught, menu exits cleanly.
          - Empty checkbox selection → treated as "cancel" and
            returns to the menu.
          - "No" on the confirmation screen → returns to the
            menu without spawning.
    """
    console = console or Console()

    # Resolve config / env once. Doing it lazily inside the
    # loop would re-read the config on every iteration; doing
    # it here is one read per menu invocation, which is the
    # right balance.
    if default_flow is None:
        default_flow = load_default_flow()
    if available_flows is None:
        available_flows = load_available_flows()

    if gh_client_factory is None:
        gh_client_factory = GithubClient

    # Hard gate: if ``gh`` is not authenticated, the action
    # menu cannot fetch issues. We check this once at startup
    # and return a clear error (per the AC: "If ``gh`` is not
    # authenticated, the tool shows a clear error message and
    # returns to the menu"). The function is module-level so
    # the test can mock it.
    if not check_gh_authenticated():
        console.print(
            Panel(
                "[bold red]gh is not authenticated.[/bold red]\n\n"
                "Run `gh auth login` to authenticate, then re-run `maestro`.",
                border_style="red",
                title="error",
            )
        )
        return 0

    try:
        while True:
            # ── Top-level menu ──────────────────────────────────
            choice = io.select(
                "What do you want to do?",
                list(MENU_OPTIONS),
            )

            if choice == "quit":
                io.notify("Goodbye.", kind="info")
                return 0
            elif choice == "single":
                _run_single_flow(
                    io=io,
                    gh_client_factory=gh_client_factory,
                    default_flow=default_flow,
                    available_flows=available_flows,
                    repo_root=repo_root,
                    spawn_fn=spawn_fn,
                )
            elif choice == "batch":
                _run_batch_flow(
                    io=io,
                    gh_client_factory=gh_client_factory,
                    default_flow=default_flow,
                    available_flows=available_flows,
                    repo_root=repo_root,
                    spawn_fn=spawn_fn,
                )
            # Unknown keys are silently ignored — the operator
            # can correct on the next iteration. We do not log
            # them because InquirerPy's select prompt already
            # constrains the choice to the provided list.
    except (KeyboardInterrupt, EOFError):
        io.notify("\nInterrupted. Goodbye.", kind="info")
        return 0


def _run_single_flow(
    *,
    io: MenuIO,
    gh_client_factory: Callable[[], GithubClient],
    default_flow: str,
    available_flows: list[str],
    repo_root: Optional[Path],
    spawn_fn: Optional[Callable[[int, str], SpawnResult]] = None,
) -> None:
    """Handle the "Start single issue" sub-flow.

    The flow is: pick one issue from the list → pick a flow (or
    "use default") → confirm → spawn → audit → return to menu.

    Any of the steps may be cancelled (empty selection, "No"
    on confirm, Ctrl-C): the function returns to the menu
    without spawning.
    """
    try:
        gh = gh_client_factory()
        issues = gh.fetch_issues_by_label("needs-triage")
    except Exception as e:  # noqa: BLE001
        io.notify(f"Failed to fetch issues: {e}", kind="error")
        return

    if not issues:
        io.notify(
            "No open issues with the 'needs-triage' label. Nothing to start.",
            kind="info",
        )
        return

    # The issue picker shows ``#N — title (labels)`` and returns
    # the issue number. The display label includes the issue's
    # labels so the operator can spot the right one at a glance.
    issue_choices = [
        (
            str(issue.number),
            f"#{issue.number} — {issue.title}  [dim]({', '.join(issue.labels) or 'no labels'})[/dim]",
        )
        for issue in issues
    ]
    picked = io.select("Pick an issue:", issue_choices)
    if not picked:
        return
    issue_num = int(picked)
    # Resolve back to the Issue object for the title.
    issue = next(i for i in issues if i.number == issue_num)

    flow = io.flow_picker(
        "Pick a flow:",
        available_flows,
        default_flow=default_flow,
    )
    if not flow:
        return

    spec = BatchSpec(
        issue_num=issue.number,
        issue_title=issue.title,
        flow_name=flow,
    )
    resolved = resolve_flow(spec, default_flow)
    ok = io.confirm(
        f"Start flow '{resolved}' on issue #{issue.number}?",
        default=True,
    )
    if not ok:
        return

    result = run_single(
        spec,
        default_flow=default_flow,
        spawn_fn=spawn_fn,
        repo_root=repo_root,
    )
    if result.started:
        io.notify(
            f"Started flow '{result.flow_name}' on issue #{result.issue_num}.",
            kind="success",
        )
    else:
        io.notify(
            f"Failed to start: {result.error}",
            kind="error",
        )


def _run_batch_flow(
    *,
    io: MenuIO,
    gh_client_factory: Callable[[], GithubClient],
    default_flow: str,
    available_flows: list[str],
    repo_root: Optional[Path],
    spawn_fn: Optional[Callable[[int, str], SpawnResult]] = None,
) -> None:
    """Handle the "Start batch" sub-flow.

    The flow is: multi-select issues → per-issue flow picker
    (each can be "use default") → confirm a table of all
    selected → spawn all → audit each → summary.

    Cancellation at any step (empty selection, "No" on confirm,
    Ctrl-C) returns to the menu without spawning.
    """
    try:
        gh = gh_client_factory()
        issues = gh.fetch_issues_by_label("needs-triage")
    except Exception as e:  # noqa: BLE001
        io.notify(f"Failed to fetch issues: {e}", kind="error")
        return

    if not issues:
        io.notify(
            "No open issues with the 'needs-triage' label. Nothing to start.",
            kind="info",
        )
        return

    issue_choices = [
        (
            str(issue.number),
            f"#{issue.number} — {issue.title}  [dim]({', '.join(issue.labels) or 'no labels'})[/dim]",
        )
        for issue in issues
    ]
    picked = io.checkbox(
        "Pick issues to start (space to toggle, enter to confirm):",
        issue_choices,
    )
    if not picked:
        io.notify("No issues selected. Returning to menu.", kind="info")
        return

    picked_set = {int(x) for x in picked}
    specs: list[BatchSpec] = []
    for issue in issues:
        if issue.number not in picked_set:
            continue
        flow = io.flow_picker(
            f"Flow for #{issue.number} — {issue.title}:",
            available_flows,
            default_flow=default_flow,
        )
        if not flow:
            # Operator cancelled mid-batch. Bail out of the
            # whole sub-flow (not just skip this issue) so they
            # can re-think the batch as a unit.
            io.notify("Batch cancelled mid-pick. Returning to menu.", kind="info")
            return
        specs.append(BatchSpec(
            issue_num=issue.number,
            issue_title=issue.title,
            flow_name=flow,
        ))

    # Confirmation screen: show a table of all selected
    # (issue #, title, flow) BEFORE any spawn. The AC
    # explicitly requires this so the operator can sanity-check
    # the batch.
    table = _render_batch_table(specs, default_flow)
    console = Console()
    console.print(table)
    ok = io.confirm(
        f"Start {len(specs)} flow(s)?",
        default=True,
    )
    if not ok:
        io.notify("Batch cancelled at confirmation. Returning to menu.", kind="info")
        return

    # Spawn each. The batch runner handles per-spawn failure
    # isolation; we just print the summary.
    results = run_batch(
        specs,
        default_flow=default_flow,
        spawn_fn=spawn_fn,
        repo_root=repo_root,
    )
    summary = _format_batch_summary(results)
    # Emit the summary through the IO adapter (so scripted
    # tests can assert on it via ``io.messages``) AND print
    # it to the console (so the operator sees styled output).
    # The IO message is the plain text; the console print adds
    # styling.
    io.notify(summary, kind=("success" if all(r.started for r in results) else "warning"))
    console.print(f"\n[bold]{summary}[/bold]")
    # Surface per-issue failures so the operator can fix them
    # (e.g. an orchestrate.py bug is a real issue, not a
    # transient flake).
    for r in results:
        if not r.started:
            err = f"  #{r.issue_num} ({r.flow_name}): {r.error}"
            console.print(f"  [red]✗[/red]{err}")
            io.notify(err, kind="error")
