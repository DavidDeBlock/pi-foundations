# PRD: Deepen the Flow Engine — Layer Separation, Structured Logging, Token Observability

> **Type:** Refactor (architecture deepening)
> **Effort:** 1-2 days
> **Depends on:** nothing (refactor of existing code)
> **Required by:** [DAG Support](maestro-dag-support.md) (Wave 3) — `depends_on` needs a clean runner interface; [Playbooks](maestro-playbooks.md) — playbook context is a `FlowContext` extension
> **Roadmap:** [maestro-case-improvements-roadmap.md](maestro-case-improvements-roadmap.md)
> **Origin:** Grilling session 2026-06-15 — separating the "layer above that chains flows" from the "runner that runs one flow on one issue"

---

## Problem Statement

`flow_engine.py` is **1,591 lines** and has become a kitchen sink. It started as a phase-loop runner (per the README: "phase loop with per-phase retry counters, phase transitions, tool allowlists + evidence policies"). Over the Wave 1 + Wave 2 rollout (working memory, evidence gates, repo onboarding, retrospective, scout), every new concern wired *into* `flow_engine.py` instead of into a module that owns the concern. The function `run_flow_on_issue` (line 1258) is now a 9-argument god-function whose first 180 lines are *setup* (load issue, fetch parent PRD, load working memory, prefetch context, persist git SHA, load repo context, run scout) before the actual phase loop starts.

Three concrete consequences:

1. **Locality is broken.** Change the evidence policy default → `flow_engine.py` diff. Change scout behavior → `flow_engine.py` diff. Bug in the retro context builder hides behind a flow-engine test surface. Nothing concentrates.

