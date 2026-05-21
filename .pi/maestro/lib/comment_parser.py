import re

PHASE_OUTPUT_PATTERN = re.compile(
    r"---\s*\n### PHASE_OUTPUT:\s*(success|rejected|system_error)\s*\n(.+?)\n### END_PHASE_OUTPUT\s*\n---",
    re.DOTALL
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
