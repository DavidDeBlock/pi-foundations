#!/usr/bin/env bash
#
# run-slices.sh — GitHub Issues-driven slice orchestrator (refactored).
#
# Modular architecture: thin orchestrator delegates to lib/ modules.
# Configurable via config.json, env vars, or CLI flags.
# Resilient: signal handling, batch continuation on failure, JSON validation.
#
# Usage:
#   .pi/slices/run-slices.sh [options]
#
# Options:
#   --dry-run          Simulate entire flow without side effects
#   --repo OWNER/REPO  Override default repo (from gh config or remote)
#   --label LABEL      Fetch issues with this label instead of needs-triage
#   --issue N          Process only issue #N (skip queue logic)
#   --resume           Resume from last saved state, skip completed issues
#
set -euo pipefail

# ─── Resolve Script Directory ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Load Library Modules (order matters) ──────────────────────────────────
source "${SCRIPT_DIR}/lib/config.sh"     # Configuration loading
source "${SCRIPT_DIR}/lib/state.sh"      # State management + session logs
source "${SCRIPT_DIR}/lib/github.sh"     # GitHub API wrappers
source "${SCRIPT_DIR}/lib/result.sh"     # Result file handling
source "${SCRIPT_DIR}/lib/prompt.sh"     # Prompt template building
source "${SCRIPT_DIR}/lib/rpc.sh"        # RPC client wrapper

# ─── Colors ────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

# ─── Helpers ────────────────────────────────────────────────────────────────
log_info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[OK]${NC}   $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error()   { echo -e "${RED}[ERR]${NC}  $*"; }
log_slice()   { echo -e "${CYAN}[SLICE]${NC} $*"; }
log_phase()   { echo -e "${MAGENTA}[PHASE]${NC} $*"; }

# ─── Defaults ──────────────────────────────────────────────────────────────
DRY_RUN=false
TARGET_LABEL="${CFG_TARGET_LABEL}"
SINGLE_ISSUE=""
RESUME=false
REPO_OVERRIDE=""
DEBUG_CONTEXT=false

# ─── Batch Tracking ────────────────────────────────────────────────────────
declare -a BATCH_RESULTS=()   # "success:N" or "fail:N" per issue

# ─── Interrupt Flag (volatile so signal handler can set it mid-loop) ────────
INTERRUPTED=false

# ─── Signal Handling & Cleanup ─────────────────────────────────────────────
_handle_interrupt() {
    INTERRUPTED=true
    echo "" >&2
    log_warn "Interrupted — saving state and exiting..."
    save_state 2>/dev/null || true
    rm -f /tmp/pi-builder-prompt.* /tmp/pi-reviewer-prompt.* /tmp/pi-rpc-output.* /tmp/pi-tmpl-vars* 2>/dev/null || true
    exit 130
}

_cleanup() {
    # Clean up temp files on normal exit too
    rm -f /tmp/pi-builder-prompt.* /tmp/pi-reviewer-prompt.* /tmp/pi-rpc-output.* /tmp/pi-tmpl-vars* 2>/dev/null || true
}

trap _handle_interrupt INT TERM
trap _cleanup EXIT

# ─── Hook Execution ────────────────────────────────────────────────────────
_run_hook() {
    local hook_name="$1"
    shift
    local hook_file="${SCRIPT_DIR}/hooks/${hook_name}.sh"

    if [ -f "$hook_file" ] && [ -x "$hook_file" ]; then
        bash "$hook_file" "$@" 2>/dev/null || true
    fi
}

# ─── Argument Parsing ──────────────────────────────────────────────────────
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)   DRY_RUN=true; shift ;;
            --repo)      REPO_OVERRIDE="$2"; shift 2 ;;
            --label)     TARGET_LABEL="$2"; shift 2 ;;
            --issue)     SINGLE_ISSUE="$2"; shift 2 ;;
            --resume)    RESUME=true; shift ;;
            --debug)     DEBUG_CONTEXT=true; export SLICES_DEBUG=true; shift ;;
            *)           log_error "Unknown option: $1"; exit 1 ;;
        esac
    done
}

