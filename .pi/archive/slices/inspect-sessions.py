#!/usr/bin/env python3
"""
inspect-sessions.py — Pi Agent Session Inspector

Quickly extract data from session JSONL files to monitor what's happening:
- Loop detection (repeated tool calls, stuck patterns)
- Error scanning across all sessions
- Token usage & cost tracking
- Slice execution status correlation
- Timeline of recent activity

Usage:
  python3 inspect-sessions.py                  # Full dashboard for pi-pos-v0
  python3 inspect-sessions.py --project test   # Another project's sessions
  python3 inspect-sessions.py --loops          # Only loop detection
  python3 inspect-sessions.py --errors         # Only errors
  python3 inspect-sessions.py --metrics        # Token/cost metrics only
  python3 inspect-sessions.py --timeline       # Recent activity timeline
  python3 inspect-sessions.py --latest N       # Show last N sessions (default: 5)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional


# ─── Constants ──────────────────────────────────────────────────────────────

SESSIONS_BASE = Path.home() / ".pi" / "agent" / "sessions"
STATE_DIR = Path(__file__).parent.parent / "state"  # .pi/state/ from project root
PROJECT_SLUG = "pi-pos-v0"  # default project directory name


# ─── Color helpers ──────────────────────────────────────────────────────────

class C:
    RESET = "\033[0m"
    RED = "\033[0;31m"
    GREEN = "\033[0;32m"
    YELLOW = "\033[1;33m"
    BLUE = "\033[0;34m"
    CYAN = "\033[0;36m"
    MAGENTA = "\033[0;35m"
    BOLD = "\033[1m"
    DIM = "\033[2m"


def red(s: str) -> str: return f"{C.RED}{s}{C.RESET}"
def green(s: str) -> str: return f"{C.GREEN}{s}{C.RESET}"
def yellow(s: str) -> str: return f"{C.YELLOW}{s}{C.RESET}"
def blue(s: str) -> str: return f"{C.BLUE}{s}{C.RESET}"
def cyan(s: str) -> str: return f"{C.CYAN}{s}{C.RESET}"
def magenta(s: str) -> str: return f"{C.MAGENTA}{s}{C.RESET}"
def bold(s: str) -> str: return f"{C.BOLD}{s}{C.RESET}"
def dim(s: str) -> str: return f"{C.DIM}{s}{C.RESET}"


# ─── Data classes ───────────────────────────────────────────────────────────

@dataclass
class SessionMetrics:
    session_id: str
    timestamp: str
    cwd: str
    file_size_kb: float = 0.0
    total_events: int = 0
    message_count: int = 0
    tool_call_count: int = 0
    thinking_count: int = 0
    compaction_count: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read: int = 0
    cache_write: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0
    models_used: list[str] = field(default_factory=list)
    tool_names: Counter = field(default_factory=Counter)
    errors_found: list[dict] = field(default_factory=list)
    user_messages: list[str] = field(default_factory=list)  # first 100 chars of each


@dataclass
class LoopIndicator:
    session_id: str
    tool_name: str
    repeat_count: int
    pattern: str  # description of the loop


# ─── Parsing ────────────────────────────────────────────────────────────────

def parse_jsonl(filepath: Path) -> list[dict]:
    """Parse a JSONL file, skipping malformed lines."""
    events = []
    with open(filepath, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return events


def extract_metrics(events: list[dict]) -> SessionMetrics:
    """Extract comprehensive metrics from session events."""
    m = SessionMetrics(
        session_id="",
        timestamp="",
        cwd=""
    )

    # Track tool call IDs → names for correlation with results
    tool_call_map: dict[str, str] = {}
    # Track pending tool calls to correlate with sequential toolResult messages
    pending_tool_calls: list[str] = []  # ordered list of tool names

    for ev in events:
        etype = ev.get("type", "")

        if etype == "session":
            m.session_id = ev.get("id", "?")[:12]
            m.timestamp = ev.get("timestamp", "")
            m.cwd = ev.get("cwd", "")

        elif etype == "message":
            msg = ev.get("message", {})
            content = msg.get("content", [])
            role = msg.get("role", "?")

            # Handle toolResult messages (separate events, not content items)
            if role == "toolResult":
                text = str(msg.get("content", ""))
                
                # Pop the corresponding tool call name from pending list
                source_tool = pending_tool_calls.pop(0) if pending_tool_calls else "unknown"
                
                # Only check bash results for errors — write/edit/read return structured data
                # or file content that often contains false-positive keywords in comments/code
                if source_tool == "bash":
                    real_error_patterns = [
                        r"error TS\d+:",  # TypeScript compile errors
                        r"^\s*command exited with code \d+",
                        r"process exited with code \d+",
                        r"failed after \d+ attempts",
                        r"session failed",
                        r"no agent_end received",
                    ]
                    for pattern in real_error_patterns:
                        if re.search(pattern, text):
                            m.errors_found.append({
                                "role": role,
                                "preview": text[:120].replace("\n", " "),
                                "line_type": f"toolResult(bash)"
                            })
                            break
                continue  # Skip the rest of message processing for toolResult

            m.message_count += 1

            for item in content:
                if not isinstance(item, dict):
                    continue

                itype = item.get("type", "")

                # Track tool calls with their IDs → names for result correlation
                if itype == "toolCall":
                    tool_name = item.get("name", "?")
                    tool_id = item.get("id", "")
                    m.tool_call_count += 1
                    m.tool_names[tool_name] += 1
                    tool_call_map[tool_id] = tool_name
                    pending_tool_calls.append(tool_name)

                # Thinking blocks
                elif itype == "thinking":
                    m.thinking_count += 1

                # Error detection in text content (assistant messages only)
                elif itype == "text" and role == "assistant":
                    text = str(item.get("text", ""))
                    real_error_patterns = [
                        r"error TS\d+:",
                        r"TypeError:\s",
                        r"SyntaxError:\s",
                        r"failed after \d+ attempts",
                        r"session failed",
                        r"no agent_end received",
                        r"TIMEOUT after \d+s",
                    ]
                    for pattern in real_error_patterns:
                        if re.search(pattern, text):
                            m.errors_found.append({
                                "role": role,
                                "preview": text[:120].replace("\n", " "),
                                "line_type": itype
                            })
                            break

                    # Track user messages (for context)
                elif itype == "text" and role == "user":
                    if len(m.user_messages) < 5:
                        m.user_messages.append(str(item.get("text", ""))[:100])

        # Usage/cost data (only on assistant messages)
        if etype == "message" and msg.get("usage"):
            usage = msg["usage"]
            m.input_tokens += usage.get("input", 0) or 0
            m.output_tokens += usage.get("output", 0) or 0
            m.cache_read += usage.get("cacheRead", 0) or 0
            m.cache_write += usage.get("cacheWrite", 0) or 0
            m.total_tokens += usage.get("totalTokens", 0) or 0

            cost = usage.get("cost", {})
            if cost:
                m.cost_usd += cost.get("total", 0) or 0

        elif etype == "model_change":
            model_id = ev.get("modelId", "?")
            provider = ev.get("provider", "?")
            key = f"{provider}/{model_id}"
            if key not in m.models_used:
                m.models_used.append(key)

        elif etype == "compaction":
            m.compaction_count += 1

    return m


# ─── Loop Detection ────────────────────────────────────────────────────────

def detect_loops(events: list[dict]) -> list[LoopIndicator]:
    """Detect potential infinite loops in session execution.

    Looks for:
    - Same tool called 5+ times consecutively
    - Repeated tool call patterns (A → B → A → B)
    - Multiple retries of the same operation
    """
    loops = []

    # Extract tool call sequence with context
    tool_sequence = []
    for ev in events:
        if ev.get("type") == "message":
            msg = ev.get("message", {})
            content = msg.get("content", [])
            role = msg.get("role", "?")

            for item in content:
                if isinstance(item, dict) and item.get("type") == "toolCall":
                    tool_sequence.append({
                        "name": item.get("name", "?"),
                        "arguments": json.dumps(item.get("arguments", {}), sort_keys=True)[:100],
                        "role": role
                    })

    if len(tool_sequence) < 5:
        return loops

    # Check for consecutive repeats (same tool called N times in a row)
    consecutive = defaultdict(list)
    current_tool = None
    count = 0

    for tc in tool_sequence:
        key = f"{tc['name']}:{tc['arguments'][:50]}"
        if tc["name"] == current_tool and tc["arguments"][:50] == (tool_sequence[consecutive[current_tool][-1]]["arguments"][:50] if consecutive.get(current_tool) else ""):
            count += 1
            consecutive[current_tool].append(len(consecutive[current_tool]))
        elif tc["name"] != current_tool:
            if count >= 3 and current_tool in ("read", "bash"):
                loops.append(LoopIndicator(
                    session_id="",  # filled by caller
                    tool_name=current_tool,
                    repeat_count=count,
                    pattern=f"Consecutive '{current_tool}' calls ({count}x) — possible infinite read loop"
                ))
            current_tool = tc["name"]
            count = 1

    # Check for retry patterns (same tool with similar arguments appearing multiple times)
    tool_arg_counts = Counter()
    for tc in tool_sequence:
        arg_key = f"{tc['name']}:{tc['arguments'][:80]}"
        tool_arg_counts[arg_key] += 1

    for key, count in tool_arg_counts.items():
        if count >= 3 and ":" in key:
            name, args = key.split(":", 1)
            loops.append(LoopIndicator(
                session_id="",
                tool_name=name,
                repeat_count=count,
                pattern=f"Same '{name}' with similar arguments called {count}x — possible retry loop"
            ))

    # Check for oscillating patterns (A → B → A → B)
    if len(tool_sequence) >= 6:
        names = [tc["name"] for tc in tool_sequence]
        for i in range(len(names) - 3):
            if names[i] == names[i+2] == names[i+4] and names[i+1] == names[i+3] == names[i+5]:
                loops.append(LoopIndicator(
                    session_id="",
                    tool_name=f"{names[i]} ↔ {names[i+1]}",
                    repeat_count=3,
                    pattern=f"Oscillating pattern: {names[i]} → {names[i+1]} repeated — possible stuck in a cycle"
                ))
                break  # report once per session

    return loops


# ─── Slice Status Correlation ──────────────────────────────────────────────

def get_slice_status() -> dict:
    """Read slice execution state from .pi/state/ files."""
    status = {
        "state_file": None,
        "result_file": None,
        "logs_file": None,
        "issues_pending": 0,
        "last_result": None,
        "total_iterations": 0,
        "builder_retries": 0,
    }

    state_dir = STATE_DIR if STATE_DIR.exists() else Path.cwd() / ".pi" / "state"
    if not state_dir.exists():
        return status

    # Read slice-run.json
    run_file = state_dir / "slice-run.json"
    if run_file.exists():
        try:
            with open(run_file) as f:
                data = json.load(f)
            status["state_file"] = str(run_file.relative_to(Path.cwd()))
            status["issues_pending"] = len(data.get("issueList", [])) - data.get("currentSliceIndex", 0)
            status["total_iterations"] = data.get("totalIterations", 0)
            status["builder_retries"] = data.get("builderRetries", 0)

            phase = data.get("agentPhase", "?")
            if phase == "builder":
                status["current_phase"] = "Builder"
            elif phase == "reviewer-rejected":
                status["current_phase"] = "Reviewer rejected (retrying)"
            else:
                status["current_phase"] = phase

        except json.JSONDecodeError:
            status["state_file"] = str(run_file.relative_to(Path.cwd())) + " (corrupted)"

    # Read slice-result.json
    result_file = state_dir / "slice-result.json"
    if result_file.exists():
        try:
            with open(result_file) as f:
                data = json.load(f)
            status["result_file"] = str(result_file.relative_to(Path.cwd()))
            status["last_result"] = {
                "status": data.get("status", "?"),
                "slice": data.get("slice"),
                "verdict": data.get("verdict"),
                "issues": data.get("issues", []),
                "critique": data.get("critique", [])
            }
        except json.JSONDecodeError:
            status["result_file"] = str(result_file.relative_to(Path.cwd())) + " (corrupted)"

    # Read slice-logs.json if it exists
    logs_file = state_dir / "slice-run-logs.json"
    if logs_file.exists():
        try:
            with open(logs_file) as f:
                data = json.load(f)
            status["logs_file"] = str(logs_file.relative_to(Path.cwd()))
            entries = data.get("entries", [])
            status["total_log_entries"] = len(entries)
            success_count = sum(1 for e in entries if e.get("status") == "success")
            fail_count = sum(1 for e in entries if e.get("status") != "success")
            status["log_success"] = success_count
            status["log_fail"] = fail_count
        except json.JSONDecodeError:
            pass

    return status


# ─── Display Functions ──────────────────────────────────────────────────────

def fmt_tokens(n: int) -> str:
    """Format token count with K/M suffix."""
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    elif n >= 1_000:
        return f"{n/1_000:.0f}K"
    return str(n)


def fmt_size_kb(kb: float) -> str:
    if kb >= 1024:
        return f"{kb/1024:.1f}MB"
    return f"{kb:.0f}KB"


def print_separator(char="─", width=70):
    print(f"\n{char * width}")


# ─── Dashboard Sections ────────────────────────────────────────────────────

def show_metrics(sessions: list[SessionMetrics]):
    """Show token usage and cost metrics."""
    if not sessions:
        print(yellow("  No session data found."))
        return

    total_input = sum(s.input_tokens for s in sessions)
    total_output = sum(s.output_tokens for s in sessions)
    total_cache = sum(s.cache_read + s.cache_write for s in sessions)
    total_all = sum(s.total_tokens for s in sessions)
    total_cost = sum(s.cost_usd for s in sessions)

    print(f"\n{bold('TOKEN & COST METRICS')}")
    print_separator("─")
    print(f"  Sessions analyzed: {len(sessions)}")
    print()
    print(f"  {'Metric':<20} {'Value':>15}")
    print(f"  {'─'*18} {'─'*13}")
    print(f"  {'Input tokens':<20} {fmt_tokens(total_input):>15}")
    print(f"  {'Output tokens':<20} {fmt_tokens(total_output):>15}")
    print(f"  {'Cache read':<20} {fmt_tokens(sum(s.cache_read for s in sessions)):>15}")
    print(f"  {'Cache write':<20} {fmt_tokens(sum(s.cache_write for s in sessions)):>15}")
    print(f"  {'Total tokens':<20} {bold(fmt_tokens(total_all)):>15}")
    print()

    if total_cost > 0:
        print(f"  {'Estimated cost':<20} ${total_cost:.4f}")
    else:
        print(f"  {'Cost':<20} {dim('local model (no cost)')}")

    # Per-session breakdown
    print()
    print(f"  {'Session':<16} {'Tokens':>10} {'Calls':>7} {'Errors':>7}")
    print(f"  {'─'*14} {'─'*8} {'─'*5} {'─'*5}")
    for s in sessions:
        err_icon = red("✗") if s.errors_found else green("✓")
        print(f"  {s.session_id:<16} {fmt_tokens(s.total_tokens):>10} {s.tool_call_count:>7} {err_icon:>7}")


def show_loops(all_sessions: list[tuple[SessionMetrics, list[LoopIndicator]]]):
    """Show loop detection results."""
    all_loops = []
    for metrics, loops in all_sessions:
        for loop in loops:
            loop.session_id = metrics.session_id
            all_loops.append(loop)

    if not all_loops:
        print(f"\n{bold('LOOP DETECTION')}")
        print_separator("─")
        print(green("  No loops detected. Sessions look healthy."))
        return

    print(f"\n{bold('LOOP DETECTION')}")
    print_separator("─")
    print(yellow(f"  ⚠️  {len(all_loops)} potential loop(s) found:\n"))

    for i, loop in enumerate(all_loops, 1):
        print(f"  {i}. Session: {loop.session_id}")
        print(f"     Tool:   {bold(loop.tool_name)}")
        print(f"     Count:  {yellow(str(loop.repeat_count))}x")
        print(f"     Pattern: {dim(loop.pattern)}")
        print()


def show_errors(all_sessions: list[tuple[SessionMetrics, list[LoopIndicator]]]):
    """Show error detection results."""
    all_errors = []
    for metrics, _ in all_sessions:
        for err in metrics.errors_found:
            all_errors.append((metrics.session_id, metrics.timestamp, err))

    if not all_errors:
        print(f"\n{bold('ERROR SCAN')}")
        print_separator("─")
        print(green("  No errors detected across sessions."))
        return

    # Deduplicate by preview text
    seen = set()
    unique_errors = []
    for sid, ts, err in all_errors:
        key = (err["preview"][:60], err["line_type"])
        if key not in seen:
            seen.add(key)
            unique_errors.append((sid, ts, err))

    print(f"\n{bold('ERROR SCAN')}")
    print_separator("─")
    print(red(f"  ⚠️  {len(unique_errors)} error(s) found across sessions:\n"))

    for i, (sid, ts, err) in enumerate(unique_errors[:20], 1):  # cap at 20
        role_icon = "👤" if err["role"] == "user" else "🤖"
        print(f"  {i}. [{sid}] {ts[:16] if ts else '?'}")
        print(f"     {role_icon} Role: {err['role']} | Type: {err['line_type']}")
        print(f"     Preview: {dim(err['preview'][:100])}")
        print()

    if len(unique_errors) > 20:
        print(dim(f"  ... and {len(unique_errors) - 20} more errors"))


def show_timeline(sessions: list[SessionMetrics]):
    """Show recent activity timeline."""
    if not sessions:
        print(yellow("  No session data found."))
        return

    # Sort by timestamp descending
    sorted_sessions = sorted(sessions, key=lambda s: s.timestamp or "", reverse=True)

    print(f"\n{bold('RECENT ACTIVITY TIMELINE')}")
    print_separator("─")

    for i, s in enumerate(sorted_sessions[:10]):  # last 10 sessions
        ts = s.timestamp[:19].replace("T", " ") if s.timestamp else "?"
        size = fmt_size_kb(s.file_size_kb)
        tokens = fmt_tokens(s.total_tokens)
        calls = s.tool_call_count

        err_indicator = red("✗") if s.errors_found else green("✓")
        print(f"  {i+1}. [{ts}] {bold(s.session_id)}  {dim(size):<8} {tokens:<8} {calls} calls  {err_indicator}")


def show_slice_status(status: dict):
    """Show slice execution status."""
    print(f"\n{bold('SLICE EXECUTION STATUS')}")
    print_separator("─")

    if not status.get("state_file"):
        print(dim("  No slice state found. Run slices first."))
        return

    # State file info
    sf = status["state_file"] or "?"
    rf = status.get("result_file", "?") or "?"
    lf = status.get("logs_file", "?") or "?"

    print(f"  State:   {sf}")
    print(f"  Result:  {rf}")
    if status.get("logs_file"):
        print(f"  Logs:    {lf} ({status.get('total_log_entries', 0)} entries)")

    # Current phase
    phase = status.get("current_phase", "?")
    if "retry" in str(phase).lower():
        print(f"  Phase:   {yellow(phase)}")
    else:
        print(f"  Phase:   {blue(str(phase))}")

    # Pending issues
    pending = status.get("issues_pending", 0)
    if pending > 0:
        print(f"  Pending: {yellow(str(pending))} issue(s)")
    elif pending == 0 and status.get("total_iterations", 0) > 0:
        print(f"  Pending: {green('0')} (all processed)")

    # Last result
    last = status.get("last_result")
    if last:
        print()
        print(f"  Last Result:")
        status_icon = {"approved": green, "rejected": red}.get(last["status"], dim)
        print(f"    Status: {status_icon(last['status'].upper())}")
        if last.get("slice"):
            print(f"    Slice:  #{last['slice']}")
        if last.get("verdict"):
            print(f"    Verdict: {last['verdict']}")

        issues = last.get("issues", []) or last.get("critique", [])
        if issues:
            for issue in issues[:3]:
                print(f"    • {dim(issue[:80])}")
            if len(issues) > 3:
                print(f"    ... and {len(issues) - 3} more")

    # Retry info
    retries = status.get("builder_retries", 0)
    iterations = status.get("total_iterations", 0)
    if retries > 0 or iterations > 1:
        print()
        print(f"  Retries: {retries}")
        print(f"  Iterations: {iterations}")


# ─── Main ──────────────────────────────────────────────────────────────────

def get_project_session_dir(project_slug: str) -> Optional[Path]:
    """Find the session directory for a given project."""
    # Try exact match first
    candidates = [d for d in SESSIONS_BASE.iterdir() if d.is_dir()]

    # Match by project slug in directory name
    for d in candidates:
        if project_slug.lower() in d.name.lower():
            return d

    # If only one session dir exists, use it
    if len(candidates) == 1:
        return candidates[0]

    # List available projects
    print(yellow(f"  Available projects in {SESSIONS_BASE}:"))
    for d in sorted(candidates):
        count = len([f for f in d.iterdir() if f.suffix == ".jsonl"])
        print(f"    • {d.name} ({count} sessions)")

    return None


def load_sessions(project_slug: str, latest_n: int) -> list[SessionMetrics]:
    """Load and parse session files for a project."""
    session_dir = get_project_session_dir(project_slug)
    if not session_dir or not session_dir.exists():
        print(yellow(f"  No sessions found for '{project_slug}'"))
        return []

    jsonl_files = sorted(
        [f for f in session_dir.iterdir() if f.suffix == ".jsonl"],
        key=lambda f: f.stat().st_mtime,
        reverse=True
    )[:latest_n]

    if not jsonl_files:
        print(yellow(f"  No .jsonl files found in {session_dir}"))
        return []

    sessions = []
    for filepath in jsonl_files:
        events = parse_jsonl(filepath)
        metrics = extract_metrics(events)
        metrics.file_size_kb = filepath.stat().st_size / 1024
        sessions.append(metrics)

    return sessions


def main():
    parser = argparse.ArgumentParser(
        description="Pi Agent Session Inspector — detect loops, errors, and track metrics"
    )
    parser.add_argument("--project", default=PROJECT_SLUG, help=f"Project slug (default: {PROJECT_SLUG})")
    parser.add_argument("--latest", type=int, default=5, help="Number of recent sessions to analyze (default: 5)")
    parser.add_argument("--loops", action="store_true", help="Only show loop detection")
    parser.add_argument("--errors", action="store_true", help="Only show errors")
    parser.add_argument("--metrics", action="store_true", help="Only show token/cost metrics")
    parser.add_argument("--timeline", action="store_true", help="Only show activity timeline")
    parser.add_argument("--slice-status", action="store_true", help="Only show slice execution status")

    args = parser.parse_args()

    # Load sessions
    sessions = load_sessions(args.project, args.latest)
    if not sessions:
        sys.exit(0)

    # Detect loops for each session
    all_session_data = []
    for s in sessions:
        filepath = None
        for f in Path.home().joinpath(".pi", "agent", "sessions").glob(f"*{s.session_id}*"):
            if f.suffix == ".jsonl":
                filepath = f
                break

        loops = []
        if filepath and filepath.exists():
            events = parse_jsonl(filepath)
            loops = detect_loops(events)

        all_session_data.append((s, loops))

    # Show requested sections
    if args.loops:
        show_loops(all_session_data)
    elif args.errors:
        show_errors(all_session_data)
    elif args.metrics:
        show_metrics(sessions)
    elif args.timeline:
        show_timeline(sessions)
    elif args.slice_status:
        status = get_slice_status()
        show_slice_status(status)
    else:
        # Full dashboard
        print(bold(f"\n  ╔{'═' * 68}╗"))
        print(bold(f"  ║{cyan('PI AGENT SESSION INSPECTOR'):>68}║"))
        print(bold(f"  ╚{'═' * 68}╝\n"))

        show_slice_status(get_slice_status())
        show_timeline(sessions)
        show_metrics(sessions)
        show_loops(all_session_data)
        show_errors(all_session_data)

        # Footer
        print()
        print(f"  {dim('Tip: Use --loops, --errors, --metrics, --timeline, --slice-status for focused views')}")
        print(f"  {dim('Sessions dir: ' + str(SESSIONS_BASE))}")


if __name__ == "__main__":
    main()
