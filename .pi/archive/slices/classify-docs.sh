#!/usr/bin/env bash
#
# classify-docs.sh — Agent-driven docs classification orchestrator.
#
# Runs the docs-manager pipeline: scan → auto-classify → agent loop for uncertain entries.
# Mirrors run-slices.sh structure: shared lib/, signal handling, dry-run mode, batch processing.
#
# Usage:
#   .pi/slices/classify-docs.sh [options]
#
# Options:
#   --dry-run       Simulate entire flow without side effects
#   --full-scan     Re-run Phase 1 scan before classifying (refresh inventory)

set -euo pipefail

# ─── Resolve Script Directory ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Load Library Modules (order matters) ──────────────────────────────────
source "${SCRIPT_DIR}/lib/config.sh"     # Configuration loading
source "${SCRIPT_DIR}/lib/state.sh"      # State management + session logs
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
log_batch()   { echo -e "${CYAN}[BATCH]${NC} $*"; }
log_phase()   { echo -e "${MAGENTA}[PHASE]${NC} $*"; }

# Safe grep count — returns 0 on no-match (grep exits 1 when count is 0)
count_lines() {
    local pattern="$1"
    local file="$2"
    local result
    result=$(grep -c "$pattern" "$file" 2>/dev/null || true)
    [[ "$result" =~ ^[0-9]+$ ]] && echo "$result" || echo "0"
}

# ─── Defaults ──────────────────────────────────────────────────────────────
DRY_RUN=false
FULL_SCAN=false
BATCH_SIZE=5
RESULT_FILE="${CFG_RESULT_FILE:-.pi/state/slice-result.json}"  # From config.sh
DOCS_DIR="docs"
INVENTORY_FILE="docs/_system/DOCS_INVENTORY.md"
RULES_FILE="docs/_system/DOCS_RULES.md"

# ─── Batch Tracking ────────────────────────────────────────────────────────
declare -a BATCH_RESULTS=()   # "success:N" or "fail:N" per batch
TOTAL_CLASSIFIED=0
TOTAL_FAILED=0

# ─── Interrupt Flag (volatile so signal handler can set it mid-loop) ────────
INTERRUPTED=false

# ─── Signal Handling & Cleanup ─────────────────────────────────────────────
_handle_interrupt() {
    INTERRUPTED=true
    echo "" >&2
    log_warn "Interrupted — exiting..."
    rm -f /tmp/pi-docs-prompt.* /tmp/pi-rpc-output.* /tmp/pi-tmpl-vars* 2>/dev/null || true
    exit 130
}

_cleanup() {
    rm -f /tmp/pi-docs-prompt.* /tmp/pi-rpc-output.* /tmp/pi-tmpl-vars* 2>/dev/null || true
}

trap _handle_interrupt INT TERM
trap _cleanup EXIT

# ─── Argument Parsing ──────────────────────────────────────────────────────
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)   DRY_RUN=true; shift ;;
            --full-scan) FULL_SCAN=true; shift ;;
            *)           log_error "Unknown option: $1"; exit 1 ;;
        esac
    done
}

# ─── Phase 1: Scan Inventory ──────────────────────────────────────────────
phase_scan() {
    log_phase "Phase 1 — Scanning inventory..."

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would run: npx tsx scripts/scan-inventory.ts ${DOCS_DIR}"
        return 0
    fi

    npx tsx scripts/scan-inventory.ts "${DOCS_DIR}" || {
        log_error "Scan failed — aborting"
        exit 1
    }

    if [ ! -f "$INVENTORY_FILE" ]; then
        log_error "Inventory file not found at ${INVENTORY_FILE} after scan"
        exit 1
    fi

    local count
    count=$(count_lines "^id: F" "$INVENTORY_FILE")
    log_success "Scanned ${count} files → ${INVENTORY_FILE}"
}

# ─── Phase 2a: Auto-Classify Obvious Files ────────────────────────────────
phase_auto_classify() {
    log_phase "Phase 2a — Auto-classifying obvious files..."

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would run: npx tsx scripts/classify-inventory.ts ${DOCS_DIR} --auto"
        return 0
    fi

    # Capture console output for summary
    local output
    output=$(npx tsx scripts/classify-inventory.ts "${DOCS_DIR}" --auto 2>&1) || {
        log_error "Auto-classification failed — aborting"
        exit 1
    }

    echo "$output" | while IFS= read -r line; do
        echo "  $line"
    done

    # Count results from inventory
    local total high_medium low_confidence
    total=$(count_lines '^id: F' "$INVENTORY_FILE")
    low_confidence=$(count_lines 'confidence: low' "$INVENTORY_FILE")
    high_medium=$((total - low_confidence))
    log_success "Auto-classified ${high_medium} files (high/medium confidence), ${low_confidence} remain uncertain (low confidence)"
}

