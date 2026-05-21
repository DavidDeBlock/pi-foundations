---
name: context-sync-audit
description: >
  Audits drift between project documentation and the actual codebase after implementation rounds.
  Reads one section at a time to stay within context limits, classifies drift by type, and outputs
  a structured report — no file modifications. Use when docs may be stale after coding work,
  before creating an update plan, or when user mentions "sync docs", "doc drift", "context sync".
---

# Context Sync Audit

## Quick start

Audit whether operational documents match the current codebase:
1. Pick a target document (or both)
2. Run section-by-section audit against code artefacts
3. Collect findings into a drift report

**Input:** one or more documentation files  
**Output:** structured drift report grouped by severity — no files modified

---

## Workflows

### Default Audit Process

1. **Catalogue claims** — read the target doc section-by-section (not all at once)
2. **Map to code artefacts** — for each claim, identify which file/type/handler/route validates it
3. **Verify on disk** — check existence, content, and current state of referenced artefacts
4. **Classify drift** — assign a category and severity (see Drift Categories below)
5. **Repeat** until all sections are audited
6. **Compile report** — group findings by document, then by severity

**Section-by-section rule:** Read one section at a time (~30 lines max). Verify claims against code before moving on. Accumulate findings in memory; compile the final report after all sections.

---

## Drift Categories

| Category | Meaning | Severity Default |
|----------|---------|------------------|
| `undocumented-feature` | Code exists but is not described in docs | 🟡 Medium |
| `stale-description` | Docs describe something that has changed in code | 🔴 Critical |
| `renamed-moved` | Artefact was renamed or relocated; doc points to old location | 🟡 Medium |
| `removed-but-documented` | Code was deleted but docs still reference it | 🔴 Critical |
| `count-discrepancy` | Doc states a number (file count, skill count) that no longer matches | 🟢 Low |
| `path-unspecified` | Doc references an artefact without stating its actual path | 🟢 Low |

---

## Guardrails

### Allowed Actions

- Read documentation files
- Inspect codebase structure (`ls`, `find`, `grep`)
- Read individual source files to verify claims
- Classify and categorise drift findings
- Produce a markdown drift report

### Forbidden Actions

- Modify any documentation or source files
- Create update plans (that's the Planner's job)
- Rewrite doc content or structure
- Load entire documents into context at once

---

## Output Format

Produce a **drift report** with this structure:

```
# Drift Report — [Document Name]
Audited: YYYY-MM-DD | Sections checked: N / M

## Critical (🔴)
- `category`: description + code evidence

## Medium (🟡)
- `category`: description + code evidence

## Low (🟢)
- `category`: description + code evidence

## Verified (✅)
- Claim — confirmed accurate
```



---

## GitHub Integration

### Reading the issue tracker config

Read `docs/agents/issue-tracker.md` (if it exists) to learn how this repo tracks issues — whether via `gh` CLI (GitHub/GitLab), local markdown files, or another system. If the file doesn't exist, assume GitHub with `gh` CLI.

### Publishing a drift report as an issue

When the user wants findings tracked on the issue tracker, publish the drift report as a GitHub issue:

```bash
ghtitle="Drift Report — [Document Name]"
ghbody=$(cat <<'EOF'
## Summary
N critical, N medium, N low findings across M sections.

## Critical (🔴)
- `category`: description + code evidence

## Medium (🟡)
- `category`: description + code evidence

## Low (🟢)
- `category`: description + code evidence
EOF
)
gh issue create --title "$ghtitle" --body "$ghbody" --label "needs-triage"
```

Apply the `needs-triage` label so it enters the normal triage flow.

### Referencing related issues

If drift findings relate to a specific implementation issue, reference it using `#N` format:

```markdown
## Related Issue
- #42 — Add user profile editing (caused undocumented-feature drift)
```

---

## Handoff

| To | When |
|----|------|
| `planner` | Drift report complete; user wants an update plan |
| `typescript-implementer` | User executes doc updates slice-by-slice |
| `reviewer` | Doc updates need quality validation |

---

## Definition of Done

A usable drift report exists for the audited document(s). No files were modified. Each finding includes a category, description, and code evidence.
