#!/usr/bin/env python3
"""
working_memory.py — Per-issue structured working memory for Maestro.

Stores phase outputs, files touched, test results, and errors as a JSON file
on disk so they survive across flow restarts, retries, and agent loops.

Key design choices (see docs/35-prds/maestro-working-memory.md):

- JSON on disk (not SQLite) — easy to inspect, back up, and version.
- Schema-tolerant — unknown fields are preserved; missing fields default to
  empty. Adding new fields to the dataclass doesn't break old memory files.
- Atomic writes — write to ``.tmp`` then ``rename`` so a crash mid-write
  never leaves a half-written file.
- Corrupt files are backed up as ``<issue>.corrupt.<unix_ts>.json`` and the
  in-memory store is reset to empty. We never silently ignore corruption.
- ``previous_output`` continues to work. Working memory is a parallel,
  additive channel — never a replacement.

Public API:
    - ``MEMORY_DIR`` — default location for memory files.
    - ``WorkingMemory`` — dataclass holding all per-issue state.
    - ``MemoryStore`` — read/write/append API for a single issue.
    - ``now_iso()`` — UTC ISO-8601 timestamp helper.
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# Default location for memory files. Resolved relative to cwd by callers.
MEMORY_DIR = Path(".maestro/tasks/active")


def now_iso() -> str:
    """Return current UTC time as ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


@dataclass
class WorkingMemory:
    """Per-issue structured memory. Persisted as JSON.

    Each phase has its own dict section (``scout``, ``builder``, ``reviewer``,
    ``test_runner``, ``diagnostic``, ``retrospective``). Cross-cutting
    accumulators (``files_touched``, ``test_results``, ``errors``,
    ``notes``) live alongside.

    Schema-tolerant: ``from_dict`` ignores unknown keys and supplies defaults
    for missing ones, so evolving the dataclass doesn't break old memory
    files on disk.
    """

    issue: int
    created_at: str = ""
    updated_at: str = ""
    repo_path: str = ""
    git_sha: str = ""

    # Phase outputs (one section per phase name)
    scout: dict = field(default_factory=dict)
    builder: dict = field(default_factory=dict)
    reviewer: dict = field(default_factory=dict)
    test_runner: dict = field(default_factory=dict)
    diagnostic: dict = field(default_factory=dict)
    retrospective: dict = field(default_factory=dict)

    # Cross-cutting
    files_touched: list = field(default_factory=list)  # list[str], but typed loose for tolerance
    test_results: list = field(default_factory=list)  # list[dict]
    errors: list = field(default_factory=list)  # list[dict]
    notes: list = field(default_factory=list)  # list[dict]

    def to_dict(self) -> dict:
        """Return a plain dict representation (recursively serialisable)."""
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "WorkingMemory":
        """Construct a WorkingMemory from a dict, tolerating unknown/missing fields.

        - Unknown fields are dropped (we don't preserve them as dataclass attrs,
          but the JSON file is untouched so they survive on disk for future reads).
        - Missing fields default to their declared defaults (empty dict / list).
        - ``issue`` is required — if absent or invalid, a ValueError bubbles up.
        """
        if not isinstance(d, dict):
            raise ValueError(f"WorkingMemory.from_dict expected dict, got {type(d).__name__}")

        if "issue" not in d:
            raise ValueError("WorkingMemory.from_dict: missing required 'issue' field")

        known_fields = set(cls.__dataclass_fields__.keys())
        filtered = {k: v for k, v in d.items() if k in known_fields}
        return cls(**filtered)


