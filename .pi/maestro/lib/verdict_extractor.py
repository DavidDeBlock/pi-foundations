#!/usr/bin/env python3
"""
verdict_extractor.py — Extract phase verdicts from JSONL session logs.

Parses assistant message text in session logs for ```verdict``` code fences,
extracts the JSON payload, and returns a standardized verdict dict consumed
by the fallback chain.

Usage:
    from lib.verdict_extractor import extract_phase_verdict

    verdict = extract_phase_verdict("/path/to/session.jsonl")
    # Returns: {"status": "approved", "details": "", "issues": [], "raw_text": "..."}
"""

import json
import re
from pathlib import Path
from typing import Optional


# ─── Verdict block extraction ────────────────────────────────────────────

def _extract_verdict_from_prose(text: str) -> Optional[dict]:
    """Fallback: extract verdict from prose when the agent writes it outside a code fence.

    The LLM sometimes writes its verdict as plain text (e.g. "Approval Status: rejected")
    instead of inside a ```verdict code block. This function scans for common patterns,
    but only in structured locations (headers or message ending) to avoid false positives.

    Returns:
        Standardized verdict dict, or None if no verdict pattern found.
    """
    # Only look at the last 1000 chars — verdicts appear at the END of messages
    search_text = text[-1000:]
    normalized = re.sub(r'\s+', ' ', search_text.lower())

    # Pattern 1: explicit status header (e.g. "## Approval Status: rejected")
    m = re.search(r'(?:approval|review)\s+status[.:]\s*(approved|rejected)', normalized)
    if m:
        return {"status": m.group(1), "details": f"Prose verdict detected: '{m.group(1)}'", "issues": []}

    # Pattern 2: explicit verdict header (e.g. "## Verdict: rejected")
    m = re.search(r'verdict[.:]\s*(approved|rejected)', normalized)
    if m:
        return {"status": m.group(1), "details": f"Prose verdict detected: '{m.group(1)}'", "issues": []}

    # Pattern 3: explicit approval/rejection phrases at end of message
    for phrase, status in [
        ("changes required", "rejected"),
        ("changes needed", "rejected"),
        ("must be fixed before merge", "rejected"),
        ("cannot merge", "rejected"),
    ]:
        if phrase in normalized:
            return {"status": status, "details": f"Prose verdict detected: '{phrase}'", "issues": []}

    # Pattern 4: standalone "approved" or "rejected" as a header keyword near end
    m = re.search(r'\b(?:approval|verdict|decision)[.:]\s*(approved)\b', normalized)
    if m:
        return {"status": "approved", "details": f"Prose verdict detected: 'approved'", "issues": []}

    return None


#: Outcomes the retrospective phase's PHASE_OUTPUT marker can declare.
#: Maps onto the binary verdict model the flow engine expects:
#:   - success  → approved (the retrospective itself completed cleanly)
#:   - failure  → rejected (the parent flow failed; retrospective still ran)
#:   - rejected → rejected (alias; matches the orchestrator comment-parser regex)
#:   - system_error → rejected (the retrospective hit a runtime error)
#: Mirrors PHASE_OUTPUT_PATTERN in lib/comment_parser.py and lib/github_client.py.
_PHASE_OUTPUT_OUTCOMES = {
    "success": "approved",
    "failure": "rejected",
    "rejected": "rejected",
    "system_error": "rejected",
}


def _extract_phase_output_block(text: str) -> Optional[dict]:
    """Fallback: extract verdict from a retrospective ``### PHASE_OUTPUT`` block.

    The retrospective phase (per ``prompts/retrospective.md``) emits its
    outcome as a fenced block delimited by::

        ---
        ### PHASE_OUTPUT: success
        { "outcome": "success", "what_worked": [...], ... }
        ### END_PHASE_OUTPUT
        ---

    This is richer than the binary approved/rejected verdict the flow
    engine consumes. We map the outer marker (``success`` / ``failure``
    / ``rejected`` / ``system_error``) onto the binary verdict model and
    return a verdict dict with the parsed JSON body in ``details`` so
    the flow engine can still log it.

    Why a fallback and not the primary path:
        Most phases emit `` ```verdict `` fences (the canonical contract).
        Only the retrospective phase uses ``PHASE_OUTPUT`` — keeping it
        as a fallback preserves backwards compatibility with every other
        flow that already uses fences correctly.

    Returns:
        Standardized verdict dict, or None if no ``PHASE_OUTPUT`` block
        is present. Note: we don't try to parse the JSON body here —
        that's ``learnings.parse_retrospective_output``'s job. We only
        return the binary verdict so the flow engine can route correctly;
        the persistence step in ``flow_engine._persist_retrospective_result``
        re-parses the body from the raw rpc output.
    """
    if not text:
        return None

    # The marker can be preceded by ``---\n`` (a horizontal rule) and
    # followed by JSON then ``### END_PHASE_OUTPUT``. We use a non-greedy
    # match on the outcome keyword and capture the full body.
    m = re.search(
        r"###\s*PHASE_OUTPUT:\s*(success|failure|rejected|system_error)\b",
        text,
        re.IGNORECASE,
    )
    if not m:
        return None

    outcome = m.group(1).lower()
    verdict_status = _PHASE_OUTPUT_OUTCOMES.get(outcome)
    if verdict_status is None:
        return None

    return {
        "status": verdict_status,
        "details": f"PHASE_OUTPUT block detected: outcome={outcome}",
        "issues": [],
    }


