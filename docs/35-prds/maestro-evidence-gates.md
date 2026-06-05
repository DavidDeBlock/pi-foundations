# PRD: Evidence Gates (Mechanical Quality Enforcement)

> **Wave:** 2 (Quality & Learning)
> **Effort:** 4-6 hours
> **Depends on:** [Working Memory](maestro-working-memory.md), [Tool Allowlists](maestro-tool-allowlists.md)
> **Required by:** [Retrospective](maestro-retrospective.md) (uses evidence in retrospective analysis)
> **Roadmap:** [maestro-case-improvements-roadmap.md](maestro-case-improvements-roadmap.md#8-prds-in-this-set)

---

## Problem Statement

Maestro's quality gate is currently **LLM-judged**: a `reviewer` agent reads code, then either says `APPROVED` or `REJECTED` in its session log. The flow engine greps the session log for `APPROVED` and routes accordingly.

This has three problems:

1. **Fragile:** A reviewer that says "looks good, but I have minor concerns" might be parsed as `APPROVED` when it should be `REJECTED`. The verdict is a vibe check.
2. **Unauditable:** If the PR turns out to be broken, we can't ask "what evidence supported the success verdict?" The only artifact is the reviewer's prose.
3. **Easy to game:** A reviewer that wants to please the user (or its training data) might rubber-stamp work. There's no mechanical check.

The **workos/case** project solves this with **evidence markers** — physical files under `<repo>/.case/<task-slug>/` that are written by **mark commands** after concrete verification:

- `tested` — written by `ca mark-tested` from real test output
- `manual-tested` — written by `ca mark-manual-tested` from browser verification (Playwright)
- `reviewed` — written by `ca mark-reviewed --critical 0`

The `closer` agent **physically cannot succeed** without these markers. "The point is not ceremony; it is making the PR auditable without trusting a chat transcript."

## Solution

Add **Evidence Gates** to Maestro:

1. New CLI commands: `maestro mark-tested`, `maestro mark-manual-tested`, `maestro mark-reviewed`
2. Evidence files written to `.maestro/evidence/<issue>/`
3. New `close` phase (or extension to existing closer) that **mechanically checks** for required evidence
4. Evidence is a **gate, not the only signal** — LLM verdict + human override remain as fallbacks
5. Backward compatible: LLM-only approval still works, but emits a warning

**Evidence taxonomy:**

| Marker | Producer | Verifies | Example |
|---|---|---|---|
| `tested.json` | `maestro mark-tested` (or test_runner phase) | Automated test output | `{"command": "bun test", "exit_code": 0, "tests_run": 47, "tests_passed": 47, "timestamp": "..."}` |
| `manual-tested.json` | `maestro mark-manual-tested` (or verifier phase with Playwright) | Browser/manual verification | `{"screenshot_before": "before.png", "screenshot_after": "after.png", "scenario": "user can log in", "verified_by": "playwright"}` |
| `reviewed.json` | `maestro mark-reviewed` (or reviewer phase) | Human or structured review | `{"critical_issues": 0, "non_blocking_issues": 2, "reviewer": "claude-sonnet"}` |

**Default gate policy** (configurable per flow):

- `builder-reviewer` flow: requires `tested` + `reviewed`
- `builder-test-reviewer` flow: requires `tested` + `reviewed` (test_runner produces `tested`)
- `gap-check` / `prd-audit` flows: no evidence required (not PR flows)

## User Stories

1. As a Maestro operator, I want the flow to physically require evidence files before declaring success, so that I can trust the success verdict
2. As a Maestro operator, I want to write a `tested` evidence file from a real test run, so that the success verdict is grounded in actual test output
3. As a Maestro operator, I want to write a `reviewed` evidence file from a structured review, so that the success verdict includes a critical-issue count
4. As a Maestro operator, I want a Playwright-driven `manual-tested` command, so that UI changes can be verified before success
5. As a Maestro operator, I want to configure evidence requirements per flow, so that PR flows require all three, but audit flows require none
6. As a Maestro operator, I want evidence to be a gate, not a wall — LLM verdict + human override should still work as fallbacks
7. As a Maestro operator, I want to inspect evidence files for any past run, so that I can audit "what supported this success verdict?"
8. As a Maestro developer, I want evidence files to be tamper-evident (hash-signed), so that a malicious agent can't fake evidence
9. As a Maestro operator, I want a `maestro evidence check <issue>` command to verify all required markers exist, so that I can pre-flight check before close
10. As a Maestro operator, I want the closer phase to post a clear error when evidence is missing, so that the next iteration knows what to produce

## Implementation Decisions

### New Module: `lib/evidence.py`

```python
# lib/evidence.py
from pathlib import Path
import json
import time
import hashlib
from dataclasses import dataclass, asdict
from enum import Enum
from typing import Literal

EVIDENCE_DIR = Path(".maestro/evidence")


class EvidenceType(str, Enum):
    TESTED = "tested"
    MANUAL_TESTED = "manual_tested"
    REVIEWED = "reviewed"


@dataclass
class EvidenceMarker:
    """A single evidence marker — physical file representing verification."""
    issue: int
    type: EvidenceType
    verified: bool
    created_at: str
    created_by: str  # "human", "test_runner_phase", "playwright_phase", etc.
    data: dict  # Type-specific verification data
    content_hash: str = ""  # SHA256 of data for tamper detection
    signature: str = ""  # Optional HMAC signature

    def to_dict(self) -> dict:
        return asdict(self)

    def to_file_payload(self) -> dict:
        """The on-disk format — includes hash for integrity."""
        return {
            "issue": self.issue,
            "type": self.type.value,
            "verified": self.verified,
            "created_at": self.created_at,
            "created_by": self.created_by,
            "data": self.data,
            "content_hash": self.content_hash,
        }


class EvidenceStore:
    """Read/write evidence markers for a specific issue."""

    def __init__(self, issue_num: int, evidence_dir: Path = EVIDENCE_DIR):
        self.issue_num = issue_num
        self.dir = evidence_dir / str(issue_num)
        self.dir.mkdir(parents=True, exist_ok=True)

    def path_for(self, evidence_type: EvidenceType) -> Path:
        return self.dir / f"{evidence_type.value}.json"

    def write(self, marker: EvidenceMarker) -> None:
        """Write evidence marker atomically."""
        if marker.issue != self.issue_num:
            raise ValueError(f"Marker issue {marker.issue} doesn't match store issue {self.issue_num}")
        # Compute content hash
        marker.content_hash = self._compute_hash(marker.data)
        path = self.path_for(marker.type)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(marker.to_file_payload(), indent=2))
        tmp.rename(path)

    def read(self, evidence_type: EvidenceType) -> EvidenceMarker | None:
        """Read evidence marker, or None if not present."""
        path = self.path_for(evidence_type)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text())
            return EvidenceMarker(
                issue=data["issue"],
                type=EvidenceType(data["type"]),
                verified=data["verified"],
                created_at=data["created_at"],
                created_by=data["created_by"],
                data=data["data"],
                content_hash=data.get("content_hash", ""),
            )
        except (json.JSONDecodeError, KeyError, ValueError) as e:
            # Corrupt file
            return None

    def check(self, required: list[EvidenceType]) -> tuple[bool, list[EvidenceType]]:
        """Check if all required evidence markers exist and are verified."""
        missing = []
        for etype in required:
            marker = self.read(etype)
            if marker is None or not marker.verified:
                missing.append(etype)
        return (len(missing) == 0, missing)

    def _compute_hash(self, data: dict) -> str:
        """SHA256 of canonical JSON."""
        canonical = json.dumps(data, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode()).hexdigest()


def make_tested_marker(issue: int, command: str, exit_code: int, tests_run: int, tests_passed: int, created_by: str = "test_runner_phase") -> EvidenceMarker:
    return EvidenceMarker(
        issue=issue,
        type=EvidenceType.TESTED,
        verified=(exit_code == 0 and tests_passed == tests_run),
        created_at=now_iso(),
        created_by=created_by,
        data={
            "command": command,
            "exit_code": exit_code,
            "tests_run": tests_run,
            "tests_passed": tests_passed,
            "tests_failed": tests_run - tests_passed,
        },
    )


def make_reviewed_marker(issue: int, critical_issues: int, non_blocking_issues: int, reviewer: str, created_by: str = "human") -> EvidenceMarker:
    return EvidenceMarker(
        issue=issue,
        type=EvidenceType.REVIEWED,
        verified=(critical_issues == 0),
        created_at=now_iso(),
        created_by=created_by,
        data={
            "critical_issues": critical_issues,
            "non_blocking_issues": non_blocking_issues,
            "reviewer": reviewer,
        },
    )


def make_manual_tested_marker(issue: int, scenario: str, screenshot_before: str, screenshot_after: str, verified_by: str = "playwright") -> EvidenceMarker:
    return EvidenceMarker(
        issue=issue,
        type=EvidenceType.MANUAL_TESTED,
        verified=True,  # Screenshots are evidence enough
        created_at=now_iso(),
        created_by="manual_tested_phase",
        data={
            "scenario": scenario,
            "screenshot_before": screenshot_before,
            "screenshot_after": screenshot_after,
            "verified_by": verified_by,
        },
    )


def now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
```

### New CLI Commands: `maestro mark-*`

```python
# maestro/commands/evidence.py
import click
import json
import subprocess
from pathlib import Path
from lib.evidence import (
    EvidenceStore, EvidenceType,
    make_tested_marker, make_reviewed_marker, make_manual_tested_marker,
)


@click.group()
def evidence():
    """Manage evidence markers for issues."""
    pass


@evidence.command()
@click.argument("issue_num", type=int)
@click.option("--command", required=True, help="Test command that was run")
@click.option("--output-file", type=click.Path(exists=True), help="File containing test output")
@click.option("--tests-run", type=int, required=True)
@click.option("--tests-passed", type=int, required=True)
@click.option("--exit-code", type=int, required=True)
def mark_tested(issue_num, command, output_file, tests_run, tests_passed, exit_code):
    """Mark an issue as having passed automated tests."""
    marker = make_tested_marker(
        issue=issue_num,
        command=command,
        exit_code=exit_code,
        tests_run=tests_run,
        tests_passed=tests_passed,
    )
    EvidenceStore(issue_num).write(marker)
    click.echo(f"✓ Wrote tested evidence for issue #{issue_num} ({tests_passed}/{tests_run} passed)")


@evidence.command()
@click.argument("issue_num", type=int)
@click.option("--critical", type=int, default=0, help="Number of critical issues")
@click.option("--non-blocking", type=int, default=0, help="Number of non-blocking issues")
@click.option("--reviewer", default="human", help="Reviewer identifier")
def mark_reviewed(issue_num, critical, non_blocking, reviewer):
    """Mark an issue as having been reviewed."""
    marker = make_reviewed_marker(
        issue=issue_num,
        critical_issues=critical,
        non_blocking_issues=non_blocking,
        reviewer=reviewer,
    )
    EvidenceStore(issue_num).write(marker)
    click.echo(f"✓ Wrote reviewed evidence for issue #{issue_num} (critical: {critical}, non-blocking: {non_blocking})")


@evidence.command()
@click.argument("issue_num", type=int)
@click.option("--scenario", required=True, help="User-facing scenario verified")
@click.option("--screenshot-before", type=click.Path(exists=True))
@click.option("--screenshot-after", type=click.Path(exists=True))
@click.option("--verified-by", default="playwright", help="Verification method")
def mark_manual_tested(issue_num, scenario, screenshot_before, screenshot_after, verified_by):
    """Mark an issue as having been manually verified (e.g., via Playwright)."""
    marker = make_manual_tested_marker(
        issue=issue_num,
        scenario=scenario,
        screenshot_before=screenshot_before or "",
        screenshot_after=screenshot_after or "",
        verified_by=verified_by,
    )
    EvidenceStore(issue_num).write(marker)
    click.echo(f"✓ Wrote manual-tested evidence for issue #{issue_num} (scenario: {scenario})")


@evidence.command()
@click.argument("issue_num", type=int)
@click.option("--required", multiple=True, type=click.Choice(["tested", "manual_tested", "reviewed"]), help="Required evidence types")
def check(issue_num, required):
    """Check if all required evidence markers exist for an issue."""
    if not required:
        required = ["tested", "reviewed"]  # default for PR flows
    required_types = [EvidenceType(r) for r in required]
    ok, missing = EvidenceStore(issue_num).check(required_types)
    if ok:
        click.echo(f"✓ All required evidence present for issue #{issue_num}")
    else:
        click.echo(f"✗ Missing evidence for issue #{issue_num}: {[m.value for m in missing]}")
        raise click.exceptions.Exit(1)


@evidence.command()
@click.argument("issue_num", type=int)
def show(issue_num):
    """Show all evidence markers for an issue."""
    store = EvidenceStore(issue_num)
    for etype in EvidenceType:
        marker = store.read(etype)
        if marker:
            status = "✓" if marker.verified else "✗"
            click.echo(f"{status} {etype.value} (verified={marker.verified}, by={marker.created_by}, at={marker.created_at})")
            click.echo(f"  {json.dumps(marker.data, indent=2)}")
        else:
            click.echo(f"  {etype.value}: (missing)")
```

### Updated: `flows/builder-reviewer.json` — Add Evidence Policy

```json
{
  "name": "builder-reviewer",
  "scout_enabled": true,
  "evidence_policy": {
    "required_on_success": ["tested", "reviewed"],
    "on_missing_evidence": "warn_but_proceed"  // "block" | "warn_but_proceed" | "ignore"
  },
  "phases": {
    "scout": { ... },
    "builder": { ... },
    "test_runner": {
      "skill": "/skill:test_runner",
      "timeout_seconds": 600,
      "retries": 1,
      "on_success_evidence": "tested"  // This phase writes tested.json
    },
    "reviewer": {
      "skill": "/skill:reviewer",
      "timeout_seconds": 1200,
      "retries": 2
    },
    "close": {
      "skill": "/skill:close",
      "is_local": true,
      "command": "python3 -m maestro.commands.evidence check {issue_num}",
      "timeout_seconds": 30
    }
  },
  "transitions": [
    { "from": "scout", "on_success": "builder", "on_error": "builder", "on_reject": "builder" },
    { "from": "builder", "on_success": "test_runner", "on_reject": "builder", "on_error": "diagnostic" },
    { "from": "test_runner", "on_success": "reviewer", "on_reject": "builder", "on_error": "diagnostic" },
    { "from": "reviewer", "on_success": "close", "on_reject": "builder", "on_error": "diagnostic" },
    { "from": "close", "on_success": "finish", "on_error": "diagnostic", "on_reject": "diagnostic" },
    { "from": "diagnostic", "on_success": "builder", "on_reject": "finish", "on_error": "finish" }
  ]
}
```

### New Phase Type: `is_local: true` with `command`

Already supported in Maestro (the existing `test_runner` is local). The new `close` phase uses this to invoke the evidence check command. If the command exits non-zero, the phase routes to `diagnostic` instead of `finish`.

### Updated: `flow_engine.py` — Evidence-Aware Closer

```python
# flow_engine.py — new close phase handler
def run_close_phase(phase_name: str, phase_config: dict, issue_num: int, context: dict) -> dict:
    """Run a close phase, which mechanically checks evidence gates."""
    from lib.evidence import EvidenceStore, EvidenceType
    from flow_config import get_evidence_policy

    policy = get_evidence_policy(phase_config)  # reads evidence_policy from flow
    required = [EvidenceType(t) for t in policy.get("required_on_success", [])]
    on_missing = policy.get("on_missing_evidence", "warn_but_proceed")

    ok, missing = EvidenceStore(issue_num).check(required)

    if ok:
        return {"status": "success", "details": f"All evidence present: {[e.value for e in required]}"}

    if on_missing == "block":
        return {"status": "rejected", "details": f"Missing evidence: {[m.value for m in missing]}"}
    elif on_missing == "warn_but_proceed":
        log(f"[WARN] Missing evidence for issue #{issue_num}: {[m.value for m in missing]}")
        log("[WARN] Proceeding with LLM verdict as fallback (not recommended for production)")
        return {"status": "success", "details": f"Missing evidence (warned): {[m.value for m in missing]}"}
    else:  # ignore
        return {"status": "success", "details": "Evidence check skipped (policy: ignore)"}
```

### Updated: `prompts/test_runner.md` — Auto-Write Evidence

```markdown
---
name: test_runner
description: Runs the project's test command and records results.
tools: ['Read', 'Bash']
---

# Test Runner

You run the test command for issue #{issue_number} and record the results.

## Workflow

1. Identify the test command from the prefetched context: {prefetched_context}
2. Run the test command: `{test_command}`
3. Parse the output to count tests_run, tests_passed, tests_failed
4. After the run, write the evidence file:

```bash
maestro mark-tested {issue_number} \
  --command "{test_command}" \
  --tests-run $TESTS_RUN \
  --tests-passed $TESTS_PASSED \
  --exit-code $EXIT_CODE
```

5. Output PHASE_OUTPUT with test results
```

### New Prompt: `prompts/close.md`

```markdown
---
name: close
description: Mechanical close phase — checks evidence gates before allowing success.
tools: []
---

# Close — Evidence Gate Verification

This phase runs AFTER the reviewer approves. It mechanically checks that all required evidence markers exist before allowing the flow to finish.

## What This Phase Does

This phase does not run an LLM. It runs a local command:

```bash
python3 -m maestro.commands.evidence check {issue_number} --required tested --required reviewed
```

If the command exits 0, the phase succeeds (all evidence present). If it exits non-zero, the phase is rejected and the flow routes to `diagnostic` to investigate why evidence is missing.

## Why This Phase Exists

LLM-judged approval ("looks good!") is not auditable. Evidence-based approval ("tested.json shows 47/47 passed, reviewed.json shows 0 critical issues") is auditable. This phase enforces the latter.
```

### Tamper-Evidence: Content Hash

Each evidence file includes a SHA256 hash of its `data` field. The `EvidenceStore.read()` method recomputes the hash and warns (or fails) if it doesn't match.

```python
# lib/evidence.py — tamper detection in read()
def read(self, evidence_type: EvidenceType) -> EvidenceMarker | None:
    path = self.path_for(evidence_type)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        marker = EvidenceMarker(...)
        # Verify hash
        expected_hash = self._compute_hash(marker.data)
        if marker.content_hash and marker.content_hash != expected_hash:
            log(f"[EVIDENCE] Tamper detected in {path}: hash mismatch")
            marker.verified = False  # Mark as unverified on hash mismatch
        return marker
    except (json.JSONDecodeError, KeyError, ValueError) as e:
        return None
```

## Testing Decisions

### Unit Tests

**`tests/test_evidence.py`** (new, ~14 tests):
- `test_write_creates_file_with_hash`
- `test_write_is_atomic_uses_tmp_rename`
- `test_read_returns_none_for_missing_file`
- `test_read_parses_existing_marker`
- `test_read_detects_tampered_hash`
- `test_read_handles_corrupt_json`
- `test_check_returns_true_when_all_present`
- `test_check_returns_false_when_any_missing`
- `test_check_returns_false_when_unverified`
- `test_make_tested_marker_verified_when_all_pass`
- `test_make_tested_marker_unverified_when_exit_nonzero`
- `test_make_tested_marker_unverified_when_tests_failed`
- `test_make_reviewed_marker_verified_when_zero_critical`
- `test_make_reviewed_marker_unverified_when_critical_nonzero`

**`tests/test_flow_evidence.py`** (new, ~6 tests):
- `test_close_phase_succeeds_when_evidence_present`
- `test_close_phase_rejected_when_evidence_missing_with_block_policy`
- `test_close_phase_warns_when_missing_with_warn_policy`
- `test_close_phase_skips_check_with_ignore_policy`
- `test_test_runner_phase_auto_writes_evidence`
- `test_evidence_survives_across_flow_restart`

### Integration Tests

**`tests/test_integration_evidence_gates.py`** (new, ~4 tests):
- `test_end_to_end_pr_flow_with_evidence` — full flow with test_runner + reviewer + close
- `test_close_blocks_when_no_test_runner_phase`
- `test_evidence_mismatch_causes_diagnostic_phase`
- `test_evidence_visible_in_retrospective` (depends on Retrospective PRD)

### Manual Verification

- [ ] Run a builder-reviewer flow on a real issue; verify `.maestro/evidence/<issue>/tested.json` is created
- [ ] Run `maestro evidence show 42`; verify all markers display
- [ ] Manually tamper with a marker file (change a value); verify `read()` detects the mismatch
- [ ] Run a flow without test_runner phase; verify close phase rejects with "missing evidence: tested"
- [ ] Set `on_missing_evidence: "warn_but_proceed"`; verify flow succeeds with warning
- [ ] Run `maestro evidence check 42 --required tested --required reviewed`; verify exit code is 0/1 correctly

### Prior Art

- **Case:** `src/commands/mark-tested.ts` — writes `tested` marker from test output
- **Case:** `src/commands/mark-reviewed.ts` — writes `reviewed` marker with critical issue count
- **Case:** `src/commands/mark-manual-tested.ts` — writes `manual-tested` marker from screenshots
- **Case:** `src/phases/close.ts` — checks evidence markers before opening PR
- **Case:** `docs/philosophy.md` — "Enforce mechanically, not rhetorically"
- **Maestro:** `lib/state_manager.py` — atomic write pattern (`.tmp` + rename)
- **Maestro:** `lib/github_client.py` — CLI command pattern

## Out of Scope

- **HMAC signatures** — case supports `signature` field on markers for HMAC signing. We compute a content hash but don't sign with a key. Could add later.
- **Multi-repo evidence** — evidence files are per-issue, not per-repo. If we work across multiple repos, we'd need to namespace by repo.
- **Evidence expiration** — markers are valid forever. Could add TTL (e.g., `tested` expires in 7 days).
- **Automatic evidence from CI** — could integrate with GitHub Actions to auto-write `tested.json` on CI success. Deferred to a separate PRD.
- **Evidence summary in PR description** — could generate a markdown table for PR descriptions. Not in this PRD.
- **Custom evidence types** — the enum is closed (`tested`, `manual_tested`, `reviewed`). Could be extended to a registry. Defer.

## Further Notes

### Why is this a gate, not a wall?

Case's design is that evidence is *required* for success. If you don't have evidence, you can't open a PR. We soften this with `on_missing_evidence` policy:

- `block` (Case's default): missing evidence → reject, route to diagnostic
- `warn_but_proceed` (Maestro's softer default): missing evidence → warn, succeed anyway
- `ignore` (escape hatch): skip the check entirely

This is intentional. Maestro is used for both PR flows and non-PR flows (PRD audits, gap-checks). The default policy is `warn_but_proceed` for backward compatibility. PR flows should be configured with `block`.

### Why SHA256 content hash, not HMAC?

Content hash detects **tampering** (someone modified the file). HMAC detects **forgery** (someone created a fake file without the secret). The threat model for evidence is "did the agent lie about test results?" — both attacks are possible, but HMAC requires key management. For now, content hash is sufficient: if an agent forges evidence, the file will be inconsistent with the actual test run, and the human reviewer can compare.

If we want stronger guarantees, we can add HMAC later with a key stored in `~/.maestro/secret.key`.

### Why is `close` a separate phase, not a hook?

In Case, `close` is a phase with its own agent (writes the PR). In Maestro, `close` is a local command (checks evidence + posts success comment). This separation lets us:
- Test the evidence check independently
- Swap out the closer behavior without changing the rest of the flow
- Add more local-only phases in the future (e.g., `update_memory` after close)

## Acceptance Criteria

- [ ] `lib/evidence.py` exists with `EvidenceStore`, `EvidenceMarker`, and marker factories
- [ ] CLI commands: `maestro mark-tested`, `maestro mark-manual-tested`, `maestro mark-reviewed`, `maestro evidence check`, `maestro evidence show`
- [ ] Evidence files written to `.maestro/evidence/<issue>/` with content hash
- [ ] Tamper detection: hash mismatch marks marker as unverified
- [ ] `flows/builder-reviewer.json` includes evidence policy (`required_on_success`, `on_missing_evidence`)
- [ ] New `close` phase mechanically checks evidence before success
- [ ] `test_runner` phase auto-writes `tested.json` from test output
- [ ] Per-flow policy: `block` (strict), `warn_but_proceed` (default), `ignore` (escape hatch)
- [ ] New tests: `test_evidence.py` (14), `test_flow_evidence.py` (6), `test_integration_evidence_gates.py` (4)
- [ ] All existing tests pass
- [ ] Manual verification on at least 2 real PR flows demonstrates the new behavior
- [ ] Documentation: `README.md` updated with evidence gates documentation

## References

### Case
- `src/commands/mark-tested.ts` — `ca mark-tested` from test output
- `src/commands/mark-reviewed.ts` — `ca mark-reviewed --critical 0`
- `src/commands/mark-manual-tested.ts` — `ca mark-manual-tested` from screenshots
- `src/phases/close.ts` — `closer` phase checks evidence markers
- `agents/closer.md` — closer agent definition
- `docs/philosophy.md` — "Enforce mechanically, not rhetorically"
- `README.md` — "Evidence markers live under the target repo's `.case/<task-slug>/`"

### Maestro
- `lib/state_manager.py` — atomic write pattern (`.tmp` + rename)
- `lib/github_client.py` — `GithubClient` for posting comments
- `flows/builder-reviewer.json` — to be updated with evidence policy
- `tests/test_flow_engine.py` — example of flow execution tests
- `prompts/test_runner.tmpl` — to be updated to auto-write evidence
- `lib/verdict_extractor.py` — existing verdict extraction (LLM-based) — remains as fallback

### Related PRDs in this set
- [Tool Allowlists](maestro-tool-allowlists.md) — `close` phase has empty tools list
- [Working Memory](maestro-working-memory.md) — evidence events can be logged to working memory
- [Retrospective](maestro-retrospective.md) — retrospective reads evidence to inform learnings
- [Repo Onboarding](maestro-repo-onboarding.md) — onboarding declares default evidence strategy per repo
