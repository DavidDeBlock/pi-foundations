#!/usr/bin/env python3
"""
dashboard_api.py — Shared data layer for Maestro Dashboard.

Provides a clean API interface between the UI panels and backend services:
- Lazy GitHub client initialization
- Session directory scanning (stubbed for future use)
- Flow config loading from flows/*.json
- Structured error handling (returns success dicts, not exceptions)

Usage:
    from lib.dashboard_api import DashboardAPI
    
    api = DashboardAPI()
    
    # Fetch issues with label
    result = await api.fetch_issues_by_label("needs-triage")
    if result["success"]:
        for issue in result["data"]:
            print(issue.title)
    else:
        print(f"Error: {result['error']}")
"""

import json
import re
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field


@dataclass
class DashboardResult:
    """Structured result for API methods.
    
    All public methods return this instead of raising exceptions,
    allowing panels to handle errors gracefully without crashing.
    """
    success: bool
    data: any = None
    error: str = ""


class DashboardAPI:
    """Shared API layer for the Maestro Dashboard.
    
    Encapsulates all I/O operations (GitHub API, file system reads)
    behind a clean interface with consistent error handling patterns.
    Lazy-initializes expensive resources like the GitHub client.
    """

    def __init__(self, repo_override: Optional[str] = None):
        self._repo_override = repo_override
        self._github_client = None
        
        # Paths relative to .pi/maestro/
        self.maestro_root = Path(__file__).resolve().parent.parent
        self.flows_dir = self.maestro_root / "flows"
        self.state_dir = self.maestro_root / "state"

    @property
    def github_client(self):
        """Lazy-initialized GitHub client.
        
        Returns:
            GithubClient instance, initialized on first access.
        """
        if self._github_client is None:
            from lib.github_client import GithubClient
            self._github_client = GithubClient(repo_override=self._repo_override)
        return self._github_client

    def fetch_issues_by_label(self, label: str) -> DashboardResult:
        """Fetch open GitHub issues with a specific label.
        
        Args:
            label: GitHub label to filter by (e.g., 'needs-triage').
            
        Returns:
            DashboardResult with list of Issue objects on success,
            or error message on failure.
        """
        try:
            issues = self.github_client.fetch_issues_by_label(label)
            return DashboardResult(success=True, data=issues)
        except Exception as e:
            return DashboardResult(
                success=False,
                data=None,
                error=f"Failed to fetch issues with label '{label}': {str(e)}"
            )

    def fetch_issues(
        self,
        labels: list[str] | None = None
    ) -> DashboardResult:
        """Fetch open issues matching any of the given labels.

        Merges results from multiple label queries, deduplicates by issue
        number, and sorts by recency (newest first).

        Args:
            labels: List of GitHub labels to filter by. Defaults to
                    ['needs-triage', 'parent-prd'].

        Returns:
            DashboardResult with list of Issue objects sorted by
            created_at descending, or error message on failure.
        """
        if labels is None:
            labels = ["needs-triage", "parent-prd"]

        try:
            issues = self.github_client.fetch_issues_by_labels(labels)
            return DashboardResult(success=True, data=issues)
        except Exception as e:
            return DashboardResult(
                success=False,
                data=None,
                error=f"Failed to fetch issues: {str(e)}"
            )

    def fetch_issue(self, issue_num: int) -> DashboardResult:
        """Fetch a single GitHub issue by number.
        
        Args:
            issue_num: GitHub issue number to fetch.
            
        Returns:
            DashboardResult with Issue object on success,
            or error message on failure.
        """
        try:
            issue = self.github_client.fetch_issue(issue_num)
            if issue is None:
                return DashboardResult(
                    success=False,
                    data=None,
                    error=f"Issue #{issue_num} not found"
                )
            return DashboardResult(success=True, data=issue)
        except Exception as e:
            return DashboardResult(
                success=False,
                data=None,
                error=f"Failed to fetch issue #{issue_num}: {str(e)}"
            )

    def _parse_session_name(self, name: str) -> dict | None:
        """Parse a session directory/file name into structured components.

        Supports two layouts:
          - Old: <issue>-<flow>-<phase>-YYYYMMDD-HHMMSS
            e.g. 177-builder-reviewer-builder-20260526-193930
            (note: flow may contain hyphens, so we split from the right)
          - New: <flow>-<phase>-<ISO8601>.jsonl (inside an issue-numbered dir)
            e.g. builder-reviewer-builder-2026-05-27T00:02:26.jsonl

        Args:
            name: The session directory or file prefix to parse.

        Returns:
            Dict with keys: issue (int|None), flow (str|None), phase (str|None),
            timestamp (str|None), raw_name (str).
        """
        # Try old layout: <issue>-<flow>-<phase>-YYYYMMDD-HHMMSS
        # e.g. 177-builder-reviewer-builder-20260526-193930
        old_pattern = r'^(\d+)-(.*)-(\d{8}-\d{6})$'
        m = re.match(old_pattern, name)
        if m:
            issue_num = int(m.group(1))
            middle = m.group(2)  # e.g. "builder-reviewer-builder"
            timestamp = m.group(3)  # e.g. "20260526-193930"

            # Split the middle part from the right: last segment is phase,
            # everything before that is flow.
            last_hyphen = middle.rfind("-")
            if last_hyphen > 0:
                flow = middle[:last_hyphen]
                phase = middle[last_hyphen + 1:]
            else:
                flow = middle
                phase = "unknown"

            return {
                "issue": issue_num,
                "flow": flow,
                "phase": phase,
                "timestamp": timestamp,
                "raw_name": name,
            }

        # Try new layout: <flow>-<phase>-<ISO8601>.jsonl
        # e.g. builder-reviewer-builder-2026-05-27T00:02:26.jsonl
        # The ISO timestamp contains colons, so we can use that to anchor.
        new_pattern = r'^(.+?)-(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.jsonl$'
        m = re.match(new_pattern, name)
        if m:
            middle = m.group(1)  # e.g. "builder-reviewer-builder"
            timestamp = m.group(2)  # e.g. "2026-05-27T00:02:26"

            # Split the middle part from the right: last segment is phase,
            # everything before that is flow.
            last_hyphen = middle.rfind("-")
            if last_hyphen > 0:
                flow = middle[:last_hyphen]
                phase = middle[last_hyphen + 1:]
            else:
                flow = middle
                phase = "unknown"

            return {
                "issue": None,
                "flow": flow,
                "phase": phase,
                "timestamp": timestamp,
                "raw_name": name,
            }

        return None

    def get_all_sessions(
        self,
        sessions_dir: Optional[str] = None,
        days_limit: int | None = None,
    ) -> DashboardResult:
        """Scan the sessions directory and return structured summaries.

        Recursively scans both old (<issue>-<flow>-<phase>-<ts>/) and new
        (<issue>/<flow>-<phase>-<ISO>.jsonl/) layouts, parses each JSONL file,
        extracts verdicts via verdict_extractor, and returns a sorted list of
        session summaries.

        Args:
            sessions_dir: Override the default sessions directory path.
                         Defaults to ``sessions/`` under the maestro root.
            days_limit: If set, only include sessions from the last N days.

        Returns:
            DashboardResult with a list of summary dicts sorted by timestamp
            descending. Each dict contains:
              - issue (int|None): GitHub issue number
              - flow (str): Flow name (e.g. "builder-reviewer")
              - phase (str): Phase name (e.g. "builder", "reviewer")
              - model (str|None): Model used in the session
              - duration_seconds (float): Session duration
              - verdict_status (str|None): "approved", "rejected", or None
              - verdict_issues (list[str]): Issue descriptions if rejected
              - file_ops_count (int): Number of file operations
              - error_count (int): Number of errors encountered
              - timestamp_str (str): Original timestamp string from the name
        """
        try:
            scan_path = Path(sessions_dir) if sessions_dir else self.maestro_root / "sessions"

            if not scan_path.exists():
                return DashboardResult(success=True, data=[])

            summaries: list[dict] = []

            # Collect all candidate session directories
            # Each entry is (parsed_info_dict, session_dir_path)
            candidates: list[tuple[dict, Path]] = []

            for entry in sorted(scan_path.iterdir()):
                if not entry.is_dir():
                    continue

                entry_name = entry.name

                # --- New layout: <issue>/<flow>-<phase>-<ISO>.jsonl/ ---
                # The top-level dir is an issue number.
                # Subdirs match the pattern flow-phase-ISO.jsonl/
                if re.match(r'^\d+$', entry_name):
                    for sub in sorted(entry.iterdir()):
                        if not sub.is_dir():
                            continue
                        parsed = self._parse_session_name(sub.name)
                        if parsed:
                            parsed["issue"] = int(entry_name)  # override from parent dir
                            candidates.append((parsed, sub))
                    continue

                # --- Old layout: <issue>-<flow>-<phase>-<timestamp>/ ---
                parsed = self._parse_session_name(entry_name)
                if parsed:
                    candidates.append((parsed, entry))

            # Process each candidate — find the .jsonl file(s) inside
            for parsed_info, session_dir in candidates:
                jsonl_files = sorted(session_dir.glob("*.jsonl"), reverse=True)
                if not jsonl_files:
                    continue

                # Use the most recent JSONL file in this session dir
                primary_jsonl = jsonl_files[0]

                try:
                    # Parse session log via session_reader
                    from lib.session_reader import parse_session_log
                    summary_data = parse_session_log(str(primary_jsonl))

                    # Extract verdict via verdict_extractor
                    from lib.verdict_extractor import extract_phase_verdict
                    verdict = extract_phase_verdict(primary_jsonl)

                    file_ops = summary_data.get("file_operations", [])
                    errors = summary_data.get("errors", [])

                    record: dict = {
                        "issue": parsed_info["issue"],
                        "flow": parsed_info["flow"] or "unknown",
                        "phase": parsed_info["phase"] or "unknown",
                        "model": summary_data.get("model"),
                        "duration_seconds": summary_data.get("duration_seconds", 0.0) or 0.0,
                        "verdict_status": verdict.get("status"),
                        "verdict_issues": verdict.get("issues", []),
                        "file_ops_count": len(file_ops),
                        "error_count": len(errors),
                        "timestamp_str": parsed_info["timestamp"] or "",
                        "raw_path": str(primary_jsonl),
                    }

                    # Apply optional date filter
                    if days_limit is not None:
                        from datetime import datetime, timedelta, timezone
                        cutoff = datetime.now(timezone.utc) - timedelta(days=days_limit)
                        try:
                            ts_str = record["timestamp_str"]
                            # Try parsing the timestamp string to determine recency
                            parsed_ts = None
                            for fmt in (
                                "%Y-%m-%dT%H:%M:%S",
                                "%Y%m%d-%H%M%S",
                                "%Y-%m-%d %H:%M:%S",
                            ):
                                try:
                                    dt = datetime.strptime(ts_str, fmt)
                                    parsed_ts = dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt
                                    break
                                except ValueError:
                                    continue
                            if parsed_ts and parsed_ts < cutoff:
                                continue  # Skip sessions older than the limit
                        except Exception:
                            pass  # If we can't parse, include it anyway

                    summaries.append(record)
                except Exception as e:
                    # Gracefully skip unparseable sessions
                    print(
                        f"[dashboard] WARNING: Skipping {primary_jsonl}: {e}",
                        file=__import__("sys").stderr,
                    )

            # Sort by timestamp string descending (most recent first)
            summaries.sort(key=lambda s: s.get("timestamp_str", ""), reverse=True)

            return DashboardResult(success=True, data=summaries)
        except Exception as e:
            return DashboardResult(
                success=False,
                data=None,
                error=f"Failed to get all sessions: {str(e)}",
            )

    def list_flows(self) -> DashboardResult:
        """List all available flow configurations from flows/*.json.
        
        Returns:
            DashboardResult with list of flow config dicts on success,
            or error message on failure.
        """
        try:
            if not self.flows_dir.exists():
                return DashboardResult(
                    success=False,
                    data=None,
                    error=f"Flows directory not found: {self.flows_dir}"
                )
            
            flows = []
            for flow_file in sorted(self.flows_dir.glob("*.json")):
                try:
                    with open(flow_file, 'r') as f:
                        config = json.load(f)
                        # Add file path metadata
                        config['_file'] = str(flow_file.name)
                        flows.append(config)
                except (json.JSONDecodeError, IOError) as e:
                    # Skip malformed flow files gracefully
                    print(f"[dashboard] WARNING: Skipping {flow_file.name}: {e}", 
                          file=__import__('sys').stderr)
            
            return DashboardResult(success=True, data=flows)
        except Exception as e:
            return DashboardResult(
                success=False,
                data=None,
                error=f"Failed to list flows: {str(e)}"
            )

    def get_flow_config(self, flow_name: str) -> DashboardResult:
        """Load a specific flow configuration by name.
        
        Args:
            flow_name: Name of the flow (without .json extension).
            
        Returns:
            DashboardResult with flow config dict on success,
            or error message on failure.
        """
        try:
            flow_file = self.flows_dir / f"{flow_name}.json"
            
            if not flow_file.exists():
                return DashboardResult(
                    success=False,
                    data=None,
                    error=f"Flow config not found: {flow_file.name}"
                )
            
            with open(flow_file, 'r') as f:
                config = json.load(f)
            
            # Add file path metadata
            config['_file'] = flow_file.name
            return DashboardResult(success=True, data=config)
        except (json.JSONDecodeError, IOError) as e:
            return DashboardResult(
                success=False,
                data=None,
                error=f"Failed to load flow '{flow_name}': {str(e)}"
            )

    def get_orchestrator_state(self) -> DashboardResult:
        """Read the current orchestrator state from state.json.
        
        Returns:
            DashboardResult with state dict on success,
            or error message on failure.
        """
        try:
            # Try standard location first, then fall back to root
            state_file = self.state_dir / "state.json"
            if not state_file.exists():
                state_file = self.maestro_root / "state.json"
            
            if not state_file.exists():
                return DashboardResult(
                    success=False,
                    data=None,
                    error=f"State file not found in {self.state_dir} or {self.maestro_root}"
                )
            
            with open(state_file, 'r') as f:
                state = json.load(f)
            
            return DashboardResult(success=True, data=state)
        except (json.JSONDecodeError, IOError) as e:
            return DashboardResult(
                success=False,
                data=None,
                error=f"Failed to read orchestrator state: {str(e)}"
            )

    def get_active_session(
        self,
        sessions_dir: Optional[str] = None,
        active_threshold_sec: int = 30,
        idle_threshold_sec: int = 60,
    ) -> DashboardResult:
        """Poll the sessions directory for recently modified JSONL files.

        Detects active Maestro pipeline runs by scanning for `.jsonl` files
        that have been modified within a configurable time window.

        Active thresholds:
          - **Active**: any .jsonl file modified within the last 30 seconds
          - **Idle**: no updates for more than 60 seconds

        Args:
            sessions_dir: Override the default sessions directory path.
                         Defaults to ``sessions/`` under the maestro root.
            active_threshold_sec: Seconds since last modification to consider
                                 a session "active". Default 30s.
            idle_threshold_sec: Seconds since last modification to consider
                               the pipeline fully idle. Default 60s.

        Returns:
            DashboardResult with:
              - success (bool): True if scan completed, False on error
              - data (dict|None):
                  When active:
                    {
                      "active": True,
                      "state": "running" | "idle",
                      "issue": int | None,
                      "flow": str,
                      "phase": str,
                      "jsonl_path": str,  # absolute path to the .jsonl file
                      "last_modified_ts": float,  # epoch seconds
                      "elapsed_seconds": float,  # from first event in log
                    }
                  When idle or nothing found:
                    {
                      "active": False,
                      "state": "idle",
                      "message": "Idle — no active pipeline"
                    }
              - error (str): Error message if scan failed
        """
        try:
            from datetime import datetime, timezone

            scan_path = Path(sessions_dir) if sessions_dir else self.maestro_root / "sessions"
            now_epoch = datetime.now(timezone.utc).timestamp()

            if not scan_path.exists():
                return DashboardResult(
                    success=True,
                    data={
                        "active": False,
                        "state": "idle",
                        "message": "Idle — no active pipeline"
                    }
                )

            # Collect all .jsonl files with their modification times.
            # Each candidate is (jsonl_path, mtime, session_metadata_name).
            # The metadata name is used for _parse_session_name to extract
            # flow/phase info. In the new layout it's the parent dir;
            # in the old layout it's the session dir itself.
            candidates: list[tuple[Path, float, str]] = []

            for entry in sorted(scan_path.iterdir()):
                if not entry.is_dir():
                    continue

                # New layout: sessions/<issue>/<flow>-<phase>-<ISO>.jsonl/*.jsonl
                if re.match(r'^\d+$', entry.name):
                    for sub in entry.rglob("*.jsonl"):
                        if sub.is_file():
                            candidates.append(
                                (sub, sub.stat().st_mtime, sub.parent.name)
                            )
                    continue

                # Old layout: sessions/<issue>-<flow>-<phase>-<ts>/*.jsonl
                parsed = self._parse_session_name(entry.name)
                if parsed:
                    for jsonl_file in entry.glob("*.jsonl"):
                        if jsonl_file.is_file():
                            candidates.append(
                                (jsonl_file, jsonl_file.stat().st_mtime, entry.name)
                            )

            if not candidates:
                return DashboardResult(
                    success=True,
                    data={
                        "active": False,
                        "state": "idle",
                        "message": "Idle — no active pipeline"
                    }
                )

            # Sort by modification time descending (most recent first)
            candidates.sort(key=lambda x: x[1], reverse=True)
            most_recent_file, most_recent_mtime, metadata_name = candidates[0]
            age_seconds = now_epoch - most_recent_mtime

            if age_seconds > idle_threshold_sec:
                return DashboardResult(
                    success=True,
                    data={
                        "active": False,
                        "state": "idle",
                        "message": "Idle — no active pipeline"
                    }
                )

            # Determine state: running (within active threshold) or idle-ish
            is_running = age_seconds <= active_threshold_sec

            # Extract metadata from the session directory name
            parsed_info = self._parse_session_name(metadata_name)

            # The issue number may come from a parent directory in new layout
            issue_num = None
            if not parsed_info or parsed_info.get("issue") is None:
                # Check if parent dir is an issue number (new layout)
                parent = most_recent_file.parent.parent
                if re.match(r'^\d+$', parent.name):
                    issue_num = int(parent.name)
            else:
                issue_num = parsed_info.get("issue")

            # Calculate elapsed time from the first event in the log
            elapsed_seconds = 0.0
            try:
                from lib.session_reader import _to_epoch_ms
                with open(most_recent_file, 'r') as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        event = json.loads(line)
                        ts_ms = _to_epoch_ms(event.get("timestamp"))
                        if ts_ms is not None:
                            elapsed_seconds = (now_epoch * 1000 - ts_ms) / 1000.0
                            break
            except Exception:
                pass

            return DashboardResult(
                success=True,
                data={
                    "active": True,
                    "state": "running" if is_running else "idle",
                    "issue": issue_num,
                    "flow": parsed_info.get("flow", "unknown") if parsed_info else "unknown",
                    "phase": parsed_info.get("phase", "unknown") if parsed_info else "unknown",
                    "jsonl_path": str(most_recent_file),
                    "last_modified_ts": most_recent_mtime,
                    "elapsed_seconds": elapsed_seconds,
                }
            )
        except Exception as e:
            return DashboardResult(
                success=False,
                data=None,
                error=f"Failed to get active session: {str(e)}"
            )

    def get_session_progress(self, jsonl_path: str) -> DashboardResult:
        """Tail-parse the last ~50 lines of a running session log.

        Extracts recent tool calls (read/write/edit) and model info from
        ``model_change`` events without blocking on full-file parsing.

        Args:
            jsonl_path: Absolute path to the JSONL session file.
            tail_lines: Number of lines to read from the end. Default 50.

        Returns:
            DashboardResult with:
              - success (bool): True if parse completed, False on error
              - data (dict|None):
                  {
                    "model": str | None,       # e.g. "llama-cpp-main/qwen-35b-a3b-118k-bf16"
                    "recent_events": list[dict], # last N tool call events
                    "tool_calls": list[dict],    # filtered to read/write/edit ops
                  }
              - error (str): Error message if parse failed
        """
        try:
            from lib.session_reader import _to_epoch_ms

            path = Path(jsonl_path)
            if not path.exists():
                return DashboardResult(
                    success=False,
                    data=None,
                    error=f"Session log not found: {jsonl_path}"
                )

            # Read last N lines efficiently (no full-file parse)
            tail_lines_count = 50
            model_name = None
            recent_events: list[dict] = []
            tool_calls: list[dict] = []

            with open(path, 'r') as f:
                # Use a circular buffer approach — read all lines but only keep last N
                line_buffer: list[str] = []
                for line in f:
                    stripped = line.strip()
                    if not stripped:
                        continue
                    line_buffer.append(stripped)
                    if len(line_buffer) > tail_lines_count:
                        line_buffer.pop(0)

            # Process the tail lines
            pending_tool_calls: dict[str, dict] = {}

            for raw_line in line_buffer:
                try:
                    event = json.loads(raw_line)
                except (json.JSONDecodeError, ValueError):
                    continue

                event_type = event.get("type", "")
                ts_ms = _to_epoch_ms(event.get("timestamp"))

                # Track model info from metadata events
                if event_type == "model_change":
                    provider = event.get("provider", "")
                    model_id = event.get("modelId", "")
                    if provider and model_id:
                        model_name = f"{provider}/{model_id}"
                    elif model_id:
                        model_name = model_id
                    continue

                # Process messages for tool calls
                message = event.get("message")
                if not message or "role" not in message:
                    continue

                role = message["role"]

                # Handle assistant messages with tool calls
                if role == "assistant":
                    content_parts = message.get("content", [])

                    for part in (content_parts if isinstance(content_parts, list) else []):
                        if not isinstance(part, dict):
                            continue

                        part_type = part.get("type", "")

                        # Track tool calls
                        if part_type == "toolCall":
                            call_id = part.get("id")
                            tool_name = part.get("name", "")
                            args = part.get("arguments", {}) or {}

                            pending_tool_calls[call_id] = {
                                "toolName": tool_name,
                                "arguments": args,
                                "timestamp_ms": ts_ms or 0,
                            }
                        elif part_type == "text":
                            text = part.get("text", "")
                            if isinstance(text, str) and text.strip():
                                recent_events.append({
                                    "type": "assistant_text",
                                    "text": text[:300],  # truncate for display
                                    "timestamp_ms": ts_ms or 0,
                                })

                # Handle tool results (success/failure)
                elif role == "toolResult":
                    call_id = message.get("toolCallId") or message.get("parentId")
                    is_error = message.get("isError", False)

                    call_info = pending_tool_calls.pop(call_id, None) if call_id else None

                    if call_info:
                        tool_name = call_info["toolName"]
                        args = call_info.get("arguments", {}) or {}

                        # Extract file path from arguments
                        file_path = (
                            args.get("path")
                            or args.get("file")
                            or args.get("filePath")
                            or "unknown"
                        )

                        error_content = ""
                        content = message.get("content", "")
                        if isinstance(content, str):
                            error_content = content[:200]
                        elif isinstance(content, list):
                            texts = [
                                p.get("text", "")
                                for p in content
                                if isinstance(p, dict) and p.get("type") == "text"
                            ]
                            error_content = "\n".join(texts)[:200]

                        op = {
                            "tool": tool_name.upper(),
                            "path": file_path,
                            "status": "failed" if is_error else "success",
                            "timestamp_ms": ts_ms or 0,
                            "error_message": error_content if is_error and error_content else None,
                        }

                        recent_events.append(op)

                        # Filter to read/write/edit ops for the tool_calls display
                        if tool_name in ("read", "write", "edit"):
                            tool_calls.append(op)

            return DashboardResult(
                success=True,
                data={
                    "model": model_name,
                    "recent_events": recent_events[-10:],  # last 10 events max
                    "tool_calls": tool_calls[-5:],          # last 5 tool calls max
                }
            )
        except Exception as e:
            return DashboardResult(
                success=False,
                data=None,
                error=f"Failed to get session progress: {str(e)}"
            )