2. **The layer above is implicit.** The original design intent — "the flow engine regulates one flow; the layer above chains flows" (per the user's grilling-session restatement) — is hidden. Pipelines (`pipelines/autonomous.py`, `pipelines/full-lifecycle.py`) call `run_flow_on_issue` directly and re-implement the context-building steps the runner already does. There is no named concept of "give a flow what it needs to know about an issue" (the `FlowContext`).

3. **Operator diagnostics are mixed into the user interface.** ~15 `print(... file=sys.stderr)` calls are scattered through `flow_engine.py` for operator debugging ("[memory] Failed to load working memory for #N", "[onboard] Loaded context for alias='X'"). They pollute terminal output and aren't structured for log analysis. There is no way to ask "what happened during the last run?" without re-parsing the session log.

A secondary issue: the runner already has *most* of the data for per-phase observability (phase duration comes from the session log; the JSONL schema carries `message.usage` with `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens` fields). None of it is surfaced to the caller — the dashboard and the autonomous loop can't see it without re-parsing session logs themselves.

## Solution

Five concrete changes, each independently buildable:

1. **Introduce value objects** for the things that already have a name in the code: `Flow`, `FlowContext`, `PhaseState`, `PhaseRun`, `FlowOutcome`, `FlowEvent`. Replace the loose `flow_config: dict` and `context: dict` with typed values.

2. **Extract modules from `flow_engine.py`** along their natural seams: `phase_runner.py` (the per-phase function), `prompt_assembler.py` (the prompt builder), `diagnostic.py` (the diagnostic pass), `flow_dispatcher.py` (the context loader). Keep `flow_engine.py` as the loop and the value-object definitions.

3. **Introduce a `FlowLogger` port** with two adapters (`StderrLogger` for default behavior, `FileLogger` for `.maestro/logs/<flow>/<issue>.jsonl`). Replace the `print(..., file=sys.stderr)` calls with structured `FlowEvent` emissions. This is a real seam, not hypothetical — there is also a `ListLogger` test adapter.

4. **Plumb tokens through.** Add `extract_phase_usage(log_path) -> {input, output, cacheRead, cacheWrite, totalTokens, cost}` to `lib/session_reader.py`. Populate `PhaseRun.tokens_in` and `tokens_out` from it. The data is already in the JSONL; only the reader is missing.

5. **Narrow the public interface.** The new runner is `run_flow(flow, context, state, term, gh, log) -> FlowOutcome`. The old 6-arg `run_flow_on_issue(term, gh, flow_name, issue_num, ...)` becomes a thin shim. The 3 callers in `app_shell.py` and the pipelines layer migrate to the new shape. The shim dies.

Plus five small pre-amble cleanups (deleted in a single issue before the deepening starts):

- `dashboard_old.py` (15 KB) — orphaned, never referenced
- `run_prd_audit_loop` in `app_shell.py` (lines 200-228) — orphaned, never called
- `_extract_verdict_from_session` in `rpc_client.py` — pass-through wrapper around `verdict_extractor.extract_phase_verdict`
- `PHASE_OUTPUT_PATTERN` regex duplicated in `lib/comment_parser.py`, `lib/github_client.py`, `lib/verdict_extractor.py` — drift risk on the ADR-009 contract
- Duplicate `🔄 Entering Autonomous Loop Mode...` print in `app_shell.py` (lines 165-166 and 169-170) — in-progress refactor

## User Stories

1. As a Maestro operator, I want `flow_engine.py` to be small enough that I can read the whole thing, so that I can reason about the phase loop without scrolling for 1,500 lines.
2. As a Maestro developer, I want the "load everything a flow needs to know about an issue" concept to have a name (`FlowContext`), so that I can find all the setup code in one place.
3. As a Maestro dashboard developer, I want the runner to return a structured `FlowOutcome` with per-phase duration and tokens, so that I don't have to re-parse session logs to display this.
4. As a Maestro operator debugging a failed run, I want a JSONL log file at `.maestro/logs/<flow>/<issue>.jsonl` that captures every meaningful event, so that I can investigate "what happened" without re-running the flow.
5. As a pipeline script author (`pipelines/autonomous.py`, `pipelines/full-lifecycle.py`), I want to call `run_flow` with a `Flow` and a `FlowContext` and get a `FlowOutcome` back, so that I can chain flows on the basis of their outcomes.
6. As a test author, I want the runner's diagnostic output to go through a `FlowLogger` port with a `ListLogger` test adapter, so that tests can assert "the runner emitted a `phase_rejected` event for the reviewer phase" without string-matching stderr.
7. As a Maestro maintainer three months from now, I want the new `FlowContext` to be a value object (dataclass), not a dict, so that "what does a flow know" is a type-checked question.
8. As a Maestro operator, I want the cleanup of orphaned code (`dashboard_old.py`, `run_prd_audit_loop`) to happen *before* the deepening, so that we don't inherit the leftovers into the new design.

## Implementation Decisions

### Pre-amble Cleanup (5 small changes, one commit)

```bash
# 1. Delete orphaned dashboard prototype
rm .pi/maestro/dashboard_old.py

# 2. Delete orphaned PRD-audit loop in app_shell.py (lines 200-228)
# 3. Fix the duplicated "Autonomous Loop Mode" print (lines 165-166 and 169-170)

# 4. Inline the verdict-extraction wrapper in rpc_client.py
#    (delete _extract_verdict_from_session; call extract_phase_verdict directly)

# 5. Make github_client.py and verdict_extractor.py import
#    PHASE_OUTPUT_PATTERN from lib/comment_parser.py (the canonical home)
```

This is a single issue / single commit. Each cleanup is independent; the issue lists all five as a checklist.

### New Types (one module each, one issue)

All types live in their natural module. The value objects are the public interface; helpers are private.

```python
# flow_engine.py — the type definitions
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal


@dataclass(frozen=True)
class PhaseConfig:
    """One phase's config, post-validation, post-defaults."""
    name: str
    skill: str
    timeout_seconds: int
    retries: int
    is_local: bool
    is_optional: bool
    model: str | None
    provider: str | None
    command: str | None
    tools: tuple[str, ...]            # loaded from prompt frontmatter


@dataclass(frozen=True)
class Transition:
    """One transition rule from the flow config."""
    from_phase: str
    on_success: str | None            # target phase name or "finish"
    on_reject: str | None
    on_error: str | None
    on_no_gaps: str | None


@dataclass(frozen=True)
class Flow:
    """A flow config, validated and defaults applied. Immutable."""
    name: str
    description: str
    scout_enabled: bool
    evidence_policy: dict             # merged with defaults
    phases: dict[str, PhaseConfig]
    transitions: tuple[Transition, ...]


@dataclass(frozen=True)
class FlowContext:
    """Everything a flow needs to know about an issue at the START
    of execution. Static — loaded once per flow run."""
    flow: Flow
    issue_num: int
    issue_body: str
    issue_title: str
    parent_prd: str | None            # body of parent PRD if issue references one
    working_memory: "WorkingMemory"   # a view, not the store
    prefetched: "PrefetchedContext"
    repo_context: dict | None         # projects-registry entry, if onboarded
    scout_findings: "ScoutFindings | None"


@dataclass
class PhaseState:
    """The per-iteration state, mutated by the runner.
    NOT in FlowContext — this is dynamic."""
    current_phase: str
    phase_attempt: int = 1
    previous_output: str = ""
    diagnostic_insights: str = ""
    phase_outputs: dict[str, dict] = field(default_factory=dict)


@dataclass(frozen=True)
class PhaseRun:
    """A single phase attempt, returned in FlowOutcome.phases."""
    name: str
    attempt: int
    status: Literal["approved", "rejected", "no_gaps", "error", "skipped"]
    duration_s: float | None
    tokens_in: int | None
    tokens_out: int | None
    cache_read: int | None
    session_log: Path | None
    details: str


@dataclass(frozen=True)
class FlowOutcome:
    """The runner's return value. Captures the whole run."""
    flow_name: str
    issue_num: int
    status: Literal["success", "failed", "exhausted_iterations", "no_gaps"]
    iterations: int
    phases: tuple[PhaseRun, ...]      # per-attempt, in order
    events: tuple["FlowEvent", ...]   # all FlowLogger events
    total_duration_s: float
    evidence_summary: str | None
    retro_learning: str | None        # populated if retrospective phase ran
```

### Logger Port and Adapters (`flow_logger.py`)

```python
# flow_logger.py
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal, Protocol


@dataclass(frozen=True)
class FlowEvent:
    """A structured event emitted by the runner.
    The interface is the test surface — tests assert on these."""
    kind: Literal[
        "phase_start", "phase_end", "phase_retry",
        "phase_rejected", "phase_approved", "no_gaps",
        "diagnostic", "scout_complete", "scout_skipped",
        "memory_warn", "prefetch_warn", "onboard_warn", "evidence_warn",
    ]
    phase: str | None
    attempt: int | None
    duration_s: float | None
    tokens: dict | None
    message: str
    timestamp: str                    # ISO8601


class FlowLogger(Protocol):
    """The port. Anything that can receive a FlowEvent."""
    def emit(self, event: FlowEvent) -> None: ...


class StderrLogger:
    """Default — renders events as the current print(..., file=sys.stderr)
    lines, so terminal output is byte-identical to the pre-refactor CLI."""
    def emit(self, event: FlowEvent) -> None:
        prefix = f"[{event.phase}] " if event.phase else ""
        print(f"{prefix}{event.kind}: {event.message}", file=sys.stderr)
        sys.stderr.flush()


class FileLogger:
    """Append-only JSONL at .maestro/logs/<flow>/<issue>.jsonl.
    Use this when you want to investigate 'what happened' after a run."""
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, event: FlowEvent) -> None:
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(asdict(event)) + "\n")


class ListLogger:
    """In-memory collector. Test adapter — assertions on .events."""
    def __init__(self) -> None:
        self.events: list[FlowEvent] = []

    def emit(self, event: FlowEvent) -> None:
        self.events.append(event)
```

This is a real seam (production adapter + test adapter), not a hypothetical port. The current `print(... file=sys.stderr)` calls are the *previous* implementation of `StderrLogger`; the refactor makes them call `StderrLogger.emit` explicitly.

### Token Plumbing (`session_reader.py` extension)

```python
# lib/session_reader.py — add to existing file
def extract_phase_usage(log_path: str | Path) -> dict | None:
    """Extract token usage from the last assistant message in a session log.

    Returns:
        Dict with keys input, output, cacheRead, cacheWrite, totalTokens,
        cost.{input,output,cacheRead,cacheWrite,total}.
        None if the log is missing or has no usage data.
    """
    path = Path(log_path)
    if not path.exists():
        return None

    last_usage = None
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            message = event.get("message", {})
            if message.get("role") != "assistant":
                continue
            usage = message.get("usage")
            if isinstance(usage, dict):
                last_usage = usage  # keep the last; they're cumulative

    return last_usage
```

The runner calls this after `parse_session_log` (which it already calls) and populates `PhaseRun.tokens_in` (= `usage["input"] + usage["cacheWrite"]`), `tokens_out` (= `usage["output"]`), and `cache_read` (= `usage["cacheRead"]`). If the log is missing or has no usage data, the fields default to `None`.

### The Narrowed Runner Interface

```python
# flow_engine.py — the public interface
def run_flow(
    flow: Flow,
    context: FlowContext,
    state: PhaseState,
    term: Terminal,
    gh: GithubClient,
    log: FlowLogger,
) -> FlowOutcome:
    """Run one flow on one issue. The phase loop, retry semantics,
    transition dispatch, comment gating, close-phase evidence check,
    and optional-phase handling. Returns FlowOutcome.

    Does NOT build context — that's the caller's job.
    Does NOT log directly — events go through `log`.
    Does NOT post comments without going through `gh`.
    """
    # ...existing 1,591 lines, reorganized to use the new types...
```

The old `run_flow_on_issue` becomes a 10-line shim:

```python
# flow_engine.py — the backward-compat shim
def run_flow_on_issue(
    term: Terminal,
    gh: GithubClient,
    flow_name: str,
    issue_num: int,
    initial_context: dict | None = None,
) -> bool:
    """Deprecated. Use run_flow() with explicit Flow + FlowContext."""
    flow = load_flow(flow_name)
    context = build_flow_context(flow, issue_num, gh)  # NEW — extracted
    state = PhaseState(current_phase=_initial_phase(flow, skip_scout=True))
    log = StderrLogger()                                # default adapter
    outcome = run_flow(flow, context, state, term, gh, log)
    return outcome.status == "success"
```

The shim lives until all 3 callers in `app_shell.py` and the pipelines layer migrate to `run_flow` directly. The migration is the last issue.

### New File Layout

```
.pi/maestro/
├── flow_engine.py             # RUNNER + TYPE DEFINITIONS
│   # - Flow, FlowContext, PhaseState, PhaseRun, FlowOutcome (types)
│   # - run_flow() (the deep module)
│   # - run_flow_on_issue() (the shim)
│   # - load_flow() (validation + defaults)
│
├── flow_dispatcher.py         # NEW — build_flow_context (the setup helper)
│   # - Owns: "load the 7 things a flow needs"
│   # - Owns: per-issue working memory load + persist
│   # - Owns: parent-PRD fetch
│   # - Owns: repo context lookup
│   # - Owns: scout synchronous run + findings parse
│
├── phase_runner.py            # NEW — run_phase + _run_phase_inner
│   # - Owns: the per-phase function
│   # - Owns: tool allowlist enforcement
│   # - Owns: is_optional wrap (try/except → synthetic success)
│   # - Owns: is_local dispatch (subprocess / close-phase)
│   # - Owns: session log path construction
│   # - Returns: PhaseRun (with verdict + duration + tokens)
│
├── prompt_assembler.py        # NEW — build_prompt + PreparedPrompt
│   # - Owns: template loading
│   # - Owns: variable substitution
│   # - Owns: tool-allowlist extraction from frontmatter
│   # - Returns: PreparedPrompt (text + tools + future fields)
│
├── diagnostic.py              # NEW — run_diagnostic
│   # - Owns: diagnostic-prompt construction
│   # - Owns: diagnostic RPC call
│   # - Returns: dict with status + analysis
│
├── flow_logger.py             # NEW — FlowEvent, FlowLogger, StderrLogger,
│                              #        FileLogger, ListLogger
│
├── lib/
│   ├── session_reader.py      # EXTEND — add extract_phase_usage()
│   ├── rpc_client.py          # SIMPLIFY — drop _extract_verdict_from_session
│   ├── verdict_extractor.py   # SIMPLIFY — drop duplicate PHASE_OUTPUT_PATTERN
│   ├── github_client.py       # SIMPLIFY — import regex from comment_parser
│   └── ...
```

### Implementation Order (10 commits / 9 issues)

The order matters — each commit depends on the prior. Each is small (1-2 hours), independently buildable through `builder-reviewer`, and reversible.

| # | Commit | Issue | Depends on |
|---|---|---|---|
| 0 | Pre-amble cleanup (5 small deletions/dedupes) | Issue #1 | — |
| 1 | Add new types + `flow_logger.py` (no behavior change) | Issue #2 | #1 |
| 2 | Add `flow_dispatcher.py` with `build_flow_context` (old `run_flow_on_issue` wraps it) | Issue #3 | #1 |
| 3 | Add token plumbing (`extract_phase_usage` + `PhaseRun.tokens_*`) | Issue #4 | #2 |
| 4 | Replace `print(..., file=sys.stderr)` with `FlowLogger` events (using `StderrLogger`) | Issue #5 | #2 |
| 5 | Extract `phase_runner.py` (move `run_phase` + `_run_phase_inner` out) | Issue #6 | #3, #5 |
| 6 | Extract `prompt_assembler.py` (move `build_prompt`, introduce `PreparedPrompt`) | Issue #7 | #6 |
| 7 | Extract `diagnostic.py` (move `run_diagnostic`) | Issue #8 | #6 |
| 8 | Narrow interface: `run_flow(flow, context, state, term, gh, log) -> FlowOutcome` (migrate callers, delete shim) | Issue #9 | #7, #8 |

## Testing Decisions

### New test files

| File | Replaces | Asserts on |
|---|---|---|
| `tests/test_flow_logger.py` | (new) | `ListLogger` collects events in order; `FileLogger` writes JSONL; `StderrLogger` emits byte-identical output to current print lines |
| `tests/test_flow_dispatcher.py` | parts of `test_flow_engine_integration.py` | `build_flow_context` loads the right fields, failures (corrupt memory, missing registry) are non-fatal and return a partial `FlowContext` with `None` for the failed field |
| `tests/test_phase_runner.py` | parts of `test_run_single_flow.py`, `test_flow_engine_tools.py` | `run_phase` returns a `PhaseRun`; `is_optional` phases return synthetic success on exception; `is_local` phases dispatch to subprocess or close-phase |
| `tests/test_prompt_assembler.py` | parts of `test_flow_engine_tools.py` | `build_prompt` substitutes all variables; tool allowlist is extracted from frontmatter; missing template falls back to default; `PreparedPrompt` is frozen |
| `tests/test_diagnostic.py` | (new) | `run_diagnostic` builds the right prompt and returns a structured dict |
| `tests/test_session_reader_usage.py` | (new) | `extract_phase_usage` returns the right fields; missing log → `None`; corrupt JSON lines skipped |
| `tests/test_run_flow.py` | `test_run_single_flow.py` (the rest), parts of `test_flow_engine_integration.py`, parts of `test_flow_evidence.py` | full `run_flow` with synthetic `Flow` + `FlowContext` + `ListLogger` — assertions on `FlowOutcome` shape, event sequence, retry semantics, transition dispatch, evidence-policy behavior |

### Tests that die

These tests assert on internals of the *old* shape (e.g., "the [PHASE] X -> Y print appears on stderr") and have no behavioral equivalent at the new interface. **Delete them.**

- `tests/test_flow_engine_integration.py` — most of it. The setup-step assertions move to `test_flow_dispatcher.py`; the loop assertions move to `test_run_flow.py`.
- `tests/test_run_single_flow.py` — split between `test_phase_runner.py` and `test_run_flow.py`.
- `tests/test_flow_engine_tools.py` — split between `test_prompt_assembler.py` and `test_phase_runner.py`.
- `tests/test_flow_scout.py` — most of it. The scout-dispatcher behavior moves to `test_flow_dispatcher.py`; the end-to-end scout + builder behavior moves to `test_run_flow.py`.
- `tests/test_flow_evidence.py` — most of it. The close-phase behavior moves to `test_run_flow.py` (or stays as a smaller `test_close_phase.py` if it remains a separately testable unit).

### Tests that stay

- `tests/test_session_reader.py` — add the usage test, keep the rest.
- `tests/test_evidence.py` — independent module, unchanged.
- `tests/test_github_client.py` — independent module, unchanged.
- `tests/test_working_memory.py` — independent module, unchanged.
- `tests/test_prompt_loader.py` — independent module, unchanged.

### Coverage target

90%+ on the new modules. The `tests/test_run_flow.py` file is the integration test for the whole flow loop; it must cover at least:
- Single-phase flow with one retry then success
- Multi-phase flow with a rejection (route to builder, not finish)
- Flow with `is_optional` phase that errors (synthetic success, flow continues)
- Flow with diagnostic routing on error
- Flow with close-phase evidence gate (`block`, `warn_but_proceed`, `ignore` policies)
- `FlowOutcome` carries all expected fields including per-phase duration and tokens
- `ListLogger` records the expected event sequence

### Prior Art

- **Case:** `src/agent/runner.ts` — `runner` interface takes context, returns outcome (similar narrowing).
- **Case:** `src/agent/pi-runner.ts` — token usage surfaced as a runner-output field, not re-parsed.
- **Case:** `docs/philosophy.md` — "What the runner knows, the runner logs."
- **Maestro:** `lib/working_memory.py` — dataclass + store pattern; `WorkingMemory` is a value object, `MemoryStore` is the I/O adapter.
- **Maestro:** `lib/projects_registry.py` — value object + registry pattern; `ProjectsRegistry` is the I/O, `get_by_path` returns a value.
- **Maestro:** `pipelines/context.py` — `PipelineContext` is a value-object pattern that the new `FlowContext` mirrors.

## Out of Scope

- **Real-time event streaming** — events are emitted after the fact, not during a run. Could add streaming later.
- **`pipelines/dashboard.py` rename** — the `PipelineDashboard` progress reporter; different concern from this deepening.
- **Dashboard rewrite per `REDESIGN_PLAN.md`** — separate PRD.
- **DAG support** — Wave 3; depends on this deepening but is not part of it.
- **`state_manager.py` CLI wiring** — README explicitly notes this is unbuilt planned work; not part of this deepening.
- **HMAC signature on `FlowEvent` logs** — content-hash-equivalent (JSONL) is sufficient for the threat model.
- **HMAC signature on `EvidenceMarker`** — same.
- **Multi-repo evidence / cross-repo token aggregation** — single-repo focus, matches current Maestro scope.

## Further Notes

### Why is this a "deepening" rather than a "rewrite"?

The user-facing behavior is preserved: all 6 flow configs (`builder-reviewer`, `builder-test-reviewer`, `full-lifecycle`, `gap-check`, `prd-audit`, `prd-to-issues-reviewer`) continue to work without modification. The deletion test (per `LANGUAGE.md`) passes at the *interface* level — delete `flow_engine.py`'s old body, the complexity reappears in the new modules (good, it concentrates), and the *behavior* vanishes only if the new modules are also gone (good, it isn't a pass-through).

