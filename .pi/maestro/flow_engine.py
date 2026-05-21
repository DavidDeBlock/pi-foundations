#!/usr/bin/env python3
"""
flow_engine.py — Core execution engine for a single flow on a single issue.

Handles:
- Issue metadata fetching & header display
- Phase loop with per-phase retry counters
- Session log parsing & inline metadata rendering
- GitHub comment gating (first rejection + final success)
- Terminal tree layout output
"""

import json
import sys
from pathlib import Path
from typing import Optional, Tuple

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent / "lib"))

from terminal import Terminal
from rpc_client import run_rpc_with_session_log
from github_client import GithubClient
from session_reader import parse_session_log


def get_next_step(transitions: list, current_phase: str, status: str) -> Optional[str]:
    """Determine the next step based on transitions and phase status."""
    for t in transitions:
        if t.get("from") == current_phase:
            key = f"on_{status}"
            if key in t:
                return t[key]
    return None


def _print_prompt_debug(phase_name: str, issue_num: int, template_exists: bool, variables: dict, prompt: str, extra_context: str):
    """Print debug info about the built prompt to stderr."""
    print("\n" + "="*60, file=sys.stderr)
    print(f"[DEBUG] Phase: {phase_name} | Issue: #{issue_num}", file=sys.stderr)
    print(f"[DEBUG] Template loaded: {'YES' if template_exists else 'NO (fallback)'}", file=sys.stderr)
    
    # Show variable values (truncated for readability)
    for key, value in variables.items():
        display = value[:200] + "..." if len(value) > 200 else value
        print(f"[DEBUG]   {key} = '{display}'", file=sys.stderr)
    
    # Show extra context (diagnostic or previous_output)
    if extra_context:
        display = extra_context[:300] + "..." if len(extra_context) > 300 else extra_context
        print(f"[DEBUG]   Context preview: '{display}'", file=sys.stderr)
    
    # Prompt stats
    lines = prompt.split('\n')
    print(f"[DEBUG] Prompt: {len(prompt)} chars, {lines.__len__()} lines", file=sys.stderr)
    if len(lines) > 0:
        print(f"[DEBUG] First line: '{lines[0].strip()[:100]}'", file=sys.stderr)
    print("="*60 + "\n", file=sys.stderr)


def build_prompt(phase_name: str, phase_config: dict, flow_config: dict, issue_num: int, context: dict) -> str:
    """Build a prompt for the given phase using templates or defaults."""
    skill = phase_config.get("skill", "")
    
    # Determine prompt source
    if not skill:
        print(f"[WARN] Phase '{phase_name}' has no 'skill' configured in flow config.", file=sys.stderr)
        sys.stderr.flush()
        
    prompt_dir = Path(__file__).parent / "prompts"
    template_file = prompt_dir / f"{phase_name}.tmpl"
    
    if template_file.exists():
        with open(template_file) as f:
            prompt = f.read()
    else:
        # Fallback to default prompt
        prompt = f"""## Phase: {phase_name}
## Issue: #{issue_num}

**YOUR TASK:** Execute this phase for issue #{issue_num}.

{'## DIAGNOSTIC INSIGHTS (Previous Failure)\n' + context.get('diagnostic_insights', '') if context.get('diagnostic_insights') else ''}
{'## PREVIOUS PHASE OUTPUT\n' + context.get('previous_output', '')[:500] if context.get('previous_output') else ''}

**RESULT FORMAT:**
Write a result file to `.pi/maestro/state/slice-result.json`:

If APPROVED:
{"status":"approved","slice":{issue_num}}

If REJECTED:
{"status":"rejected","slice":{issue_num},"issues":["specific issue 1", "specific issue 2"]}
"""
    
    # Inject variables from context
    issue_body = context.get("prompt", f"## Issue #{issue_num}\n\nPlease execute this phase.")
    variables = {
        "{issue_number}": str(issue_num),
        "{diagnostic_insights}": context.get("diagnostic_insights", ""),
        "{previous_output}": context.get("previous_output", ""),
        "{prd_body}": context.get("prd_body", ""),
        "{issue_body}": issue_body
    }
    for key, value in variables.items():
        prompt = prompt.replace(key, value)
    
    # Inject local command or skill directive
    if phase_config.get("is_local"):
        cmd = phase_config.get("command", "")
        prompt += f"\n\n**LOCAL COMMAND TO RUN:** `{cmd}`"
        print(f"[PHASE] Running local command: {cmd}", file=sys.stderr)
    elif skill:
        prompt += f"\n\n**SKILL TO USE:** `{skill}`"
        print(f"[PHASE] Invoking skill: {skill}", file=sys.stderr)
        sys.stderr.flush()
    
    # DEBUG: Show what was built
    extra = context.get("diagnostic_insights", "") or context.get("previous_output", "")
    if context.get("prd_body"):
        extra = f"PRD ({len(context['prd_body'])} chars) | {extra[:200]}"
    _print_prompt_debug(phase_name, issue_num, template_file.exists(), variables, prompt, extra)
    
    return prompt


