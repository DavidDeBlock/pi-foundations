#!/usr/bin/env python3
"""
flow_logger.py — Structured logging port for the flow engine.

The runner emits :class:`FlowEvent` objects through a :class:`FlowLogger`
port. Three adapters ship in this module:

- :class:`StderrLogger` — the production default. Renders events as
  ``"[<phase>] <kind>: <message>"`` lines on ``sys.stderr``. The format
  is what the future logger-migration slice (issue #28) will use to
  keep terminal output byte-identical to the current
  ``print(..., file=sys.stderr)`` calls.
- :class:`FileLogger` — append-only JSONL at
  ``.maestro/logs/<flow>/<issue>.jsonl``. Useful for after-the-fact
  "what happened during this run?" debugging.
- :class:`ListLogger` — in-memory collector. The test adapter — tests
  assert on ``logger.events`` rather than string-matching stderr.

This module is intentionally side-effect free except for the
``StderrLogger`` and ``FileLogger`` adapters' I/O. The :class:`FlowEvent`
dataclass and :class:`FlowLogger` protocol are pure data + interface
definitions.

Public API:
    - ``FlowEvent`` — a structured logger event (frozen dataclass)
    - ``FlowLogger`` — the port (Protocol)
    - ``StderrLogger`` — default adapter (stderr)
    - ``FileLogger`` — JSONL adapter (append-only file)
    - ``ListLogger`` — in-memory test adapter
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Protocol


def now_iso() -> str:
    """Return the current time as an ISO-8601 string (UTC, microsecond).

    The :class:`FlowEvent.timestamp` field expects an ISO string. This
    helper is the canonical way to populate it from inside the engine
    — pulled out into :mod:`flow_logger` so callers don't need to
    import :mod:`working_memory` just to get a timestamp. The
    microsecond suffix is intentional: it lets us distinguish events
    emitted in the same millisecond, which matters when a single
    phase emits both ``phase_start`` and ``phase_end`` rapidly.
    """
    return datetime.now(timezone.utc).isoformat()


# The closed set of FlowEvent kinds. Adding a new event type is a
# deliberate change — it expands the test surface (tests assert on
# event kinds) and the migration surface (the kind shows up in
# terminal output via StderrLogger).
FlowEventKind = Literal[
    "phase_start",
    "phase_end",
    "phase_retry",
    "phase_rejected",
    "phase_approved",
    "no_gaps",
    "diagnostic",
    "scout_complete",
    "scout_skipped",
    "memory_warn",
    "prefetch_warn",
    "onboard_warn",
    "evidence_warn",
    "tokens_recorded",
]


@dataclass(frozen=True)
class FlowEvent:
    """A structured event emitted by the runner.

    The interface IS the test surface — tests assert on these objects
    via the :class:`ListLogger` adapter. ``kind`` is a closed enum (see
    :data:`FlowEventKind`) so a typo at a call site is a static error
    under mypy/right-type-checker.
    """
    kind: FlowEventKind
    message: str
    timestamp: str  # ISO8601
    phase: str | None = None
    attempt: int | None = None
    duration_s: float | None = None
    tokens: dict | None = None


class FlowLogger(Protocol):
    """The port. Anything that can receive a :class:`FlowEvent`."""
    def emit(self, event: FlowEvent) -> None: ...


class StderrLogger:
    """Default adapter — renders events as ``"[<phase>] <kind>: <message>"``
    on ``sys.stderr`` (plus a trailing newline, courtesy of ``print``).

    The format is what the future migration slice (issue #28) will use
    to keep terminal output stable: existing call sites will be
    rewritten to construct a :class:`FlowEvent` whose ``kind`` and
    ``message`` reproduce the current ``print(...)`` text exactly.

    Special case: ``tokens_recorded`` events are rendered as
    ``"[<phase>] tokens: in=N out=M cache=K"`` (the word ``tokens``
    is used in place of the longer kind, and the value comes from the
    event's ``tokens`` dict rather than the ``message`` field). This
    matches the operator-facing format documented in the token-
    plumbing PRD.
    """
    def emit(self, event: FlowEvent) -> None:
        prefix = f"[{event.phase}] " if event.phase else ""
        if event.kind == "tokens_recorded":
            tokens = event.tokens or {}
            rendered = " ".join(f"{k}={v}" for k, v in tokens.items())
            print(f"{prefix}tokens: {rendered}", file=sys.stderr)
        else:
            print(f"{prefix}{event.kind}: {event.message}", file=sys.stderr)
        sys.stderr.flush()


class FileLogger:
    """Append-only JSONL at ``.maestro/logs/<flow>/<issue>.jsonl``.

    Each call to :meth:`emit` opens the file in append mode and writes
    one JSON object per line. The parent directory is created lazily
    on construction. The dataclass is serialised via :func:`dataclasses.asdict`
    so callers don't need to know the field names.

    Use this adapter when you want to investigate "what happened" after
    a flow run without re-parsing the session log.
    """
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, event: FlowEvent) -> None:
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(asdict(event)) + "\n")


@dataclass
class ListLogger:
    """In-memory collector. Test adapter.

    The :attr:`events` attribute accumulates every emitted event in
    emission order. Tests assert on this list — never on stderr text
    or on disk contents — so they stay fast and deterministic.
    """
    events: list = field(default_factory=list)

    def emit(self, event: FlowEvent) -> None:
        self.events.append(event)