### Why a small PRD, not a big one?

The user's project history shows several iterations and changes of direction. A small PRD survives changes of heart; a big one goes stale. This PRD is the *minimum* that captures the design and the order; each issue is a vertical slice that the autonomous loop can grab independently.

### Why are value objects frozen?

`Flow` and `FlowContext` are inputs to `run_flow`. They should not mutate during a run. `PhaseState` is the *one* mutable type — it's the loop's local state, and "frozen" would be a lie. The split is the design: static vs dynamic is the invariant.

### Why is `FlowLogger` a port, not a single class?

The seam is real because there are two adapters today: `StderrLogger` (production default) and `ListLogger` (test). `FileLogger` is a third adapter for the operator use case. Per `LANGUAGE.md`: "one adapter means a hypothetical seam. Two adapters means a real one." We're at three.

### Why are per-attempt phases in `FlowOutcome.phases` (not rolled-up)?

A single phase can run multiple times (retries). Per-attempt is the source of truth. The dashboard derives the rolled-up view (e.g., "reviewer: 2 attempts, final status rejected") from the per-attempt list. This keeps `FlowOutcome` simple and avoids the "what does rolled-up mean when retries have different durations?" question.

### Why is `parent_prd` a string, not a structured object?

The only thing the prompt builder does with the parent PRD is inline it into the prompt. A structured `ParentPRD` type would be over-engineered for one consumer. If a future phase needs to query the parent PRD (e.g., for a specific AC), this changes.

