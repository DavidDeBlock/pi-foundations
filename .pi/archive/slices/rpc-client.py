#!/usr/bin/env python3
"""
rpc-client.py — Minimal Pi RPC client for slice execution.
Usage: python3 rpc-client.py <prompt-text-file> [timeout-seconds]
Sends prompt to pi --mode rpc, waits for agent_end, exits 0 on success.
"""

import subprocess
import sys
import json
import time
import os
import select


def main():
    if len(sys.argv) < 2:
        print("Usage: rpc-client.py <prompt-file> [timeout]", file=sys.stderr)
        sys.exit(1)

    prompt_file = sys.argv[1]
    timeout = int(sys.argv[2]) if len(sys.argv) > 2 else 600

    # Read prompt from file
    with open(prompt_file, 'r') as f:
        prompt_text = f.read()

    # Build RPC command
    rpc_cmd = json.dumps({
        "type": "prompt",
        "message": prompt_text
    })

    startup_timeout = 30  # seconds to wait for agent_start
    
    # Model selection: read from env or use default.
    # Pi's --model flag supports "provider/id" format — no separate provider needed.
    model_name = os.environ.get("PI_MODEL", "qwen-27b-64k-q8")
    provider_name = os.environ.get("PI_PROVIDER", "llama-cpp-3090")
    model_id = f"{provider_name}/{model_name}"
    print(f"[rpc] Starting pi --mode rpc (model={model_id}, startup={startup_timeout}s, work={timeout}s)", file=sys.stderr)
    sys.stderr.flush()

    try:
        proc = subprocess.Popen(
            ["pi", "--mode", "rpc", "--model", model_id],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,  # Suppress stderr noise
            text=True,
            bufsize=1
        )
    except FileNotFoundError:
        print("[rpc] ERROR: 'pi' command not found in PATH", file=sys.stderr)
        sys.exit(1)

    try:
        # Request session state to get log file path (called immediately so it arrives early in the stream)
        state_cmd = json.dumps({"type": "command", "id": "get_state_1"})
        proc.stdin.write(state_cmd + "\n")
        proc.stdin.flush()

        # Send prompt command
        proc.stdin.write(rpc_cmd + "\n")
        proc.stdin.flush()
        print(f"[rpc] Prompt sent ({len(prompt_text)} chars)", file=sys.stderr)
        sys.stderr.flush()

        # Wait for agent_end event with timeout
        # Timer starts only after agent_start — gives Pi init time before counting
        proc_start_time = time.time()  # For startup timeout
        start_time = None              # Set when agent_start arrives
        got_agent_start = False
        got_agent_end = False
        buffer = ""

        while True:
            # Startup timeout: fail fast if Pi never responds
            if start_time is None:
                elapsed_startup = time.time() - proc_start_time
                if elapsed_startup > startup_timeout:
                    print(f"[rpc] STARTUP TIMEOUT — no agent_start after {startup_timeout}s", file=sys.stderr)
                    sys.stderr.flush()
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                    sys.exit(1)

            # Work timeout: only enforced after agent has started working
            if start_time is not None:
                elapsed = time.time() - start_time
                if elapsed > timeout:
                    print(f"[rpc] TIMEOUT after {timeout}s", file=sys.stderr)
                    sys.stderr.flush()
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                    sys.exit(1)

            # Non-blocking read using select — avoids blocking forever on readline()
            readable, _, _ = select.select([proc.stdout], [], [], 1.0)
            if not readable and proc.poll() is not None:
                # Process exited with no more data
                print(f"[rpc] Pi process exited with code {proc.returncode}", file=sys.stderr)
                sys.stderr.flush()
                break

            if not readable:
                continue  # No data yet, loop back to check timeouts

            chunk = proc.stdout.readline()
            if not chunk:
                if proc.poll() is not None:
                    print(f"[rpc] Pi process exited with code {proc.returncode}", file=sys.stderr)
                    sys.stderr.flush()
                    break
                continue

            buffer += chunk
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.strip()
                if not line:
                    continue

                try:
                    event = json.loads(line)
                    event_type = event.get("type", "")

                    if event_type == "response" and event.get("command") == "get_state":
                        if event.get("success"):
                            session_file = event.get("data", {}).get("sessionFile", "")
                            if session_file:
                                print(f"[rpc] SESSION_LOG={session_file}", file=sys.stderr)
                    elif event_type == "agent_start":
                        got_agent_start = True
                        start_time = time.time()  # Start timer when agent begins work
                        print("[rpc] Agent started", file=sys.stderr)
                    elif event_type == "agent_end":
                        got_agent_end = True
                        print("[rpc] Agent finished", file=sys.stderr)
                        sys.stderr.flush()
                        break
                    elif event_type == "error":
                        error_msg = event.get("message", "Unknown error")
                        print(f"[rpc] Error: {error_msg}", file=sys.stderr)
                except json.JSONDecodeError:
                    # Skip non-JSON lines (shouldn't happen in RPC mode)
                    pass
            else:
                sys.stderr.flush()
                continue  # agent_end not found yet
            break  # agent_end found, exit outer loop

        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

        if got_agent_end:
            print("[rpc] SUCCESS", file=sys.stderr)
            sys.exit(0)
        else:
            print("[rpc] FAILED — no agent_end received", file=sys.stderr)
            sys.exit(1)

    except KeyboardInterrupt:
        print("\n[rpc] Interrupted", file=sys.stderr)
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        sys.exit(130)


if __name__ == "__main__":
    main()