# ─── Builder Phase ────────────────────────────────────────────────────────
run_builder() {
    local issue_num="$1"
    local retry_count="${2:-0}"
    local critique="${3:-}"

    CURRENT_ISSUE=$issue_num
    log_phase "Builder — Issue #${issue_num} (attempt $((retry_count + 1))/${CFG_MAX_RETRIES})"

    # Run pre-builder hook
    _run_hook "pre-builder" "$issue_num" "$((retry_count + 1))"

    # Fetch issue body
    local issue_body
    issue_body=$(fetch_issue_body "$issue_num") || return 1

    # Build prompt
    local prompt_file
    prompt_file=$(mktemp /tmp/pi-builder-prompt.XXXXXX)
    build_builder_prompt "$issue_num" "$issue_body" "$retry_count" "$critique" > "$prompt_file"

    # Remove old result file
    rm -f "$RESULT_FILE"

    # Run RPC client
    local rpc_ok=true
    run_rpc "$prompt_file" "$CFG_TIMEOUT_SECONDS" || rpc_ok=false

    # Track session log
    _track_session "$issue_num" "$((retry_count + 1))" "builder" \
        "$([ "$rpc_ok" = true ] && echo success || echo failed)"

    if [ "$rpc_ok" != true ]; then
        write_rejection "$issue_num" "Pi RPC session failed with exit code $?"
        _run_hook "post-builder" "$issue_num" "failed"
        return 1
    fi

    # Validate and read result
    local status
    status=$(read_result_status) || {
        log_warn "Invalid or missing result file from Builder"
        write_rejection "$issue_num" "Builder produced invalid result"
        _run_hook "post-builder" "$issue_num" "failed"
        return 1
    }

    if [ "$status" = "approved" ]; then
        log_success "Builder approved issue #${issue_num} ✓"
        _run_hook "post-builder" "$issue_num" "success"
        return 0
    else
        log_warn "Builder self-rejected issue #${issue_num}:"
        read_result_issues | while IFS= read -r issue; do
            echo "  • $issue"
        done
        _run_hook "post-builder" "$issue_num" "self-rejected"
        return 1
    fi
}

# ─── Reviewer Phase ────────────────────────────────────────────────────────
run_reviewer() {
    local issue_num="$1"

    CURRENT_ISSUE=$issue_num
    log_phase "Reviewer — Issue #${issue_num}"

    # Run pre-reviewer hook
    _run_hook "pre-reviewer" "$issue_num"

    # Fetch issue body + builder comment for context
    local issue_body
    issue_body=$(timeout "$GH_TIMEOUT" gh issue view "$issue_num" \
        --repo "$(_get_repo)" \
        --json body,title,number 2>&1) || {
        log_error "Failed to fetch issue #$issue_num for review"
        return 1
    }

    # Get builder's comment (last [BUILDER] comment)
    local builder_comment=""
    if [ "$DRY_RUN" = false ]; then
        builder_comment=$(fetch_builder_comment "$issue_num")
    fi

    # Build reviewer prompt
    local prompt_file
    prompt_file=$(mktemp /tmp/pi-reviewer-prompt.XXXXXX)
    build_reviewer_prompt "$issue_num" "$issue_body" "$builder_comment" > "$prompt_file"

    # Remove old result file
    rm -f "$RESULT_FILE"

    # Run RPC client
    local rpc_ok=true
    run_rpc "$prompt_file" "$CFG_TIMEOUT_SECONDS" || rpc_ok=false

    # Track session log
    _track_session "$issue_num" 1 "reviewer" \
        "$([ "$rpc_ok" = true ] && echo success || echo failed)"

    if [ "$rpc_ok" != true ]; then
        write_rejection "$issue_num" "Reviewer RPC session failed"
        _run_hook "post-reviewer" "$issue_num" "failed"
        return 1
    fi

    # Validate and read result
    local status verdict
    status=$(read_result_status) || {
        log_warn "Invalid or missing result file from Reviewer"
        write_rejection "$issue_num" "Reviewer produced invalid result"
        _run_hook "post-reviewer" "$issue_num" "failed"
        return 1
    }

    verdict=$(read_result_verdict)

    if [ "$status" = "approved" ]; then
        log_success "Reviewer approved issue #${issue_num} ✓"
        _run_hook "post-reviewer" "$issue_num" "success"
        return 0
    else
        log_warn "Reviewer rejected issue #${issue_num}: ${verdict}"
        read_result_issues | while IFS= read -r issue; do
            echo "  • $issue"
        done
        _run_hook "post-reviewer" "$issue_num" "rejected"
        return 1
    fi
}

