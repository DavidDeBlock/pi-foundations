#!/usr/bin/env python3
"""
scripts/build-pass-rate.py — Maestro build pass rate measurement.

Scans session logs in `.pi/maestro/sessions/<issue>/` and computes the
build pass rate from the verdict blocks emitted by the builder phase.

A "build" is a single end-to-end flow run on one issue. The build is
considered "passed" if the final builder phase emitted a verdict with
status="approved" (and the reviewer accepted, if reviewer ran).

The "build pass rate" = (number of issues whose flow ended in
"approved") / (number of issues with at least one verdict-producing
phase). When multiple builders ran (retries), the LAST verdict wins.

This is the metric tracked by the Wave 1 success-metrics table in
`docs/35-prds/maestro-case-improvements-roadmap.md` §6:
    - Build pass rate baseline: ~60% (pre-Wave 1)
    - Build pass rate target:   ~70% (post-Wave 1)

Usage:
    python scripts/build-pass-rate.py                                # Default
    python scripts/build-pass-rate.py --json                         # Machine-readable
    python scripts/build-pass-rate.py --flow builder-reviewer        # Filter by flow
    python scripts/build-pass-rate.py --issue 240                    # Single issue
    python scripts/build-pass-rate.py --help                         # Show usage

Examples:
    python scripts/build-pass-rate.py
    python scripts/build-pass-rate.py --json | jq '.pass_rate_pct'
"""

import json
import sys
from pathlib import Path
from collections import defaultdict
from datetime import datetime
import argparse


# Resolve relative to this script so the script is callable from anywhere.
MAESTRO_DIR = Path(__file__).resolve().parent.parent
SESSIONS_DIR = MAESTRO_DIR / "sessions"

# Ensure lib is importable so we can reuse the verdict extractor.
sys.path.insert(0, str(MAESTRO_DIR))
from lib.verdict_extractor import extract_phase_verdict  # noqa: E402


# ─── Verdict collection helpers ────────────────────────────────────────


def _parse_log_name(name: str) -> tuple[str, str, str]:
    """Parse a log entry name into ``(flow, phase, timestamp)``.

    Format: ``<flow>-<phase>-<ISO8601>``.

    Flows can be hyphenated (``builder-test-reviewer``), so we anchor on the
    ISO8601 timestamp at the tail — the *last* ``-``-separated chunk that
    matches the timestamp pattern is the timestamp, and the chunk immediately
    before it is the phase. Everything before that is the flow.
    """
    import re

    # ISO8601 timestamps can be hyphen-delimited (e.g. "2026-05-31T17:05:54"),
    # so the timestamp boundary is the part that begins with a 4-digit year.
    iso_re = re.compile(r"^\d{4}$")

    parts = name.split("-")
    # Find the timestamp index: the first part that is a 4-digit year. The
    # timestamp then runs until the end of the string.
    ts_idx = None
    for i, p in enumerate(parts):
        if iso_re.match(p):
            ts_idx = i
            break

    if ts_idx is None:
        # Fallback: assume single timestamp chunk at the end.
        timestamp = parts[-1]
        rest = parts[:-1]
    else:
        timestamp = "-".join(parts[ts_idx:])
        rest = parts[:ts_idx]

    if len(rest) < 2:
        return rest[0] if rest else "", "", timestamp

    # Last element of ``rest`` is the phase; everything before is the flow.
    flow = "-".join(rest[:-1])
    phase = rest[-1]
    return flow, phase, timestamp


def _classify_log(log_path: Path) -> dict:
    """Return metadata about a single session log file.

    Returns:
        Dict with keys: issue, flow, phase, timestamp, verdict (str|None)

    Supports both the modern flat layout (`<issue>/<flow>-<phase>-<ts>.jsonl`)
    and the legacy directory layout (`<issue>/<flow>-<phase>-<ts>.jsonl/...`).
    In the legacy case, we recurse into the directory and pick the first
    `*.jsonl` we find.

    The flow/phase/timestamp are parsed from the *directory* name in the
    legacy case, not the inner jsonl filename (which is a UUID).
    """
    # Legacy directory layout: <flow>-<phase>-<ts>.jsonl/<filename>.jsonl
    if log_path.is_dir():
        nested = sorted(log_path.glob("*.jsonl"))
        if not nested:
            return None  # type: ignore[return-value]
        # Directory name is the readable flow-phase-timestamp label.
        label = log_path.stem
        flow, phase, timestamp = _parse_log_name(label)
        issue_num = None
        try:
            issue_num = int(log_path.parent.name)
        except ValueError:
            pass
        verdict = extract_phase_verdict(nested[0])
    else:
        flow, phase, timestamp = _parse_log_name(log_path.stem)
        issue_num = None
        try:
            issue_num = int(log_path.parent.name)
        except ValueError:
            pass
        verdict = extract_phase_verdict(log_path)
    return {
        "issue": issue_num,
        "flow": flow,
        "phase": phase,
        "timestamp": timestamp,
        "verdict_status": verdict.get("status"),
        "verdict_details": verdict.get("details", ""),
        "log_path": str(log_path),
    }


