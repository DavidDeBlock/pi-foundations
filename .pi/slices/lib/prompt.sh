#!/usr/bin/env bash
# prompt.sh — Template-based prompt building from external .tmpl files.
# Falls back to inline templates if .tmpl files are missing.
#
# Usage: source lib/config.sh; source lib/prompt.sh

PROMPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/prompts"

# ─── Context Loading ────────────────────────────────────────────────────────
load_context_md() {
    if [ "$CFG_LOAD_CONTEXT_MD" != true ]; then
        return 0
    fi

    local ctx_file="CONTEXT.md"
    if [ -f "$ctx_file" ]; then
        echo "[INFO] Loading domain context: $PWD/$ctx_file" >&2
        if [ "${SLICES_DEBUG:-}" = "true" ]; then
            echo "=========================================="
            echo "📖 LOADED CONTEXT.md (raw content)"
            echo "=========================================="
            cat "$ctx_file"
            echo "=========================================="
            echo "✅ END OF CONTEXT.md"
            echo "==========================================" >&2
        fi
        cat "$ctx_file"
    else
        echo "# WARNING: CONTEXT.md not found — no domain glossary available" >&2
    fi
}

# ─── Render Template (variable substitution + conditional blocks) ──────────
# Uses base64-encoded values in a JSON file for safe multiline handling.
# Conditional syntax: {{#IF_KEY}}...{{/IF_KEY}} — included only when KEY is non-empty.
_render_template() {
    local template_file="$1"
    shift

    if [ ! -f "$template_file" ]; then
        log_warn "Template not found: $template_file — using inline fallback"
        return 1
    fi

    # Encode all key=value pairs as base64 and write to JSON for Python.
    # This safely handles multiline values, special chars, quotes, etc.
    local tmp_json="/tmp/pi-tmpl-vars-json.$$"
    echo "{}" > "$tmp_json"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            *=*)
                local key="${1%%=*}"
                local value="${1#*=}"
                # Base64 encode the value (wrap quotes to preserve them)
                local b64_value
                b64_value=$(printf '%s' "$value" | base64 -w 0)
                python3 -c "
import json, sys
with open('${tmp_json}') as f:
    d = json.load(f)
d['${key}'] = '${b64_value}'
with open('${tmp_json}', 'w') as f:
    json.dump(d, f)
" 2>/dev/null || true
                ;;
        esac
        shift
    done

    python3 -c "
import sys, re, base64

template_file = sys.argv[1]
vars_json_file = sys.argv[2]

# Read template
with open(template_file) as f:
    content = f.read()

# Read and decode variables from JSON (values are base64-encoded)
import json
with open(vars_json_file) as f:
    encoded_vars = json.load(f)

vars_dict = {}
for k, v in encoded_vars.items():
    vars_dict[k] = base64.b64decode(v).decode('utf-8', errors='replace')

# Simple variable substitution: {{KEY}} -> value
for key, value in vars_dict.items():
    content = content.replace('{{' + key + '}}', value)

# Conditional blocks: {{#IF_KEY}}...{{/IF_KEY}}
def replace_conditional(match):
    tag_name = match.group(1)
    block_content = match.group(2)
    var_key = tag_name[3:]  # strip IF_ prefix
    value = vars_dict.get(var_key, '')
    return block_content if value.strip() else ''

content = re.sub(
    r'\{\{#(IF_[A-Z_]+)\}\}(.*?)\{\{/\\1\}\}',
    replace_conditional,
    content,
    flags=re.DOTALL
)

print(content, end='')
" "$template_file" "$tmp_json"

    rm -f "$tmp_json"
}