# ─── Post Comments & Update Labels ────────────────────────────────────────
_post_success_artifacts() {
    local issue_num="$1"

    # Post builder comment
    if [ "$CFG_POST_BUILDER_COMMENT" = true ]; then
        local comment_body
        comment_body=$(build_builder_comment "$issue_num")
        post_comment "$issue_num" "$comment_body" || true
    fi

    # Post reviewer comment
    if [ "$CFG_POST_REVIEWER_COMMENT" = true ]; then
        local comment_body
        comment_body=$(build_reviewer_comment "$issue_num")
        post_comment "$issue_num" "$comment_body" || true
    fi

    # Update labels
    update_labels "$issue_num" "success"

    # Run on-success hook
    _run_hook "on-success" "$issue_num"
}

_post_failure_artifacts() {
    local issue_num="$1"
    local attempts="$2"

    # Post builder comment noting failure
    if [ "$CFG_POST_BUILDER_COMMENT" = true ]; then
        post_comment "$issue_num" \
            "## [BUILDER] Implementation Failed\n\n**Issue:** #${issue_num}\n**Status:** Failed after ${attempts} attempts. See comments for details." || true
    fi

    # Update labels
    update_labels "$issue_num" "fail"

    # Run on-failure hook
    _run_hook "on-failure" "$issue_num" "$attempts"
}

# ─── Process Single Issue (Builder ↔ Reviewer Loop) ────────────────────────
process_issue() {
    local issue_num="$1"
    local max_retries=$CFG_MAX_RETRIES
    local retry_count=0
    local success=false

    log_slice "=========================================="
    log_slice "Processing Issue #${issue_num}"
    log_slice "=========================================="

    while [ $retry_count -lt $max_retries ]; do
        # Check for interrupt before each attempt
        if [ "$INTERRUPTED" = true ]; then
            log_warn "Interrupted — aborting issue #${issue_num}"
            BATCH_RESULTS+=("interrupted:${issue_num}")
            return 1
        fi

        ((TOTAL_ITERATIONS++)) || true

        # ── Builder Phase ────────────────────────────────────────────────
        local critique=""
        if [ $retry_count -gt 0 ] && [ -n "${PREVIOUS_CRITIQUE:-}" ]; then
            critique="$PREVIOUS_CRITIQUE"
        fi

        if ! run_builder "$issue_num" "$retry_count" "$critique"; then
            ((retry_count++)) || true
            echo ""
            continue
        fi

        # ── Reviewer Phase (only if Builder approved) ────────────────────
        if ! run_reviewer "$issue_num"; then
            # Get critique from result file for retry
            PREVIOUS_CRITIQUE=$(read_result_issues | tr '\n' '|')

            ((retry_count++)) || true
            AGENT_PHASE="builder"
            BUILDER_RETRIES=$retry_count
            save_state
            echo ""
            continue
        fi

        success=true
        break
    done

    if $success; then
        _post_success_artifacts "$issue_num"
        log_success "Issue #${issue_num} — Reviewer approved, awaiting manual check ✓"
        BATCH_RESULTS+=("success:${issue_num}")
        save_state
    else
        _post_failure_artifacts "$issue_num" "$max_retries"
        log_error "Issue #${issue_num} — FAILED after ${max_retries} attempts ❌"
        BATCH_RESULTS+=("fail:${issue_num}")
        save_state

        # Continue to next issue if configured (don't exit)
        if [ "$CFG_CONTINUE_ON_FAILURE" != true ]; then
            log_error "Aborting batch: continue_on_failure is disabled"
            exit 1
        fi
    fi
}

