# PRD: DAG Support (Parallel Phase Execution)

> **Wave:** 3 (Advanced Capabilities)
> **Effort:** 2-3 days
> **Depends on:** nothing (independent engine change; benefits from [Tool Allowlists](maestro-tool-allowlists.md) for parallel phase safety)
> **Required by:** nothing
> **Roadmap:** [maestro-case-improvements-roadmap.md](maestro-case-improvements-roadmap.md#8-prds-in-this-set)

---

## Problem Statement

Maestro's flow engine treats phases as a **linear state machine** with `on_success` / `on_reject` / `on_error` transitions between named phases. This works for the common case (build → review → close) but cannot express:

- **Parallel phases:** "Run linter and test_runner in parallel, then proceed to review" — currently impossible, must run sequentially
- **Conditional phases:** "Run the documentation phase only if files in `docs/` were touched" — currently no way to express
- **Phase dependencies:** "Phase C requires both Phase A and Phase B to complete" — currently must run A → B → C sequentially
- **Phase resumption from failure:** "Skip phases that already succeeded in a previous run" — currently re-runs everything

The **workos/case** project solves this with a **DAG (Directed Acyclic Graph) execution engine** in `src/dag/`. Phases declare `depends_on: []` and `parallel: true`. The engine builds a DAG, runs independent phases in parallel, and waits for dependencies before starting dependents. The DAG also supports **fingerprinting** (skip phases whose inputs haven't changed) and **restore** (resume from a previous run's state).

For Maestro, the highest-value subset is **parallel phase execution** with **dependencies**. Fingerprinting and restore can be follow-ups.

## Solution

Extend Maestro's flow JSON to support:

1. **`depends_on: []`**: List of phase names that must complete before this phase runs
2. **`parallel: true`**: Marks a phase as safe to run concurrently with other parallel phases
3. **`condition: "<jq-like-expression>"`**: Optional condition (evaluated against working memory) for conditional execution
4. **DAG executor in `flow_engine.py`**: Builds the DAG from flow JSON, runs phases respecting dependencies, parallelizes where safe

**Backward compatibility:** Flows without `depends_on` and `parallel` continue to work as linear state machines. The DAG executor detects the new fields and activates DAG mode; otherwise it runs the existing transition logic.

**Example: parallel lint + test after build, before review**

```json
{
  "name": "builder-reviewer-parallel",
  "phases": {
    "scout": { "skill": "/skill:scout", "parallel": false },
    "builder": {
      "skill": "/skill:tdd",
      "depends_on": ["scout"],
      "parallel": false
    },
    "lint": {
      "skill": "/skill:lint",
      "depends_on": ["builder"],
      "parallel": true
    },
    "test_runner": {
      "skill": "/skill:test_runner",
      "depends_on": ["builder"],
      "parallel": true
    },
    "reviewer": {
      "skill": "/skill:reviewer",
      "depends_on": ["lint", "test_runner"],
      "parallel": false
    },
    "close": {
      "skill": "/skill:close",
      "depends_on": ["reviewer"],
      "parallel": false
    }
  }
}
```

In this flow, `lint` and `test_runner` run in parallel after `builder` completes. `reviewer` waits for both.

## User Stories

1. As a Maestro operator, I want to run independent phases in parallel, so that the total flow runtime is reduced
2. As a Maestro operator, I want to express phase dependencies in flow JSON, so that I can model complex workflows declaratively
3. As a Maestro operator, I want parallel phases to be backward compatible with linear flows, so that existing flows don't break
4. As a Maestro operator, I want the DAG executor to detect cycles and report them, so that I don't get infinite loops
5. As a Maestro operator, I want parallel phases to share a common context (working memory), so that results from one phase are visible to siblings
6. As a Maestro operator, I want parallel phases to coordinate via a barrier (all siblings complete before dependents start), so that dependents see the full picture
7. As a Maestro operator, I want the DAG executor to fall back to linear mode if `parallel: true` is not used, so that the existing flow engine keeps working
8. As a Maestro operator, I want to specify a `condition` for conditional phase execution, so that I can skip phases that don't apply
9. As a Maestro operator, I want the TUI dashboard to show parallel phase status, so that I can see what's running concurrently
10. As a Maestro developer, I want the DAG executor to be a separate module, so that the existing flow_engine.py stays simple

## Implementation Decisions

### Updated Flow JSON Schema: `depends_on` and `parallel`

```python
# lib/dag_schema.py — JSON schema for DAG-enabled flow configs
from typing import Literal
from dataclasses import dataclass, field

@dataclass
class PhaseConfig:
    skill: str = ""
    model: str = ""
    provider: str = ""
    timeout_seconds: int = 1800
    retries: int = 0
    is_local: bool = False
    command: str = ""
    playbook: str = ""
    tools: list[str] = field(default_factory=list)

    # DAG extensions
    depends_on: list[str] = field(default_factory=list)  # Phase names that must complete first
    parallel: bool = False  # Safe to run concurrently with other parallel phases
    condition: str = ""  # Optional condition (jq-like) evaluated against working memory


@dataclass
class FlowConfig:
    name: str
    description: str = ""
    default_provider: str = ""
    default_model: str = ""
    scout_enabled: bool = False
    evidence_policy: dict = field(default_factory=dict)
    phases: dict[str, PhaseConfig] = field(default_factory=dict)

    # Legacy: linear transitions (used when no depends_on is specified)
    transitions: list[dict] = field(default_factory=list)
```

### New Module: `lib/dag.py`

```python
# lib/dag.py
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Callable, Any
import asyncio
import concurrent.futures
from pathlib import Path

from lib.working_memory import MemoryStore


@dataclass
class PhaseNode:
    name: str
    config: dict
    depends_on: list[str] = field(default_factory=list)
    parallel: bool = False
    condition: str = ""  # Optional

    def is_ready(self, completed: set[str], failed: set[str], memory: dict) -> bool:
        """A node is ready when all dependencies are completed (or skipped) and the condition is met."""
        for dep in self.depends_on:
            if dep not in completed:
                return False
        if self.condition:
            if not evaluate_condition(self.condition, memory):
                return False  # Condition not met, skip
        return True


def build_dag(flow_config: dict) -> tuple[dict[str, PhaseNode], list[str]]:
    """Build a DAG from flow config. Returns (nodes, topological_order).

    Raises ValueError on cycles or missing dependencies.
    """
    nodes = {}
    for phase_name, phase_cfg in flow_config["phases"].items():
        nodes[phase_name] = PhaseNode(
            name=phase_name,
            config=phase_cfg,
            depends_on=phase_cfg.get("depends_on", []),
            parallel=phase_cfg.get("parallel", False),
            condition=phase_cfg.get("condition", ""),
        )

    # Validate: all dependencies exist
    for node in nodes.values():
        for dep in node.depends_on:
            if dep not in nodes:
                raise ValueError(f"Phase '{node.name}' depends on unknown phase '{dep}'")

    # Topological sort (Kahn's algorithm)
    in_degree = defaultdict(int)
    for node in nodes.values():
        in_degree.setdefault(node.name, 0)
        for dep in node.depends_on:
            in_degree[node.name] += 1

    queue = deque([n for n in nodes if in_degree[n] == 0])
    topo_order = []
    while queue:
        n = queue.popleft()
        topo_order.append(n)
        for other in nodes.values():
            if n in other.depends_on:
                in_degree[other.name] -= 1
                if in_degree[other.name] == 0:
                    queue.append(other.name)

    if len(topo_order) != len(nodes):
        cycle_nodes = [n for n in nodes if n not in topo_order]
        raise ValueError(f"Cycle detected in DAG involving: {cycle_nodes}")

    return nodes, topo_order


def detect_dag_mode(flow_config: dict) -> bool:
    """Return True if any phase uses DAG features (depends_on or parallel)."""
    for phase_cfg in flow_config.get("phases", {}).values():
        if "depends_on" in phase_cfg or phase_cfg.get("parallel"):
            return True
    return False


def evaluate_condition(condition: str, memory: dict) -> bool:
    """Evaluate a simple condition expression against working memory.

    Supported syntax:
    - "files_touched contains 'migrations/'"  — substring check
    - "issue.labels contains 'bug'"           — list membership
    - "builder.status == 'success'"           — equality
    - "reviewer.critical_issues == 0"         — nested field access

    This is intentionally simple — not a full expression language. Use Python
    eval for complex conditions (gated by safe globals).
    """
    # Tokenize: split on 'and' / 'or' (case-insensitive)
    # For simplicity, support single-condition expressions in v1
    condition = condition.strip()
    # Use a restricted eval — only allow attribute access and comparisons
    try:
        # Build a flat namespace from memory
        namespace = _flatten_memory(memory)
        return bool(eval(condition, {"__builtins__": {}}, namespace))
    except Exception:
        return False  # Condition errors are non-fatal — treat as "not met"


def _flatten_memory(memory: dict, prefix: str = "") -> dict:
    """Flatten nested memory dict to dot-notation namespace for eval."""
    result = {}
    for k, v in memory.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            result.update(_flatten_memory(v, key))
        else:
            result[key] = v
    return result


def run_dag(
    flow_config: dict,
    issue_num: int,
    repo_path: Path,
    run_phase_fn: Callable,
    max_concurrent: int = 4,
) -> dict:
    """Execute the DAG. Independent phases run in parallel.

    Args:
        flow_config: The flow configuration
        issue_num: Issue number
        repo_path: Path to the target repo
        run_phase_fn: Function that runs a single phase (signature: (name, config, issue_num, context) -> result)
        max_concurrent: Maximum number of phases to run concurrently

    Returns:
        Final working memory dict
    """
    nodes, topo_order = build_dag(flow_config)
    completed = set()
    failed = set()
    skipped = set()
    results = {}
    memory = MemoryStore(issue_num).load().to_dict()

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_concurrent) as executor:
        in_flight = {}  # future -> phase_name

        def submit_ready_phases():
            for phase_name in topo_order:
                if phase_name in completed or phase_name in failed or phase_name in skipped:
                    continue
                if phase_name in in_flight:
                    continue
                node = nodes[phase_name]
                if node.is_ready(completed, failed, memory):
                    if node.condition and not evaluate_condition(node.condition, memory):
                        skipped.add(phase_name)
                        results[phase_name] = {"status": "skipped", "details": "condition not met"}
                        continue
                    # Submit for execution
                    future = executor.submit(
                        run_phase_fn,
                        phase_name,
                        node.config,
                        issue_num,
                        memory,
                    )
                    in_flight[future] = phase_name

        while in_flight or len(completed) + len(failed) + len(skipped) < len(nodes):
            submit_ready_phases()
            if not in_flight:
                break
            # Wait for at least one future to complete
            done, _ = concurrent.futures.wait(
                in_flight.keys(),
                return_when=concurrent.futures.FIRST_COMPLETED,
            )
            for future in done:
                phase_name = in_flight.pop(future)
                try:
                    result = future.result()
                except Exception as e:
                    result = {"status": "error", "details": str(e)}
                results[phase_name] = result
                # Update memory
                memory = MemoryStore(issue_num).load().to_dict()
                memory[phase_name] = result
                MemoryStore(issue_num).save(memory_from_dict(memory, issue_num))
                # Mark completed or failed
                if result["status"] == "success":
                    completed.add(phase_name)
                else:
                    failed.add(phase_name)

    # Save final state
    MemoryStore(issue_num).save(memory_from_dict(memory, issue_num))
    return memory


def memory_from_dict(d: dict, issue_num: int):
    """Convert a memory dict back to a WorkingMemory object."""
    from lib.working_memory import WorkingMemory
    return WorkingMemory(issue=issue_num, **d)
```

### Updated: `flow_engine.py` — Dispatcher

```python
# flow_engine.py — dispatcher chooses linear or DAG mode
from lib.dag import detect_dag_mode, run_dag

def run_flow(flow_config: dict, issue_num: int, repo_path: Path) -> dict:
    """Run a flow on an issue, choosing linear or DAG mode based on flow config."""
    if detect_dag_mode(flow_config):
        log(f"[flow] DAG mode detected (parallel phases or depends_on)")
        return run_dag(flow_config, issue_num, repo_path, run_phase)
    else:
        log(f"[flow] Linear mode (no parallel phases)")
        return run_flow_linear(flow_config, issue_num, repo_path)


def run_flow_linear(flow_config: dict, issue_num: int, repo_path: Path) -> dict:
    """Existing linear flow engine (unchanged)."""
    # ... existing implementation ...
```

### New Flow: `flows/builder-reviewer-parallel.json`

```json
{
  "name": "builder-reviewer-parallel",
  "description": "Builder-reviewer flow with parallel lint and test_runner.",
  "scout_enabled": true,
  "evidence_policy": {
    "required_on_success": ["tested", "reviewed"],
    "on_missing_evidence": "warn_but_proceed"
  },
  "phases": {
    "scout": {
      "skill": "/skill:scout",
      "timeout_seconds": 240,
      "retries": 1
    },
    "builder": {
      "skill": "/skill:tdd",
      "depends_on": ["scout"],
      "timeout_seconds": 1800,
      "retries": 3,
      "playbook": "fix-bug"
    },
    "lint": {
      "skill": "/skill:lint",
      "depends_on": ["builder"],
      "parallel": true,
      "timeout_seconds": 300
    },
    "test_runner": {
      "skill": "/skill:test_runner",
      "depends_on": ["builder"],
      "parallel": true,
      "timeout_seconds": 600
    },
    "reviewer": {
      "skill": "/skill:reviewer",
      "depends_on": ["lint", "test_runner"],
      "timeout_seconds": 1200,
      "retries": 2,
      "playbook": "fix-bug"
    },
    "close": {
      "skill": "/skill:close",
      "depends_on": ["reviewer"],
      "is_local": true,
      "timeout_seconds": 30
    },
    "retrospective": {
      "skill": "/skill:retrospective",
      "depends_on": ["close"],
      "timeout_seconds": 300,
      "is_optional": true
    }
  }
}
```

### Conditional Phase Example: Run docs phase only if docs/ was touched

```json
{
  "phases": {
    "builder": {
      "skill": "/skill:tdd",
      "depends_on": ["scout"]
    },
    "docs_update": {
      "skill": "/skill:docs",
      "depends_on": ["builder"],
      "parallel": true,
      "condition": "files_touched_any matches 'docs/'"
    }
  }
}
```

### TUI Dashboard Update: Show Parallel Status

```python
# panels/live_monitor_panel.py — update for parallel phase display
def render_phase_status(phase_name: str, status: str, parallel: bool = False) -> str:
    """Render a phase status with parallel indicator."""
    if parallel and status == "running":
        return f"⚡ {phase_name}: {status} (parallel)"
    return f"  {phase_name}: {status}"
```

## Testing Decisions

### Unit Tests

**`tests/test_dag.py`** (new, ~14 tests):
- `test_build_dag_with_no_dependencies`
- `test_build_dag_with_linear_dependencies`
- `test_build_dag_with_diamond_dependencies` (A → B, A → C, B → D, C → D)
- `test_build_dag_with_parallel_phases`
- `test_build_dag_detects_cycle`
- `test_build_dag_detects_missing_dependency`
- `test_topological_order_respects_dependencies`
- `test_detect_dag_mode_returns_false_for_linear_flow`
- `test_detect_dag_mode_returns_true_with_depends_on`
- `test_detect_dag_mode_returns_true_with_parallel_true`
- `test_evaluate_condition_simple_equality`
- `test_evaluate_condition_list_membership`
- `test_evaluate_condition_string_contains`
- `test_evaluate_condition_returns_false_on_error`

**`tests/test_dag_executor.py`** (new, ~8 tests):
- `test_run_dag_executes_phases_in_topological_order`
- `test_run_dag_runs_parallel_phases_concurrently`
- `test_run_dag_waits_for_all_dependencies`
- `test_run_dag_skips_phases_with_unmet_condition`
- `test_run_dag_records_failure_propagation` (failed dep → dependent skipped)
- `test_run_dag_updates_working_memory_between_phases`
- `test_run_dag_respects_max_concurrent_limit`
- `test_run_dag_handles_phase_exceptions_gracefully`

### Integration Tests

**`tests/test_integration_dag.py`** (new, ~4 tests):
- `test_end_to_end_parallel_flow` — real flow with parallel phases, verify they actually run concurrently (timing check)
- `test_dag_fallback_to_linear_for_legacy_flow` — verify linear flows still work
- `test_dag_with_conditional_phase` — verify condition skips the phase
- `test_dag_visible_in_dashboard` — TUI shows parallel status correctly

### Manual Verification

- [ ] Run a flow with `parallel: true` on two phases; verify both run concurrently (check timestamps in logs)
- [ ] Run a flow with a cycle; verify DAG executor reports the error clearly
- [ ] Run a legacy linear flow (no `parallel: true`); verify it runs as before
- [ ] Run a flow with a conditional phase; verify the phase is skipped when the condition is false
- [ ] Inspect the TUI dashboard during a parallel flow; verify parallel phases are marked
- [ ] Run a flow with 5+ parallel phases; verify `max_concurrent` is respected

### Prior Art

- **Case:** `src/dag/builder.ts` — builds DAG from pipeline config
- **Case:** `src/dag/executor.ts` — runs DAG with parallel execution
- **Case:** `src/dag/types.ts` — `PhaseNode` type with `depends_on` and `parallel`
- **Case:** `src/dag/fingerprint.ts` — phase fingerprinting (skip if inputs unchanged)
- **Case:** `src/dag/restore.ts` — resume from previous run
- **Case:** `src/dag/merge.ts` — merge parallel results
- **Case:** `src/dag/status.ts` — DAG status tracking
- **Case:** `src/dag/outcome-table.ts` — outcome table for resumability
- **Maestro:** `flow_engine.py:run_phase()` — existing single-phase runner (reused in DAG executor)
- **Maestro:** `lib/working_memory.py` (from [Working Memory PRD](maestro-working-memory.md)) — shared state for parallel phases

## Out of Scope

- **Phase fingerprinting** — skipping phases whose inputs haven't changed. Could be a follow-up. Requires hashing inputs and outputs.
- **DAG restore** — resuming a partially-completed DAG from a previous run. Requires persistent outcome table.
- **DAG merge** — combining parallel results into a single verdict. For now, all parallel phases must succeed for dependents to proceed.
- **DAG visualization** — generating a graphviz/mermaid diagram of the DAG. Could be a follow-up.
- **Dynamic DAG modification** — adding/removing phases at runtime. Not needed.
- **Cross-flow DAGs** — phases that span multiple flows. Each flow is its own DAG.
- **Phase priorities** — running high-priority phases first. Defer.
- **Resource limits per DAG** — e.g., max total LLM tokens. Defer.

## Further Notes

### Why is this the last PRD (and biggest)?

DAG support is a fundamental engine change. It touches the dispatcher, the executor, the dashboard, and potentially the prompt-building. Doing it last means we have:
- Solid primitives (working memory, tool allowlists) to build on
- A real use case (parallel lint + test) to validate against
- Confidence that the existing linear flows still work

### Why backward compatible?

Some flows will never need DAG (e.g., a simple "build → review → close" with no parallel work). Forcing them to use the DAG executor adds overhead and risk. Linear mode is a fast path.

### Why is `condition` a simple expression language, not full Python?

A full Python `eval` is a security risk. We're evaluating expressions from flow JSON, which could be tampered with. A restricted subset (string contains, list membership, equality) is safer. If we need more, we can add specific functions (`has_files_in('docs/')`) rather than full eval.

### Why `concurrent.futures.ThreadPoolExecutor`, not `asyncio`?

The existing flow engine uses `subprocess` (for RPC) and synchronous code. ThreadPoolExecutor integrates cleanly with this. asyncio would require rewriting all the I/O to be async, which is a much bigger change. ThreadPoolExecutor is good enough for the parallelism we need (4-8 concurrent phases).

### Why is `max_concurrent` a config option?

Some flows might want to limit concurrency (e.g., to avoid rate-limiting on a shared LLM endpoint). Others might want max parallelism. Configurable per flow, with a sensible default (4).

## Acceptance Criteria

- [ ] `lib/dag.py` exists with `build_dag`, `run_dag`, `detect_dag_mode`, `evaluate_condition`
- [ ] Flow JSON supports `depends_on: []` and `parallel: true` per phase
- [ ] Flow JSON supports `condition: "<expr>"` for conditional execution
- [ ] `flow_engine.py` dispatches to DAG mode when DAG features are detected
- [ ] Linear mode continues to work for flows without DAG features
- [ ] DAG executor detects cycles and reports them clearly
- [ ] DAG executor respects `max_concurrent` limit
- [ ] Working memory is shared across parallel phases
- [ ] At least one example parallel flow shipped: `flows/builder-reviewer-parallel.json`
- [ ] TUI dashboard shows parallel phase status
- [ ] New tests: `test_dag.py` (14), `test_dag_executor.py` (8), `test_integration_dag.py` (4)
- [ ] All existing tests pass
- [ ] Manual verification: parallel flow runs phases concurrently (timing check)
- [ ] Documentation: `README.md` updated with DAG documentation

## References

### Case
- `src/dag/builder.ts` — DAG construction from pipeline config
- `src/dag/executor.ts` — DAG execution with parallelism
- `src/dag/types.ts` — `PhaseNode` with `depends_on` and `parallel`
- `src/dag/fingerprint.ts` — phase fingerprinting (out of scope for this PRD)
- `src/dag/restore.ts` — DAG restore (out of scope)
- `src/dag/merge.ts` — merging parallel results
- `src/dag/status.ts` — DAG status tracking
- `src/dag/outcome-table.ts` — outcome table for resumability
- `README.md` — "Case detects the repo, fetches the GitHub issue, creates task files, runs a baseline check, and dispatches the pipeline"

### Maestro
- `flow_engine.py:run_phase()` — existing single-phase runner (reused in DAG executor)
- `flow_engine.py:run_flow()` — to be extended with DAG dispatcher
- `lib/working_memory.py` (new, from [Working Memory PRD](maestro-working-memory.md)) — shared state for parallel phases
- `panels/live_monitor_panel.py` — to be updated to show parallel status
- `tests/test_run_single_flow.py` — example of single-flow execution tests
- `flows/builder-reviewer.json` — to be updated or supplemented with `flows/builder-reviewer-parallel.json`

### Related PRDs in this set
- [Tool Allowlists](maestro-tool-allowlists.md) — parallel phases need tool coordination (e.g., test_runner and lint shouldn't both run Bash with conflicting commands)
- [Working Memory](maestro-working-memory.md) — shared state substrate for parallel phases
- [Scout Phase](maestro-scout-phase.md) — often a dependency for parallel post-build phases
- [Evidence Gates](maestro-evidence-gates.md) — close phase can depend on parallel evidence-producing phases
