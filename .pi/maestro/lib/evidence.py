#!/usr/bin/env python3
"""
evidence.py — Per-issue evidence markers for Maestro.

Evidence markers are physical JSON files under ``.maestro/evidence/<issue>/``
that record concrete verification results (automated tests, manual browser
checks, structured review). They replace LLM-judged "APPROVED" with auditable
artifacts that survive across flow restarts and can be inspected post-hoc.

Key design choices (see docs/35-prds/maestro-evidence-gates.md):

- **Atomic writes** — write to ``.tmp`` then ``rename`` so a crash mid-write
  never leaves a half-written marker. Same pattern as ``working_memory.py``.
- **SHA256 content hash** of the ``data`` field only — recomputed on read
  to detect tampering. The wrapper metadata (``created_at``, ``created_by``)
  is excluded so re-stamping with a new timestamp doesn't invalidate the
  marker.
- **``verified`` is computed by the factory**, not trusted from input. e.g.
  a ``tested`` marker is verified iff ``exit_code == 0 and tests_passed ==
  tests_run``. A reviewer can pass ``verified=True`` but the factory will
  override.
- **Corrupt / tampered files return ``None``** on ``read()``; callers decide
  what to do (the flow engine routes to ``diagnostic`` in that case).
- **Closed enum of evidence types** — no registry, no custom types in v1.

Public API:
    - ``EVIDENCE_DIR`` — default location for evidence files.
    - ``EvidenceType`` — closed enum: ``tested``, ``manual_tested``, ``reviewed``.
    - ``EvidenceMarker`` — dataclass holding the full marker (incl. hash).
    - ``EvidenceStore`` — read/write/check API for a single issue.
    - ``now_iso()`` — UTC ISO-8601 timestamp helper.
    - ``make_tested_marker`` / ``make_reviewed_marker`` / ``make_manual_tested_marker``
      — factory functions that compute ``verified`` from the input.

Threat model: content hash detects **tampering** (file modified). It does not
detect **forgery** (fake file created) — that needs HMAC, deferred. See the
PRD §"Why SHA256 content hash, not HMAC?".
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional


# Default location for evidence files. Resolved relative to cwd by callers.
EVIDENCE_DIR = Path(".maestro/evidence")


def now_iso() -> str:
    """Return current UTC time as ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


class EvidenceType(str, Enum):
    """Closed set of evidence marker types.

    Adding a new type here is a deliberate contract change — both the marker
    factory in this module and the ``evidence`` CLI's ``--required`` choices
    must stay in sync. See PRD §"Why a closed enum, not a registry?".
    """

    TESTED = "tested"
    MANUAL_TESTED = "manual_tested"
    REVIEWED = "reviewed"


@dataclass
class EvidenceMarker:
    """A single evidence marker — physical file representing verification.

    The on-disk format (``to_file_payload``) is the canonical wire form. The
    in-memory form includes all fields; ``data`` is the type-specific payload
    that gets hashed.
    """

    issue: int
    type: EvidenceType
    verified: bool
    created_at: str
    created_by: str  # "human", "test_runner_phase", "playwright_phase", etc.
    data: dict
    content_hash: str = ""

    def to_dict(self) -> dict:
        """Return the in-memory dict form (incl. hash for round-tripping)."""
        return asdict(self)

    def to_file_payload(self) -> dict:
        """The on-disk wire format — JSON-serialisable dict.

        Note: the hash is stored on disk so ``read()`` can verify integrity
        without recomputing from scratch (it still recomputes, but having it
        on disk is useful for audits and for human inspection).
        """
        return {
            "issue": self.issue,
            "type": self.type.value if isinstance(self.type, EvidenceType) else str(self.type),
            "verified": self.verified,
            "created_at": self.created_at,
            "created_by": self.created_by,
            "data": self.data,
            "content_hash": self.content_hash,
        }


