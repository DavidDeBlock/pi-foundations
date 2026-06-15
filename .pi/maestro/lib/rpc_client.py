#!/usr/bin/env python3
"""
rpc_client.py — Native Pi RPC client for Maestro orchestrator.

Replaces the old external rpc-client.py dependency with direct subprocess
calls to `pi --mode rpc`. Uses JSON stdin protocol and extracts session logs
for verdict extraction via Phase 1's verdict_extractor pipeline.

Protocol:
    - Send JSON commands to stdin (JSONL): {"type": "prompt", "message": "..."}
    - Receive JSON events on stdout (JSONL) including agent_end with messages
    - Session log saved by `pi --session-dir` flag, parseable by verdict_extractor

Usage:
    from lib.rpc_client import run_rpc_with_session_log
    
    result = run_rpc_with_session_log(
        prompt_text="Your agent prompt here",
        phase_name="builder",
        timeout_seconds=1800
    )
"""

import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Optional


PI_BIN: str = os.environ.get("MAESTRO_PI_BIN", "pi")


def _find_latest_jsonl(session_dir: Path) -> Optional[Path]:
    """Find the most recent .jsonl file in a session directory."""
    if not session_dir.is_dir():
        return None
    
    jsonl_files = list(session_dir.glob("*.jsonl"))
    if not jsonl_files:
        return None
    
    # Sort by name (includes timestamp prefix) — most recent last, so reverse
    return sorted(jsonl_files)[-1]


def _build_session_path(flow_name: str, issue_num: int, phase_name: str, 
                        session_dir_base: Path) -> Path:
    """Build a predictable session file path for this execution.
    
    Phase 1+ flat-file layout:
        <session_dir_base>/<issue>/<flow>-<phase>-<ISO8601>.jsonl
    
    The actual filename created by `pi --mode rpc` follows its own naming
    convention (<timestamp>_uuid.jsonl), so we search for the latest file
    after execution rather than relying on a predictable name.
    
    Returns:
        Path to the session directory where pi will write the .jsonl file.
    """
    safe_phase = phase_name.replace("/", "-")
    issue_dir = session_dir_base / str(issue_num)
    os.makedirs(issue_dir, exist_ok=True)
    return issue_dir


