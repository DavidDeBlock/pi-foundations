#!/usr/bin/env python3
"""
monitor.py — CLI for ``maestro monitor`` — the read-only live view.

This is the entry point for the monitor subcommand. It owns:

  - The :class:`rich.live.Live` context manager (alternate-screen,
    manual refresh — we re-render on each poll).
  - A background input watcher thread that reads ``q`` from stdin
    and signals a stop event.
  - The poll loop, which calls
    :func:`monitor_view.poll_snapshot` on every iteration and
    pushes the fresh :class:`rich.layout.Layout` to ``Live``.

This module is intentionally thin. The pure rendering and snapshot
logic lives in :mod:`monitor_view` (under ``lib/``) so the view
itself can be unit-tested without spinning up a Live loop or
threading.

Read-only contract:

  The monitor never writes to disk. The only writes are to the
  terminal via ``rich`` (alternate-screen output). In particular:

    - No file is opened in write/append mode anywhere in this
      module or in :mod:`monitor_view`.
    - The :class:`FlowLogger` port's :class:`FileLogger` adapter
      is never instantiated by the monitor — only the runner
      writes logs, and the monitor is a separate process.
    - The ``Live`` context manager restores the terminal on exit
      (we use ``screen=True``) so the operator's previous
      terminal contents are preserved.

Keyboard contract:

  - ``q`` (then Enter): the input thread sets the stop event; the
    main thread breaks out of the poll loop on the next iteration;
    the ``Live`` context manager exits cleanly; the terminal is
    restored.
  - ``ctrl-c``: :class:`KeyboardInterrupt` is raised in the main
    thread. We catch it, set the stop event as a belt-and-braces
    measure, and return cleanly. The input thread is a daemon
    thread so it dies with the main process.

Usage:

  - ``maestro monitor``                              default (cwd/.maestro/logs, 1s)
  - ``maestro monitor --logs-dir /var/log/maestro``  custom log directory
  - ``maestro monitor --interval 0.5``               faster polling
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path
from typing import Callable

import click
from rich.console import Console
from rich.live import Live

# ─── Path setup ──────────────────────────────────────────────────────────
#
# This file lives at ``.pi/maestro/commands/monitor.py``. We need both
# ``.pi/maestro`` and ``.pi/maestro/lib`` on sys.path so the imports
# work whether the module is invoked via ``python3 -m commands.monitor``
# OR through the top-level ``maestro.py`` aggregator. The pattern is
# identical to the one in ``commands/onboard.py``.
_COMMANDS_DIR = Path(__file__).parent.resolve()
_MAESTRO_DIR = _COMMANDS_DIR.parent
if str(_MAESTRO_DIR / "lib") not in sys.path:
    sys.path.insert(0, str(_MAESTRO_DIR / "lib"))
if str(_MAESTRO_DIR) not in sys.path:
    sys.path.insert(0, str(_MAESTRO_DIR))

# Imports must come after path setup.
from monitor_view import (  # noqa: E402
    FOOTER_HINT,
    build_layout,
    poll_snapshot,
)


# ─── Input watcher ───────────────────────────────────────────────────────


def start_input_watcher(
    stop_event: threading.Event,
    input_func: Callable[[], str] = input,
) -> threading.Thread:
    """Spawn a daemon thread that listens for ``q`` on stdin.

    The thread reads one line at a time from ``input_func`` (defaults
    to the built-in :func:`input`) and sets ``stop_event`` when the
    user types ``q`` (case-insensitive, whitespace-stripped). On
    :class:`EOFError` (e.g. stdin closed) or :class:`KeyboardInterrupt`
    the thread also sets ``stop_event`` and exits.

    Why a thread? ``rich.live.Live`` is a blocking context manager
    that owns the main thread while it runs. We need stdin reading
    to happen concurrently so the user can quit without killing
    the process.

    The thread is marked ``daemon=True`` so it never blocks process
    exit — even if the main thread raises and the daemon is still
    blocked on :func:`input`, the interpreter will terminate it
    during shutdown.

    The ``input_func`` parameter exists so tests can drive the
    watcher deterministically without touching real stdin.

    Args:
        stop_event: Set by the thread when the user types ``q`` or
            stdin closes. The main loop polls this to decide when
            to exit.
        input_func: Callable that returns a line of input. Defaults
            to :func:`input`. Tests pass a function that returns a
            predetermined string.

    Returns:
        The started :class:`threading.Thread`. It is already
        running by the time the function returns.
    """
    def _watch() -> None:
        while not stop_event.is_set():
            try:
                line = input_func()
            except EOFError:
                stop_event.set()
                return
            except KeyboardInterrupt:
                # Re-raise on the input thread so the main thread's
                # KeyboardInterrupt handler is the single source of
                # truth for ctrl-c.
                stop_event.set()
                raise
            if line.strip().lower() == "q":
                stop_event.set()
                return

    thread = threading.Thread(target=_watch, daemon=True)
    thread.start()
    return thread


# ─── Main loop ───────────────────────────────────────────────────────────


def run_monitor(
    logs_dir: Path,
    interval: float = 1.0,
    console: Console | None = None,
    input_func: Callable[[], str] = input,
) -> int:
    """Run the live monitor until ``q`` or ``ctrl-c``.

    The function blocks for the lifetime of the monitor. It returns
    ``0`` on a clean exit (whether via ``q`` or ``ctrl-c``).

    The function takes ``console`` and ``input_func`` parameters
    for testability — tests can pass a :class:`rich.console.Console`
    and a fake input function to drive the loop without a real TTY
    or real stdin. In production both parameters default to their
    natural values (``Console()`` and :func:`input`).

    The function does not write to any file. The only I/O is to
    the provided ``console`` (or a fresh one if ``None``).

    Args:
        logs_dir: Directory to poll. Non-existent paths are OK —
            the empty-state panel is rendered regardless.
        interval: Poll interval in seconds. Minimum effective value
            is bounded by rich's refresh rate (the Live context
            throttles to 10 fps by default).
        console: Optional :class:`rich.console.Console`. ``None``
            creates a default one tied to stdout.
        input_func: Callable that returns a line of input. Defaults
            to :func:`input`. Tests pass a function that returns a
            predetermined value (e.g. ``"q"``) or raises
            :class:`EOFError` immediately. Only consulted when
            ``input_func`` is the default :func:`input` for the
            ``sys.stdin`` close below — a custom ``input_func`` is
            never expected to read ``sys.stdin``.

    Returns:
        Always ``0``. The function never propagates exceptions to
        its caller; ``KeyboardInterrupt`` and ``EOFError`` are
        caught and turned into a clean exit.
    """
    if console is None:
        console = Console()

    stop_event = threading.Event()
    input_thread = start_input_watcher(stop_event, input_func=input_func)

    try:
        # ``screen=True`` puts rich on the alternate screen buffer
        # so the operator's previous terminal contents are
        # preserved on exit. ``refresh_per_second`` is a cap, not
        # a guarantee — we drive refreshes manually in the loop.
        with Live(
            build_layout(poll_snapshot(logs_dir, interval_s=interval)),
            console=console,
            screen=True,
            refresh_per_second=10,
        ) as live:
            while not stop_event.is_set():
                # Snapshot the directory and re-render. This is
                # the only place the filesystem is touched; for
                # this slice the snapshot is always "no flows".
                live.update(build_layout(poll_snapshot(logs_dir, interval_s=interval)))
                # Sleep on the stop event, not on time.sleep, so a
                # ``q`` press is honoured within ``interval`` seconds
                # rather than after the next ``time.sleep`` returns.
                if stop_event.wait(interval):
                    break
    except KeyboardInterrupt:
        # Clean exit on ctrl-c. The Live context manager (if
        # entered) restores the alternate screen in its __exit__.
        pass
    finally:
        # Belt-and-braces: ensure the input watcher exits even on
        # an unexpected exception path. The thread is a daemon so
        # this is just a hint, not a hard guarantee.
        stop_event.set()
        # If the watcher is blocked on ``input()`` (reading from
        # stdin), it won't honour the stop event until stdin yields.
        # Closing stdin unblocks the read so the thread can exit
        # cleanly *before* the interpreter starts shutting down.
        # Without this, a stuck daemon thread at shutdown trips
        # Python 3.12's "finalizing" fatal error.
        #
        # We try this unconditionally — the cost is one syscall,
        # and a custom ``input_func`` (passed by tests) doesn't
        # touch ``sys.stdin`` so it is unaffected.
        try:
            sys.stdin.close()
        except Exception:  # noqa: BLE001
            # stdin may already be closed (tests, pipes). Best-
            # effort only — the daemon flag is the real safety net.
            pass
        # Give the watcher a brief moment to exit. If it's stuck
        # on a syscall we don't want to block the caller; the
        # daemon=True ensures it dies with the process.
        input_thread.join(timeout=0.2)

    return 0


# ─── Click command ──────────────────────────────────────────────────────


@click.command(name="monitor")
@click.option(
    "--logs-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=Path(".maestro/logs"),
    show_default=True,
    help=(
        "Directory containing JSONL flow logs produced by the runner. "
        "If the directory does not exist, the monitor renders its "
        "empty state without error."
    ),
)
@click.option(
    "--interval",
    type=float,
    default=1.0,
    show_default=True,
    help="Polling interval in seconds. Minimum effective value is ~0.1s.",
)
def monitor_cmd(logs_dir: Path, interval: float) -> None:
    """Launch the read-only live monitor view.

    Polls ``--logs-dir`` (default ``.maestro/logs``) and renders a
    full-screen :class:`rich.layout.Layout` of active flows. Read-only:
    no files are written. Quit with ``q`` (then Enter) or ``ctrl-c``.
    """
    sys.exit(run_monitor(logs_dir=logs_dir, interval=interval))


# Allow ``python3 -m commands.monitor ...`` for ops scripts
if __name__ == "__main__":
    monitor_cmd()