def _try_parse_verdict_json(body: str) -> Optional[dict]:
    """Parse verdict JSON with lenient fallbacks for common LLM artifacts.

    The LLM sometimes emits trailing characters inside the fence (extra `}`,
    whitespace, or stray punctuation). This function tries progressively
    aggressive cleanup strategies before giving up.

    Strategies (in order):
      1. Parse as-is
      2. Strip trailing `}` / `]` / whitespace chars
      3. Find the *last* valid JSON object by trimming from the end char-by-char
      4. Try json5-style parsing (handles single quotes, trailing commas)
    """
    # Strategy 1: straight parse
    try:
        return json.loads(body)
    except (json.JSONDecodeError, ValueError):
        pass

    stripped = body.strip()

    # Strategy 2: strip trailing braces/brackets/punctuation
    cleaned = stripped.rstrip("}]\t \r\n")
    if cleaned != stripped:
        try:
            return json.loads(cleaned)
        except (json.JSONDecodeError, ValueError):
            pass

    # Strategy 3: find last valid JSON object by trimming from the end char-by-char.
    # This handles cases like `{...}}}` or `{...} }` where there's a gap between
    # the closing `}` and whatever junk follows.
    for i in range(len(stripped) - 1, max(0, len(stripped) - 20), -1):
        candidate = stripped[:i].rstrip()
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            continue

    # Strategy 4: try replacing single quotes with double quotes and removing trailing commas.
    # Some LLMs emit JSON5-style objects inside the fence.
    alt = stripped.replace("'", '"')
    alt = re.sub(r',\s*([}\]])', r'\1', alt)  # remove trailing commas before ] or }
    try:
        return json.loads(alt)
    except (json.JSONDecodeError, ValueError):
        pass

    return None


def _extract_verdict_block(text: str) -> Optional[dict]:
    """Find the last ```verdict code fence in *text* and parse its JSON body.

    The agent is expected to emit a final verdict as a fenced block whose
    language tag is exactly ``verdict`` (not ``json``, ``text``, etc.).  We
    take the **last** such block so that earlier reasoning blocks don't
    shadow the final decision.

    Args:
        text: Full assistant message text (may contain multiple fences).

    Returns:
        Parsed verdict dict with keys ``status``, ``details``, ``issues`` —
        or ``None`` when no valid verdict block is found, the JSON inside is
        malformed, or the language tag isn't exactly ``verdict``.
    """
    # Match ```verdict ... (optional whitespace) then content until closing ```
    fence_re = re.compile(
        r"^```verdict\s*$\s*(.*?)\s*^```\s*$",
        re.MULTILINE | re.DOTALL,
    )

    matches = list(fence_re.finditer(text))
    if not matches:
        # No code fence found — try the PHASE_OUTPUT fallback (used by
        # the retrospective phase) before the generic prose fallback.
        # Order matters: fences are canonical, PHASE_OUTPUT is
        # retrospective-specific, prose is the last-ditch heuristic.
        phase_output = _extract_phase_output_block(text)
        if phase_output is not None:
            return phase_output
        return _extract_verdict_from_prose(text)

    # Use the LAST match (agent reasoning → final commit pattern)
    body = matches[-1].group(1).strip()
    if not body:
        # No code fence found — try the PHASE_OUTPUT fallback (used by
        # the retrospective phase) before the generic prose fallback.
        phase_output = _extract_phase_output_block(text)
        if phase_output is not None:
            return phase_output
        return _extract_verdict_from_prose(text)

    # Try parsing the body as-is first.
    # If that fails, try stripping trailing junk (common LLM artifact: extra `}` or whitespace).
    data = _try_parse_verdict_json(body)
    if data is None:
        # JSON inside fence is malformed — fall back to prose extraction on full text
        return _extract_verdict_from_prose(text)

    # Validate required keys and types
    if not isinstance(data, dict):
        return None

    status = data.get("status")
    if status not in ("approved", "rejected"):
        return None

    details = str(data.get("details", ""))
    issues_raw = data.get("issues", [])
    if not isinstance(issues_raw, list):
        issues_raw = []
    issues: list[str] = [str(i) for i in issues_raw]

    return {
        "status": status,
        "details": details,
        "issues": issues,
    }


