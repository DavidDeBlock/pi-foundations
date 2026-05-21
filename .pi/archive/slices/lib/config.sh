#!/usr/bin/env bash
# config.sh — Configuration loading from config.json with env var overrides.
#
# Usage: source lib/config.sh
# Then access via $CFG_<KEY> (e.g., $CFG_MAX_RETRIES, $CFG_MODEL)

CONFIG_FILE="${SLICE_CONFIG_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/config.json}"

# ─── Load Config ────────────────────────────────────────────────────────────
_load_config() {
    if [ ! -f "$CONFIG_FILE" ]; then
        echo "[WARN] config.json not found at: $CONFIG_FILE — using defaults" >&2
        _set_defaults
        return 0
    fi

    # Read all keys from JSON into shell variables as CFG_<UPPER_KEY>
    while IFS='=' read -r key value || [[ -n "$key" ]]; do
        # Skip empty lines and comments
        [[ -z "$key" || "$key" =~ ^# ]] && continue
        export "CFG_${key}=${value}"
    done < <(python3 -c "
import json, sys
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
for k, v in cfg.items():
    key = k.upper().replace('-', '_')
    # Convert types for shell compatibility
    if isinstance(v, bool):
        val = 'true' if v else 'false'
    elif isinstance(v, (int, float)):
        val = str(v)
    else:
        val = str(v)
    print(f'{key}={val}')
" 2>/dev/null) || true

    # Apply env var overrides (PI_* prefix takes precedence)
    _apply_env_overrides
}

_set_defaults() {
    export CFG_MODEL="qwen-35b-a3b-118k-bf16"
    export CFG_PROVIDER="llama-cpp-3090"
    export CFG_MAX_RETRIES=3
    export CFG_TIMEOUT_SECONDS=900
    export CFG_TARGET_LABEL="needs-triage"
    export CFG_SUCCESS_LABEL="awaiting-manual-check"
    export CFG_FAIL_LABEL="failed-slice"
    export CFG_BUILDER_SKILL="/skill:tdd"
    export CFG_REVIEWER_SKILL="/skill:reviewer"
    export CFG_STATE_DIR=".pi/state"
    export CFG_RESULT_FILE=".pi/state/slice-result.json"
    export CFG_CONTINUE_ON_FAILURE=true
    export CFG_POST_BUILDER_COMMENT=true
    export CFG_POST_REVIEWER_COMMENT=true
    export CFG_UPDATE_LABELS=true
    export CFG_FETCH_PARENT_PRD=true
    export CFG_LOAD_CONTEXT_MD=true
    export CFG_SESSION_LOG_TRACKING=true
}

_apply_env_overrides() {
    # PI_MODEL / PI_PROVIDER override config (existing convention)
    if [ -n "${PI_MODEL:-}" ]; then
        export CFG_MODEL="$PI_MODEL"
    fi
    if [ -n "${PI_PROVIDER:-}" ]; then
        export CFG_PROVIDER="$PI_PROVIDER"
    fi
}

# Initialize on source
_load_config

# Export PI_* env vars so rpc-client.py picks up config.json values.
export PI_MODEL="${CFG_MODEL}"
export PI_PROVIDER="${CFG_PROVIDER}"
