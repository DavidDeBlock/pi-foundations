#!/usr/bin/env bash
# state.sh — State management using proper JSON + bash arrays.
#
# Usage: source lib/config.sh; source lib/state.sh

STATE_FILE="${CFG_STATE_DIR}/slice-run.json"
LOGS_FILE="${CFG_STATE_DIR}/slice-logs.json"

# ─── Bash Array for Issue List (replaces fragile space-separated string) ────
declare -a ISSUE_NUMBERS=()
CURRENT_SLICE_INDEX=0
AGENT_PHASE="builder"
BUILDER_RETRIES=0
TOTAL_ITERATIONS=1

# ─── Init State ─────────────────────────────────────────────────────────────
init_state() {
    mkdir -p "$CFG_STATE_DIR"

    if [ "$RESUME" = true ] && [ -f "$STATE_FILE" ]; then
        log_info "Resuming from state file: $STATE_FILE"
        load_state
        return 0
    fi

    # Initialize fresh state
    _write_json_state [] 0 "builder" 0 1
    log_info "Initialized state file: $STATE_FILE"
}

# ─── Write State as Proper JSON ─────────────────────────────────────────────
_write_json_state() {
    local issue_array="$1"
    local slice_index="$2"
    local phase="$3"
    local retries="$4"
    local iterations="$5"
    local tmp="${STATE_FILE}.tmp.$$"

    python3 -c "
import json, sys
state = {
    'issueList': ${issue_array},
    'currentSliceIndex': ${slice_index},
    'agentPhase': '${phase}',
    'builderRetries': ${retries},
    'totalIterations': ${iterations}
}
with open('${tmp}', 'w') as f:
    json.dump(state, f, indent=2)
" 2>/dev/null || return 1

    mv "$tmp" "$STATE_FILE"
}

save_state() {
    # Convert bash array to JSON array string
    local issue_json="[]"
    if [ ${#ISSUE_NUMBERS[@]} -gt 0 ]; then
        issue_json=$(printf '%s\n' "${ISSUE_NUMBERS[@]}" | python3 -c "import sys,json; print(json.dumps([int(x.strip()) for x in sys.stdin if x.strip()]))")
    fi

    _write_json_state "$issue_json" "$CURRENT_SLICE_INDEX" "$AGENT_PHASE" "$BUILDER_RETRIES" "$TOTAL_ITERATIONS"
}

# ─── Load State from JSON ──────────────────────────────────────────────────
load_state() {
    if [ ! -f "$STATE_FILE" ]; then
        return 1
    fi

    local data
    data=$(python3 -c "
import json, sys
with open('${STATE_FILE}') as f:
    d = json.load(f)
# Print tab-separated values for reliable parsing
issues = ' '.join(str(x) for x in d.get('issueList', []))
print(f'{issues}\t{d.get(\"currentSliceIndex\", 0)}\t{d.get(\"agentPhase\", \"builder\")}\t{d.get(\"builderRetries\", 0)}\t{d.get(\"totalIterations\", 1)}')
" 2>/dev/null) || return 1

    # Parse tab-separated values
    IFS=$'\t' read -r issue_str slice_index phase retries iterations <<< "$data"

    # Load into bash array
    ISSUE_NUMBERS=()
    if [ -n "$issue_str" ]; then
        read -ra ISSUE_NUMBERS <<< "$issue_str"
    fi

    CURRENT_SLICE_INDEX="$slice_index"
    AGENT_PHASE="$phase"
    BUILDER_RETRIES="$retries"
    TOTAL_ITERATIONS="$iterations"
}

# ─── Session Log Tracking ──────────────────────────────────────────────────
save_session_log() {
    local issue_num="$1"
    local attempt="$2"
    local phase="$3"
    local log_path="$4"
    local status="$5"  # "success" or "failed"

    if [ "$CFG_SESSION_LOG_TRACKING" != true ]; then
        return 0
    fi
    if [ -z "$log_path" ]; then
        return 0
    fi

    python3 -c "
import json, os

log_file = '${LOGS_FILE}'
data = {'entries': []}
if os.path.exists(log_file):
    try:
        with open(log_file) as f:
            data = json.load(f)
    except (json.JSONDecodeError, IOError):
        pass

entry = {
    'issue': ${issue_num},
    'attempt': ${attempt},
    'phase': '${phase}',
    'log': '''${log_path}''',
    'status': '${status}'
}
data['entries'].append(entry)
with open(log_file, 'w') as f:
    json.dump(data, f, indent=2)
" 2>/dev/null || true
}

# ─── Skip Completed Issues (for --resume) ──────────────────────────────────
is_issue_completed() {
    local issue_num="$1"
    local repo="$2"

    # Check if issue has success or fail label (already processed)
    local labels
    labels=$(gh issue view "$issue_num" --repo "$repo" --json labels 2>/dev/null | \
        python3 -c "import json,sys; d=json.load(sys.stdin); names=[l.get('name','') for l in d]; print(' '.join(names))" 2>/dev/null || echo "")

    if [[ "$labels" == *"$CFG_SUCCESS_LABEL"* ]] || [[ "$labels" == *"$CFG_FAIL_LABEL"* ]]; then
        return 0  # true — issue is completed/failed, skip it
    fi
    return 1  # false — not yet processed
}
