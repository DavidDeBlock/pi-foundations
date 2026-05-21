#!/usr/bin/env python3
"""
rpc_client.py — Pi RPC client wrapper for Maestro orchestrator.

Wraps the existing rpc-client.py with proper environment variable mapping,
timeout handling, and session log extraction.

Usage:
    from lib.rpc_client import run_rpc
    
    success, output = run_rpc(
        prompt_text="Your agent prompt here",
        phase_name="builder",
        timeout_seconds=1800
    )
"""

import subprocess
import sys
import os
import json
import tempfile
from pathlib import Path


# Path to the Pi RPC client (consolidated into maestro/lib/)
RPC_CLIENT_PATH = Path(__file__).parent / "pi_rpc_client.py"


def run_rpc(prompt_text: str, phase_name: str = "builder", timeout_seconds: int = 1800,
            model: str = None, provider: str = None) -> tuple[bool, str]:
    """
    Runs the Pi RPC client for a specific phase.
    
    Args:
        prompt_text: The full prompt to send to the agent
        phase_name: Name of the phase (used for logging/context)
        timeout_seconds: Maximum time to wait for completion
        model: Model name override (defaults to qwen-35b-a3b-118k-bf16)
        provider: Provider name override (defaults to llama-cpp-3090)
        
    Returns:
        Tuple of (success: bool, output: str with all stderr/stdout)
    """
    if not RPC_CLIENT_PATH.exists():
        return False, f"ERROR: rpc-client.py not found at {RPC_CLIENT_PATH}"
    
    # Create temporary file for prompt content
    with tempfile.NamedTemporaryFile(mode='w', suffix='.prompt', delete=False) as tmp:
        tmp.write(prompt_text)
        prompt_file = tmp.name
    
    try:
        # Set environment variables from config (or use defaults)
        env = os.environ.copy()
        if model is not None:
            env["PI_MODEL"] = model
        else:
            env.setdefault("PI_MODEL", "qwen-35b-a3b-118k-bf16")
        
        if provider is not None:
            env["PI_PROVIDER"] = provider
        else:
            env.setdefault("PI_PROVIDER", "llama-cpp-3090")
        
        print(f"[rpc] Starting rpc-client.py (model={env['PI_PROVIDER']}/{env['PI_MODEL']}, timeout={timeout_seconds}s)", 
              file=sys.stderr)
        sys.stderr.flush()
        
        # Run the existing rpc-client.py with prompt file as argument
        result = subprocess.run(
            [sys.executable, str(RPC_CLIENT_PATH), prompt_file, str(timeout_seconds)],
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_seconds + 30  # Extra time for cleanup
        )
        
        output = result.stdout + "\n" + result.stderr
        
        if result.returncode == 0:
            print(f"[rpc] SUCCESS (phase: {phase_name})", file=sys.stderr)
            return True, output
        else:
            # Extract useful error info
            if "TIMEOUT" in output or "STARTUP TIMEOUT" in output:
                error_msg = f"RPC timed out after {timeout_seconds}s"
            elif "agent_end not received" in output.lower():
                error_msg = "Agent did not complete (no agent_end event)"
            else:
                error_msg = result.stderr.strip() or f"Exit code {result.returncode}"
            
            print(f"[rpc] FAILED ({phase_name}): {error_msg}", file=sys.stderr)
            return False, output
            
    except subprocess.TimeoutExpired as e:
        error_msg = f"RPC client process timed out after {timeout_seconds}s"
        print(f"[rpc] TIMEOUT ({phase_name}): {error_msg}", file=sys.stderr)
        return False, error_msg
        
    finally:
        # Clean up temporary prompt file
        try:
            os.unlink(prompt_file)
        except OSError:
            pass


def read_result_file(result_path: str = None) -> dict:
    """
    Read and parse the slice result JSON file.
    
    Args:
        result_path: Path to the result file. Defaults to standard location.
        
    Returns:
        Dict with keys from the result JSON (status, issues, verdict, etc.)
    """
    if result_path is None:
        resolved = Path(__file__).resolve()
        pi_dir = resolved.parents[2]  # Goes: lib → maestro → .pi
        paths = [
            str(pi_dir / "state" / "slice-result.json"),      # .pi/state/
            str(pi_dir / "maestro" / "state" / "slice-result.json")  # .pi/maestro/state/
        ]
        result_path = None
        for p in paths:
            if os.path.exists(p):
                result_path = p
                print(f"[rpc] Reading result from: {result_path}", file=sys.stderr)
                sys.stderr.flush()
                break
    
    try:
        with open(result_path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def run_rpc_with_session_log(prompt_text: str, phase_name: str = "builder", timeout_seconds: int = 1800,
    model: str = None, provider: str = None) -> dict:
    """
    Enhanced version that also extracts session log path and result JSON.
    
    Returns:
        Dict with keys: success (bool), output (str), session_log (str or None),
                       result (dict with status, issues, verdict, etc.)
    """
    success, output = run_rpc(prompt_text, phase_name, timeout_seconds, model=model, provider=provider)
    
    # Extract session log path from output
    session_log = None
    for line in output.split('\n'):
        if 'SESSION_LOG=' in line:
            session_log = line.split('SESSION_LOG=')[-1].strip()
            break
    
    # Read the actual result JSON file written by the agent
    result_data = read_result_file()
    
    return {
        "success": success,
        "output": output,
        "session_log": session_log,
        "result": result_data
    }
