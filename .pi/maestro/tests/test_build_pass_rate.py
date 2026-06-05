#!/usr/bin/env python3
"""
Unit tests for build-pass-rate.py — Maestro build pass rate script.

Covers:
- Log name parsing (flow / phase / timestamp) for hyphenated flows
- Legacy directory layout where the "log file" is actually a directory
- Verdict aggregation per issue (latest per phase; reviewer wins over builder)
- Pass rate computation
- JSON output structure

Run with: python3 -m pytest tests/test_build_pass_rate.py
"""

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

import pytest

# Add scripts/ to path so we can import the script module.
SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))


def _load_script(name: str):
    """Load a top-level script from .pi/maestro/scripts/ by name."""
    spec = importlib.util.spec_from_file_location(name, SCRIPTS_DIR / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


bpr = _load_script("build-pass-rate")


# ─── _parse_log_name ─────────────────────────────────────────────────


class TestParseLogName:
    def test_simple_flow(self):
        # Only one part before the timestamp — phase slot is empty, the
        # entire prefix becomes the flow.
        flow, phase, ts = bpr._parse_log_name("builder-2026-05-31T17:05:54")
        assert flow == "builder"
        assert phase == ""
        assert ts == "2026-05-31T17:05:54"

    def test_hyphenated_flow(self):
        flow, phase, ts = bpr._parse_log_name("builder-reviewer-builder-2026-05-31T17:05:54")
        assert flow == "builder-reviewer"
        assert phase == "builder"
        assert ts == "2026-05-31T17:05:54"

    def test_triple_hyphen_flow(self):
        flow, phase, ts = bpr._parse_log_name("builder-test-reviewer-builder-2026-05-31T17:05:54")
        assert flow == "builder-test-reviewer"
        assert phase == "builder"
        assert ts == "2026-05-31T17:05:54"

    def test_full_lifecycle_flow(self):
        flow, phase, ts = bpr._parse_log_name("full-lifecycle-reviewer-2026-06-01T07:30:26")
        assert flow == "full-lifecycle"
        assert phase == "reviewer"
        assert ts == "2026-06-01T07:30:26"

    def test_prd_to_issues_flow(self):
        flow, phase, ts = bpr._parse_log_name("prd-to-issues-reviewer-archivist-2026-06-01T16:20:25")
        assert flow == "prd-to-issues-reviewer"
        assert phase == "archivist"
        assert ts == "2026-06-01T16:20:25"


# ─── _classify_log (legacy directory layout) ─────────────────────────


def _make_verdict_jsonl(verdict_status: str, tmpdir: Path,
                        issue: str, log_name: str) -> Path:
    """Create a fake session directory with a verdict block.

    Layout: ``<tmpdir>/<issue>/<log_name>.jsonl/<filename>.jsonl``
    """
    issue_dir = tmpdir / issue
    log_dir = issue_dir / f"{log_name}.jsonl"
    log_dir.mkdir(parents=True)

    body = (
        f"```verdict\n"
        f'{{"status": "{verdict_status}", "details": "test", "issues": []}}\n'
        f"```\n"
    )
    inner = log_dir / "2026-05-31T17-05-55-235Z_uuid.jsonl"
    inner.write_text(
        json.dumps(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": body}],
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )
    return log_dir


class TestClassifyLogLegacyLayout:
    def test_legacy_directory_uses_dir_name(self, tmp_path, monkeypatch):
        log_dir = _make_verdict_jsonl(
            "approved", tmp_path, "240", "full-lifecycle-builder-2026-05-31T17:05:54"
        )
        meta = bpr._classify_log(log_dir)

        assert meta is not None
        assert meta["issue"] == 240
        assert meta["flow"] == "full-lifecycle"
        assert meta["phase"] == "builder"
        assert meta["timestamp"] == "2026-05-31T17:05:54"
        assert meta["verdict_status"] == "approved"

    def test_legacy_directory_rejected(self, tmp_path):
        log_dir = _make_verdict_jsonl(
            "rejected", tmp_path, "255", "full-lifecycle-reviewer-2026-06-02T21:15:18"
        )
        meta = bpr._classify_log(log_dir)

        assert meta is not None
        assert meta["issue"] == 255
        assert meta["verdict_status"] == "rejected"


# ─── _collect_logs and aggregation ──────────────────────────────────


class TestCollectLogs:
    def test_walks_sessions_dir(self, tmp_path, monkeypatch):
        _make_verdict_jsonl("approved", tmp_path, "1", "builder-reviewer-builder-2026-05-17T00:00:00")
        _make_verdict_jsonl("rejected", tmp_path, "2", "builder-reviewer-reviewer-2026-05-17T00:01:00")

        monkeypatch.setattr(bpr, "SESSIONS_DIR", tmp_path)
        logs = bpr._collect_logs(tmp_path)

        # Two issues, one log each.
        assert len(logs) == 2
        statuses = {l["verdict_status"] for l in logs}
        assert statuses == {"approved", "rejected"}

    def test_filter_by_issue(self, tmp_path, monkeypatch):
        _make_verdict_jsonl("approved", tmp_path, "1", "builder-reviewer-builder-2026-05-17T00:00:00")
        _make_verdict_jsonl("approved", tmp_path, "2", "builder-reviewer-builder-2026-05-17T00:01:00")

        monkeypatch.setattr(bpr, "SESSIONS_DIR", tmp_path)
        logs = bpr._collect_logs(tmp_path, issue_filter=1)

        assert len(logs) == 1
        assert logs[0]["issue"] == 1

    def test_filter_by_flow(self, tmp_path, monkeypatch):
        _make_verdict_jsonl("approved", tmp_path, "1", "builder-reviewer-builder-2026-05-17T00:00:00")
        _make_verdict_jsonl("approved", tmp_path, "1", "full-lifecycle-builder-2026-05-17T00:00:00")

        monkeypatch.setattr(bpr, "SESSIONS_DIR", tmp_path)
        logs = bpr._collect_logs(tmp_path, flow_filter="builder-reviewer")

        assert len(logs) == 1
        assert logs[0]["flow"] == "builder-reviewer"


class TestLatestVerdictPerIssue:
    def test_picks_latest_per_phase(self):
        logs = [
            {"issue": 1, "phase": "builder", "timestamp": "2026-05-17T00:00:00", "verdict_status": "rejected", "flow": "builder-reviewer", "verdict_details": ""},
            {"issue": 1, "phase": "builder", "timestamp": "2026-05-17T00:05:00", "verdict_status": "approved", "flow": "builder-reviewer", "verdict_details": ""},
        ]
        per_issue = bpr._latest_verdict_per_issue(logs)
        assert len(per_issue) == 1
        assert per_issue[0]["verdict"] == "approved"

    def test_reviewer_beats_builder(self):
        logs = [
            {"issue": 1, "phase": "builder", "timestamp": "2026-05-17T00:00:00", "verdict_status": "approved", "flow": "builder-reviewer", "verdict_details": ""},
            {"issue": 1, "phase": "reviewer", "timestamp": "2026-05-17T00:05:00", "verdict_status": "rejected", "flow": "builder-reviewer", "verdict_details": ""},
        ]
        per_issue = bpr._latest_verdict_per_issue(logs)
        assert per_issue[0]["verdict"] == "rejected"
        assert per_issue[0]["winning_phase"] == "reviewer"

    def test_skips_issues_with_no_verdict_phase(self):
        logs = [
            {"issue": 1, "phase": "diagnostic", "timestamp": "2026-05-17T00:00:00", "verdict_status": None, "flow": "builder-reviewer", "verdict_details": ""},
        ]
        per_issue = bpr._latest_verdict_per_issue(logs)
        assert per_issue == []


# ─── _compute_metrics ────────────────────────────────────────────────


class TestComputeMetrics:
    def test_empty_input(self):
        m = bpr._compute_metrics([])
        assert m["pass_rate_pct"] == 0.0
        assert m["issues_with_verdict"] == 0

    def test_pure_pass(self):
        per_issue = [
            {"issue": 1, "verdict": "approved", "flow": "builder-reviewer", "timestamp": "2026-05-17T00:00:00"},
            {"issue": 2, "verdict": "approved", "flow": "builder-reviewer", "timestamp": "2026-05-17T00:00:00"},
        ]
        m = bpr._compute_metrics(per_issue)
        assert m["issues_passed"] == 2
        assert m["issues_failed"] == 0
        assert m["pass_rate_pct"] == 100.0

    def test_mixed(self):
        per_issue = [
            {"issue": 1, "verdict": "approved", "flow": "builder-reviewer", "timestamp": "2026-05-17T00:00:00"},
            {"issue": 2, "verdict": "rejected", "flow": "builder-reviewer", "timestamp": "2026-05-17T00:00:00"},
            {"issue": 3, "verdict": "approved", "flow": "builder-reviewer", "timestamp": "2026-05-17T00:00:00"},
            {"issue": 4, "verdict": "approved", "flow": "builder-reviewer", "timestamp": "2026-05-17T00:00:00"},
        ]
        m = bpr._compute_metrics(per_issue)
        # 3 of 4 decided = 75%
        assert m["pass_rate_pct"] == 75.0

    def test_pending_does_not_count(self):
        per_issue = [
            {"issue": 1, "verdict": "approved", "flow": "builder-reviewer", "timestamp": "2026-05-17T00:00:00"},
            {"issue": 2, "verdict": None, "flow": "builder-reviewer", "timestamp": "2026-05-17T00:00:00"},
        ]
        m = bpr._compute_metrics(per_issue)
        # 1/1 decided = 100%; pending is excluded from the rate.
        assert m["pass_rate_pct"] == 100.0
        assert m["issues_pending"] == 1

    def test_by_flow_breakdown(self):
        per_issue = [
            {"issue": 1, "verdict": "approved", "flow": "builder-reviewer", "timestamp": "2026-05-17T00:00:00"},
            {"issue": 2, "verdict": "rejected", "flow": "builder-reviewer", "timestamp": "2026-05-17T00:00:00"},
            {"issue": 3, "verdict": "approved", "flow": "full-lifecycle", "timestamp": "2026-05-17T00:00:00"},
        ]
        m = bpr._compute_metrics(per_issue)
        assert m["by_flow"]["builder-reviewer"]["passed"] == 1
        assert m["by_flow"]["builder-reviewer"]["failed"] == 1
        assert m["by_flow"]["full-lifecycle"]["passed"] == 1
