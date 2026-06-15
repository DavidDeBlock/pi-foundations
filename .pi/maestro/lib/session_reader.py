#!/usr/bin/env python3
"""
session_reader.py — Parse JSONL session logs into human-readable summaries.

Adapted from the shared TypeScript session-parser library to provide structured
summaries of Pi agent sessions for terminal display and phase comments.

Extracts: file operations, errors, model metadata, duration, and key events.

Usage:
    summary = parse_session_log("/tmp/sessions/abc123.jsonl")
    print(format_session_summary(summary))  # Human-readable string
"""

import json
from pathlib import Path
from typing import Optional, Union


def extract_phase_usage(log_path: Union[str, Path]) -> Optional[dict]:
    """Extract the last token-usage block from a session-log JSONL file.

    The session log already carries ``message.usage`` on each assistant
    message (with fields ``input``, ``output``, ``cacheRead``,
    ``cacheWrite``, ``totalTokens``, and a nested ``cost`` object).
    Within a single phase run, assistant messages are cumulative — the
    last one reflects the total tokens spent in the phase. The runner
    surfaces these totals as ``PhaseRun.tokens_in`` (= ``input +
    cacheWrite``), ``tokens_out`` (= ``output``), and ``cache_read``
    (= ``cacheRead``).

    Behaviour:
        - ``None`` if the log file does not exist
        - ``None`` if the log is empty or has no assistant message with
          a ``message.usage`` field
        - The ``usage`` dict of the **last** assistant message that
          has a ``usage`` field (cumulative within a session)
        - Malformed JSON lines are skipped, not raised
        - Only ``role == "assistant"`` events are considered; ``user``,
          ``toolResult``, ``system`` etc. are ignored

    Args:
        log_path: Path to the JSONL session log. Accepts both ``str``
            and ``pathlib.Path``.

    Returns:
        The raw ``usage`` dict (caller computes ``tokens_in``,
        ``tokens_out``, ``cache_read`` from its fields), or ``None`` if
        no usable usage data is present.
    """
    path = Path(log_path)
    if not path.exists():
        return None

    last_usage: Optional[dict] = None
    try:
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                message = event.get("message") if isinstance(event, dict) else None
                if not isinstance(message, dict):
                    continue
                if message.get("role") != "assistant":
                    continue
                usage = message.get("usage")
                if isinstance(usage, dict):
                    last_usage = usage
    except (OSError, UnicodeDecodeError):
        # Unreadable file (permission denied, binary blob, etc.) — the
        # caller treats this the same as "no usage data".
        return last_usage

    return last_usage


def _to_epoch_ms(ts) -> Optional[int]:
    """Convert an ISO timestamp or epoch ms to epoch milliseconds."""
    if ts is None:
        return None
    
    if isinstance(ts, (int, float)):
        # Already numeric — check if it's already ms (epoch > 1e12 means ms)
        if ts > 1e12:
            return int(ts)
        else:
            return int(ts * 1000)  # Assume seconds
    
    try:
        # Try parsing as ISO string
        from datetime import datetime
        dt = datetime.fromisoformat(str(ts).replace('Z', '+00:00'))
        return int(dt.timestamp() * 1000)
    except (ValueError, TypeError):
        return None


def _extract_text_from_content(content) -> str:
    """Extract plain text from tool result content (array of parts or scalar)."""
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


