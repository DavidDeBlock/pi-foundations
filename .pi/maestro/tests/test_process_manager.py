#!/usr/bin/env python3
"""
Unit tests for `lib/process_manager.py`.
"""

import json
import os
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

import process_manager


def _make_dir() -> Path:
    return Path(tempfile.mkdtemp(prefix="maestro_process_test_"))


def _cleanup(d: Path) -> None:
    for p in d.rglob("*"):
        try:
            p.unlink()
        except OSError:
            pass
    try:
        d.rmdir()
    except OSError:
        pass


def test_registry_write_read():
    """Test registering and unregistering processes."""
    d = _make_dir()
    reg_file = d / "active_processes.json"
    
    with patch("process_manager.REGISTRY_FILE", reg_file):
        # Starts empty
        assert process_manager._read_registry() == {}
        
        # Register a process
        process_manager.register_process(
            pid=99999,
            flow_name="test-flow",
            issue_num=42,
            phase_name="builder",
            cmd=["pi", "--mode", "rpc", "--model", "foo"]
        )
        
        reg = process_manager._read_registry()
        assert "99999" in reg
        assert reg["99999"]["pid"] == 99999
        assert reg["99999"]["flow_name"] == "test-flow"
        assert reg["99999"]["issue_num"] == 42
        
        # Unregister
        process_manager.unregister_process(99999)
        assert process_manager._read_registry() == {}
        
    _cleanup(d)


@patch("process_manager.is_pid_running")
@patch("process_manager.get_proc_cmdline")
def test_get_active_processes(mock_cmdline, mock_running):
    """Test filtering running processes and detecting orphans."""
    d = _make_dir()
    reg_file = d / "active_processes.json"
    
    with patch("process_manager.REGISTRY_FILE", reg_file):
        # Register two processes: one running, one stale
        process_manager.register_process(
            pid=1111,
            flow_name="test-flow-1",
            issue_num=101,
            phase_name="builder",
            cmd=["pi", "--mode", "rpc"]
        )
        process_manager.register_process(
            pid=2222,
            flow_name="test-flow-2",
            issue_num=102,
            phase_name="reviewer",
            cmd=["pi", "--mode", "rpc"]
        )
        
        # Mock 1111 as running and 2222 as stopped
        def running_side_effect(pid):
            return pid == 1111
        mock_running.side_effect = running_side_effect
        
        # Mock cmdline
        def cmdline_side_effect(pid):
            if pid == 1111:
                return ["pi", "--mode", "rpc"]
            return []
        mock_cmdline.side_effect = cmdline_side_effect
        
        # Patch Path.glob to return no system processes
        with patch.object(Path, "glob", return_value=[]):
            active = process_manager.get_active_processes()
            
            # Should clean up 2222 and keep 1111
            assert len(active) == 1
            assert active[0]["pid"] == 1111
            assert active[0]["status"] == "registered"
            
            reg = process_manager._read_registry()
            assert "1111" in reg
            assert "2222" not in reg
            
    _cleanup(d)


@patch("process_manager.is_pid_running")
@patch("os.kill")
def test_kill_process(mock_kill, mock_running):
    """Test process termination logic."""
    d = _make_dir()
    reg_file = d / "active_processes.json"
    
    with patch("process_manager.REGISTRY_FILE", reg_file):
        process_manager.register_process(
            pid=3333,
            flow_name="test-flow-3",
            issue_num=103,
            phase_name="builder",
            cmd=["pi", "--mode", "rpc"]
        )
        
        # Mock running check: first True, then False (representing it exited)
        mock_running.side_effect = [True, False]
        
        success = process_manager.kill_process(3333)
        assert success is True
        mock_kill.assert_called_once_with(3333, 15)  # SIGTERM
        
        # Verify it unregistered
        assert "3333" not in process_manager._read_registry()
        
    _cleanup(d)


@patch("process_manager.get_active_processes")
@patch("process_manager.kill_process")
def test_cleanup_existing_processes(mock_kill, mock_active):
    """Test cleaning up existing processes for the same issue."""
    mock_active.return_value = [
        {
            "pid": 5555,
            "issue_num": 42,
            "flow_name": "test-flow",
            "phase_name": "builder",
            "status": "registered",
            "cmd": ["pi", "--mode", "rpc"]
        },
        {
            "pid": 6666,
            "issue_num": 43,
            "flow_name": "test-flow",
            "phase_name": "builder",
            "status": "registered",
            "cmd": ["pi", "--mode", "rpc"]
        }
    ]
    
    # Run cleanup for issue 42
    process_manager.cleanup_existing_processes("test-flow", 42)
    
    # Should terminate 5555 but not 6666
    mock_kill.assert_called_once_with(5555, force=True)
