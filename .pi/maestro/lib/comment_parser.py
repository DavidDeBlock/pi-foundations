import re

# Canonical full-block regex: matches the entire PHASE_OUTPUT fence used
# in GitHub comments (per the ADR-009 contract).
# Format:
#   ---
#   ### PHASE_OUTPUT: {status}
#   {details}
#   ### END_PHASE_OUTPUT
#   ---
PHASE_OUTPUT_PATTERN = re.compile(
    r"---\s*\n### PHASE_OUTPUT:\s*(success|rejected|system_error)\s*\n(.+?)\n### END_PHASE_OUTPUT\s*\n---",
    re.DOTALL
)

# Looser start-marker regex: matches just the `### PHASE_OUTPUT: {status}`
# line (no leading `---` and no closing `END_PHASE_OUTPUT` required). Used
# by ``verdict_extractor`` when scanning session logs, where the body may
# be JSON or the surrounding `---` fences may be missing.
# Supports an extended outcome set (``success`` / ``failure`` / ``rejected``
# / ``system_error``) so the retrospective phase's richer marker parses.
PHASE_OUTPUT_MARKER_PATTERN = re.compile(
    r"###\s*PHASE_OUTPUT:\s*(success|failure|rejected|system_error)\b",
    re.IGNORECASE,
)

def parse_phase_output(comment_body: str):
    """
    Parses the strict comment format to extract status and details.
    
    Format:
    ---
    ### PHASE_OUTPUT: {status}
    {details}
    ### END_PHASE_OUTPUT
    ---
    """
    match = PHASE_OUTPUT_PATTERN.search(comment_body)
    if not match:
        return None
    
    status = match.group(1).strip()
    details = match.group(2).strip()
    
    return {"status": status, "details": details}