## Acceptance Criteria

- [ ] Pre-amble cleanup: `dashboard_old.py` deleted, `run_prd_audit_loop` removed, `_extract_verdict_from_session` inlined, `PHASE_OUTPUT_PATTERN` deduplicated, duplicate print in `app_shell.py` resolved.
- [ ] New types exist as `frozen=True` dataclasses: `Flow`, `FlowContext`, `PhaseState`, `PhaseRun`, `FlowOutcome`, `FlowEvent`, plus helpers `PhaseConfig`, `Transition`.
- [ ] `flow_logger.py` exists with `FlowLogger` port + `StderrLogger`, `FileLogger`, `ListLogger` adapters.
- [ ] `flow_dispatcher.py` exists with `build_flow_context(flow, issue_num, gh) -> FlowContext`.
- [ ] `phase_runner.py` exists with `run_phase(...) -> PhaseRun`.
- [ ] `prompt_assembler.py` exists with `build_prompt(...) -> PreparedPrompt`.
- [ ] `diagnostic.py` exists with `run_diagnostic(...) -> dict`.
- [ ] `flow_engine.py` is reduced to types + `run_flow` + `load_flow` + thin shim. Target: under 500 lines.
- [ ] `extract_phase_usage` in `lib/session_reader.py` returns the right fields; `PhaseRun.tokens_in/out/cache_read` are populated from it.
- [ ] All `print(..., file=sys.stderr)` calls in the runner are replaced with `log.emit(FlowEvent(...))`. Production output (via `StderrLogger`) is byte-identical to the pre-refactor CLI.
- [ ] `run_flow(flow, context, state, term, gh, log) -> FlowOutcome` is the public interface.
- [ ] `app_shell.py` and `pipelines/autonomous.py` call `run_flow` directly. The shim `run_flow_on_issue` is removed.
- [ ] All 6 flow configs (`builder-reviewer.json`, `builder-test-reviewer.json`, `full-lifecycle.json`, `gap-check.json`, `prd-audit.json`, `prd-to-issues-reviewer.json`) continue to work unchanged.
- [ ] New test files exist with 90%+ coverage: `test_flow_logger.py`, `test_flow_dispatcher.py`, `test_phase_runner.py`, `test_prompt_assembler.py`, `test_diagnostic.py`, `test_session_reader_usage.py`, `test_run_flow.py`.
- [ ] Tests that asserted on the *old* shape (e.g., string-matching stderr print lines) are deleted. Their *behavior coverage* is preserved in the new tests.
- [ ] At least 2 real flow runs on real issues demonstrate the new shape end-to-end (one PR flow, one audit flow).
- [ ] `README.md` documents the new module layout, the `FlowContext` value object, and the `FlowLogger` port.