def run_phase(phase_name: str, flow_config: dict, issue_num: int, context: dict) -> Tuple[dict, Optional[str]]:
    """Execute a single phase and return its result."""
    phase_config = flow_config["phases"][phase_name]
    
    # Local command phases run directly via subprocess (no LLM)
    if phase_config.get("is_local"):
        cmd = phase_config.get("command", "").replace("{issue_number}", str(issue_num))
        print(f"[PHASE] Running local command: {cmd}", file=sys.stderr)
        sys.stderr.flush()
        
        import subprocess
        try:
            result = subprocess.run(
                cmd, shell=True, capture_output=True, text=True,
                timeout=phase_config.get("timeout_seconds", 60)
            )
            if result.returncode == 0:
                return {"status": "success", "details": f"Local command succeeded: {cmd}"}, None
            else:
                err = (result.stderr or result.stdout)[:300]
                return {"status": "reject", "details": f"Local command failed ({result.returncode}): {err}"}, None
        except subprocess.TimeoutExpired:
            return {"status": "error", "details": f"Local command timed out after {phase_config.get('timeout_seconds', 60)}s"}, None
        except Exception as e:
            return {"status": "error", "details": f"Local command error: {str(e)[:200]}"}, None
    
    prompt = build_prompt(phase_name, phase_config, flow_config, issue_num, context)
    
    print(f"[PHASE] Running '{phase_name}' on issue #{issue_num}", file=sys.stderr)
    sys.stderr.flush()
    
    timeout = phase_config.get("timeout_seconds", 1800)
    model = phase_config.get("model")
    provider = phase_config.get("provider")
    rpc_result = run_rpc_with_session_log(prompt, phase_name, timeout, model=model, provider=provider)
    
    session_log_path = rpc_result.get("session_log")
    
    if not rpc_result["success"]:
        return {
            "status": "error",
            "details": f"RPC failed: {rpc_result['output'][:200]}"
        }, session_log_path
    
    status_data = rpc_result.get("result", {})
    phase_status = status_data.get("status", "rejected")
    
    if phase_status == "approved":
        final_status = "success"
        details = f"{phase_name} approved"
    elif phase_status == "no_gaps":
        final_status = "no_gaps"
        details = status_data.get("message", f"No significant gaps found in {phase_name}")
    else:
        final_status = "reject"
        issues = status_data.get("issues", [])
        verdict = status_data.get("verdict", "")
        
        if issues:
            details_parts = [f"{phase_name} rejected"]
            for issue in issues[:5]:
                details_parts.append(f"• {issue}")
            details = "\n".join(details_parts)
        elif verdict:
            details = f"{phase_name} rejected: {verdict}"
        else:
            details = f"{phase_name} self-rejected (no details in result)"
    
    return {
        "status": final_status,
        "details": details,
        "output": rpc_result["output"]
    }, session_log_path


def run_diagnostic(term: Terminal, flow_config: dict, issue_num: int, failure_context: dict) -> dict:
    """Run a diagnostic pass to analyze what went wrong."""
    term._print_verbose(f"[DIAGNOSTIC] Analyzing failure on issue #{issue_num}")
    
    diag_prompt = f"""## DIAGNOSTIC PHASE
Issue: #{issue_num}
Failure Context: {json.dumps(failure_context, indent=2)}

Analyze the session logs and identify why the previous phase failed.
Provide specific actionable insights for the next retry attempt."""
    
    diag_config = flow_config["phases"]["diagnostic"]
    timeout = diag_config.get("timeout_seconds", 600)
    model = diag_config.get("model")
    provider = diag_config.get("provider")
    rpc_result = run_rpc_with_session_log(diag_prompt, "diagnostic", timeout, model=model, provider=provider)
    
    return {
        "status": "success" if rpc_result["success"] else "failed",
        "analysis": rpc_result.get("output", "")[:1000]
    }