def run_rpc(prompt_text: str, phase_name: str = "builder", timeout_seconds: int = 1800,
            model: str = None, provider: str = None, session_dir: Optional[str] = None,
            flow_name: str = "unknown", issue_num: int = 0,
            tools: Optional[list[str]] = None) -> dict:
    """
    Run the Pi agent via native `pi --mode rpc` subprocess.

    Uses JSON stdin protocol — sends a prompt command and streams events from
    stdout until agent_end or timeout.

    Args:
        prompt_text: The full prompt to send to the agent.
        phase_name: Name of the phase (used for logging/context).
        timeout_seconds: Maximum time to wait for completion.
        model: Model name override.
        provider: Provider name override.
        session_dir: Optional directory for session storage. When set, the
                     resulting .jsonl file will be in this dir with a predictable
                     path structure (Phase 1+ flat-file layout).
        flow_name: Flow name used for session organization.
        issue_num: Issue number used for session organization.
        tools: Optional list of allowed tool names. Forwarded to the Pi agent
               runtime via the ``tools`` field in the JSON spawn options so the
               runtime can enforce the allowlist (e.g., a reviewer that is
               physically unable to call ``Write``). ``None`` means "no
               restriction declared" — the agent will fall back to its own
               default behaviour. Per the per-phase tool-allowlist PRD, the
               contract is a ``list[str]``; Pi-side enforcement is responsible
               for returning an error when a disallowed tool is invoked.

    Returns:
        Dict with keys:
            - success (bool): Whether the subprocess exited cleanly.
            - output (str): Raw stdout from the RPC process.
            - session_log (str|None): Path to the .jsonl file, or None.
            - agent_end (dict|None): The final agent_end event with messages,
                                     if captured during streaming.
    """
    # Resolve session directory path
    actual_session_dir: Optional[Path] = None
    if session_dir:
        session_path = Path(session_dir)
        if session_path.is_file():
            # Flat file layout already resolved — use parent dir
            actual_session_dir = session_path.parent
        elif session_path.is_dir():
            actual_session_dir = session_path
        else:
            os.makedirs(str(session_path), exist_ok=True)
            actual_session_dir = session_path
    
    # Build environment
    env = os.environ.copy()
    
    # Set up the command — pass model/provider as CLI flags (pi does not read PI_MODEL/PI_PROVIDER env vars)
    cmd = [PI_BIN, "--mode", "rpc"]
    if provider:
        cmd.extend(["--provider", provider])
    if model:
        cmd.extend(["--model", model])

    if actual_session_dir:
        cmd.extend(["--session-dir", str(actual_session_dir)])

    tools_summary = (
        f"tools={tools}" if tools is not None else "tools=default"
    )
    print(f"[rpc] Starting pi --mode rpc (model={model or 'default'}, "
          f"provider={provider or 'default'}, timeout={timeout_seconds}s, "
          f"{tools_summary})",
          file=sys.stderr)
    sys.stderr.flush()

    # Spawn the process with pipes for stdin/stdout
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,  # Use text mode for JSON lines
            env=env,
            bufsize=1,  # Line-buffered
        )
    except FileNotFoundError:
        error_msg = f"ERROR: 'pi' binary not found at '{PI_BIN}'. " \
                    f"Ensure @mariozechner/pi-coding-agent is installed."
        print(f"[rpc] {error_msg}", file=sys.stderr)
        return {
            "success": False,
            "output": error_msg,
            "session_log": None,
            "agent_end": None,
        }
    except Exception as e:
        error_msg = f"Failed to spawn pi process: {e}"
        print(f"[rpc] {error_msg}", file=sys.stderr)
        return {
            "success": False,
            "output": error_msg,
            "session_log": None,
            "agent_end": None,
        }

    # Stream stdout and capture the agent_end event
    output_lines: list[str] = []
    agent_end_event: Optional[dict] = None
    done_event = threading.Event()

    try:
        # Build the prompt command payload. Per the per-phase tool-allowlist
        # PRD, the ``tools`` field is included so Pi's agent runtime can
        # enforce the allowlist. When ``tools`` is None we omit the field to
        # preserve the existing contract (no restriction).
        prompt_payload: dict = {
            "type": "prompt",
            "message": prompt_text,
        }
        if tools is not None:
            prompt_payload["tools"] = tools
        prompt_command = json.dumps(prompt_payload) + "\n"
        
        print(f"[rpc] Sending prompt ({len(prompt_text)} chars)", file=sys.stderr)
        sys.stderr.flush()
        
        # Write to stdin and read from stdout concurrently
        
        def write_stdin():
            try:
                proc.stdin.write(prompt_command)
                proc.stdin.flush()
                # Wait for completion signal (agent_end received) or timeout
                done_event.wait(timeout=timeout_seconds + 30)
                # Close stdin to trigger RPC mode shutdown
                try:
                    proc.stdin.close()
                except Exception:
                    pass
            finally:
                pass
        
        def read_stdout():
            nonlocal agent_end_event, output_lines
            if proc.stdout is None:
                done_event.set()  # Signal completion immediately on error
                return
            try:
                for line in proc.stdout:
                    line = line.rstrip('\n')
                    if not line:
                        continue
                    
                    try:
                        event = json.loads(line)
                    except (json.JSONDecodeError, ValueError):
                        output_lines.append(line)
                        continue
                    
                    output_lines.append(line)
                    
                    # Capture agent_end event and signal completion
                    if isinstance(event, dict) and event.get("type") == "agent_end":
                        agent_end_event = event
                        done_event.set()  # Signal writer to close stdin
            except Exception:
                pass
        
        writer_thread = threading.Thread(target=write_stdin, daemon=True)
        reader_thread = threading.Thread(target=read_stdout, daemon=True)
        
        writer_thread.start()
        reader_thread.start()
        
        # Wait for completion with timeout
        try:
            proc.wait(timeout=timeout_seconds + 30)
        except subprocess.TimeoutExpired:
            print(f"[rpc] TIMEOUT after {timeout_seconds}s", file=sys.stderr)
            sys.stderr.flush()
            done_event.set()  # Signal writer to close stdin
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        
        output_text = "\n".join(output_lines)
        returncode = proc.returncode
        
    except KeyboardInterrupt:
        # Outer catch: handles interrupt during prompt send or thread setup (before proc.wait)
        print("\n[rpc] Interrupted — terminating child process...", file=sys.stderr)
        sys.stderr.flush()
        done_event.set()
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
                proc.wait()
            except Exception:
                pass
        raise
    except Exception as e:
        error_msg = f"RPC process error: {e}"
        print(f"[rpc] ERROR ({phase_name}): {error_msg}", file=sys.stderr)
        sys.stderr.flush()
        
        # Clean up process if still running
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
                proc.wait()
            except Exception:
                pass
        
        return {
            "success": False,
            "output": error_msg,
            "session_log": None,
            "agent_end": None,
        }
    
    # Check for subprocess exit status
    if returncode != 0 and returncode is not None:
        print(f"[rpc] FAILED (exit code {returncode}, phase: {phase_name})", 
              file=sys.stderr)
        sys.stderr.flush()
    
    success = (returncode == 0 or agent_end_event is not None)
    
    # Find session log file in the output for backwards compatibility
    session_log: Optional[str] = None
    
    if actual_session_dir:
        latest_jsonl = _find_latest_jsonl(actual_session_dir)
        if latest_jsonl:
            session_log = str(latest_jsonl)
            print(f"[rpc] Session log: {session_log}", file=sys.stderr)

    if not success:
        return {
            "success": False,
            "output": output_text[:2000],
            "session_log": session_log,
            "agent_end": agent_end_event,
        }
    
    print(f"[rpc] SUCCESS (phase: {phase_name})", file=sys.stderr)
    sys.stderr.flush()
    
    return {
        "success": True,
        "output": output_text[:2000],  # Truncate for log readability
        "session_log": session_log,
        "agent_end": agent_end_event,
    }