# ─── Build Builder Prompt ──────────────────────────────────────────────────
build_builder_prompt() {
    local issue_num="$1"
    local issue_body="$2"
    local retry_count="${3:-0}"
    local critique="${4:-}"

    local template_file="${PROMPT_DIR}/builder.tmpl"

    # Try template file first, fall back to inline
    if [ -f "$template_file" ]; then
        _render_template "$template_file" \
            SKILL="$CFG_BUILDER_SKILL" \
            CONTEXT="$(load_context_md)" \
            PARENT_PRD="$(fetch_parent_prd "$issue_num")" \
            ISSUE_BODY="$issue_body" \
            RESULT_FILE="$RESULT_FILE" \
            ISSUE_NUMBER="$issue_num" \
            RETRY_COUNT="$retry_count" \
            CRITIQUE="$critique"
        return 0
    fi

    # Inline fallback (preserves original behavior)
    cat <<PROMPT_HEADER
${CFG_BUILDER_SKILL}

## DOMAIN CONTEXT (Glossary & Conventions)
$(load_context_md)

## PARENT PRD — Implementation & Testing Decisions
$(fetch_parent_prd "$issue_num")

## SOURCE OF TRUTH — GitHub Issue
${issue_body}

## YOUR TASK
Implement all acceptance criteria from the issue above. Follow existing project patterns exactly.

## RULES
1. Implement each requirement in the issue body and comments
2. Use domain terminology from CONTEXT.md above — do not invent your own terms
3. Respect implementation decisions from the parent PRD section above
4. After implementing, self-review your work against the issue requirements
5. Write a result file to: ${RESULT_FILE}
PROMPT_HEADER

    if [ -n "$critique" ]; then
        cat <<PROMPT_RETRY

## PREVIOUS REVIEW CRITIQUE (Attempt $((retry_count + 1)))
The reviewer found these issues that must be fixed:

${critique}

Fix ALL issues above before writing the result file.
PROMPT_RETRY
    fi

    cat <<PROMPT_FOOTER

## RESULT FILE FORMAT
Write ${RESULT_FILE} as valid JSON:

If APPROVED (all requirements implemented correctly):
{"status":"approved","slice":${issue_num}}

If REJECTED (issues found during self-review):
{"status":"rejected","slice":${issue_num},"issues":["issue1","issue2"]}

Do NOT write the result file until you have completed implementation AND self-review.
PROMPT_FOOTER
}

# ─── Build Reviewer Prompt ──────────────────────────────────────────────────
build_reviewer_prompt() {
    local issue_num="$1"
    local issue_body="$2"
    local builder_comment="${3:-}"

    local template_file="${PROMPT_DIR}/reviewer.tmpl"

    # Try template file first, fall back to inline
    if [ -f "$template_file" ]; then
        _render_template "$template_file" \
            SKILL="$CFG_REVIEWER_SKILL" \
            CONTEXT="$(load_context_md)" \
            PARENT_PRD="$(fetch_parent_prd "$issue_num")" \
            ISSUE_BODY="$issue_body" \
            BUILDER_COMMENT="$builder_comment" \
            RESULT_FILE="$RESULT_FILE" \
            ISSUE_NUMBER="$issue_num"
        return 0
    fi

    # Inline fallback (preserves original behavior)
    cat <<PROMPT_HEADER
${CFG_REVIEWER_SKILL}

## DOMAIN CONTEXT (Glossary & Conventions)
$(load_context_md)

## PARENT PRD — Implementation & Testing Decisions
$(fetch_parent_prd "$issue_num")

## SOURCE OF TRUTH — GitHub Issue
${issue_body}
PROMPT_HEADER

    if [ -n "$builder_comment" ]; then
        cat <<PROMPT_BUILDER

## BUILDER'S IMPLEMENTATION SUMMARY
\`\`\`
${builder_comment}
\`\`\`
PROMPT_BUILDER
    fi

    cat <<PROMPT_RULES

## PROJECT CONVENTIONS
- TypeScript strict mode enabled — no \`any\` types
- Follow existing feature patterns in src/ for structure
- Tests go alongside source files with .test.ts suffix
- Use the domain glossary from CONTEXT.md above for naming

## YOUR TASK
1. Read the code that was implemented for this issue
2. Validate against the acceptance criteria in the issue body
3. Verify terminology matches the domain glossary above
4. Check alignment with parent PRD implementation decisions
5. Write a verdict to ${RESULT_FILE}
PROMPT_RULES

    cat <<PROMPT_FOOTER

## RESULT FILE FORMAT
Write ${RESULT_FILE} as valid JSON:

If APPROVED (code is correct, tests pass):
{"status":"approved","slice":${issue_num},"verdict":"reviewer-approved"}

If REJECTED (issues found):
{"status":"rejected","slice":${issue_num},"verdict":"reviewer-rejected","critique":["issue1","issue2"]}

Do NOT write the result file until you have reviewed code AND run tests.
PROMPT_FOOTER
}