# ─── Dry-Run Simulation ────────────────────────────────────────────────────
dry_run_mode() {
    echo ""
    log_info "=========================================="
    log_info "DRY RUN MODE — No side effects"
    log_info "=========================================="
    echo ""

    # Simulate issue fetching
    if [ -n "$SINGLE_ISSUE" ]; then
        ISSUE_NUMBERS=("$SINGLE_ISSUE")
    else
        fetch_issues_by_label "$TARGET_LABEL" 2>/dev/null || true
    fi

    if [ ${#ISSUE_NUMBERS[@]} -eq 0 ]; then
        log_warn "No issues found (dry run)"
        return 0
    fi

    local total=${#ISSUE_NUMBERS[@]}
    local idx=0
    for num in "${ISSUE_NUMBERS[@]}"; do
        ((idx++)) || true
        echo ""
        log_slice "--- Issue #${num} (${idx}/${total}) ---"

        log_phase "[DRY-RUN] Would fetch issue body and run Builder RPC..."
        log_info "[DRY-RUN] Would post [BUILDER] comment on #${num}"
        log_phase "[DRY-RUN] Would run Reviewer with test execution..."
        log_info "[DRY-RUN] Would post reviewer verdict comment on #${num}"
        log_info "[DRY-RUN] Would remove '${CFG_TARGET_LABEL}', add '${CFG_SUCCESS_LABEL}' on #${num}"
    done

    echo ""
    log_success "Dry run complete. ${idx} issues would be processed."
}

# ─── Print Summary Report ──────────────────────────────────────────────────
print_summary() {
    local total=${#BATCH_RESULTS[@]}
    local success_count=0
    local fail_count=0

    for entry in "${BATCH_RESULTS[@]}"; do
        case "$entry" in
            success:*)     ((success_count++)) || true ;;
            fail:*)        ((fail_count++)) || true ;;
            interrupted:*) ;; # Don't count interrupted as success or failure
        esac
    done

    echo ""
    log_info "=========================================="
    log_info "Batch Summary"
    log_info "=========================================="
    echo -e "  Total:   ${total}"
    echo -e "  Success: ${GREEN}${success_count}${NC}"
    echo -e "  Failed:  ${RED}${fail_count}${NC}"

    if [ $fail_count -gt 0 ]; then
        echo ""
        log_warn "Failed issues:"
        for entry in "${BATCH_RESULTS[@]}"; do
            case "$entry" in
                fail:*) echo "  ❌ #${entry#fail:}" ;;
            esac
        done
    fi

    local interrupted_count=0
    for entry in "${BATCH_RESULTS[@]}"; do
        case "$entry" in
            interrupted:*) ((interrupted_count++)) || true ;;
        esac
    done
    if [ $interrupted_count -gt 0 ]; then
        echo ""
        log_warn "Interrupted issues (resume with --resume):"
        for entry in "${BATCH_RESULTS[@]}"; do
            case "$entry" in
                interrupted:*) echo "  ⏸️  #${entry#interrupted:}" ;;
            esac
        done
    fi

    # Session logs reference
    if [ -f "$LOGS_FILE" ]; then
        echo ""
        log_info "Session logs saved to: ${LOGS_FILE}"
        python3 -c "
