---
name: to-prd
description: Creates a PRD from a drift-report.md and publishes it to GitHub.
tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']
---

## PHASE: to-prd
## ISSUE: {issue_number}

{previous_output}

**DRIFT REPORT:** Read `.pi/maestro/state/drift-report.md` — this contains the full analysis from the previous phase with all findings, code evidence, and severity ratings. Use it as your primary input for generating the PRD.

**YOUR TASK:** Create a PRD from the gap analysis above and publish it to the issue tracker.

**RULES:**
1. Use domain terminology from CONTEXT.md — do not invent your own terms
2. Respect existing ADRs in the area you're touching
3. Write user stories that directly address each documented gap
4. Include implementation decisions, testing decisions, and module boundaries
5. Label the new PRD with `parent-prd` (not needs-triage) so it enters the autonomous loop

**PUBLISHING:**
Create a new GitHub issue with the PRD as its body:
```bash
gh issue create --title "PRD: [feature name]" --body "$BODY" --label "parent-prd"
```

**RESULT FORMAT:**
Output your verdict as a JSON code block with language tag `verdict`:
```verdict
{"status":"approved","verdict":"complete","details":"PRD published: #<new issue number>","issues":[],"labels":{"add":[],"remove":[]},"findings":[]}
```

If REJECTED:
```verdict
{"status":"rejected","verdict":"incomplete","details":"","issues":["specific reason 1", "specific reason 2"],"labels":{"add":[],"remove":[]},"findings":[]}
```