def load_flow(name: str) -> dict:
    """Load a flow configuration from JSON file with defaults applied."""
    FLOWS_DIR = Path(__file__).parent / "flows"
    flow_file = FLOWS_DIR / f"{name}.json"
    
    if not flow_file.exists():
        print(f"[ERROR] Flow '{name}' not found at {flow_file}", file=sys.stderr)
        sys.exit(1)
    
    with open(flow_file) as f:
        config = json.load(f)
    
    if "phases" not in config or "transitions" not in config:
        print(f"[ERROR] Invalid flow configuration in {flow_file}", file=sys.stderr)
        sys.exit(1)
    
    for transition in config["transitions"]:
        if transition.get("from") and transition["from"] not in config["phases"]:
            print(f"[ERROR] Phase '{transition['from']}' referenced in transitions but not defined", file=sys.stderr)
            sys.exit(1)
    
    default_retries = 3
    default_timeout = 1800
    flow_provider = config.get("default_provider")
    
    for phase_name, phase_config in config["phases"].items():
        if "retries" not in phase_config:
            print(f"[WARN] Phase '{phase_name}' missing 'retries' field — applying default: {default_retries}", file=sys.stderr)
            sys.stderr.flush()
            config["phases"][phase_name]["retries"] = default_retries
        elif phase_config["retries"] < 1:
            print(f"[ERROR] Phase '{phase_name}' has invalid retries: {phase_config['retries']} (must be >= 1)", file=sys.stderr)
            sys.exit(1)
        
        if "timeout_seconds" not in phase_config:
            config["phases"][phase_name]["timeout_seconds"] = default_timeout
        
        # Apply model/provider defaults from flow-level or hardcoded fallbacks
        if "model" not in phase_config:
            print(f"[WARN] Phase '{phase_name}' missing 'model' field", file=sys.stderr)
            sys.stderr.flush()
        
        if "provider" not in phase_config and flow_provider:
            config["phases"][phase_name]["provider"] = flow_provider
    
    return config


def _extract_parent_issue(body: str) -> Optional[int]:
    """Extract parent issue number from body if formatted as '## Parent\n\n#NNN'."""
    import re
    match = re.search(r'^##\s*Parent\s*\n\s*#(\d+)', body, re.MULTILINE)
    return int(match.group(1)) if match else None


