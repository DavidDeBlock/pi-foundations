#!/usr/bin/env python3
"""
scripts/session-summary.py — JSONL session log summarizer.

Parses a Pi agent JSONL session log and outputs a human-readable summary:
model used, duration, file operations, errors, and key events.

Adapted from the TypeScript session-parser for quick debugging.

Usage:
    python scripts/session-summary.py <path>                    # Human-readable (default)
    python scripts/session-summary.py <path> --json             # Machine-readable JSON
    python scripts/session-summary.py <path> --help             # Show usage information

Examples:
    python scripts/session-summary.py maestro/sessions/177-builder-reviewer-*/session.jsonl
    python scripts/session-summary.py /tmp/session.jsonl --json"""

import json
import sys
from pathlib import Path
from datetime import datetime, timezone
import argparse


def _to_epoch_ms(ts) -> int | None:
    """Convert an ISO timestamp or epoch ms to epoch milliseconds."""
    if ts is None:
        return None
    
    if isinstance(ts, (int, float)):
        if ts > 1e12:
            return int(ts)
        else:
            return int(ts * 1000)
    
    try:
        dt = datetime.fromisoformat(str(ts).replace('Z', '+00:00'))
        return int(dt.timestamp() * 1000)
    except (ValueError, TypeError):
        return None


def _extract_text_from_content(content) -> str:
    """Extract plain text from tool result content."""
    if not content:
        return ""
    
    if isinstance(content, str):
        return content
    
    if isinstance(content, list):
        texts = [
            part.get("text", "") 
            for part in content 
            if isinstance(part, dict) and part.get("type") == "text"
        ]
        return "\n".join(texts)
    
    return str(content)


