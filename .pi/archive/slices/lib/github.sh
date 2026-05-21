#!/usr/bin/env bash
# github.sh — GitHub API wrappers with caching, timeout, and error handling.
#
# Usage: source lib/config.sh; source lib/github.sh

GH_TIMEOUT="${GH_TIMEOUT:-30}"  # seconds per gh CLI call

# ─── Repo Detection ────────────────────────────────────────────────────────
_get_repo() {
    local repo=""
    if [ -n "$REPO_OVERRIDE" ]; then
        echo "$REPO_OVERRIDE"
        return 0
    fi

    # Try remote origin first
    if [ -d ".git" ]; then
        repo=$(git remote get-url origin 2>/dev/null | sed 's|.*github.com[:/]||; s|\.git$||' || true)
    fi

    # Fallback to gh config
    if [ -z "$repo" ]; then
        repo=$(gh config get defaultRepo 2>&1 | head -1 || true)
    fi

    echo "${repo:-}"
}

# ─── Fetch Issues with Label ────────────────────────────────────────────────
fetch_issues_by_label() {
    local label="$1"
    local repo="$(_get_repo)"

    if [ -z "$repo" ]; then
        log_error "Could not detect GitHub repo"
        return 1
    fi

    log_info "Fetching issues with label '${label}' from ${repo}..."

    local raw_output
    raw_output=$(timeout "$GH_TIMEOUT" gh issue list \
        --label "$label" \
        --json number,title \
        --state all \
        --limit 100 2>&1) || {
        log_error "Failed to fetch issues: $raw_output"
        return 1
    }

    # Parse into bash array (sorted ascending by number)
    local issue_str
    issue_str=$(echo "$raw_output" | python3 -c "
import json, sys
data = json.load(sys.stdin)
issues = sorted(data, key=lambda x: int(x['number']))
print(' '.join(str(i['number']) for i in issues))
" 2>/dev/null || echo "")

    if [ -z "$issue_str" ]; then
        log_warn "No issues found with label '${label}'"
        return 0
    fi

    # Load into global ISSUE_NUMBERS array
    read -ra ISSUE_NUMBERS <<< "$issue_str"
    local count=${#ISSUE_NUMBERS[@]}
    log_success "Found ${count} issues to process: ${ISSUE_NUMBERS[*]}"
}

# ─── Fetch Issue Body ──────────────────────────────────────────────────────
fetch_issue_body() {
    local issue_num="$1"
    local repo="$(_get_repo)"

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would fetch issue #$issue_num from ${repo}"
        echo "DRY-RUN: Issue body for #${issue_num} would be fetched here."
        return 0
    fi

    local body
    body=$(timeout "$GH_TIMEOUT" gh issue view "$issue_num" \
        --repo "$repo" \
        --json body,title,number,comments 2>&1) || {
        log_error "Failed to fetch issue #$issue_num: $body"
        return 1
    }
    echo "$body"
}

# ─── Fetch Parent PRD (with caching) ────────────────────────────────────────
declare -A _PRD_CACHE=()

fetch_parent_prd() {
    local issue_num="$1"

    # Return cached result if available
    if [ -n "${_PRD_CACHE[$issue_num]+x}" ]; then
        echo "${_PRD_CACHE[$issue_num]}"
        return 0
    fi

    if [ "$CFG_FETCH_PARENT_PRD" != true ]; then
        echo "# Parent PRD fetching disabled in config"
        return 0
    fi

    local repo="$(_get_repo)"
    local parent_ref=""

    # Try label first (e.g., parent-prd:#34)
    parent_ref=$(timeout "$GH_TIMEOUT" gh issue view "$issue_num" --repo "$repo" --json labels 2>/dev/null | \
        python3 -c "
import json, sys, re
d = json.load(sys.stdin)
names = [l.get('name', '') for l in d]
text = ' '.join(names)
m = re.search(r'parent-prd:#(\d+)', text)
print(m.group(1) if m else '')
" 2>/dev/null || echo "")

    # Fallback to body text
    if [ -z "$parent_ref" ]; then
        parent_ref=$(timeout "$GH_TIMEOUT" gh issue view "$issue_num" --repo "$repo" --json body 2>/dev/null | \
            python3 -c "
import json, sys, re
d = json.load(sys.stdin)
body = d.get('body', '')
# Match 'Parent #N' or '[#N](...)' markdown links
m = re.search(r'(?:Parent|## Parent).*?(?:\[?\s*#\s*(\d+)\s*\]?)', body, re.IGNORECASE)
print(m.group(1) if m else '')
" 2>/dev/null || echo "")
    fi

    local prd_content=""
    if [ -n "$parent_ref" ]; then
        prd_content=$(timeout "$GH_TIMEOUT" gh issue view "$parent_ref" --repo "$repo" --json body,title 2>/dev/null | \
            python3 -c "
import json, sys
d = json.load(sys.stdin)
print('### PRD: ' + d.get('title', '') + '\n\n' + d.get('body', ''))
" 2>/dev/null || echo "")

        if [ -z "$prd_content" ]; then
            prd_content="# Parent PRD #$parent_ref referenced but could not be fetched."
        fi
    else
        prd_content="# No parent PRD reference found for this issue."
    fi

    # Cache result
    _PRD_CACHE[$issue_num]="$prd_content"
    echo "$prd_content"
}

# ─── Post Comment on Issue ────────────────────────────────────────────────
post_comment() {
    local issue_num="$1"
    local body="$2"
    local repo="$(_get_repo)"

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would post comment on #${issue_num}"
        return 0
    fi

    timeout "$GH_TIMEOUT" gh issue comment "$issue_num" --repo "$repo" --body "$body" 2>&1 || {
        log_warn "Failed to post comment on #${issue_num}"
        return 1
    }
}

# ─── Update Labels ────────────────────────────────────────────────────────
update_labels() {
    local issue_num="$1"
    local action="$2"  # success | fail
    local repo="$(_get_repo)"

    if [ "$CFG_UPDATE_LABELS" != true ]; then
        return 0
    fi

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would update labels on #${issue_num}: ${action}"
        return 0
    fi

    case "$action" in
        success)
            timeout "$GH_TIMEOUT" gh issue edit "$issue_num" --repo "$repo" --remove-label "$CFG_TARGET_LABEL" 2>&1 || true
            timeout "$GH_TIMEOUT" gh issue edit "$issue_num" --repo "$repo" --add-label "$CFG_SUCCESS_LABEL" 2>&1 || {
                log_warn "Failed to add ${CFG_SUCCESS_LABEL} label on #${issue_num}"
            }
            ;;
        fail)
            timeout "$GH_TIMEOUT" gh issue edit "$issue_num" --repo "$repo" --add-label "$CFG_FAIL_LABEL" 2>&1 || {
                log_warn "Failed to add ${CFG_FAIL_LABEL} label on #${issue_num}"
            }
            timeout "$GH_TIMEOUT" gh issue edit "$issue_num" --repo "$repo" --remove-label "$CFG_TARGET_LABEL" 2>&1 || true
            ;;
    esac
}

# ─── Fetch Builder Comment (last [BUILDER] comment) ────────────────────────
fetch_builder_comment() {
    local issue_num="$1"
    local repo="$(_get_repo)"

    if [ "$DRY_RUN" = true ]; then
        echo ""
        return 0
    fi

    timeout "$GH_TIMEOUT" gh issue view "$issue_num" --repo "$repo" --json comments 2>&1 | python3 -c "
import json, sys
data = json.load(sys.stdin)
comments = data.get('comments', [])
for c in reversed(comments):
    body = c.get('body', '')
    if '[BUILDER]' in body:
        print(body)
        break
" 2>/dev/null || echo ""
}