def _collect_logs(sessions_dir: Path, issue_filter: int | None = None,
                  flow_filter: str | None = None) -> list[dict]:
    """Walk sessions/ and classify every log, optionally filtered."""
    if not sessions_dir.is_dir():
        return []

    results: list[dict] = []

    for issue_dir in sorted(sessions_dir.iterdir(), key=lambda p: p.name):
        if not issue_dir.is_dir():
            continue
        # Skip non-numeric directories (e.g. 999 staging dir).
        if not issue_dir.name.isdigit():
            continue

        for log_file in sorted(issue_dir.glob("*.jsonl")):
            meta = _classify_log(log_file)
            if meta is None:
                continue
            if issue_filter is not None and meta["issue"] != issue_filter:
                continue
            if flow_filter and meta["flow"] != flow_filter:
                continue
            results.append(meta)

    return results


# ─── Aggregation ──────────────────────────────────────────────────────


def _latest_verdict_per_issue(logs: list[dict]) -> list[dict]:
    """Reduce many phase runs to one verdict per issue.

    Strategy:
      1. Group by issue.
      2. Within an issue, group by phase; take the latest log per phase.
      3. Among the surviving phases, prefer reviewer over builder (the
         reviewer is the final authority — see flow.json transitions).
      4. Fall back to the latest builder verdict when no reviewer ran.
    """
    by_issue: dict[int, list[dict]] = defaultdict(list)
    for entry in logs:
        if entry["issue"] is None:
            continue
        by_issue[entry["issue"]].append(entry)

    results: list[dict] = []
    for issue, entries in sorted(by_issue.items()):
        # Per-phase latest.
        latest_per_phase: dict[str, dict] = {}
        for e in entries:
            current = latest_per_phase.get(e["phase"])
            if current is None or e["timestamp"] > current["timestamp"]:
                latest_per_phase[e["phase"]] = e

        # Pick winner.
        if "reviewer" in latest_per_phase:
            winner = latest_per_phase["reviewer"]
        elif "builder" in latest_per_phase:
            winner = latest_per_phase["builder"]
        else:
            # No verdict-producing phase for this issue — skip.
            continue

        results.append({
            "issue": issue,
            "winning_phase": winner["phase"],
            "verdict": winner["verdict_status"],
            "flow": winner["flow"],
            "timestamp": winner["timestamp"],
            "details": winner["verdict_details"],
        })
    return results


def _compute_metrics(per_issue: list[dict]) -> dict:
    """Compute pass rate, breakdown, and timeline metrics."""
    if not per_issue:
        return {
            "issues_with_verdict": 0,
            "issues_passed": 0,
            "issues_failed": 0,
            "issues_pending": 0,
            "pass_rate_pct": 0.0,
            "by_flow": {},
            "by_month": {},
        }

    passed = sum(1 for r in per_issue if r["verdict"] == "approved")
    failed = sum(1 for r in per_issue if r["verdict"] == "rejected")
    pending = len(per_issue) - passed - failed
    decided = passed + failed
    rate = (passed / decided * 100.0) if decided else 0.0

    by_flow: dict[str, dict] = defaultdict(lambda: {"passed": 0, "failed": 0, "pending": 0})
    for r in per_issue:
        bucket = by_flow[r["flow"]]
        if r["verdict"] == "approved":
            bucket["passed"] += 1
        elif r["verdict"] == "rejected":
            bucket["failed"] += 1
        else:
            bucket["pending"] += 1

    by_month: dict[str, dict] = defaultdict(lambda: {"passed": 0, "failed": 0, "pending": 0})
    for r in per_issue:
        ts = r["timestamp"]
        # ISO8601 starts with YYYY-MM-DD
        if len(ts) >= 7:
            month = ts[:7]
        else:
            month = "unknown"
        bucket = by_month[month]
        if r["verdict"] == "approved":
            bucket["passed"] += 1
        elif r["verdict"] == "rejected":
            bucket["failed"] += 1
        else:
            bucket["pending"] += 1

    return {
        "issues_with_verdict": len(per_issue),
        "issues_passed": passed,
        "issues_failed": failed,
        "issues_pending": pending,
        "pass_rate_pct": round(rate, 1),
        "by_flow": {k: dict(v) for k, v in by_flow.items()},
        "by_month": {k: dict(v) for k, v in sorted(by_month.items())},
    }


