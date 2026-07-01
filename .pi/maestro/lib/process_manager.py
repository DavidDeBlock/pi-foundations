#!/usr/bin/env python3
"""
process_manager.py — Process tracking and management for Maestro RPC clients.

Tracks active `pi --mode rpc` subprocesses, saving details (PID, flow, issue,
phase, start time) to `.pi/maestro/state/active_processes.json` using atomic
writes. Scans `/proc` to verify process status and detect unregistered orphans.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import time
from pathlib import Path
from typing import Optional

# Setup base paths
_MAESTRO_DIR = Path(__file__).parent.parent.resolve()
REGISTRY_FILE = _MAESTRO_DIR / "state" / "active_processes.json"


def _read_registry() -> dict[str, dict]:
    """Read the process registry file. Returns empty dict on error/missing."""
    if not REGISTRY_FILE.exists():
        return {}
    try:
        with open(REGISTRY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def _write_registry(registry: dict[str, dict]) -> None:
    """Atomic write of the process registry file."""
    REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = REGISTRY_FILE.parent / (REGISTRY_FILE.name + ".tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(registry, f, indent=2)
        os.replace(tmp, REGISTRY_FILE)
    except Exception as e:
        print(f"[process_manager] Failed to save registry: {e}", file=sys.stderr)


def get_proc_cmdline(pid: int) -> list[str]:
    """Read cmdline for a PID on Linux (/proc/<pid>/cmdline)."""
    try:
        cmdline_path = Path(f"/proc/{pid}/cmdline")
        if cmdline_path.exists():
            with open(cmdline_path, "rb") as f:
                content = f.read()
            # Split null bytes and decode
            return [p.decode("utf-8", errors="replace") for p in content.split(b"\x00") if p]
    except Exception:
        pass
    return []


def is_pid_running(pid: int) -> bool:
    """Check if process is active via os.kill(pid, 0)."""
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def is_pi_rpc_process(pid: int, cmdline: list[str]) -> bool:
    """Validate if the process is a `pi --mode rpc` process."""
    if not cmdline:
        return False
    
    first_arg = cmdline[0].lower()
    # Check if first arg has 'pi' or if any arg contains 'pi' and 'rpc'
    has_pi = "pi" in first_arg or any("pi" in arg for arg in cmdline)
    has_rpc = any(arg == "rpc" for arg in cmdline)
    
    # Also verify --mode rpc pattern
    has_mode_rpc = False
    for i, arg in enumerate(cmdline):
        if arg == "--mode" and i + 1 < len(cmdline) and cmdline[i + 1] == "rpc":
            has_mode_rpc = True
            break
        if arg == "rpc" and i > 0 and cmdline[i - 1] == "--mode":
            has_mode_rpc = True
            break

    return has_pi and (has_rpc or has_mode_rpc)


def register_process(pid: int, flow_name: str, issue_num: int, phase_name: str, cmd: list[str]) -> None:
    """Add a spawned process to the registry."""
    registry = _read_registry()
    registry[str(pid)] = {
        "pid": pid,
        "flow_name": flow_name,
        "issue_num": issue_num,
        "phase_name": phase_name,
        "cmd": cmd,
        "start_time": time.time(),
        "start_time_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    }
    _write_registry(registry)


def unregister_process(pid: int) -> None:
    """Remove a process from the registry."""
    registry = _read_registry()
    pid_str = str(pid)
    if pid_str in registry:
        del registry[pid_str]
        _write_registry(registry)


def get_active_processes() -> list[dict]:
    """Retrieve all active processes, cleaning up stale registry entries.
    
    Also scans /proc to find any running `pi --mode rpc` processes that were
    not registered (e.g. spawned by previous sessions or crashed runs).
    """
    registry = _read_registry()
    active = []
    registered_pids = set()
    stale_pids = []

    # 1. Verify registered processes
    for pid_str, info in registry.items():
        try:
            pid = int(pid_str)
            cmdline = get_proc_cmdline(pid)
            if is_pid_running(pid) and is_pi_rpc_process(pid, cmdline):
                info["status"] = "registered"
                info["current_cmdline"] = cmdline
                active.append(info)
                registered_pids.add(pid)
            else:
                stale_pids.append(pid_str)
        except ValueError:
            stale_pids.append(pid_str)

    # Clean up stale entries from registry
    if stale_pids:
        for pid_str in stale_pids:
            if pid_str in registry:
                del registry[pid_str]
        _write_registry(registry)

    # 2. Scan /proc for unregistered orphans
    try:
        for pid_dir in Path("/proc").glob("[0-9]*"):
            try:
                pid = int(pid_dir.name)
                if pid in registered_pids:
                    continue
                cmdline = get_proc_cmdline(pid)
                if is_pi_rpc_process(pid, cmdline):
                    active.append({
                        "pid": pid,
                        "flow_name": "unknown",
                        "issue_num": 0,
                        "phase_name": "unknown",
                        "cmd": cmdline,
                        "status": "orphan",
                        "start_time": None,
                        "start_time_iso": "unknown"
                    })
            except Exception:
                continue
    except Exception:
        pass

    # Sort by start_time (registered first, then orphans)
    return sorted(active, key=lambda x: (x.get("status") != "registered", x.get("start_time") or 0))


def kill_process(pid: int, force: bool = False) -> bool:
    """Terminate a process by PID. Returns True if successfully terminated."""
    if not is_pid_running(pid):
        unregister_process(pid)
        return True

    sig = signal.SIGKILL if force else signal.SIGTERM
    try:
        os.kill(pid, sig)
        # Give it a tiny moment to exit
        for _ in range(10):
            time.sleep(0.05)
            if not is_pid_running(pid):
                unregister_process(pid)
                return True
        
        # If SIGTERM failed and force wasn't set, try SIGKILL
        if not force:
            os.kill(pid, signal.SIGKILL)
            for _ in range(10):
                time.sleep(0.05)
                if not is_pid_running(pid):
                    unregister_process(pid)
                    return True
    except Exception:
        pass

    return not is_pid_running(pid)


def kill_all_processes(force: bool = False) -> int:
    """Kill all active and orphan Pi RPC processes. Returns count of killed."""
    active = get_active_processes()
    killed = 0
    for proc in active:
        if kill_process(proc["pid"], force):
            killed += 1
    return killed


def cleanup_existing_processes(flow_name: str, issue_num: int, term_logger=None) -> None:
    """Find and terminate any existing processes running for the same issue."""
    active = get_active_processes()
    for proc in active:
        if proc["issue_num"] == issue_num and proc["status"] == "registered":
            pid = proc["pid"]
            msg = f"[process_manager] Terminating existing active RPC client (PID {pid}) for issue #{issue_num}..."
            if term_logger:
                print(msg, file=term_logger)
            else:
                print(msg, file=sys.stderr)
            kill_process(pid, force=True)