# ─── Build Classifier Prompt (Phase 2b — Agent Loop) ──────────────────────
build_classifier_prompt() {
    local batch_jsonl="$1"  # JSONL string from classify-inventory.ts --uncertain

    cat <<PROMPT_HEADER
/skill:docs-manager

## TASK
Classify the uncertain documentation entries below. Use the docs-manager skill to:

1. Read each entry's parsed content (sections, headings, cross-references)
2. Apply classification rules from \`DOCS_RULES.md\`
3. For tricky entries, run \`parse-doc-file.ts <path>\` for deeper analysis
4. Edit their YAML blocks in-place in \`${INVENTORY_FILE}\`
5. Write escalation questions to \`${DOCS_DIR}/_system/DOCS_QUESTIONS.md\` if needed

## CLASSIFICATION RULES
$(cat "$RULES_FILE" 2>/dev/null || echo "# WARNING: DOCS_RULES.md not found")

## CURRENT BATCH (${BATCH_SIZE} entries)
${batch_jsonl}

## INSTRUCTIONS
- Classify each entry by updating its YAML block in \`${INVENTORY_FILE}\`
- Set fields: status, class, confidence, proposed_action, target_path (if moving), reason
- Use the parsed doc content to determine classification — don't guess
- If a file is clearly in the wrong folder, propose moving it with target_path
- Be conservative: if truly ambiguous, write an escalation question instead of guessing
- Write the result file ONLY after updating all entries you can classify

## RESULT FILE FORMAT
Write \`${RESULT_FILE}\` as valid JSON:

If ALL entries classified successfully:
{"status":"approved","classified":N}

If some entries need human review (escalation questions written):
{"status":"rejected","classified":M,"issues":["F0123: ambiguous — escalation question written"]}

Do NOT write the result file until you have updated all YAML blocks.
PROMPT_HEADER
}

# ─── Check Agent Result (Agent edits inventory directly) ──────────────────
check_classification_result() {
    local before_count="$1"  # low-confidence count before this batch

    if [ ! -f "$RESULT_FILE" ]; then
        log_warn "No result file written by agent"
        return 1
    fi

    # Validate JSON and check status
    local status
    status=$(python3 -c "
import json, sys
with open('${RESULT_FILE}') as f:
    r = json.load(f)
print(r.get('status', 'unknown'))
" 2>/dev/null || echo "unknown")

    if [ "$status" != "approved" ]; then
        log_warn "Agent rejected batch — checking inventory anyway"
    fi

    # Count how many low-confidence entries remain (agent should upgrade them to high/medium)
    local after_count
    after_count=$(count_lines "confidence: low" "$INVENTORY_FILE")
    local resolved=$((before_count - after_count))

    if [ "$resolved" -gt 0 ]; then
        log_success "Agent resolved ${resolved} entries ✓"
        return 0
    else
        log_warn "No progress — agent may have failed to update inventory"
        return 1
    fi
}

# ─── Process Single Batch (Agent Classification Loop) ──────────────────────
process_batch() {
    local batch_num="$1"
    local total_batches="$2"

    log_batch "=========================================="
    log_batch "Batch ${batch_num}/${total_batches}"
    log_batch "=========================================="

    # Fetch uncertain entries as JSONL
    local jsonl_output
    jsonl_output=$(npx tsx scripts/classify-inventory.ts "${DOCS_DIR}" --uncertain --batch-size=${BATCH_SIZE} 2>/dev/null) || {
        log_error "Failed to fetch uncertain entries"
        return 1
    }

    # Check if there are any uncertain entries left
    if [ -z "$jsonl_output" ]; then
        log_info "No uncertain entries remaining — classification complete!"
        return 0
    fi

    local entry_count
    entry_count=$(echo "$jsonl_output" | wc -l)

    if [ "$entry_count" -eq 0 ]; then
        log_info "No uncertain entries remaining — classification complete!"
        return 0
    fi

    log_info "Processing ${entry_count} uncertain entries..."

    # Dry-run mode
    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would send batch to classifier agent:"
        echo "$jsonl_output" | head -c 500
        echo ""
        return 0
    fi

    # Build prompt and write to temp file
    local prompt_file
    prompt_file=$(mktemp /tmp/pi-docs-prompt.XXXXXX)
    build_classifier_prompt "$jsonl_output" > "$prompt_file"

    # Capture low-confidence count BEFORE agent edits
    local before_low
    before_low=$(count_lines "confidence: low" "$INVENTORY_FILE")

    # Remove old result file
    rm -f "$RESULT_FILE"

    # Run RPC client
    log_info "Sending batch to classifier agent..."
    local rpc_ok=true
    run_rpc "$prompt_file" "$CFG_TIMEOUT_SECONDS" || rpc_ok=false

    if [ "$rpc_ok" != true ]; then
        log_warn "RPC session failed — retrying entries individually"
        _retry_individual "$jsonl_output"
        return $?
    fi

    # Check result file exists
    if [ ! -f "$RESULT_FILE" ]; then
        log_warn "No result file written by agent — retrying entries individually"
        _retry_individual "$jsonl_output"
        return $?
    fi

    # Agent edits inventory directly — check if progress was made (before_low captured above)
    if ! check_classification_result "$before_low"; then
        log_warn "No progress on batch — retrying entries individually"
        _retry_individual "$jsonl_output"
        return $?
    fi

    local after_low
    after_low=$(count_lines "confidence: low" "$INVENTORY_FILE")
    local resolved=$((before_low - after_low))
    BATCH_RESULTS+=("success:${batch_num}")
    ((TOTAL_CLASSIFIED += resolved)) || true

    return 0
}

# ─── Retry Failed Batch Entries Individually ──────────────────────────────
_retry_individual() {
    local jsonl_input="$1"

    log_info "Retrying entries individually (batch-size=1)..."

    while IFS= read -r entry; do
        if [ "$INTERRUPTED" = true ]; then
            break
        fi

        # Extract ID for logging
        local entry_id
        entry_id=$(echo "$entry" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('id','unknown'))" 2>/dev/null || echo "unknown")

        log_info "Classifying ${entry_id} individually..."

        # Build prompt for single entry
        local prompt_file
        prompt_file=$(mktemp /tmp/pi-docs-prompt.XXXXXX)
        build_classifier_prompt "$entry" > "$prompt_file"

        # Capture low-confidence count BEFORE agent edits
        local before_low
        before_low=$(count_lines "confidence: low" "$INVENTORY_FILE")

        rm -f "$RESULT_FILE"

        local rpc_ok=true
        run_rpc "$prompt_file" "$CFG_TIMEOUT_SECONDS" || rpc_ok=false

        if [ "$rpc_ok" != true ] || [ ! -f "$RESULT_FILE" ]; then
            log_warn "Failed to classify ${entry_id} — skipping (will remain uncertain)"
            ((TOTAL_FAILED++)) || true
            continue
        fi

        # Agent edits inventory directly — check if this entry was resolved
        if ! check_classification_result "$before_low"; then
            log_warn "Agent failed to classify ${entry_id} — skipping"
            ((TOTAL_FAILED++)) || true
            continue
        fi

        after_low=$(count_lines "confidence: low" "$INVENTORY_FILE")
        local resolved=$((before_low - after_low))
        if [ "$resolved" -gt 0 ]; then
            log_success "Classified ${entry_id} ✓"
            ((TOTAL_CLASSIFIED += resolved)) || true
        else
            log_warn "No progress on ${entry_id} — skipping"
            ((TOTAL_FAILED++)) || true
        fi

    done <<< "$jsonl_input"
}

# ─── Build Review Prompt (Phase 3b — Answer Review Agent Loop) ────────────
build_review_prompt() {
    local answered_jsonl="$1"  # JSONL from generate-questions.ts --answered

    cat <<PROMPT_HEADER
/skill:docs-manager

## TASK
Review the human's answers to classification questions and update the inventory accordingly.

Use the docs-manager skill to:

1. Read each answered question below (context + human answer)
2. Update the YAML blocks in ${INVENTORY_FILE}
3. For each file ID mentioned, set: confidence=high, status=approved, approval=approved
4. If the answer confirms a move/archive action, ensure target_path is correct
5. Write the result file ONLY after updating all entries

## CLASSIFICATION RULES
$(cat "$RULES_FILE" 2>/dev/null || echo "# WARNING: DOCS_RULES.md not found")

## ANSWERED QUESTIONS (${answered_jsonl})
${answered_jsonl}

## INSTRUCTIONS
- For each answered question, find the related file IDs in ${INVENTORY_FILE}
- Update their YAML blocks based on the human's answer
- Set confidence: high (human has decided)
- Set status: approved
- Set approval: approved
- If the answer confirms archiving, ensure class=archive and proposed_action=archive
- If the answer confirms moving, ensure target_path is set correctly
- Be conservative: if an answer is unclear, leave the entry as-is

## RESULT FILE FORMAT
Write ${RESULT_FILE} as valid JSON:
{"status":"approved","reviewed":N}
PROMPT_HEADER
}

# ─── Check Review Result ──────────────────────────────────────────────────
check_review_result() {
    local before_medium="$1"

    if [ ! -f "$RESULT_FILE" ]; then
        log_warn "No result file written by agent"
        return 1
    fi

    # Count medium-confidence entries (agent should upgrade them to high)
    local after_medium
    after_medium=$(count_lines "confidence: medium" "$INVENTORY_FILE")
    local resolved=$((before_medium - after_medium))

    if [ "$resolved" -gt 0 ]; then
        log_success "Agent reviewed ${resolved} entries ✓"
        return 0
    else
        # Also check low-confidence (some may have been upgraded)
        local before_low
        before_low=$(count_lines "confidence: low" "$INVENTORY_FILE")
        if [ "$before_low" -gt 0 ]; then
            log_warn "No medium→high upgrades — agent may need different approach"
        fi
        return 1
    fi
}

# ─── Phase 3b: Review Human Answers (Agent Loop) ──────────────────────────
phase_review_answers() {
    log_phase "Phase 3b — Reviewing human answers..."

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would review answered questions via agent"
        return 0
    fi

    # Fetch answered questions as JSONL
    local answered_jsonl
    answered_jsonl=$(npx tsx scripts/generate-questions.ts "${DOCS_DIR}" --answered 2>/dev/null) || {
        log_warn "Failed to extract answered questions"
        return 0
    }

    # Check if there are any answered questions
    if [ -z "$answered_jsonl" ]; then
        log_info "No answered questions found — skipping review phase"
        return 0
    fi

    local question_count
    question_count=$(echo "$answered_jsonl" | wc -l)
    
    # ── Pre-check: skip if all related files already at high confidence ──
    log_info "Checking ${question_count} answered question(s) for upgrade eligibility..."
    local unprocessed=0
    while IFS= read -r q; do
        # Extract Related Files IDs (e.g., [F0061, F0062])
        local file_ids
        file_ids=$(echo "$q" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(' '.join(d.get('related_files',[])))" 2>/dev/null || true)
        
        for fid in $file_ids; do
            # Check if this ID is already at confidence: high or status: approved
            local conf_invent
            conf_invent=$(grep -A 30 "^id: ${fid}" "$INVENTORY_FILE" | grep -m1 "confidence:" | awk '{print $2}')
            if [ "$conf_invent" != "high" ]; then
                ((unprocessed++)) || true
                break  # Found at least one needing upgrade — stop checking this question
            fi
        done
    done <<< "$answered_jsonl"

    if [ "$unprocessed" -eq 0 ]; then
        log_info "All ${question_count} answered questions already processed (related files at high confidence) — skipping review agent"
        return 0
    fi

    log_info "Found ${unprocessed}/$question_count question(s) needing upgrade..."

    # Capture medium-confidence count BEFORE agent edits
    local before_medium
    before_medium=$(count_lines "confidence: medium" "$INVENTORY_FILE")

    rm -f "$RESULT_FILE"

    # Build prompt and write to temp file
    local prompt_file
    prompt_file=$(mktemp /tmp/pi-docs-prompt.XXXXXX)
    build_review_prompt "$answered_jsonl" > "$prompt_file"

    # Run RPC client
    log_info "Sending answered questions to review agent..."
    local rpc_ok=true
    run_rpc "$prompt_file" "$CFG_TIMEOUT_SECONDS" || rpc_ok=false

    if [ "$rpc_ok" != true ]; then
        log_warn "Review session failed — entries remain pending"
        return 0
    fi

    # Check result file exists
    if [ ! -f "$RESULT_FILE" ]; then
        log_warn "No result file written by review agent"
        return 0
    fi

    # Agent edits inventory directly — check if progress was made
    if ! check_review_result "$before_medium"; then
        log_warn "Review agent did not upgrade entries — may need manual follow-up"
        return 0
    fi

    local after_medium
    after_medium=$(count_lines "confidence: medium" "$INVENTORY_FILE")
    local reviewed=$((before_medium - after_medium))
    ((TOTAL_CLASSIFIED += reviewed)) || true

    log_success "Review complete — ${reviewed} entries upgraded to high confidence ✓"
}

# ─── Phase 4: Migrate Files ──────────────────────────────────────────────────
phase_migrate() {
    log_phase "Phase 4 — Migrating files to target structure..."

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would run: npx tsx scripts/migrate-docs.ts ${DOCS_DIR} --dry-run"
        return 0
    fi

    # Run migration script (reports its own summary)
    local output
    output=$(npx tsx scripts/migrate-docs.ts "${DOCS_DIR}" 2>&1) || {
        log_error "Migration failed — aborting. Check inventory for conflicts."
        echo "$output" | while IFS= read -r line; do
            echo "  $line"
        done
        return 1
    }

    # Show migration output (it includes its own summary)
    echo "$output" | while IFS= read -r line; do
        echo "  $line"
    done

    log_success "Migration complete ✓"
}

# ─── Phase 5: Cleanup Empty Directories ──────────────────────────────────────
phase_cleanup_dirs() {
    log_phase "Phase 5 — Cleaning up empty directories..."

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would run: npx tsx scripts/cleanup-empty-dirs.ts ${DOCS_DIR} --dry-run"
        return 0
    fi

    # Run cleanup script (reports its own summary)
    local output
    output=$(npx tsx scripts/cleanup-empty-dirs.ts "${DOCS_DIR}" 2>&1) || {
        log_warn "Cleanup completed with warnings:"
        echo "$output" | while IFS= read -r line; do
            echo "  $line"
        done
        return 0 # Non-fatal — don't abort on cleanup errors
    }

    # Show cleanup output (it includes its own summary)
    echo "$output" | while IFS= read -r line; do
        echo "  $line"
    done

    log_success "Cleanup complete ✓"
}

# ─── Phase 3: Generate Questions for Remaining Entries ─────────────────────
phase_generate_questions() {
    log_phase "Phase 3a — Generating review questions..."

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would run: npx tsx scripts/generate-questions.ts ${DOCS_DIR} --overview"
        return 0
    fi

    # Run overview first for logging
    local overview_output
    overview_output=$(npx tsx scripts/generate-questions.ts "${DOCS_DIR}" --overview 2>&1) || {
        log_warn "Overview generation failed — skipping Phase 3"
        return 0
    }

    echo "$overview_output" | while IFS= read -r line; do
        echo "  $line"
    done

    # Check if any entries need review
    if [[ "$overview_output" == *"No entries need human review"* ]]; then
        log_success "No entries need human questions — all classified!"
        return 0
    fi

    # Batch loop: generate questions until all processed
    local offset=0
    local batch_size=5
    while true; do
        if [ "$INTERRUPTED" = true ]; then
            break
        fi

        local batch_output
        batch_output=$(npx tsx scripts/generate-questions.ts "${DOCS_DIR}" --batch --size=${batch_size} --start=${offset} 2>&1) || {
            log_warn "Batch question generation failed at offset ${offset}"
            break
        }

        echo "$batch_output" | while IFS= read -r line; do
            echo "  $line"
        done

        # Check if all processed or no more entries
        if [[ "$batch_output" == *"All entries processed"* ]] || \
           [[ "$batch_output" == *"No entries need human review"* ]] || \
           [[ "$batch_output" == *"already have active questions"* ]]; then
            break
        fi

        ((offset += batch_size)) || true
    done

    log_success "Questions written to ${DOCS_DIR}/_system/DOCS_QUESTIONS.md"
}

# ─── Print Summary Report ──────────────────────────────────────────────────
print_summary() {
    echo ""
    log_info "=========================================="
    log_info "Classification Summary"
    log_info "=========================================="
    echo -e "  Total classified: ${GREEN}${TOTAL_CLASSIFIED}${NC}"
    echo -e "  Failed/skipped:   ${RED}${TOTAL_FAILED}${NC}"

    # Count remaining uncertain
    if [ -f "$INVENTORY_FILE" ]; then
        local total low_confidence high_medium
        total=$(count_lines "^id: F" "$INVENTORY_FILE")
        low_confidence=$(count_lines "confidence: low" "$INVENTORY_FILE")
        high_medium=$((total - low_confidence))

        echo ""
        log_info "Inventory state:"
        echo -e "  Total files:      ${total}"
        echo -e "  Classified (high/med): ${GREEN}${high_medium}${NC}"
        echo -e "  Uncertain (low conf):  ${YELLOW}${low_confidence}${NC}"

        if [ "$low_confidence" -gt 0 ]; then
            echo ""
            log_info "Remaining uncertain entries can be classified with:"
            echo "  .pi/slices/classify-docs.sh"
        fi
    fi

    # Session logs reference
    if [ -f "${LOGS_FILE:-}" ]; then
        echo ""
        log_info "Session logs saved to: ${LOGS_FILE}"
    fi

    if [ "$TOTAL_FAILED" -eq 0 ] && [ "$TOTAL_CLASSIFIED" -gt 0 ]; then
        log_success "Classification complete! ✓"
    elif [ "$TOTAL_CLASSIFIED" -eq 0 ] && [ "$TOTAL_FAILED" -eq 0 ]; then
        log_info "No uncertain entries to classify."
    else
        log_warn "Completed with ${TOTAL_FAILED} failure(s). Remaining uncertain entries will persist for next run."
    fi

    log_info "=========================================="
}

# ─── Main Entry Point ──────────────────────────────────────────────────────
main() {
    parse_args "$@"

    echo ""
    log_info "=========================================="
    log_info "Docs Classifier — Agent-Driven Mode"
    log_info "Model:                 ${CFG_MODEL} (${CFG_PROVIDER})"
    log_info "Timeout per batch:     ${CFG_TIMEOUT_SECONDS}s"
    if [ "$DRY_RUN" = true ]; then
        echo -e "${YELLOW}DRY RUN MODE${NC}"
    fi
    if [ "$FULL_SCAN" = true ]; then
        echo -e "${CYAN}FULL SCAN MODE${NC}"
    fi
    log_info "=========================================="
    echo ""

    # Validate prerequisites
    if [ ! -f "$RULES_FILE" ]; then
        log_error "DOCS_RULES.md not found at ${RULES_FILE}"
        exit 1
    fi

    # Phase 1: Scan (always run with --full-scan, or only if inventory missing)
    if [ "$FULL_SCAN" = true ] || [ ! -f "$INVENTORY_FILE" ]; then
        phase_scan
    else
        log_info "Skipping scan — using existing ${INVENTORY_FILE}"

        # Verify inventory exists and has entries
        local count
        count=$(count_lines "^id: F" "$INVENTORY_FILE")
        if [ "$count" -eq 0 ]; then
            log_warn "Inventory is empty — running scan..."
            phase_scan
        fi
    fi

    # Phase 2a: Auto-classify obvious files
    phase_auto_classify

    # Check remaining uncertain count before agent loop
    local total_entries low_confidence
    total_entries=$(count_lines "^id: F" "$INVENTORY_FILE")
    low_confidence=$(count_lines "confidence: low" "$INVENTORY_FILE")

    if [ "$low_confidence" -eq 0 ]; then
        log_success "All files auto-classified — no agent loop needed!"
        # Still run Phase 3 for medium-confidence entries needing human review
        echo ""
        phase_generate_questions
        phase_review_answers
        echo ""
        phase_migrate
        echo ""
        phase_cleanup_dirs
        print_summary
        return 0
    fi

    # Phase 2b: Agent loop for uncertain entries
    echo ""
    log_phase "Phase 2b — Agent classification loop (${low_confidence} low-confidence entries)..."
    echo ""

    local batch_num=0
    while true; do
        if [ "$INTERRUPTED" = true ]; then
            log_warn "Interrupted — stopping agent loop"
            break
        fi

        ((batch_num++)) || true

        # Check low-confidence count before each batch
        local remaining_low
        remaining_low=$(count_lines "confidence: low" "$INVENTORY_FILE")

        if [ "$remaining_low" -le 0 ]; then
            log_success "All entries classified!"
            break
        fi

        process_batch "$batch_num" "$(( (remaining_low + BATCH_SIZE - 1) / BATCH_SIZE ))" || true
    done

    # Phase 3a: Generate questions for remaining entries needing human review
    echo ""
    phase_generate_questions

    # Phase 3b: Review answered questions (agent upgrades medium→high confidence)
    phase_review_answers

    echo ""
    phase_migrate

    echo ""
    phase_cleanup_dirs

    # Print summary report
    print_summary
}

main "$@"
