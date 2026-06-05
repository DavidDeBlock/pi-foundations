---
name: close
description: Mechanical close phase — checks evidence gates before allowing success.
tools: []
---

# Close — Evidence Gate Verification

This phase does **not** run an LLM. It is a local-command phase (see the
flow's `is_local: true` + `command: ...` in the flow config) that
mechanically checks for required evidence markers on disk. The
`tools: []` allowlist is intentional — no LLM tools are exposed, so the
phase cannot fabricate evidence even if a malicious prompt were
injected.

## What this phase does

1. Read the flow's `evidence_policy` (top-level field on the flow JSON).
2. For each type in `required_on_success` (default: `tested`, `reviewed`):
   - Read `<issue>.maestro/evidence/<issue>/<type>.json`
   - Verify the file exists, parses, and its `content_hash` matches
3. Apply the `on_missing_evidence` policy:
   - `block` — missing or unverified evidence → `rejected` → route to
     `diagnostic` (the strict, Case-style default)
   - `warn_but_proceed` (Maestro's default) — missing or unverified
     evidence → log a warning, but proceed with `success`
   - `ignore` — skip the check entirely, always `success`

## Why this phase exists

LLM-judged approval ("looks good!") is not auditable. Evidence-based
approval ("tested.json shows 47/47 passed, reviewed.json shows 0
critical issues") is auditable. This phase enforces the latter.

If the flow succeeds, you can answer "what supported this success?" by
listing the evidence files under `.maestro/evidence/<issue>/`. See the
PRD §"Why a gate, not a wall?" for the rationale.
