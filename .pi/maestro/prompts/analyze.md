---
name: analyze
description: Audit the project for documentation drift. Produces drift-report.md and a verdict block. Read-only output target.
tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']
---

## PHASE: analyze
## ISSUE: {issue_number}

{diagnostic_insights}

{previous_output}

**YOUR TASK:** Audit the project for documentation drift — identify gaps between what the code does and what the docs say (or don't say). This gap analysis will feed into a PRD in the next phase.

**RULES:**
1. Use `context-sync-audit` skill to compare docs against the current codebase
2. Classify findings by drift category (undocumented-feature, stale-description, renamed-moved, removed-but-documented)
3. Severity matters — critical findings (stale/removed) should drive the PRD
4. Do NOT modify any files — this is an audit-only pass

**OUTPUT:** Write TWO files:

**1. Drift report** → `.pi/maestro/state/drift-report.md`
Produce a structured drift report with:
- Summary counts by severity (critical 🔴, medium 🟡, low 🟢)
- Each finding with category, description, and code evidence
- Verified claims that are accurate (for completeness)

**2. Verdict block** — Output your verdict as a JSON code block with language tag `verdict`:
```verdict
{"status":"approved","verdict":"complete","details":"No critical gaps found — flow complete.","issues":[],"labels":{"add":[],"remove":[]},"findings":[]}
```

If significant gaps were found (APPROVED for PRD generation):
```verdict
{"status":"approved","verdict":"gaps-found","details":"Gaps identified — see drift-report.md","issues":[],"labels":{"add":[],"remove":[]},"findings":[]}
```

If the audit itself failed:
```verdict
{"status":"rejected","verdict":"audit-failed","details":"","issues":["specific reason 1", "specific reason 2"],"labels":{"add":[],"remove":[]},"findings":[]}
```