# ─── Output rendering ────────────────────────────────────────────────


def _generate_markdown(metrics: dict, per_issue: list[dict], session_count: int) -> str:
    """Render a human-readable build pass rate report."""
    decided = metrics["issues_passed"] + metrics["issues_failed"]
    out = [
        "# Maestro Build Pass Rate",
        "",
        f"**Session logs scanned:** {session_count}",
        f"**Issues with verdicts:** {metrics['issues_with_verdict']}",
        f"**Issues passed:** {metrics['issues_passed']} ",
        f"**Issues failed:** {metrics['issues_failed']} ",
        f"**Issues pending:** {metrics['issues_pending']} ",
        "",
        f"## Pass rate: **{metrics['pass_rate_pct']}%** ({metrics['issues_passed']}/{decided})",
        "",
        "Reference targets (per `docs/35-prds/maestro-case-improvements-roadmap.md` §6):",
        "- Baseline (pre-Wave 1): ~60%",
        "- Wave 1 target: ~70%",
        "",
    ]

    if metrics["by_flow"]:
        out.append("## By flow")
        out.append("")
        out.append("| Flow | Passed | Failed | Pending |")
        out.append("|------|--------|--------|---------|")
        for flow, counts in sorted(metrics["by_flow"].items()):
            out.append(
                f"| `{flow}` | {counts['passed']} | {counts['failed']} | {counts['pending']} |"
            )
        out.append("")

    if metrics["by_month"]:
        out.append("## By month")
        out.append("")
        out.append("| Month | Passed | Failed | Pending |")
        out.append("|-------|--------|--------|---------|")
        for month, counts in metrics["by_month"].items():
            out.append(
                f"| {month} | {counts['passed']} | {counts['failed']} | {counts['pending']} |"
            )
        out.append("")

    if per_issue:
        out.append("## Per-issue verdicts")
        out.append("")
        out.append("| Issue | Flow | Phase | Verdict | Timestamp |")
        out.append("|------:|------|-------|---------|-----------|")
        for r in per_issue:
            verdict = r["verdict"] or "—"
            out.append(
                f"| {r['issue']} | `{r['flow']}` | {r['winning_phase']} | {verdict} | {r['timestamp']} |"
            )

    return "\n".join(out) + "\n"


def _generate_json(metrics: dict, per_issue: list[dict], session_count: int) -> str:
    return json.dumps(
        {
            "session_logs_scanned": session_count,
            "metrics": metrics,
            "per_issue": per_issue,
        },
        indent=2,
    )


def _generate_help() -> str:
    return """Usage: python scripts/build-pass-rate.py [options]

Measures Maestro build pass rate by scanning `.pi/maestro/sessions/<n>/*.jsonl`
and extracting the verdict emitted by the builder (or reviewer, when present)
phase of each flow run.

Options:
  --issue <n>      Only include logs for issue number <n>
  --flow <name>    Only include logs for flow <name> (e.g. builder-reviewer)
  --json           Output detailed JSON
  --help           Show this help message

Examples:
  python scripts/build-pass-rate.py
  python scripts/build-pass-rate.py --json
  python scripts/build-pass-rate.py --flow builder-reviewer
  python scripts/build-pass-rate.py --issue 246
"""


# ─── Main ──────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build pass rate measurement from Maestro session logs.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=_generate_help(),
    )
    parser.add_argument("--issue", type=int, default=None, help="Filter to one issue")
    parser.add_argument("--flow", type=str, default=None, help="Filter to one flow name")
    parser.add_argument("--json", action="store_true", help="Output detailed JSON")
    parser.add_argument("--help-all", action="store_true", help="Show extended help")
    args = parser.parse_args()

    if args.help_all:
        print(_generate_help())
        return 0

    logs = _collect_logs(SESSIONS_DIR, issue_filter=args.issue, flow_filter=args.flow)
    per_issue = _latest_verdict_per_issue(logs)
    metrics = _compute_metrics(per_issue)

    if args.json:
        print(_generate_json(metrics, per_issue, len(logs)))
    else:
        print(_generate_markdown(metrics, per_issue, len(logs)))

    return 0


if __name__ == "__main__":
    sys.exit(main())
