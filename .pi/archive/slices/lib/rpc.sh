#!/usr/bin/env bash
# rpc.sh — RPC client wrapper with session log extraction and tracking.
#
# Usage: source lib/config.sh; source lib/state.sh; source lib/rpc.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ─── Run RPC Client ────────────────────────────────────────────────────────
# Returns: 0 on success, non-zero on failure
# Sets: LAST_SESSION_LOG (path to session log if available)
run_rpc() {
    local prompt_file="$1"
    local timeout_seconds="${2:-$CFG_TIMEOUT_SECONDS}"

    LAST_SESSION_LOG=""

    # Run RPC client — stderr ([rpc] lines) streams live to terminal,
    # also saved to temp file for SESSION_LOG extraction
    local rpc_exit=0
    local rpc_tmpfile
    rpc_tmpfile=$(mktemp /tmp/pi-rpc-output.XXXXXX)

    python3 "${SCRIPT_DIR}/rpc-client.py" "$prompt_file" "$timeout_seconds" 2>&1 | tee "$rpc_tmpfile" || rpc_exit=${PIPESTATUS[0]}

    # Extract session log path if available (portable — no -P flag)
    local session_log=""
    if grep -q "SESSION_LOG=" "$rpc_tmpfile" 2>/dev/null; then
        session_log=$(sed -n 's/.*SESSION_LOG=//p' "$rpc_tmpfile" | head -1 | tr -d '\r\n')
    fi

    rm -f "$prompt_file" "$rpc_tmpfile"

    if [ $rpc_exit -ne 0 ]; then
        log_error "RPC session failed (exit code: ${rpc_exit})"
        LAST_SESSION_LOG="$session_log"
        return 1
    fi

    # Check result file exists
    if [ ! -f "$RESULT_FILE" ]; then
        log_warn "No result file written by Pi"
        echo "{\"status\":\"rejected\",\"slice\":${CURRENT_ISSUE:-0},\"issues\":[\"Pi session ended without writing result file\"]}" > "$RESULT_FILE"
        LAST_SESSION_LOG="$session_log"
        return 1
    fi

    LAST_SESSION_LOG="$session_log"
    return 0
}

# ─── Track Session Log After RPC ────────────────────────────────────────────
_track_session() {
    local issue_num="$1"
    local attempt="$2"
    local phase="$3"
    local rpc_status="$4"  # "success" or "failed"

    if [ -n "$LAST_SESSION_LOG" ]; then
        save_session_log "$issue_num" "$attempt" "$phase" "$LAST_SESSION_LOG" "$rpc_status"
    fi
}