def _parse_session_log(log_path: str) -> dict:
    """Parse a JSONL session log into a structured summary."""
    result = {
        "model": None,
        "duration_seconds": 0.0,
        "file_operations": [],
        "errors": [],
        "events": [],
    }
    
    try:
        path = Path(log_path)
        if not path.exists():
            result["events"].append(f"Session log file not found: {log_path}")
            return result
        
        pending_tool_calls: dict[str, dict] = {}
        first_ts_ms = None
        last_ts_ms = None
        model_name = None
        
        with open(log_path, 'r') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                
                try:
                    event = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    result["events"].append(f"Line {line_num}: invalid JSON")
                    continue
                
                # Extract timestamp
                ts_ms = _to_epoch_ms(event.get("timestamp")) or _to_epoch_ms(
                    event.get("message", {}).get("timestamp")
                )
                
                if ts_ms:
                    if first_ts_ms is None or ts_ms < first_ts_ms:
                        first_ts_ms = ts_ms
                    if last_ts_ms is None or ts_ms > last_ts_ms:
                        last_ts_ms = ts_ms
                
                # Track model info
                event_type = event.get("type", "")
                if event_type == "model_change":
                    provider = event.get("provider", "")
                    model_id = event.get("modelId", "")
                    if provider and model_id:
                        model_name = f"{provider}/{model_id}"
                    elif model_id:
                        model_name = model_id
                
                # Process messages
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
                            }
                        
                        # Detect errors in assistant text
                        elif part_type == "text":
                            text = part.get("text", "")
                            if isinstance(text, str):
                                lower_text = text.lower()
                                
                                if any(p in lower_text for p in ["✅ **", "locked in"]):
                                    result["events"].append(f"Decision: {text[:100]}")
                                elif any(w in lower_text for w in ["error:", "failed", "exception"]):
                                    if len(text) > 50:
                                        result["errors"].append({
                                            "type": "assistant_error",
                                            "message": text[:200],
                                        })
                
                # Handle tool results
                elif role == "toolResult":
                    call_id = message.get("toolCallId") or message.get("parentId")
                    is_error = message.get("isError", False)
                    
                    call_info = pending_tool_calls.pop(call_id, None) if call_id else None
                    
                    if call_info:
                        tool_name = call_info["toolName"]
                        args = call_info.get("arguments", {}) or {}
                        
                        file_path = args.get("path") or args.get("file") or args.get("filePath") or "unknown"
                        error_content = _extract_text_from_content(message.get("content"))
                        
                        op = {
                            "tool": tool_name.upper(),
                            "path": file_path,
                            "status": "failed" if is_error else "success",
                            "error_message": error_content[:200] if is_error and error_content else None,
                        }
                        
                        result["file_operations"].append(op)
                        
                        status_icon = "❌" if is_error else "✅"
                        result["events"].append(f"{status_icon} {tool_name}: {file_path}")
                        
                        if is_error and error_content:
                            result["errors"].append({
                                "type": "tool_error",
                                "message": error_content[:200],
                                "context": f"{tool_name} on {file_path}",
                            })
        
        # Calculate duration
        if first_ts_ms and last_ts_ms:
            result["duration_seconds"] = (last_ts_ms - first_ts_ms) / 1000.0
        
        # Add model info to events
        if model_name:
            result["model"] = model_name
            result["events"].insert(0, f"Model: {model_name}")
        
        # Duration summary
        if result["duration_seconds"]:
            mins = int(result["duration_seconds"] // 60)
            secs = int(result["duration_seconds"] % 60)
            event_line = f"Duration: {mins}m {secs}s"
            if model_name:
                event_line += f" ({model_name})"
            result["events"].insert(1, event_line)
        
        # File operation summary
        successful_ops = [op for op in result["file_operations"] if op["status"] == "success"]
        failed_ops = [op for op in result["file_operations"] if op["status"] == "failed"]
        
        if successful_ops:
            result["events"].append(f"{len(successful_ops)} file(s) written successfully")
        if failed_ops:
            result["events"].append(f"{len(failed_ops)} file operation(s) failed")
        
        # Error summary
        if result["errors"]:
            result["events"].append(f"{len(result['errors'])} error(s) detected")
    
    except Exception as e:
        result["events"].append(f"Failed to parse session log: {e}")
    
    return result


def _generate_markdown(summary: dict, filepath: str) -> str:
    """Generate a human-readable summary."""
    output = f"# Session Summary: {Path(filepath).name}\n\n"
    
    # Model and duration line
    if summary["model"]:
        output += f"**Model:** `{summary['model']}`  "
    if summary.get("duration_seconds", 0) > 0:
        mins = int(summary["duration_seconds"] // 60)
        secs = int(summary["duration_seconds"] % 60)
        output += f"**Duration:** {mins}m {secs}s\n"
    else:
        output += "\n"
    
    # File operations table (only if few ops)
    successful_ops = [op for op in summary["file_operations"] if op["status"] == "success"]
    failed_ops = [op for op in summary["file_operations"] if op["status"] == "failed"]
    
    if summary["file_operations"]:
        output += f"**{len(successful_ops)} written, {len(failed_ops)} failed**\n\n"
        
        headers = ["Tool", "Path", "Status"]
        rows: list[list[str]] = []
        
        for op in summary["file_operations"][:20]:  # Limit to first 20
            status_icon = "✅" if op["status"] == "success" else "❌"
            rows.append([op["tool"], op.get("path", ""), status_icon])
        
        col_widths = [len(h) for h in headers]
        for row in rows:
            for i, cell in enumerate(row):
                col_widths[i] = max(col_widths[i], len(str(cell)))
        
        output += "| " + " | ".join(h.ljust(col_widths[i]) for i, h in enumerate(headers)) + " |\n"
        output += "|" + "|".join("-" * (col_widths[i] + 2) for i in range(len(headers))) + "|\n"
        
        for row in rows:
            output += "| " + " | ".join(str(c).ljust(col_widths[i]) for i, c in enumerate(row)) + " |\n"
        
        if len(summary["file_operations"]) > 20:
            output += f"\n*... and {len(summary['file_operations']) - 20} more operations*\n\n"
    
    # Errors section (only if errors exist)
    if summary["errors"]:
        output += "## ⚠️ Errors\n\n"
        
        headers = ["Type", "Message"]
        rows: list[list[str]] = []
        
        for err in summary["errors"][:10]:  # Limit to first 10
            msg_preview = (err.get("message", "") or "").replace('\n', ' ')[:80]
            ctx = err.get("context", "")
            rows.append([err["type"], f"{msg_preview}{' (' + ctx + ')' if ctx else ''}"])
        
        col_widths = [len(h) for h in headers]
        for row in rows:
            for i, cell in enumerate(row):
                col_widths[i] = max(col_widths[i], len(str(cell)))
        
        output += "| " + " | ".join(h.ljust(col_widths[i]) for i, h in enumerate(headers)) + " |\n"
        output += "|" + "|".join("-" * (col_widths[i] + 2) for i in range(len(headers))) + "|\n"
        
        for row in rows:
            output += "| " + " | ".join(str(c).ljust(col_widths[i]) for i, c in enumerate(row)) + " |\n"
    
    # Events log (last few key events)
    if summary["events"]:
        output += "\n## Events\n\n"
        
        # Show last 10 events (skip model/duration which are already shown above)
        display_events = [e for e in summary["events"] 
                         if not e.startswith(("Model:", "Duration:"))][-10:]
        
        for event in display_events:
            output += f"- {event}\n"
    
    return output.strip() + "\n"


def _generate_json(summary: dict) -> str:
    """Generate JSON output of session summary."""
    return json.dumps(summary, indent=2)


def _generate_help() -> str:
    return """Usage: python scripts/session-summary.py <path> [options]

JSONL session log summarizer. Parses Pi agent session logs and outputs
a structured summary with model info, duration, file operations, and errors.

Arguments:
  path            Path to the .jsonl session log file

Options:
  --json          Output detailed JSON (includes full error details)
  --help          Show this help message

Output Formats:
  Default       Human-readable Markdown with model, ops table, and events
  --json        Detailed JSON with all parsed fields

Examples:
  python scripts/session-summary.py maestro/sessions/177-*/session.jsonl
  python scripts/session-summary.py /tmp/debug.jsonl --json"""


def main():
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Session log summarizer — parses JSONL session logs.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=_generate_help()
    )
    parser.add_argument("path", help="Path to the .jsonl session log file")
    parser.add_argument("--json", action="store_true", help="Output detailed JSON")
    parser.add_argument("--help-all", action="store_true", help="Show extended help")
    
    args = parser.parse_args()
    
    if args.help_all:
        print(_generate_help())
        return
    
    filepath = str(Path(args.path).resolve())
    
    summary = _parse_session_log(filepath)
    
    if args.json:
        print(_generate_json(summary))
    else:
        print(_generate_markdown(summary, filepath))


if __name__ == "__main__":
    main()
