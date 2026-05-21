---
name: prd-auditor
description: Audits GitHub Issues (PRDs) against implemented code and tests. Extracts acceptance criteria, verifies existence in routes/models/tests, runs build/lint/test suite. Use when verifying if a PRD is correctly implemented, checking issue completion status, or auditing feature delivery before merge.
---

# PRD Auditor

## Quick start
1. Fetch the GitHub Issue body using `gh issue view <number>`.
2. Extract Acceptance Criteria (ACs) from checkboxes `- [ ]` and "Acceptance Criteria" sections.
3. For each AC, search codebase for matching routes, functions, DB models, or test files.
4. Run `pnpm build`, `pnpm lint`, and `pnpm test`.
5. Output structured result with approval status and JSON payload if rejected.

---

## Workflow: PRD Verification Loop

### 1. Extract Requirements
- Fetch the issue body via `gh issue view <number> --json title,body,labels`.
- Identify all Acceptance Criteria (ACs). Look for:
  - Markdown checkboxes (`- [ ]` or `- [x]`)
  - Bulleted lists under "Acceptance Criteria", "Requirements", or "Scope" headers
- List them out clearly before verifying. Flag any vague/ambiguous ACs as `needs_clarification`.

### 2. Medium Verification (Code & Tests)
For each verified AC, confirm existence in the codebase:
- **Routes/Endpoints**: `grep` for route handlers matching the feature path or HTTP method in `server/src/`.
- **Functions/Services**: Search for function names, classes, or logic blocks that implement the behavior.
- **Database**: Check `drizzle/schema/` for new tables/columns if data is involved.
- **Tests**: Confirm a corresponding test file exists in `server/__tests__/` and contains assertions matching the AC's intent.

### 3. CI Checks
Run the full suite to ensure nothing breaks:
```bash
pnpm build && pnpm lint && pnpm test
```
*(Note: Use timeouts if running via bash, e.g., 15s for tests)*

### 4. Decision & Output
Compare findings against ACs:
- **All ACs verified + CI passes** → `approved`
- **Missing code/tests or CI fails** → `rejected`

---

## Rejection Handoff Format
If rejected, output a JSON block at the end for `to-prd` consumption:
```json
{
  "status": "rejected",
  "summary": "One-line reason for rejection.",
  "missing_criteria": ["AC text or description"],
  "reasons": ["Test suite failed (X errors)", "Route /api/xyz missing", "No unit tests found for feature Y"]
}
```

---

## Guardrails
- **Do not rewrite code.** Only audit and verify.
- If an AC is vague, flag it as `needs_clarification` rather than failing outright.
- Keep grep searches scoped to `server/src/`, `drizzle/`, and `__tests__/`.
- Always use `|| true` on absence checks (grep).
- Separate critical issues from optional improvements.

---

## Handoff
| To | When |
|----|------|
| `typescript-implementer` | Fixes needed based on audit findings |
| `to-prd` | PRD is rejected, needs restructuring or new scope definition |
| `finish` | All ACs verified and CI passes |