## References

### Internal
- `flow_engine.py` — current kitchen-sink runner (1,591 lines, the file this PRD restructures)
- `app_shell.py` — current dispatch (3 callers of `run_flow_on_issue`)
- `lib/rpc_client.py` — RPC + session log path (verdict-extraction wrapper to inline)
- `lib/verdict_extractor.py` — verdict extraction (regex dedup target)
- `lib/github_client.py` — comment posting + regex dedup target
- `lib/comment_parser.py` — canonical `PHASE_OUTPUT_PATTERN` home
- `lib/session_reader.py` — session log parser (target for `extract_phase_usage` extension)
- `lib/working_memory.py` — value-object pattern (the `WorkingMemory` / `MemoryStore` split is the model for `FlowContext`)
- `lib/projects_registry.py` — value-object pattern (registry + value pair is the model for `FlowContext.repo_context`)
- `pipelines/context.py` — value-object pattern (the `PipelineContext` is a per-pipeline equivalent of the new `FlowContext`)
- `pipelines/autonomous.py`, `pipelines/full-lifecycle.py` — pipeline scripts that will migrate to `run_flow`
- `tests/test_flow_engine_*.py` — existing tests; most will be re-pointed or split
- `tests/test_run_single_flow.py` — existing integration test; re-pointed
- `dashboard_old.py` — orphaned cleanup target
- `state.json` (with `state_manager.py`) — intentional unbuilt work; out of scope

### External
- **Case** `src/agent/runner.ts` — runner that takes context and returns outcome
- **Case** `src/agent/pi-runner.ts` — token usage surfaced as a runner-output field
- **Case** `docs/philosophy.md` — "What the runner knows, the runner logs"

### Related PRDs in this set
- [Tool Allowlists](maestro-tool-allowlists.md) — `phase_runner.py` enforces the allowlist
- [Scout Phase](maestro-scout-phase.md) — `flow_dispatcher.py` runs scout before the loop
- [Working Memory](maestro-working-memory.md) — `FlowContext.working_memory` is the per-flow view
- [Evidence Gates](maestro-evidence-gates.md) — `run_flow` calls the close-phase evidence check
- [Retrospective](maestro-retrospective.md) — `FlowOutcome.retro_learning` is the per-flow carry-out
- [Repo Onboarding](maestro-repo-onboarding.md) — `FlowContext.repo_context` is the registry lookup
- [DAG Support](maestro-dag-support.md) — depends on this PRD's narrowed interface
- [Playbooks](maestro-playbooks.md) — depends on `FlowContext` for per-playbook context
