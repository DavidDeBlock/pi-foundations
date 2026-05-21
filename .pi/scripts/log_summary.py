#!/usr/bin/env python3
"""
Summarize agent session logs from a directory of JSONL files.

Usage:
  python log_summary.py /path/to/logdir
  python log_summary.py /path/to/logdir --details
  python log_summary.py /path/to/logdir --latest 5
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Optional


@dataclass
class ToolCallInfo:
    timestamp: Optional[str]
    tool_name: str
    command: str
    is_error: Optional[bool] = None
    result_text: str = ""


@dataclass
class SessionSummary:
    file_path: Path
    session_id: Optional[str] = None
    timestamp: Optional[str] = None
    cwd: Optional[str] = None
    model_id: Optional[str] = None
    provider: Optional[str] = None
    thinking_level: Optional[str] = None
    user_prompt: Optional[str] = None
    assistant_messages: int = 0
    user_messages: int = 0
    tool_calls: list[ToolCallInfo] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    counters: Counter = field(default_factory=Counter)

    def tool_stats(self) -> Counter:
        c = Counter()
        for tc in self.tool_calls:
            c[tc.tool_name] += 1
        return c


def safe_get(d: dict[str, Any], *keys: str) -> Any:
    cur: Any = d
    for key in keys:
        if not isinstance(cur, dict) or key not in cur:
            return None
        cur = cur[key]
    return cur


def short(text: str, max_len: int = 120) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= max_len else text[: max_len - 1] + "…"


def parse_iso(ts: Optional[str]) -> str:
    if not ts:
        return "-"
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return ts


def detect_command_flags(command: str, result_text: str, summary: SessionSummary) -> None:
    cmd_lower = command.lower()
    res_lower = result_text.lower()

    if "/skill:web-searcher" in command:
        summary.counters["skill_syntax_used"] += 1
        if "no such file or directory" in res_lower:
            summary.warnings.append("Slash skill syntax failed as shell command")

    if "playwright open " in result_text.lower() or "🌐 opening:" in result_text:
        summary.counters["browser_open"] += 1
        summary.warnings.append("Browse action opened visible browser instead of returning extracted content")

    if "(no output)" in result_text:
        summary.counters["no_output"] += 1
        summary.warnings.append("Tool returned no output")

    if "request rate threshold exceeded" in res_lower:
        summary.counters["rate_limited"] += 1
        summary.warnings.append("Source rate-limited request")

    if "enablejs" in res_lower or "if you're having trouble accessing google search" in res_lower:
        summary.counters["anti_bot_page"] += 1
        summary.warnings.append("Search engine returned anti-bot / JS challenge page")

    if "command exited with code 127" in res_lower:
        summary.counters["code_127"] += 1
        summary.errors.append("Command not found / invalid command invocation")

    if "curl " in cmd_lower and "google.com/search" in cmd_lower:
        summary.counters["raw_google_scrape"] += 1
        summary.warnings.append("Raw Google scraping used")

    if "search-google.py" in cmd_lower:
        summary.counters["search_google_py"] += 1

    if "search_wrapper.sh" in cmd_lower:
        summary.counters["search_wrapper"] += 1

    if "browse-url.py" in cmd_lower:
        summary.counters["browse_script"] += 1

    if "site:wsj.com" in cmd_lower or "negative stories" in cmd_lower or "quackwatch" in cmd_lower:
        summary.counters["negative_bias_query"] += 1
        summary.warnings.append("Possibly adversarial / scope-drifting query")

    if "ftc" in cmd_lower or "sec" in cmd_lower or "wikipedia" in cmd_lower or "reuters" in cmd_lower:
        summary.counters["external_research"] += 1


def extract_text_from_content(content: Any) -> list[str]:
    texts: list[str] = []
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict):
                txt = item.get("text")
                if isinstance(txt, str):
                    texts.append(txt)
    return texts


def parse_log_file(path: Path) -> SessionSummary:
    summary = SessionSummary(file_path=path)
    tool_results_by_id: dict[str, tuple[bool, str]] = {}

    # First pass: collect tool results by call id
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    raw_events: list[dict[str, Any]] = []

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
            raw_events.append(event)
        except json.JSONDecodeError:
            summary.errors.append(f"Invalid JSON line in {path.name}")
            continue

    for event in raw_events:
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        if msg.get("role") == "toolResult":
            tool_call_id = msg.get("toolCallId")
            texts = extract_text_from_content(msg.get("content"))
            result_text = "\n".join(texts).strip()
            is_error = bool(msg.get("isError"))
            if tool_call_id:
                tool_results_by_id[tool_call_id] = (is_error, result_text)

    # Second pass: build summary
    for event in raw_events:
        event_type = event.get("type")

        if event_type == "session":
            summary.session_id = event.get("id")
            summary.timestamp = event.get("timestamp")
            summary.cwd = event.get("cwd")

        elif event_type == "model_change":
            summary.model_id = event.get("modelId")
            summary.provider = event.get("provider")

        elif event_type == "thinking_level_change":
            summary.thinking_level = event.get("thinkingLevel")

        elif event_type == "message":
            msg = event.get("message", {})
            role = msg.get("role")

            if role == "user":
                summary.user_messages += 1
                texts = extract_text_from_content(msg.get("content"))
                if texts and not summary.user_prompt:
                    summary.user_prompt = short(" ".join(texts), 200)

            elif role == "assistant":
                summary.assistant_messages += 1
                content_items = msg.get("content", [])
                for item in content_items:
                    if not isinstance(item, dict):
                        continue
                    if item.get("type") == "toolCall":
                        call_id = item.get("id")
                        tool_name = item.get("name", "?")
                        arguments = item.get("arguments", {})
                        command = ""
                        if isinstance(arguments, dict):
                            command = str(arguments.get("command", ""))
                        is_error, result_text = tool_results_by_id.get(call_id, (None, ""))
                        tc = ToolCallInfo(
                            timestamp=event.get("timestamp"),
                            tool_name=tool_name,
                            command=command,
                            is_error=is_error,
                            result_text=result_text,
                        )
                        summary.tool_calls.append(tc)
                        detect_command_flags(command, result_text, summary)

    # Global/session-level heuristics
    if summary.thinking_level == "off":
        # not necessarily wrong, but useful to show
        summary.counters["thinking_off"] += 1

    if summary.counters["raw_google_scrape"] >= 1 and summary.counters["anti_bot_page"] >= 1:
        summary.warnings.append("Agent used raw Google scraping and hit anti-bot behavior")

    if summary.counters["browser_open"] >= 2:
        summary.warnings.append("Repeated visible browser launches detected")

    if summary.counters["negative_bias_query"] >= 2:
        summary.warnings.append("Research likely drifted toward negative framing")

    if summary.counters["no_output"] >= 2:
        summary.warnings.append("Multiple empty tool outputs")

    return summary


def print_summary(summary: SessionSummary, details: bool = False) -> None:
    print("=" * 100)
    print(f"FILE        : {summary.file_path.name}")
    print(f"SESSION     : {summary.session_id or '-'}")
    print(f"TIME        : {parse_iso(summary.timestamp)}")
    print(f"CWD         : {summary.cwd or '-'}")
    print(f"MODEL       : {summary.provider or '-'} / {summary.model_id or '-'}")
    print(f"THINKING    : {summary.thinking_level or '-'}")
    print(f"PROMPT      : {summary.user_prompt or '-'}")
    print(f"MSG COUNT   : user={summary.user_messages} assistant={summary.assistant_messages}")
    print(f"TOOL CALLS  : {len(summary.tool_calls)}")

    tool_stats = summary.tool_stats()
    if tool_stats:
        stats_text = ", ".join(f"{k}={v}" for k, v in tool_stats.items())
        print(f"TOOLS       : {stats_text}")

    interesting = []
    for key in [
        "search_wrapper",
        "search_google_py",
        "browse_script",
        "browser_open",
        "raw_google_scrape",
        "anti_bot_page",
        "no_output",
        "rate_limited",
        "code_127",
        "negative_bias_query",
    ]:
        if summary.counters.get(key):
            interesting.append(f"{key}={summary.counters[key]}")
    if interesting:
        print(f"SIGNALS     : {', '.join(interesting)}")

    if summary.errors:
        print("ERRORS      :")
        for err in dict.fromkeys(summary.errors):
            print(f"  - {err}")

    if summary.warnings:
        print("WARNINGS    :")
        for warn in dict.fromkeys(summary.warnings):
            print(f"  - {warn}")

    if details and summary.tool_calls:
        print("TOOL DETAILS:")
        for i, tc in enumerate(summary.tool_calls, start=1):
            status = "ERR" if tc.is_error else "OK" if tc.is_error is not None else "?"
            print(f"  [{i:02d}] {parse_iso(tc.timestamp)} | {tc.tool_name} | {status}")
            print(f"       CMD: {short(tc.command, 160)}")
            if tc.result_text:
                print(f"       OUT: {short(tc.result_text, 180)}")
    print()


def find_log_files(log_dir: Path) -> list[Path]:
    """Find JSON log files in directory."""
    candidates = []
    for p in sorted(log_dir.rglob("*")):
        if p.is_file() and p.suffix.lower() == ".json":
            candidates.append(p)
    return candidates


def main() -> None:
    parser = argparse.ArgumentParser(description="Summarize agent session logs in a directory.")
    parser.add_argument("log_dir", help="Directory containing JSONL log files")
    parser.add_argument("--details", action="store_true", help="Show per-tool-call details")
    parser.add_argument("--latest", type=int, default=0, help="Only show latest N files")
    parser.add_argument("--watch", action="store_true", help="Watch directory for new files and update continuously")
    args = parser.parse_args()

    log_dir = Path(args.log_dir).expanduser().resolve()
    if not log_dir.exists() or not log_dir.is_dir():
        raise SystemExit(f"Directory not found: {log_dir}")

    files = find_log_files(log_dir)
    if not files:
        raise SystemExit(f"No log files found in: {log_dir}")

    files = sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)
    if args.latest > 0:
        files = files[: args.latest]

    summaries = [parse_log_file(p) for p in files]

    total_tool_calls = sum(len(s.tool_calls) for s in summaries)
    aggregate = Counter()
    for s in summaries:
        aggregate.update(s.counters)

    print("\nLOG DIRECTORY SUMMARY")
    print("=" * 100)
    print(f"DIR         : {log_dir}")
    print(f"FILES       : {len(summaries)}")
    print(f"TOOL CALLS  : {total_tool_calls}")
    if aggregate:
        agg_text = ", ".join(f"{k}={v}" for k, v in aggregate.most_common())
        print(f"AGGREGATE   : {agg_text}")
    print()

    for summary in summaries:
        print_summary(summary, details=args.details)

    # Watch mode: keep running and monitor for changes
    if args.watch:
        import time
        from pathlib import Path as PPath
        import os
        
        log_dir = PPath(args.log_dir).expanduser().resolve()
        # Track mtime to detect both new and modified files
        file_mtimes = {f.name: f.stat().st_mtime for f in files}
        print(f"👀 Watching {log_dir} for changes (Ctrl+C to stop)...")
        
        try:
            while True:
                time.sleep(2)  # Check every 2 seconds
                current_files = find_log_files(log_dir)
                
                changed = False
                for f in current_files:
                    if f.name not in file_mtimes or f.stat().st_mtime > file_mtimes[f.name]:
                        changed = True
                        break
                
                if changed:
                    os.system('clear')  # Clear screen before showing update
                    
                    # Re-scan and re-calculate everything
                    files = sorted(current_files, key=lambda p: p.stat().st_mtime, reverse=True)
                    if args.latest > 0:
                        files = files[: args.latest]
                    summaries = [parse_log_file(p) for p in files]
                    
                    # Update mtimes for all current files
                    file_mtimes = {f.name: f.stat().st_mtime for f in current_files}

                    print("\n" + "=" * 100)
                    total_tool_calls = sum(len(s.tool_calls) for s in summaries)
                    aggregate = Counter()
                    for s in summaries:
                        aggregate.update(s.counters)
                    
                    print(f"DIR         : {log_dir}")
                    print(f"FILES       : {len(summaries)}")
                    print(f"TOOL CALLS  : {total_tool_calls}")
                    if aggregate:
                        agg_text = ", ".join(f"{k}={v}" for k, v in aggregate.most_common())
                        print(f"AGGREGATE   : {agg_text}")
                    print()
                    
                    for summary in summaries:
                        print_summary(summary, details=args.details)
        except KeyboardInterrupt:
            print("\n👋 Watch mode stopped.")


if __name__ == "__main__":
    main()