def parse_session_log(log_path: str) -> dict:
    """
    Parse a JSONL session log and return a structured summary.
    
    Args:
        log_path: Path to the JSONL session file
        
    Returns:
        Dict with keys:
            - model (str): Model used in the session
            - duration_seconds (float): Total time from start to end  
            - file_operations (list[dict]): File operations performed
            - errors (list[dict]): Errors encountered
            - events (list[str]): Human-readable event descriptions
    """
    result = {
        "model": None,
        "duration_seconds": 0.0,
        "file_operations": [],
        "errors": [],
        "events": []
    }
    
    try:
        path = Path(log_path)
        if not path.exists():
            result["events"].append(f"⚠️  Session log file not found: {log_path}")
            return result
        
        # Track state for pairing tool calls with results
        pending_tool_calls = {}  # toolCallId -> {toolName, arguments}
        first_ts_ms = None
        last_ts_ms = None
        model_name = None
        
        with open(log_path, 'r') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                
                try:
                    event = json.loads(line)
                except (json.JSONDecodeError, ValueError):
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
                
                # Track model info from metadata events
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
                                "arguments": args
                            }
                        
                        # Detect errors in assistant text
                        elif part_type == "text":
                            text = part.get("text", "")
                            if isinstance(text, str):
                                lower_text = text.lower()
                                
                                # Detect decision patterns (from TS implementation)
                                if any(pattern in lower_text for pattern in [
                                    "✅ **", "locked in", "option a:", "option b:"
                                ]):
                                    result["events"].append(f"🔑 Decision: {text[:100]}")
                                
                                # Detect errors/failures in text
                                elif any(w in lower_text for w in ["error:", "failed", "exception"]):
                                    if len(text) > 50:
                                        result["errors"].append({
                                            "type": "assistant_error",
                                            "message": text[:200]
                                        })
                
                # Handle tool results (success/failure)
                elif role == "toolResult":
                    call_id = message.get("toolCallId") or message.get("parentId")
                    is_error = message.get("isError", False)
                    
                    # Find the original tool call to get name and file path
                    call_info = pending_tool_calls.pop(call_id, None) if call_id else None
                    
                    if call_info:
                        tool_name = call_info["toolName"]
                        args = call_info.get("arguments", {}) or {}
                        
                        # Extract file path from arguments (common in write_file, edit, read, etc.)
                        file_path = args.get("path") or args.get("file") or args.get("filePath") or "unknown"
                        
                        error_content = _extract_text_from_content(message.get("content"))
                        
                        op = {
                            "tool": tool_name.upper(),
                            "path": file_path,
                            "status": "failed" if is_error else "success",
                            "timestamp": ts_ms or "",
                            "error_message": error_content[:200] if is_error and error_content else None
                        }
                        
                        result["file_operations"].append(op)
                        
                        # Add to events for display
                        status_icon = "❌" if is_error else "✅"
                        result["events"].append(
                            f"{status_icon} {tool_name}: {file_path}"
                        )
                        
                        # Track errors
                        if is_error and error_content:
                            result["errors"].append({
                                "type": "tool_error",
                                "message": error_content[:200],
                                "context": f"{tool_name} on {file_path}"
                            })
                    
                    elif is_error and call_id not in pending_tool_calls:
                        # Orphan failure (result with no matching tool call)
                        error_content = _extract_text_from_content(message.get("content"))
                        if error_content:
                            result["errors"].append({
                                "type": "orphan_error",
                                "message": error_content[:200],
                                "context": f"Orphan tool result {event.get('id', 'unknown')}"
                            })
        
        # Calculate duration
        if first_ts_ms and last_ts_ms:
            result["duration_seconds"] = (last_ts_ms - first_ts_ms) / 1000.0
        
        # Add model info to events
        if model_name:
            result["model"] = model_name
            result["events"].insert(0, f"🤖 Model: {model_name}")
        
        # Add duration summary
        if result["duration_seconds"]:
            mins = int(result["duration_seconds"] // 60)
            secs = int(result["duration_seconds"] % 60)
            event_line = f"⏱️  Session lasted {mins}m {secs}s"
            if model_name:
                event_line += f" ({model_name})"
            result["events"].insert(1, event_line)
        
        # Add file operation summary (if any)
        successful_ops = [op for op in result["file_operations"] if op["status"] == "success"]
        failed_ops = [op for op in result["file_operations"] if op["status"] == "failed"]
        
        if successful_ops:
            result["events"].append(f"📄 {len(successful_ops)} file(s) written successfully")
        if failed_ops:
            result["events"].append(f"❌ {len(failed_ops)} file operation(s) failed")
        
        # Add error summary (if any)
        if result["errors"]:
            result["events"].append(f"⚠️  {len(result['errors'])} error(s) detected")
        
    except Exception as e:
        result["events"].append(f"⚠️  Failed to parse session log: {e}")
    
    return result


def format_session_summary(summary: dict) -> str:
    """Format a session summary into a readable string block."""
    lines = []
    
    for event in summary.get("events", []):
        lines.append(f"   • {event}")
        
    if summary.get("errors"):
        lines.append("")
        lines.append("   ⚠️  Errors:")
        for err in summary["errors"][:3]:  # Limit to first 3 errors
            lines.append(f"      - [{err['type']}] {err['message'][:100]}")
    
    if summary.get("file_operations"):
        lines.append("")
        lines.append("   📋 File Operations:")
        for op in summary["file_operations"][:5]:  # Limit to first 5
            status = "✅" if op["status"] == "success" else "❌"
            lines.append(f"      {status} {op['tool']}: {op['path']}")
    
    return "\n".join(lines)