import json
with open('${LOGS_FILE}') as f:
    data = json.load(f)
entries = data.get('entries', [])
if entries:
    print()
    print(f'  {'Issue':<8}{'Attempt':<10}{'Phase':<12}{'Status':<10}Log')
    print(f'  {'-'*7:<8}{'-'*9:<10}{'-'*11:<12}{'-'*9:<10}---')
    for e in entries:
        status_icon = '✅' if e['status'] == 'success' else '❌'
        print(f\"  {e['issue']:<8}{e['attempt']:<10}{e['phase']:<12}{status_icon:<10}{e['log']}\")
    print()
    print('  View a log: cat <path> | jq .')
" 2>/dev/null || true
    fi

    if [ $interrupted_count -gt 0 ]; then
        log_warn "Batch interrupted — resume with: .pi/slices/run-slices.sh --resume"
    elif [ $fail_count -eq 0 ] && [ $total -gt 0 ]; then
        log_success "All slices complete! Issues ready for manual check."
    elif [ $total -eq 0 ]; then
        log_warn "No issues were processed."
    else
        log_info "Completed with ${fail_count} failure(s). Check failed-slice label on GitHub."
    fi
    log_info "=========================================="
}

# ─── Main Entry Point ──────────────────────────────────────────────────────
main() {
    parse_args "$@"

    echo ""
    log_info "=========================================="
    log_info "Slice Orchestrator — GitHub Issues Mode"
    log_info "Max retries per slice: ${CFG_MAX_RETRIES}"
    log_info "Timeout per attempt:   ${CFG_TIMEOUT_SECONDS}s"
    log_info "Model:                 ${CFG_MODEL} (${CFG_PROVIDER})"
    if [ "$DRY_RUN" = true ]; then
        echo -e "${YELLOW}DRY RUN MODE${NC}"
    fi
    if [ "$RESUME" = true ]; then
        echo -e "${CYAN}RESUME MODE${NC}"
    fi
    log_info "=========================================="
    echo ""

    # Dry-run shortcut
    if [ "$DRY_RUN" = true ]; then
        dry_run_mode
        return 0
    fi

    # Initialize or resume state
    init_state

    # Fetch issues from GitHub (or use single issue)
    if [ -n "$SINGLE_ISSUE" ]; then
        ISSUE_NUMBERS=("$SINGLE_ISSUE")
        CURRENT_SLICE_INDEX=0
        AGENT_PHASE="builder"
        BUILDER_RETRIES=0
        TOTAL_ITERATIONS=1
        log_info "Processing single issue: #$SINGLE_ISSUE"
    else
        fetch_issues_by_label "$TARGET_LABEL" || exit 1

        # In resume mode, skip already-completed issues
        if [ "$RESUME" = true ]; then
            local original_count=${#ISSUE_NUMBERS[@]}
            local filtered=()
            for num in "${ISSUE_NUMBERS[@]}"; do
                if ! is_issue_completed "$num" "$(_get_repo)"; then
                    filtered+=("$num")
                else
                    log_info "Skipping #${num} (already processed)"
                fi
            done
            ISSUE_NUMBERS=("${filtered[@]+"${filtered[@]}"}")  # handle empty array safely

            local skipped=$((original_count - ${#ISSUE_NUMBERS[@]}))
            if [ $skipped -gt 0 ]; then
                log_info "Skipped ${skipped} completed issue(s), processing ${#ISSUE_NUMBERS[@]} remaining"
            fi
        fi
    fi

    # Process each issue sequentially
    for issue_num in "${ISSUE_NUMBERS[@]+"${ISSUE_NUMBERS[@]}"}"; do
        if [ "$INTERRUPTED" = true ]; then
            log_warn "Interrupted — stopping batch processing"
            break
        fi

        process_issue "$issue_num"
        echo ""
    done

    # Print summary report
    print_summary
}

main "$@"
