# PRD: Retrospective Phase (Compounding Self-Improvement)

> **Wave:** 2 (Quality & Learning)
> **Effort:** 4-6 hours
> **Depends on:** [Working Memory](maestro-working-memory.md), [Evidence Gates](maestro-evidence-gates.md)
> **Required by:** nothing (terminal node in the dependency graph)
> **Roadmap:** [maestro-case-improvements-roadmap.md](maestro-case-improvements-roadmap.md#8-prds-in-this-set)

---

## Problem Statement

Maestro currently has a `diagnostic` phase that runs after errors — a one-shot debug pass. It does not **compound**. After 50 failed flows, the 51st flow has no memory that this type of failure has happened before, no documentation of the workaround, and no enforcement that the underlying issue has been fixed.

The **workos/case** project solves this with a **retrospective agent** that runs after every flow (success or failure) and:

1. Appends tactical repo learnings to `<target-repo>/.case/learnings.md`
2. Proposes broader harness changes in `docs/proposed-amendments/`
3. Escalates repeated failures into docs, playbooks, conventions, or enforcement

The retrospective output is intentionally constrained. "It should not expand the product surface by default. The fix for repeated agent failure is usually a clearer task, a better playbook, a sharper convention, or a mechanical guardrail."

This is the difference between **adapting to failures** and **learning from them**.

## Solution

Add a `retrospective` phase to Maestro that runs **after** any flow (success or failure) and:

1. Reads the full working memory for the issue
2. Identifies patterns: what worked, what failed, what was surprising
3. Appends a dated entry to `.maestro/learnings.md` in the target repo
4. Proposes amendments (rare) to `.maestro/proposed-amendments.md` if the pattern recurs ≥3 times
5. Fails gracefully — retrospective is **non-blocking** (a failed retrospective logs but does not fail the flow)

**Learnings file format (per-repo):**

```markdown
# Maestro Learnings — <repo-name>

## 2026-06-04 — Issue #42 (success)
- **What worked:** Scout identified `src/auth/session.ts` as the only file needing changes; builder completed in one pass
- **Repo-specific learning:** This repo uses `bun test` not `pnpm test` despite having a `package.json` — scout findings correctly identified this
- **Proposed harness change:** None

## 2026-06-04 — Issue #43 (failure: reviewer rejected 3 times)
- **What worked:** Scout identified relevant files correctly
- **What failed:** Builder ignored the "use snake_case for DB columns" convention; reviewer rejected 3 times for the same reason
- **Repo-specific learning:** When changing DB schemas, scout must also check the `migrations/` directory for column name conventions
- **Proposed harness change:** Add a "convention enforcement" scout section that greps for similar patterns in the codebase
```

**Amendment proposal format (rare):**

```markdown
# Proposed Maestro Amendments

## 2026-06-04 — Recurring Failure: "Builder ignores type hints in TypeScript"
- **Occurrences:** 5 across 3 repos
- **Root cause:** Builder prompt doesn't emphasize TypeScript types
- **Proposed fix:** Add a "TypeScript: be precise with types" line to `prompts/builder.md` when the target repo is TS
- **Effort:** 1 hour
- **Owner:** (unassigned)
```

## User Stories

1. As a Maestro operator, I want every flow to produce a learning entry, so that I can review what worked and what failed across runs
2. As a Maestro operator, I want learnings to be persisted per-repo, so that each repo accumulates its own context
3. As a Maestro operator, I want amendments to be proposed (not auto-applied) when patterns recur, so that I can review and approve harness changes
4. As a Maestro operator, I want retrospective to be non-blocking, so that a failed retrospective doesn't break the flow
5. As a Maestro operator, I want a `maestro patterns` command that scans all repos' learnings files, so that I can identify systemic issues
6. As a Maestro operator, I want retrospective to read working memory, evidence files, and session logs, so that it has full context
7. As a Maestro operator, I want retrospective output to be constrained, so that it doesn't expand the product surface or propose features
8. As a Maestro developer, I want retrospective to be a separate phase (not a hook), so that I can disable it per flow
9. As a Maestro operator, I want retrospective to detect recurring failures (same root cause ≥3 times), so that amendments are data-driven
10. As a Maestro operator, I want a `maestro learnings show <repo>` command, so that I can inspect any repo's accumulated learnings

## Implementation Decisions

### New Prompt: `prompts/retrospective.md`

```markdown
---
name: retrospective
description: Self-improvement agent. Runs after every flow to extract learnings and propose amendments. Read-only on code; write-only on .maestro/learnings.md.
tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob']
timeout_seconds: 300
---

# Retrospective — Self-Improvement Agent

You run AFTER every flow completes (success or failure). Your job is to extract learnings and append them to the target repo's `.maestro/learnings.md`.

## Input

You receive from the orchestrator:
- **Issue number:** #{issue_number}
- **Flow name:** {flow_name}
- **Final status:** {final_status} (success | rejected | error)
- **Working memory:** {working_memory_json}
- **Evidence files:** {evidence_summary}
- **Target repo path:** {repo_path}

## Workflow

### 1. Read the full task history (1 min budget)

Read the working memory for this issue. Identify:
- What phases ran
- What files were touched
- What tests were run and their results
- What errors occurred
- What evidence was produced

### 2. Identify patterns (2 min budget)

Categorize what you observed:

- **What worked:** Specific things that contributed to success (good scout, clear prompt, good test coverage, etc.)
- **What failed:** Specific things that contributed to failure (missed convention, ignored scout finding, broken test, etc.)
- **What was surprising:** Unexpected repo behavior, undocumented conventions, fragile tests

### 3. Extract repo-specific learnings (1 min budget)

A "repo-specific learning" is a fact about THIS repo that future runs would benefit from knowing. Examples:
- "This repo uses Bun despite having a `package.json` (not pnpm)"
- "The `auth/` directory has 12 files — scout should focus on `auth/index.ts` first"
- "`migrations/` column naming is snake_case, but the TS layer expects camelCase"

Only include learnings that are **generalizable** — facts that would help on a different issue, not just this one.

### 4. Check for recurring patterns (30 sec budget)

Read `.maestro/learnings.md` in the target repo. Count occurrences of similar failure patterns. If the same root cause has appeared **≥3 times**, propose an amendment (see step 5).

### 5. Emit output

Output a `PHASE_OUTPUT` block with structured learnings:

```
---
### PHASE_OUTPUT: success
{
  "outcome": "success",
  "what_worked": ["scout identified the right files", "builder followed the convention"],
  "what_failed": [],
  "surprising": [],
  "repo_specific_learnings": [
    "This repo uses bun, not pnpm"
  ],
  "proposed_amendments": []
}
### END_PHASE_OUTPUT
---
```

Or for failures:

```
---
### PHASE_OUTPUT: success
{
  "outcome": "failure",
  "failure_reason": "reviewer_rejected",
  "what_worked": ["scout was accurate"],
  "what_failed": ["builder ignored the snake_case convention"],
  "surprising": ["the convention is in CLAUDE.md but not in package.json"],
  "repo_specific_learnings": [
    "Check CLAUDE.md for conventions, not just package.json"
  ],
  "proposed_amendments": []
}
### END_PHASE_OUTPUT
---
```

**Note:** Even for failures, the phase output is `success` — the retrospective itself succeeded. The outcome of the parent flow is captured in `outcome: "failure"`.

### 6. Write to learnings file (after PHASE_OUTPUT)

After emitting the structured output, append to `.maestro/learnings.md` in the target repo:

```bash
# Format the entry
cat >> .maestro/learnings.md <<EOF
## $(date -u +%Y-%m-%d) — Issue #${issue_number} (${outcome})
- **What worked:** ${what_worked_joined}
- **What failed:** ${what_failed_joined}
- **Repo-specific learnings:** ${learnings_joined}
- **Proposed amendments:** ${amendments_joined}
EOF
```

**If `proposed_amendments` is non-empty**, ALSO append to `.maestro/proposed-amendments.md`:

```bash
cat >> .maestro/proposed-amendments.md <<EOF
## $(date -u +%Y-%m-%d) — Recurring: ${amendment_title}
- **Occurrences:** ${count}
- **Root cause:** ${root_cause}
- **Proposed fix:** ${proposed_fix}
- **Effort:** ${effort_estimate}
- **Owner:** (unassigned)
EOF
```

## Rules

- **DO NOT** modify any code file
- **DO NOT** propose features or new flows
- **DO NOT** expand the product surface
- **DO** focus on mechanical fixes, clearer prompts, sharper conventions, or guardrails
- **DO** keep the entry short (≤10 lines)
- If you have not produced output by minute 4, emit a minimal entry with `repo_specific_learnings: []`
```

### New Flow Addition: Append Retrospective to Existing Flows

```json
// flows/builder-reviewer.json — add retrospective at the end
{
  "phases": {
    "scout": { ... },
    "builder": { ... },
    "test_runner": { ... },
    "reviewer": { ... },
    "close": { ... },
    "retrospective": {
      "skill": "/skill:retrospective",
      "timeout_seconds": 300,
      "retries": 0,
      "is_optional": true
    }
  },
  "transitions": [
    ...
    { "from": "close", "on_success": "retrospective", "on_error": "retrospective", "on_reject": "retrospective" },
    { "from": "retrospective", "on_success": "finish", "on_error": "finish", "on_reject": "finish" }
  ]
}
```

**Key design:** Retrospective's transitions all route to `finish`, regardless of success/error. A failed retrospective is logged but does not fail the flow.

### New Module: `lib/learnings.py`

```python
# lib/learnings.py
from pathlib import Path
from datetime import datetime, timezone
import re
from collections import Counter

LEARNINGS_FILENAME = ".maestro/learnings.md"
AMENDMENTS_FILENAME = ".maestro/proposed-amendments.md"


def format_learning_entry(issue_num: int, outcome: str, retrospective_output: dict) -> str:
    """Format a retrospective output as a markdown entry."""
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    parts = [f"## {date} — Issue #{issue_num} ({outcome})", ""]

    if retrospective_output.get("what_worked"):
        parts.append("- **What worked:** " + "; ".join(retrospective_output["what_worked"]))
    if retrospective_output.get("what_failed"):
        parts.append("- **What failed:** " + "; ".join(retrospective_output["what_worked"]))
    if retrospective_output.get("surprising"):
        parts.append("- **Surprising:** " + "; ".join(retrospective_output["surprising"]))
    if retrospective_output.get("repo_specific_learnings"):
        parts.append("- **Repo-specific learnings:** " + "; ".join(retrospective_output["repo_specific_learnings"]))
    if retrospective_output.get("proposed_amendments"):
        parts.append("- **Proposed amendments:** " + "; ".join(a["title"] for a in retrospective_output["proposed_amendments"]))
    parts.append("")
    return "\n".join(parts)


def append_to_learnings(repo_path: Path, entry: str) -> None:
    """Append a formatted entry to the repo's learnings file."""
    path = repo_path / LEARNINGS_FILENAME
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        # Initialize with header
        header = f"# Maestro Learnings — {repo_path.name}\n\nAccumulated learnings from Maestro runs. Each entry is a dated, scoped observation about this repo.\n\n"
        path.write_text(header)
    with path.open("a") as f:
        f.write(entry)


def count_recurring_patterns(repo_path: Path, current_failure: str) -> int:
    """Count how many times a similar failure pattern has appeared in learnings."""
    path = repo_path / LEARNINGS_FILENAME
    if not path.exists():
        return 0
    text = path.read_text()
    # Naive: count entries with similar keywords
    # Could use embedding similarity, but exact-match is simpler and good enough for v1
    keywords = set(re.findall(r"\b\w{4,}\b", current_failure.lower()))
    count = 0
    for entry in text.split("\n## "):
        entry_keywords = set(re.findall(r"\b\w{4,}\b", entry.lower()))
        if len(keywords & entry_keywords) >= 3:  # At least 3 keywords overlap
            count += 1
    return count


def scan_all_learnings(memory_dir: Path) -> dict:
    """Aggregate learnings across all repos for the `maestro patterns` command."""
    all_learnings = []
    for path in memory_dir.glob("**/.maestro/learnings.md"):
        repo = path.parent.parent.name
        text = path.read_text()
        for entry in text.split("\n## "):
            if entry.strip():
                all_learnings.append({"repo": repo, "entry": "## " + entry})
    return {
        "total_entries": len(all_learnings),
        "by_repo": Counter(l["repo"] for l in all_learnings),
        "recent": all_learnings[-10:],  # Last 10 entries
        "common_failures": _extract_common_failures(all_learnings),
    }


def _extract_common_failures(learnings: list[dict]) -> list[dict]:
    """Find failure patterns that appear across multiple repos."""
    failure_keywords = Counter()
    for l in learnings:
        if "(failure" in l["entry"] or "(rejected" in l["entry"] or "(error" in l["entry"]:
            keywords = re.findall(r"\b\w{5,}\b", l["entry"].lower())
            failure_keywords.update(keywords)
    # Filter to keywords that appear in ≥3 entries (rough heuristic)
    return [{"keyword": k, "count": c} for k, c in failure_keywords.most_common(20)]
```

### New CLI Commands

```python
# maestro/commands/retrospective.py
import click
from pathlib import Path
from lib.learnings import scan_all_learnings


@click.group()
def retrospective():
    """Manage retrospectives and learnings."""
    pass


@retrospective.command()
@click.argument("issue_num", type=int)
@click.option("--repo-path", type=click.Path(exists=True), default=".")
def run(issue_num, repo_path):
    """Manually run a retrospective for a past issue (re-process working memory)."""
    # Implementation: re-read working memory, run retrospective prompt, write to learnings
    ...


@retrospective.command(name="show")
@click.argument("repo", type=str)
def show_learnings(repo):
    """Show learnings for a specific repo."""
    path = Path(repo) / ".maestro/learnings.md"
    if not path.exists():
        click.echo(f"No learnings file for {repo}")
        return
    click.echo(path.read_text())


@retrospective.command()
def patterns():
    """Scan all repos for recurring patterns."""
    memory_dir = Path(".maestro")
    result = scan_all_learnings(memory_dir)
    click.echo(f"Total entries: {result['total_entries']}")
    click.echo("\nBy repo:")
    for repo, count in result['by_repo'].most_common():
        click.echo(f"  {repo}: {count}")
    click.echo("\nCommon failure keywords:")
    for kw in result['common_failures'][:10]:
        click.echo(f"  {kw['keyword']}: {kw['count']}")
    click.echo("\nRecent entries:")
    for entry in result['recent'][:5]:
        click.echo(f"  [{entry['repo']}] {entry['entry'][:200]}...")


@retrospective.command()
@click.argument("repo", type=str)
def amendments(repo):
    """Show proposed amendments for a repo."""
    path = Path(repo) / ".maestro/proposed-amendments.md"
    if not path.exists():
        click.echo(f"No amendments for {repo}")
        return
    click.echo(path.read_text())
```

### Updated: `flow_engine.py` — Non-Blocking Retrospective

```python
# flow_engine.py — retrospective phase handling
def run_phase(phase_name, phase_config, flow_config, issue_num, context):
    """Run a phase, with special handling for retrospective."""
    ...
    if phase_config.get("is_optional") and phase_name == "retrospective":
        # Retrospective is non-blocking: wrap in try/except
        try:
            result = _run_phase_inner(phase_name, phase_config, flow_config, issue_num, context)
            return result
        except Exception as e:
            log(f"[retrospective] Failed (non-fatal): {e}")
            return {"status": "success", "details": f"Retrospective failed (logged): {e}"}
    else:
        return _run_phase_inner(phase_name, phase_config, flow_config, issue_num, context)
```

## Testing Decisions

### Unit Tests

**`tests/test_learnings.py`** (new, ~10 tests):
- `test_format_learning_entry_includes_all_sections`
- `test_format_learning_entry_handles_empty_fields`
- `test_append_to_learnings_creates_file_with_header`
- `test_append_to_learnings_appends_to_existing_file`
- `test_count_recurring_patterns_returns_zero_for_new_repo`
- `test_count_recurring_patterns_detects_similar_failures`
- `test_scan_all_learnings_aggregates_across_repos`
- `test_extract_common_failures_finds_recurring_keywords`
- `test_atomic_write_pattern_preserves_existing_content`
- `test_learnings_file_format_is_valid_markdown`

**`tests/test_retrospective_phase.py`** (new, ~6 tests):
- `test_retrospective_runs_after_close`
- `test_retrospective_failure_routes_to_finish_not_diagnostic`
- `test_retrospective_writes_to_learnings_file`
- `test_retrospective_proposes_amendment_after_3_occurrences`
- `test_retrospective_skipped_when_disabled_in_flow`
- `test_retrospective_output_structured_as_phase_output`

### Integration Tests

**`tests/test_integration_retrospective.py`** (new, ~4 tests):
- `test_end_to_end_flow_with_retrospective` — full flow including retrospective
- `test_retrospective_persists_across_flow_restart` — kill mid-flow, restart, retrospective picks up
- `test_patterns_command_finds_recurring_issues` — run flow 3 times with same failure, verify patterns surfaces it
- `test_amendments_visible_in_amendments_command`

### Manual Verification

- [ ] Run a builder-reviewer flow on a real issue; verify `.maestro/learnings.md` is created with an entry
- [ ] Run `maestro retrospective show .`; verify the entry is readable
- [ ] Manually induce the same failure 3 times; verify a proposed amendment is created
- [ ] Run `maestro retrospective patterns`; verify it aggregates across repos
- [ ] Kill a retrospective mid-run; verify the flow still completes (non-blocking)

### Prior Art

- **Case:** `agents/retrospective.md` — full retrospective agent (227 lines)
- **Case:** `src/phases/retrospective.ts` — retrospective phase execution
- **Case:** `docs/proposed-amendments/README.md` — amendment workflow
- **Case:** `docs/learnings/` — per-target-repo learnings files
- **Case:** `improvements.md` — 60-item improvement list with citations
- **Maestro:** `prompts/diagnostic.tmpl` — existing one-shot debug prompt (inspiration, not replacement)
- **Maestro:** `lib/working_memory.py` (from [Working Memory PRD](maestro-working-memory.md)) — source of retrospective input

## Out of Scope

- **Auto-applying amendments** — amendments are proposals only. A human reviews and decides whether to apply. Auto-applying is dangerous (could change prompts based on spurious patterns).
- **Embedding-based similarity for recurring patterns** — current implementation uses keyword overlap. Embedding-based would be more accurate but adds a dependency. Defer.
- **Cross-repo amendment deduplication** — if the same amendment is proposed for 5 repos, we create 5 entries. Could deduplicate. Defer.
- **Real-time learning surfacing** — `maestro patterns` is a manual command. Could be a hook that runs daily and posts to GitHub. Defer.
- **Amendment voting** — multiple humans could vote on amendments. Not needed for personal use.
- **Amendment versioning** — if an amendment is applied, the old prompt is versioned. Defer.

## Further Notes

### Why is retrospective non-blocking?

A failed retrospective should not break the flow. The whole point of retrospective is to **compound learnings** — if a learning is missed, the next retrospective can still extract it. Failing the flow would punish the user for retrospective bugs.

This is a deliberate divergence from Case, where retrospective is more tightly integrated. Case has the same philosophy ("the fix for repeated agent failure is usually a clearer task"), but their retrospective is expected to succeed. For Maestro's personal-use context, non-blocking is safer.

### Why per-repo learnings, not global?

Each repo has its own conventions, patterns, and gotchas. A global learnings file would mix them. Per-repo is also easier to commit (each repo's `.maestro/learnings.md` can be version-controlled alongside the code).

### Why keyword-based recurrence detection, not embedding-based?

Embedding-based would be more accurate (catches semantic similarity). Keyword-based is simpler, has no dependencies, and is "good enough" for v1. If the keyword approach produces too many false positives, we can upgrade.

### Why are amendments proposed, not auto-applied?

Auto-applying changes to `prompts/builder.md` based on observed patterns is **dangerous**:
- The pattern might be spurious (a one-time failure that recurred by chance)
- The fix might have unintended side effects
- The user might disagree with the proposed fix

Humans must approve. Case has the same philosophy: "Retrospective output is constrained. It should not expand the product surface by default."

## Acceptance Criteria

- [ ] `prompts/retrospective.md` exists with read+write tools
- [ ] All flows that previously had `close → finish` now have `close → retrospective → finish`
- [ ] `lib/learnings.py` exists with formatting, appending, and pattern scanning
- [ ] `.maestro/learnings.md` is created on first retrospective run (per-repo)
- [ ] `.maestro/proposed-amendments.md` is created when a pattern recurs ≥3 times
- [ ] Retrospective is non-blocking (failures log but don't fail the flow)
- [ ] CLI commands: `maestro retrospective show <repo>`, `maestro retrospective patterns`, `maestro retrospective amendments <repo>`
- [ ] New tests: `test_learnings.py` (10), `test_retrospective_phase.py` (6), `test_integration_retrospective.py` (4)
- [ ] All existing tests pass
- [ ] Manual verification: run 3 flows with the same failure; verify amendment is proposed
- [ ] Documentation: `README.md` updated with retrospective documentation

## References

### Case
- `agents/retrospective.md` — full retrospective agent definition
- `src/phases/retrospective.ts` — phase execution
- `docs/proposed-amendments/README.md` — amendment workflow
- `docs/learnings/README.md` — per-repo learnings pattern
- `improvements.md` — 60-item improvement list with prioritization
- `docs/philosophy.md` — "After a run, the retrospective agent should leave the harness smarter"

### Maestro
- `prompts/diagnostic.tmpl` — existing one-shot debug (inspiration, different scope)
- `lib/working_memory.py` (new) — source of retrospective input
- `lib/evidence.py` (new, see [Evidence Gates PRD](maestro-evidence-gates.md)) — evidence summary is part of retrospective context
- `flow_engine.py:run_phase()` — to be extended for non-blocking retrospective handling
- `tests/test_run_single_flow.py` — example of end-to-end flow tests

### Related PRDs in this set
- [Working Memory](maestro-working-memory.md) — retrospective reads the full memory
- [Evidence Gates](maestro-evidence-gates.md) — retrospective references evidence in its output
- [Repo Onboarding](maestro-repo-onboarding.md) — onboarding seeds initial learnings file
- [Playbooks](maestro-playbooks.md) — amendments can propose new playbook entries