def run_rpc_with_session_log(prompt_text: str, phase_name: str = "builder",
                              timeout_seconds: int = 1800,
                              model: str = None, provider: str = None,
                              session_dir: Optional[str] = None,
                              flow_name: str = "unknown", issue_num: int = 0,
                              tools: Optional[list[str]] = None) -> dict:
    """
    Execute RPC and extract the verdict from the session log.

    Single-source-of-truth pipeline — verdict is extracted exclusively from
    the session log via ``extract_phase_verdict()``. No fallback to stale
    result files.

    Pipeline:
        1. Spawn `pi --mode rpc` natively with JSON stdin protocol
        2. Extract verdict from session log via verdict_extractor
        3. If no verdict found → return error state immediately

    Args:
        prompt_text: The full prompt to send to the agent.
        phase_name: Name of the phase (used for logging/context).
        timeout_seconds: Maximum time to wait for completion.
        model: Model name override.
        provider: Provider name override.
        session_dir: Optional directory for session storage.
        flow_name: Flow name used for session organization.
        issue_num: Issue number used for session organization.
        tools: Optional list of allowed tool names — forwarded to
               ``run_rpc`` and included in the JSON spawn options so the
               Pi agent runtime can enforce the allowlist.

    Returns:
        Dict with keys:
            - success (bool): Whether the RPC call succeeded.
            - output (str): Raw output from the subprocess.
            - session_log (str|None): Path to the .jsonl file, or None.
            - result (dict): The verdict result dict containing:
                * status ("approved", "rejected", "error")
                * issues (list[str]): Issue descriptions if rejected
                * details (str): Human-readable details
    """
    # Step 1: Execute the RPC call natively
    rpc_result = run_rpc(
        prompt_text, phase_name, timeout_seconds,
        model=model, provider=provider, session_dir=session_dir,
        flow_name=flow_name, issue_num=issue_num, tools=tools,
    )

    success = rpc_result["success"]
    output = rpc_result["output"]
    session_log_path = rpc_result.get("session_log")

    # If RPC itself failed, return error immediately
    if not success:
        return {
            "success": False,
            "output": output,
            "session_log": session_log_path,
            "result": {
                "status": "error",
                "details": f"RPC call failed: {output[:300]}",
            }
        }

    # Step 2: Extract verdict from session log (single source of truth).
    # The verdict_extractor module is imported lazily so a missing/optional
    # dependency never blocks RPC startup — mirrors the prior wrapper's
    # failure mode (log a warning, fall through to the "no verdict" branch).
    verdict: Optional[dict] = None
    if session_log_path:
        try:
            from verdict_extractor import extract_phase_verdict

            extracted = extract_phase_verdict(session_log_path)
            if extracted.get("status") is not None:
                print(f"[rpc] Verdict extracted from session log ({session_log_path}): "
                      f"{extracted['status']}", file=sys.stderr)
                sys.stderr.flush()
                verdict = extracted
        except ImportError:
            print("[rpc] [WARN] verdict_extractor module not available, skipping "
                  "session log parsing", file=sys.stderr)
            sys.stderr.flush()
        except Exception as e:
            print(f"[rpc] [WARN] Failed to extract verdict from session log "
                  f"({session_log_path}): {e}", file=sys.stderr)
            sys.stderr.flush()

    if verdict is not None and verdict.get("status") in ("approved", "rejected", "no_gaps"):
        return {
            "success": True,
            "output": output,
            "session_log": session_log_path,
            "result": {
                "status": verdict["status"],
                "issues": verdict.get("issues", []),
                "verdict": verdict.get("raw_text", ""),
            }
        }

    # Step 3: No verdict found — return error state immediately
    print(f"[rpc] No verdict extracted from session log ({session_log_path})",
          file=sys.stderr)
    sys.stderr.flush()

    return {
        "success": True,  # RPC succeeded but no verdict was extracted
        "output": output,
        "session_log": session_log_path,
        "result": {
            "status": "error",
            "details": (
                f"No verdict found in session log ({session_log_path}). "
                "The agent may not have emitted a verdict block."
            ),
        }
    }