# ─── Session log parsing helpers ────────────────────────────────────────

def _parse_assistant_text(event: dict) -> Optional[str]:
    """Extract plain text from an assistant message event.

    Silently returns None for malformed events (non-dict, missing fields).
    """
    if not isinstance(event, dict):
        return None
    message = event.get("message")
    if not message or message.get("role") != "assistant":
        return None

    content = message.get("content", [])
    texts = []

    for part in (content if isinstance(content, list) else []):
        if isinstance(part, dict) and part.get("type") == "text":
            text = part.get("text", "")
            if isinstance(text, str):
                texts.append(text)

    return "\n".join(texts) if texts else None


# ─── Public API ──────────────────────────────────────────────────────────

def extract_phase_verdict(log_path: str | Path) -> dict:
    """Extract the phase verdict from a JSONL session log.

    Scans all assistant message text for `` ```verdict `` code fences and
    parses the last valid one as JSON.  Malformed JSON lines are silently
    skipped (never crash).

    Args:
        log_path: Path to a JSONL session log file.

    Returns:
        Dict with keys:
            - status (str|None): "approved", "rejected", or None if no verdict found
            - details (str): Free-text explanation from the verdict block
            - issues (list[str]): Issue descriptions extracted from the verdict block
            - raw_text (str): The full text where the verdict was found (truncated to 500 chars)
    """
    path = Path(log_path)

    # File must exist and be non-empty
    if not path.exists():
        return {"status": None, "details": "", "issues": [], "raw_text": ""}

    file_size = path.stat().st_size
    if file_size == 0:
        return {"status": None, "details": "", "issues": [], "raw_text": ""}

    all_assistant_text: list[str] = []

    # Read JSONL line by line — malformed lines are silently skipped
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            try:
                event = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                # Malformed JSON — skip silently, never crash
                continue

            text = _parse_assistant_text(event)
            if text is not None:
                all_assistant_text.append(text)

    combined_text = "\n".join(all_assistant_text)
    if not combined_text.strip():
        return {"status": None, "details": "", "issues": [], "raw_text": ""}

    verdict = _extract_verdict_block(combined_text)
    if verdict is None:
        return {"status": None, "details": "", "issues": [], "raw_text": ""}

    # Truncate raw_text to 500 chars for readability
    raw_snippet = combined_text[-500:] if len(combined_text) > 500 else combined_text

    return {
        "status": verdict["status"],
        "details": verdict["details"],
        "issues": verdict["issues"],
        "raw_text": raw_snippet,
    }


def extract_latest_verdict_from_log_dir(log_dir: str | Path) -> dict[str, dict]:
    """Extract the verdict from the most recent JSONL file in a session directory.

    Sorts ```.jsonl``` files by name (reverse alphabetical, which corresponds to
    reverse chronological for timestamped filenames) and extracts the verdict
    from only the latest file.  The result is always a single-key dict mapping
    the filename to its verdict.

    Args:
        log_dir: Path to a session directory containing .jsonl files.

    Returns:
        Dict with at most one key (the latest ```.jsonl``` filename) mapped to
        its verdict dict.  Empty if the directory has no ```.jsonl``` files.
    """
    path = Path(log_dir)
    if not path.is_dir():
        return {}

    verdicts: dict[str, dict] = {}
    jsonl_files = sorted(path.glob("*.jsonl"), reverse=True)  # Most recent first

    for jsonl_file in jsonl_files[:1]:  # Only the latest session file
        verdicts[jsonl_file.name] = extract_phase_verdict(jsonl_file)

    return verdicts


# --- Convenience: find session log from directory or flat path ---

def resolve_session_log(session_dir_or_file: str | Path) -> Optional[Path]:
    """Resolve a session reference to an actual .jsonl file.

    Supports both old subdirectory layout (<issue>-<flow>-<phase>-<ts>/*.jsonl)
    and new flat file layout (<issue>/<flow>-<phase>-<ISO8601>.jsonl).

    Args:
        session_dir_or_file: Path to a session directory or .jsonl file.

    Returns:
        Path to the .jsonl file, or None if not found.
    """
    path = Path(session_dir_or_file)

    # If it's already a .jsonl file, return as-is
    if path.is_file() and path.suffix == ".jsonl":
        return path

    # If it's a directory with exactly one .jsonl file, return that
    if path.is_dir():
        jsonl_files = list(path.glob("*.jsonl"))
        if len(jsonl_files) == 1:
            return jsonl_files[0]
        elif len(jsonl_files) > 1:
            # Return the most recent one (sorted by name, which includes timestamp)
            return sorted(jsonl_files)[-1]

    return None