class EvidenceStore:
    """Read/write/check evidence markers for a specific issue.

    The store is single-writer safe via atomic rename. Multi-writer concurrency
    is out of scope (matches ``MemoryStore``'s contract).
    """

    def __init__(self, issue_num: int, evidence_dir: Path = EVIDENCE_DIR):
        self.issue_num = int(issue_num)
        self.evidence_dir = Path(evidence_dir)
        self.dir = self.evidence_dir / str(self.issue_num)
        self.dir.mkdir(parents=True, exist_ok=True)

    # ─── Paths ────────────────────────────────────────────────────────

    def path_for(self, evidence_type: EvidenceType) -> Path:
        """Return the on-disk path for a given evidence type.

        e.g. ``.maestro/evidence/42/tested.json``.
        """
        return self.dir / f"{evidence_type.value}.json"

    # ─── Hashing ──────────────────────────────────────────────────────

    def compute_hash(self, data: dict) -> str:
        """SHA256 of canonical JSON (sorted keys, tight separators).

        Stable across Python versions and across field reordering — the same
        dict always produces the same hash. Hash covers the ``data`` field
        only, not the wrapper metadata (so re-stamping ``created_at`` doesn't
        invalidate the marker).
        """
        canonical = json.dumps(data, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    # ─── Write ────────────────────────────────────────────────────────

    def write(self, marker: EvidenceMarker) -> None:
        """Write evidence marker atomically.

        - Validates the marker's ``issue`` matches the store's issue.
        - Computes a fresh content hash from ``data`` (overrides any value
          already on the marker).
        - Writes to a ``.tmp`` sibling, then atomically renames.

        Raises ``ValueError`` on a mismatched issue; ``OSError`` on disk
        failure.
        """
        if marker.issue != self.issue_num:
            raise ValueError(
                f"Marker issue {marker.issue} doesn't match store issue {self.issue_num}"
            )

        # Always recompute the hash from data; the factory is the source of
        # truth for ``verified`` and the hash is derived from ``data``.
        marker.content_hash = self.compute_hash(marker.data)

        path = self.path_for(marker.type)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(marker.to_file_payload(), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        # os.replace is atomic on POSIX (same filesystem) and overwrites
        # existing files — which is what we want for retries that re-write
        # the same marker.
        os.replace(tmp, path)

    # ─── Read ─────────────────────────────────────────────────────────

    def read(self, evidence_type: EvidenceType) -> Optional[EvidenceMarker]:
        """Read evidence marker, or ``None`` if missing / corrupt / tampered.

        Behaviour:
            - **Missing file** → returns ``None``.
            - **Corrupt JSON** → returns ``None`` (no exception, no backup —
              the caller is the flow engine and a one-line ``None`` keeps
              the error path uniform).
            - **Missing required field** (issue, type, data, etc.) → ``None``.
            - **Type string doesn't match the requested type** → ``None``.
            - **Hash mismatch** (data was tampered) → returns the marker
              with ``verified=False`` rather than ``None``. This is
              intentional: a tampered marker is *present*, but not trusted.
              The flow engine's ``check()`` treats unverified as missing.

        We don't re-stamp or re-write on read — ``write()`` is the only path
        that touches the file. A tampered file stays tampered until someone
        (human or scripted) re-runs the producer.
        """
        path = self.path_for(evidence_type)
        if not path.exists():
            return None

        try:
            raw = path.read_text(encoding="utf-8")
            data = json.loads(raw)
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            # Corrupt file. We deliberately don't back it up here (unlike
            # MemoryStore) — evidence is meant to be regenerable, and a
            # corrupt evidence file is just "we have no evidence".
            return None

        if not isinstance(data, dict):
            return None

        # Required fields — if any are missing, the file is malformed.
        try:
            issue = int(data["issue"])
            etype_str = data["type"]
            verified = bool(data["verified"])
            created_at = str(data["created_at"])
            created_by = str(data["created_by"])
            inner = data["data"]
            stored_hash = str(data.get("content_hash", ""))
        except (KeyError, TypeError, ValueError):
            return None

        if not isinstance(inner, dict):
            return None

        # The stored ``type`` must match the path. If someone hand-renamed
        # ``reviewed.json`` to ``tested.json``, refuse to return it.
        try:
            etype = EvidenceType(etype_str)
        except ValueError:
            return None
        if etype != evidence_type:
            return None

        marker = EvidenceMarker(
            issue=issue,
            type=etype,
            verified=verified,
            created_at=created_at,
            created_by=created_by,
            data=inner,
            content_hash=stored_hash,
        )

        # Tamper detection: if a hash is stored and it doesn't match the
        # recomputed value, the ``data`` field was modified after the file
        # was written. Down-grade ``verified`` to ``False`` so the flow
        # engine treats it as missing.
        if stored_hash:
            expected_hash = self.compute_hash(inner)
            if stored_hash != expected_hash:
                marker.verified = False

        return marker

    # ─── Check ────────────────────────────────────────────────────────

    def check(self, required: list) -> tuple:
        """Check that all required evidence markers exist and are verified.

        ``required`` is a list of ``EvidenceType`` values. Returns
        ``(ok, missing)`` where ``missing`` is the subset of ``required``
        that is either absent, corrupt, or unverified (e.g. tampered).

        An empty ``required`` list always returns ``(True, [])`` — the
        absence of requirements is trivially satisfied.
        """
        missing = []
        for etype in required:
            # Coerce str → EvidenceType (defensive: callers may pass strings
            # from JSON flow configs, which haven't been validated upstream).
            if isinstance(etype, str):
                try:
                    etype = EvidenceType(etype)
                except ValueError:
                    # Unknown type names in a flow config are a config error,
                    # not a runtime one — treat as missing so the gate fires.
                    missing.append(etype)  # type: ignore[arg-type]
                    continue
            elif not isinstance(etype, EvidenceType):
                missing.append(etype)  # type: ignore[arg-type]
                continue

            marker = self.read(etype)
            if marker is None or not marker.verified:
                missing.append(etype)
        return (len(missing) == 0, missing)


# ─── Marker factories ────────────────────────────────────────────────────
#
# Each factory computes ``verified`` from its inputs — callers cannot
# override the verdict. This is the "single source of truth" for what
# counts as verified evidence.


def make_tested_marker(
    issue: int,
    command: str,
    exit_code: int,
    tests_run: int,
    tests_passed: int,
    created_by: str = "test_runner_phase",
) -> EvidenceMarker:
    """Build a ``tested`` evidence marker.

    ``verified`` iff ``exit_code == 0`` AND ``tests_passed == tests_run``.
    Either condition failing marks the marker as unverified so the close
    phase will route the flow to ``diagnostic``.
    """
    verified = (exit_code == 0) and (tests_passed == tests_run)
    return EvidenceMarker(
        issue=issue,
        type=EvidenceType.TESTED,
        verified=verified,
        created_at=now_iso(),
        created_by=created_by,
        data={
            "command": command,
            "exit_code": int(exit_code),
            "tests_run": int(tests_run),
            "tests_passed": int(tests_passed),
            "tests_failed": int(tests_run) - int(tests_passed),
        },
    )


def make_reviewed_marker(
    issue: int,
    critical_issues: int,
    non_blocking_issues: int,
    reviewer: str,
    created_by: str = "human",
) -> EvidenceMarker:
    """Build a ``reviewed`` evidence marker.

    ``verified`` iff ``critical_issues == 0``. Non-blocking issues do not
    block the gate (they're still recorded in ``data`` for the
    retrospective to summarise).
    """
    verified = int(critical_issues) == 0
    return EvidenceMarker(
        issue=issue,
        type=EvidenceType.REVIEWED,
        verified=verified,
        created_at=now_iso(),
        created_by=created_by,
        data={
            "critical_issues": int(critical_issues),
            "non_blocking_issues": int(non_blocking_issues),
            "reviewer": reviewer,
        },
    )


def make_manual_tested_marker(
    issue: int,
    scenario: str,
    screenshot_before: str = "",
    screenshot_after: str = "",
    verified_by: str = "playwright",
    created_by: str = "manual_tested_phase",
) -> EvidenceMarker:
    """Build a ``manual_tested`` evidence marker.

    ``verified`` is always ``True`` — screenshots are evidence enough by
    definition. The ``verified_by`` field records who/what produced the
    evidence (default ``"playwright"``, since that's the common case in
    Maestro's evidence gates PRD).
    """
    return EvidenceMarker(
        issue=issue,
        type=EvidenceType.MANUAL_TESTED,
        verified=True,
        created_at=now_iso(),
        created_by=created_by,
        data={
            "scenario": scenario,
            "screenshot_before": screenshot_before,
            "screenshot_after": screenshot_after,
            "verified_by": verified_by,
        },
    )