def run_flow_on_issue(term: Terminal, gh_client: GithubClient, flow_name: str, issue_num: int, initial_context: Optional[dict] = None) -> bool:
    """
    Run a specific flow on a single GitHub issue.
    Returns True if completed successfully, False otherwise.
    """
    flow_config = load_flow(flow_name)
    
    # Fetch and display issue metadata
    try:
        issue_info = gh_client.fetch_issue(issue_num)
        if issue_info:
            title = issue_info.title or "No title"
            body = issue_info.body or ""
            comments_count = len(issue_info.comments) if issue_info.comments else 0
            created_at = issue_info.created_at[:10] if issue_info.created_at else None
            term.issue_header(issue_num, title=title, comments_count=comments_count, created_at=created_at)
        else:
            body = ""
            term._print_verbose(f"[WARNING] Could not fetch issue #{issue_num} metadata")
            term.issue_header(issue_num)
    except Exception as e:
        body = ""
        term._print_verbose(f"[WARNING] Could not fetch issue metadata: {e}")
        term.issue_header(issue_num)
    
    # Build context with issue body and parent PRD if available
    context = {"prompt": f"## Issue #{issue_num}\n\n{body}"}
    
    # Check for parent PRD reference (e.g., '## Parent\n\n#49')
    parent_num = _extract_parent_issue(body)
    if parent_num:
        term._print_verbose(f"[PARENT] Issue #{issue_num} references parent PRD #{parent_num}")
        try:
            prd_info = gh_client.fetch_issue(parent_num)
            if prd_info and prd_info.body:
                context["prd_body"] = f"## Parent PRD (#{parent_num})\n\n{prd_info.body}"
                term._print_verbose(f"[PARENT] Loaded parent PRD #{parent_num} ({len(prd_info.body)} chars)")
            else:
                term._print_verbose(f"[WARNING] Could not fetch parent PRD body for #{parent_num}")
        except Exception as e:
            term._print_verbose(f"[WARNING] Failed to load parent PRD: {e}")
    
    if initial_context:
        context.update(initial_context)
    
    # Main execution loop for this specific issue
    max_iterations = 50
    iteration_count = 0
    current_phase = next(iter(flow_config["phases"]))
    phase_attempt_count = 1
    first_rejection_posted = False
    completed_successfully = False
    
    while iteration_count < max_iterations:
        iteration_count += 1
        
        result, session_log_path = run_phase(current_phase, flow_config, issue_num, context)
        sys.stderr.flush()
        
        term._print_verbose(f"[PHASE] {current_phase} -> {result['status']}")
        
        max_retries = flow_config["phases"][current_phase].get("retries", 3)
        is_retry = phase_attempt_count > 1
        
        term.attempt_start(current_phase, phase_attempt_count, max_retries)
        
        # Parse session log for inline metadata
        if session_log_path:
            try:
                summary = parse_session_log(session_log_path)
                model = summary.get("model")
                duration = summary.get("duration_seconds", 0)
                file_ops = summary.get("file_operations", [])
                written = len([op for op in file_ops if op["status"] == "success"])
                failed = len([op for op in file_ops if op["status"] == "failed"])
                term.attempt_metadata(
                    model=model,
                    duration_seconds=duration,
                    file_ops_written=written,
                    file_ops_failed=failed
                )
            except Exception as e:
                term._print_verbose(f"[WARNING] Failed to parse session log: {e}")
        
        # Handle phase result
        if result["status"] == "success":
            term.phase_approved(current_phase, is_retry=is_retry)
        elif result["status"] == "no_gaps":
            term._print_verbose(f"[NO_GAPS] {current_phase}: No significant gaps found — finishing.")
        elif result["status"] == "reject":
            if not first_rejection_posted:
                gh_client.post_phase_comment(
                    issue_num=issue_num,
                    phase=current_phase,
                    status="rejected",
                    details=result.get("details", "")[:300]
                )
                first_rejection_posted = True
            term.feedback(result.get("details", ""))
        elif result["status"] == "error":
            term._print_verbose(f"[ERROR] Phase error: {result.get('details', 'Unknown')}")
            term.failure(f"{current_phase} failed with error")
            gh_client.post_phase_comment(
                issue_num=issue_num,
                phase=current_phase,
                status="error",
                details=result.get("details", "Error executing phase")[:300]
            )
        
        # Determine next step
        next_step = get_next_step(flow_config["transitions"], current_phase, result["status"])
        
        if not next_step:
            term._print_verbose(f"[ERROR] No transition defined for {current_phase} -> {result['status']}")
            break
        
        if next_step == "finish":
            completed_successfully = True
            break
        elif next_step == "diagnostic" or result["status"] == "error":
            term._print_verbose(f"[DIAGNOSTIC] Running diagnostic for {current_phase}")
            diag_result = run_diagnostic(term, flow_config, issue_num, {
                "failed_phase": current_phase,
                "output_summary": result.get("details", "")[:500]
            })
            if diag_result["status"] == "success":
                term._print_verbose(f"Diagnostic analysis: {diag_result['analysis'][:150]}")
                context["diagnostic_insights"] = diag_result.get("analysis", "")
        else:
            # Preserve issue/PRD context across phase transitions — only update previous_output
            context["previous_output"] = f"## {current_phase.upper()} COMPLETED\n{result.get('details', '')[:300]}"
            current_phase = next_step
            phase_attempt_count = 1
        
        if next_step == current_phase:
            phase_attempt_count += 1
    
    if iteration_count >= max_iterations:
        term.failure(f"Reached maximum iterations ({max_iterations}) — possible infinite loop")
    else:
        # Post final success comment only on first pass (no rejection)
        if completed_successfully and not first_rejection_posted:
             gh_client.post_phase_comment(
                issue_num=issue_num,
                phase=current_phase,
                status="approved",
                details=f"{current_phase} approved after {phase_attempt_count} attempt(s)"
            )
    
    return completed_successfully
