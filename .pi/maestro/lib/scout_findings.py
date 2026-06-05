#!/usr/bin/env python3
"""
scout_findings.py — Structured findings emitted by the Maestro Scout phase.

The scout phase runs before the builder, uses only read-only tools, and emits
a structured findings block describing the target repository (relevant files,
test command, patterns, conventions, risks). This module is the data layer
for that exchange.

Public API:
    - ``ScoutFindings`` — dataclass holding the structured fields.
    - ``ScoutFindings.from_dict(d)`` — tolerant construction (unknown /
      missing / malformed fields all default safely).
    - ``ScoutFindings.to_markdown()`` — render as a markdown block for
      prompt injection.
    - ``parse_scout_findings_from_details(details)`` — extract the JSON
      payload from a phase output's ``### PHASE_OUTPUT: success`` block.
      Returns a ``{"raw": ..., "parse_error": ...}`` envelope on failure so
      callers can still surface the raw text.
    - ``format_scout_findings_markdown(findings)`` — render any of
      ``ScoutFindings``, ``dict``, ``None``, or a parse-error envelope as a
      markdown block. The builder prompt always has a stable, non-empty
      value to substitute.

Design notes (see docs/35-prds/maestro-scout-phase.md):

- **Schema-tolerant by default.** Unknown fields are dropped, missing
  fields default to empty, malformed types fall back to the field's
  default. A scout that emits garbage must not break the pipeline.
- **No I/O.** This module is a pure data/parsing/rendering layer. The
  flow engine owns persistence to working memory.
- **Markdown sections are ordered** (relevant files → test command →
  patterns → conventions → risks) and empty sections are omitted.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any


#: Regex that captures the JSON payload between the PHASE_OUTPUT markers.
#: Group 1 = JSON payload. ``re.DOTALL`` lets ``.*`` cross newlines.
#: The opening marker matches ``### PHASE_OUTPUT: success`` (any whitespace
#: amount), and the closing marker matches ``### END_PHASE_OUTPUT``.
_PHASE_OUTPUT_RE = re.compile(
    r"###\s*PHASE_OUTPUT:\s*success\s*\n(.*?)###\s*END_PHASE_OUTPUT",
    re.DOTALL,
)


# ─── Dataclass ───────────────────────────────────────────────────────────


@dataclass
class ScoutFindings:
    """Structured findings from the scout phase.

    All fields are optional and default sensibly. Unknown fields passed to
    :meth:`from_dict` are silently dropped (they survive in any persisted
    JSON, but the dataclass instance only carries known fields).
    """

    relevant_files: list[str] = field(default_factory=list)
    test_command: str = ""
    patterns: list[str] = field(default_factory=list)
    conventions: list[str] = field(default_factory=list)
    risks: list[str] = field(default_factory=list)
    scanned_at: str = ""  # ISO 8601 timestamp, set by the scout

    @classmethod
    def from_dict(cls, d: dict) -> "ScoutFindings":
        """Construct from a dict, tolerating unknown / missing / malformed fields.

        - **Unknown fields** are dropped (the JSON file is untouched, so they
          survive on disk for future readers).
        - **Missing fields** default to their declared defaults (``[]`` / ``""``).
        - **Malformed types** fall back to the field's default rather than
          raising — a scout output that has a non-list ``relevant_files``
          must not break the pipeline.

        Args:
            d: dict that may be a partial or malformed scout findings payload.

        Returns:
            ``ScoutFindings`` instance with safe defaults applied.
        """
        if not isinstance(d, dict):
            return cls()

        def _safe_list(value: Any) -> list:
            """Return a shallow copy if ``value`` is a list, else ``[]``."""
            return list(value) if isinstance(value, list) else []

        def _safe_str(value: Any) -> str:
            """Return ``value`` if it is a string, else ``""``."""
            return value if isinstance(value, str) else ""

        known_fields = set(cls.__dataclass_fields__.keys())
        filtered = {k: v for k, v in d.items() if k in known_fields}

        # Per-field type coercion for safety against malformed inputs.
        if "relevant_files" in filtered:
            filtered["relevant_files"] = _safe_list(filtered["relevant_files"])
        if "test_command" in filtered:
            filtered["test_command"] = _safe_str(filtered["test_command"])
        if "patterns" in filtered:
            filtered["patterns"] = _safe_list(filtered["patterns"])
        if "conventions" in filtered:
            filtered["conventions"] = _safe_list(filtered["conventions"])
        if "risks" in filtered:
            filtered["risks"] = _safe_list(filtered["risks"])
        if "scanned_at" in filtered:
            filtered["scanned_at"] = _safe_str(filtered["scanned_at"])

        return cls(**filtered)

    def to_markdown(self) -> str:
        """Render as a markdown block for prompt injection.

        Sections, in order: Relevant Files → Test Command → Patterns →
        Conventions → Risks. Empty sections are omitted. The output always
        starts with the ``## Scout Findings`` heading.

        Returns:
            Markdown string ending in a single trailing newline.
        """
        parts: list[str] = ["## Scout Findings", ""]

        if self.relevant_files:
            parts.append("### Relevant Files")
            for f in self.relevant_files:
                parts.append(f"- `{f}`")
            parts.append("")

        if self.test_command:
            parts.append(f"### Test Command\n`{self.test_command}`\n")

        if self.patterns:
            parts.append("### Patterns")
            for p in self.patterns:
                parts.append(f"- {p}")
            parts.append("")

        if self.conventions:
            parts.append("### Conventions")
            for c in self.conventions:
                parts.append(f"- {c}")
            parts.append("")

        if self.risks:
            parts.append("### Risks")
            for r in self.risks:
                parts.append(f"- ⚠️ {r}")
            parts.append("")

        # Strip trailing blank lines, then re-add a single trailing newline.
        return "\n".join(parts).rstrip() + "\n"


# ─── Parsing ─────────────────────────────────────────────────────────────


def parse_scout_findings_from_details(details: str) -> dict:
    """Parse the JSON block from a scout phase's ``PHASE_OUTPUT`` envelope.

    Looks for a ``### PHASE_OUTPUT: success`` block delimited by
    ``### END_PHASE_OUTPUT``. The JSON payload between the markers is
    extracted and parsed. If the block is missing or the JSON is malformed,
    returns a parse-error envelope ``{"raw": details, "parse_error": "..."}``
    so the caller can log the failure and still surface the raw text.

    Args:
        details: Raw phase output text. Expected to contain a PHASE_OUTPUT
            block but tolerates missing / malformed input.

    Returns:
        A dict with the parsed findings, or
        ``{"raw": details, "parse_error": "<reason>"}`` on any failure.
    """
    if not isinstance(details, str):
        return {"raw": str(details), "parse_error": "details is not a string"}

    match = _PHASE_OUTPUT_RE.search(details)
    if not match:
        return {"raw": details, "parse_error": "no PHASE_OUTPUT block found"}

    payload = match.group(1).strip()
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError as exc:
        return {"raw": details, "parse_error": str(exc)}

    if not isinstance(parsed, dict):
        return {
            "raw": details,
            "parse_error": f"PHASE_OUTPUT JSON is not an object (got {type(parsed).__name__})",
        }

    return parsed


# ─── Rendering ───────────────────────────────────────────────────────────


def format_scout_findings_markdown(findings: Any) -> str:
    """Format scout findings as a markdown block for the builder prompt.

    Accepts any of: :class:`ScoutFindings`, a ``dict`` (possibly partial /
    malformed), a parse-error envelope (``{"raw": ..., "parse_error": ...}``),
    or ``None``. The function guarantees a non-empty string so the builder
    prompt always has a stable value to substitute.

    The returned markdown always begins with the ``## Scout Findings``
    heading so the builder prompt's section is always present. The body
    adapts to the findings content:

        - ``None`` → heading + "(no scout findings — proceed with general exploration)"
        - parse-error envelope → heading + "(raw, unparseable)" + raw text
        - empty ``ScoutFindings`` or empty dict → heading + "(scout ran but produced no findings)"
        - populated → heading + all populated sub-sections

    Args:
        findings: A :class:`ScoutFindings`, a dict, or ``None``.

    Returns:
        Markdown string starting with ``## Scout Findings``. Never empty.
    """
    if findings is None:
        return "## Scout Findings\n\n_(No scout findings — proceed with general exploration.)_\n"

    if isinstance(findings, ScoutFindings):
        if not any([
            findings.relevant_files, findings.test_command,
            findings.patterns, findings.conventions, findings.risks,
        ]):
            return "## Scout Findings\n\n_(Scout ran but produced no findings.)_\n"
        return findings.to_markdown()

    if isinstance(findings, dict):
        # Unparseable: caller passed a parse-error envelope
        if "parse_error" in findings and "raw" in findings:
            raw = findings.get("raw") or ""
            err = findings.get("parse_error") or "unknown parse error"
            return (
                f"## Scout Findings (raw, unparseable)\n\n"
                f"**Reason:** {err}\n\n"
                f"```\n{raw}\n```\n"
            )

        # Try to upgrade to ScoutFindings for type-safe rendering
        sf = ScoutFindings.from_dict(findings)
        if not any([
            sf.relevant_files, sf.test_command,
            sf.patterns, sf.conventions, sf.risks,
        ]):
            return "## Scout Findings\n\n_(Scout ran but produced no findings.)_\n"
        return sf.to_markdown()

    return "## Scout Findings\n\n_(No scout findings — proceed with general exploration.)_\n"