class MemoryStore:
    """Read/write working memory for a specific issue.

    The store is single-writer safe via atomic rename. Multi-writer concurrency
    is out of scope for this PRD.
    """

    def __init__(self, issue_num: int, memory_dir: Path = MEMORY_DIR):
        self.issue_num = int(issue_num)
        self.memory_dir = Path(memory_dir)
        self.path = self.memory_dir / f"{self.issue_num}.memory.json"

    def _log(self, msg: str) -> None:
        """Best-effort logger — write to stderr but never crash flow on log failure."""
        try:
            print(f"[memory] {msg}", file=sys.stderr)
            sys.stderr.flush()
        except Exception:
            pass

    def load(self) -> WorkingMemory:
        """Load memory from disk.

        Returns an empty ``WorkingMemory`` (with ``created_at`` set) if the
        file doesn't exist. If the file is corrupt (invalid JSON or
        otherwise unparseable), back it up as
        ``<issue>.corrupt.<unix_ts>.json`` and return a fresh empty memory.
        """
        if not self.path.exists():
            return WorkingMemory(issue=self.issue_num, created_at=now_iso())

        try:
            raw = self.path.read_text(encoding="utf-8")
            data = json.loads(raw)
        except (json.JSONDecodeError, OSError, UnicodeDecodeError) as e:
            # Corrupt file — preserve evidence, don't silently swallow
            backup = self._corrupt_backup_path()
            try:
                self.path.rename(backup)
                self._log(
                    f"Corrupt memory for issue #{self.issue_num} backed up to "
                    f"{backup.name}: {type(e).__name__}: {e}"
                )
            except OSError as rename_err:
                # If rename itself fails, log loudly and proceed with empty memory
                self._log(
                    f"Failed to back up corrupt memory for issue #{self.issue_num} "
                    f"({rename_err}); starting fresh"
                )
            return WorkingMemory(issue=self.issue_num, created_at=now_iso())

        # If the JSON is valid but not a dict (e.g. a stray list), back it up too
        if not isinstance(data, dict):
            backup = self._corrupt_backup_path()
            try:
                self.path.rename(backup)
                self._log(
                    f"Memory for issue #{self.issue_num} is not a JSON object "
                    f"(got {type(data).__name__}); backed up to {backup.name}"
                )
            except OSError:
                pass
            return WorkingMemory(issue=self.issue_num, created_at=now_iso())

        # Merge with empty defaults so the file's `issue` is preserved if missing
        try:
            if "issue" not in data:
                data["issue"] = self.issue_num
            return WorkingMemory.from_dict(data)
        except (ValueError, TypeError) as e:
            # from_dict failed — treat as corrupt
            backup = self._corrupt_backup_path()
            try:
                self.path.rename(backup)
                self._log(
                    f"Memory for issue #{self.issue_num} failed schema validation "
                    f"({e}); backed up to {backup.name}"
                )
            except OSError:
                pass
            return WorkingMemory(issue=self.issue_num, created_at=now_iso())

    def _corrupt_backup_path(self) -> Path:
        """Build the backup path for a corrupt memory file.

        Pattern: ``<issue>.corrupt.<unix_ts>.json`` — the issue number stem,
        not the full ``<issue>.memory`` stem. e.g. ``42.corrupt.1700000000.json``.
        """
        return self.path.parent / f"{self.issue_num}.corrupt.{int(time.time())}.json"

    def save(self, memory: WorkingMemory) -> None:
        """Persist memory to disk atomically (write to ``.tmp`` then ``rename``).

        Updates ``updated_at`` automatically. Creates parent directories
        on demand. The ``.tmp`` file is a sibling of the real file
        (``42.memory.json.tmp``), not a sibling with a replaced suffix —
        we want the partial file to be obviously a temp, not a new ``*.tmp``
        file that looks like a different memory.
        """
        memory.updated_at = now_iso()
        self.path.parent.mkdir(parents=True, exist_ok=True)

        tmp = self.path.parent / (self.path.name + ".tmp")
        tmp.write_text(
            json.dumps(memory.to_dict(), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        # Atomic on POSIX (same filesystem). os.replace overwrites the
        # destination if it exists, which is what we want for retries.
        os.replace(tmp, self.path)

    def update_phase(self, phase_name: str, data: dict) -> WorkingMemory:
        """Update a specific phase's section. Merges with existing data.

        Unknown phase names are stored in ``notes`` as a warning, not lost.
        Returns the updated memory.
        """
        if not isinstance(data, dict):
            data = {"value": data}

        memory = self.load()
        if not hasattr(memory, phase_name):
            memory.notes.append({
                "type": "unknown_phase",
                "phase": phase_name,
                "data": data,
                "timestamp": now_iso(),
            })
        else:
            existing = getattr(memory, phase_name)
            # The dataclass declares dicts with default_factory=dict, but a
            # corrupt on-disk file could yield a non-dict (e.g. None or a list).
            if not isinstance(existing, dict):
                existing = {}
            existing.update(data)
            setattr(memory, phase_name, existing)
        self.save(memory)
        return memory

    def append_file_touched(self, file_path: str) -> None:
        """Record that a file was touched. Deduplicates by exact string match."""
        if not file_path:
            return
        memory = self.load()
        # Coerce existing list (corrupt file could be anything) to a list of str
        if not isinstance(memory.files_touched, list):
            memory.files_touched = []
        if file_path not in memory.files_touched:
            memory.files_touched.append(file_path)
            self.save(memory)

    def append_test_result(self, result: dict) -> None:
        """Record a test run result, stamped with the current timestamp."""
        if not isinstance(result, dict):
            result = {"value": result}
        memory = self.load()
        if not isinstance(memory.test_results, list):
            memory.test_results = []
        memory.test_results.append({"timestamp": now_iso(), **result})
        self.save(memory)

    def append_error(self, phase: str, error: str) -> None:
        """Record an error for retrospective analysis.

        Includes timestamp, phase name, and error message. The error message
        is truncated to 2000 chars to keep memory files bounded.
        """
        if not phase:
            phase = "unknown"
        if error is None:
            error = ""
        if len(error) > 2000:
            error = error[:2000] + "...[truncated]"

        memory = self.load()
        if not isinstance(memory.errors, list):
            memory.errors = []
        memory.errors.append({
            "timestamp": now_iso(),
            "phase": phase,
            "error": error,
        })
        self.save(memory)


# ─── Markdown rendering for CLI `show` ──────────────────────────────────


def format_memory_markdown(memory: WorkingMemory) -> str:
    """Render a WorkingMemory as a human-readable markdown block.

    Used by the ``maestro memory show`` CLI command. Pure function — no
    file I/O.
    """
    lines: list = []
    lines.append(f"# Working Memory — Issue #{memory.issue}")
    lines.append("")

    # Header metadata
    if memory.created_at:
        lines.append(f"- **Created:** {memory.created_at}")
    if memory.updated_at:
        lines.append(f"- **Updated:** {memory.updated_at}")
    if memory.repo_path:
        lines.append(f"- **Repo path:** `{memory.repo_path}`")
    if memory.git_sha:
        lines.append(f"- **Git SHA:** `{memory.git_sha[:12]}`" if len(memory.git_sha) > 12 else f"- **Git SHA:** `{memory.git_sha}`")
    lines.append("")

    # Phase sections
    phase_sections = [
        ("scout", memory.scout),
        ("builder", memory.builder),
        ("reviewer", memory.reviewer),
        ("test_runner", memory.test_runner),
        ("diagnostic", memory.diagnostic),
        ("retrospective", memory.retrospective),
    ]
    for name, section in phase_sections:
        if section:
            lines.append(f"## {name}")
            lines.append("")
            lines.append("```json")
            lines.append(json.dumps(section, indent=2, ensure_ascii=False))
            lines.append("```")
            lines.append("")

    # Cross-cutting accumulators
    if memory.files_touched:
        lines.append(f"## Files Touched ({len(memory.files_touched)})")
        lines.append("")
        for f in memory.files_touched:
            lines.append(f"- `{f}`")
        lines.append("")

    if memory.test_results:
        lines.append(f"## Test Results ({len(memory.test_results)})")
        lines.append("")
        for tr in memory.test_results:
            ts = tr.get("timestamp", "?")
            status = tr.get("status", "?")
            name = tr.get("name") or tr.get("command") or ""
            lines.append(f"- `{ts}` **{status}** {name}".rstrip())
        lines.append("")

    if memory.errors:
        lines.append(f"## Errors ({len(memory.errors)})")
        lines.append("")
        for err in memory.errors:
            ts = err.get("timestamp", "?")
            phase = err.get("phase", "?")
            msg = err.get("error", "")
            # Show first line only in markdown view; full message in --json
            short = msg.split("\n", 1)[0][:200]
            lines.append(f"- `{ts}` **{phase}**: {short}")
        lines.append("")

    if memory.notes:
        lines.append(f"## Notes ({len(memory.notes)})")
        lines.append("")
        for note in memory.notes:
            lines.append(f"- `{note.get('timestamp', '?')}` {json.dumps(note, ensure_ascii=False)}")
        lines.append("")

    if not any([
        memory.scout, memory.builder, memory.reviewer,
        memory.test_runner, memory.diagnostic, memory.retrospective,
        memory.files_touched, memory.test_results,
        memory.errors, memory.notes,
    ]):
        lines.append("_No recorded activity yet._")
        lines.append("")

    return "\n".join(lines)
