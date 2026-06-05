# Roadmap: Adopt WorkOS/Case Patterns in Maestro

> **Status:** Planning — all PRDs drafted, no implementation yet
> **Date:** 2026-06-04
> **Owner:** David
> **Related:** [workos/case](https://github.com/workos/case) (external reference), `.pi/maestro/` (target)

---

## 1. Context & Motivation

Maestro is a configurable, testable Python-based orchestrator for multi-agent loops on GitHub issues. It works well for the "Pi slice" workflow but has accumulated structural limits that Compound over time:

- Quality gates are **LLM-judged** (regex match for `APPROVED` in session log) — fragile and easy to game
- Inter-phase context is **lossy** (`previous_output` is a single string overwritten each phase)
- Agent role boundaries are **prompt-enforced**, not tool-enforced — a "reviewer" prompt can still call `Write`
- No **scouting** before implementation — builders discover repo context while writing code
- No **retrospective** — repeated failures don't compound into learnings
- No **repo onboarding** — every run treats the target repo as anonymous

The **WorkOS/Case** project (`workos/case`) is a TypeScript/Bun-based orchestrator built by a team that has shipped thousands of agent-authored PRs. It solves the same problem with stronger primitives. We don't want to replace Maestro (Pi is ours, Maestro is ours, our flows are JSON-configurable — Case's hardcoded DAG is less flexible). We do want to **steal the patterns that materially improve reliability**.

This roadmap captures the 8 patterns worth adopting, organized into 3 implementation waves, with dependencies and success metrics.

---

## 2. The 8 Adopted Patterns

| # | Pattern | Source in Case | Wave | Effort |
|---|---------|----------------|------|--------|
| 1 | **Tool Allowlists** (per-phase tool lists) | `agents/scout.md` (`tools: ['Read', 'Bash', ...]`), `src/agent/pi-runner.ts` | 1 | 2-3 hrs |
| 2 | **Scout Phase** (read-only exploration before implementation) | `agents/scout.md`, `src/phases/scout.ts`, `src/scout/findings.ts` | 1 | 1-2 hrs |
| 3 | **Working Memory** (per-task structured context) | `src/memory/working-memory.ts`, `src/context/prefetch.ts` | 1 | 2-3 hrs |
| 4 | **Evidence Gates** (mechanical quality markers) | `src/commands/mark-tested.ts`, `src/commands/mark-reviewed.ts`, `src/phases/close.ts` | 2 | 4-6 hrs |
| 5 | **Retrospective Phase** (self-improvement loop) | `agents/retrospective.md`, `docs/proposed-amendments/` | 2 | 4-6 hrs |
| 6 | **Repo Onboarding** (interviewer agent) | `agents/interviewer.md`, `src/commands/onboard.ts`, `projects.schema.json` | 2 | 1-2 days |
| 7 | **Playbooks** (reusable task-type workflows) | `docs/playbooks/add-feature.md`, `docs/playbooks/fix-bug.md`, `docs/playbooks/add-cli-command.md` | 3 | 1-2 days |
| 8 | **DAG Support** (parallel phases via `depends_on`) | `src/dag/builder.ts`, `src/dag/executor.ts`, `src/dag/fingerprint.ts` | 3 | 2-3 days |

---

## 3. Dependency Graph

```
                    [1] Tool Allowlists (foundational safety primitive)
                              |
                              v
                    [2] Scout Phase ──────────────┐
                              |                    |
                              v                    |
                    [3] Working Memory ────────────┤
                              |                    |
                              v                    |
                    [4] Evidence Gates             |
                              |                    |
                              v                    |
                    [5] Retrospective <────────────┘  (uses working memory)
                              |
                              v
                    [6] Repo Onboarding  (uses working memory)
                              |
                              v
                    [7] Playbooks  (uses tool allowlists + working memory)
                              |
                              v
                    [8] DAG Support  (independent — pure engine change)
```

**Key insight:** Tool Allowlists (#1) is the foundation. Scout (#2), Retrospective (#5), Repo Onboarding (#6), and Playbooks (#7) all depend on it for role isolation. Working Memory (#3) is a shared substrate for Scout, Retrospective, and Onboarding. DAG Support (#8) is independent of all others — it can ship at any time.

---

## 4. Implementation Waves

### Wave 1 — Foundation (1-2 days total)

**Goal:** Establish safety primitives and structured context. No user-visible behavior change beyond better isolation.

| Order | PRD | Estimated Effort | Why this order |
|---|---|---|---|
| 1.1 | Tool Allowlists | 2-3 hrs | Quickest win, unblocks role isolation for everything else |
| 1.2 | Scout Phase | 1-2 hrs | Single biggest quality win; depends on tool allowlists for read-only enforcement |
| 1.3 | Working Memory | 2-3 hrs | Substrate for Wave 2 features; can be developed in parallel with Scout |

**Exit criteria:**
- All phases declare explicit `tools:` lists in frontmatter
- Scout phase exists in `builder-reviewer` flow with read-only tools
- `.maestro/tasks/active/<issue>.memory.json` accumulates structured state across phases
- All existing flows still pass their tests

### Wave 2 — Quality & Learning (3-4 days total)

**Goal:** Replace LLM-judged quality with mechanical evidence, and start compounding improvements.

| Order | PRD | Estimated Effort | Why this order |
|---|---|---|---|
| 2.1 | Evidence Gates | 4-6 hrs | Reliability step-change; needs tool allowlists to mark evidence (Bash access) |
| 2.2 | Retrospective | 4-6 hrs | Compounding value; needs working memory for context |
| 2.3 | Repo Onboarding | 1-2 days | High leverage; needs working memory and tool allowlists |

**Exit criteria:**
- `mark-tested` / `mark-reviewed` commands write evidence files
- Closer phase checks for evidence files before posting success
- Every completed flow runs a retrospective that appends to `.maestro/learnings.md`
- `maestro onboard <path>` captures repo context into `.maestro/projects.json`

### Wave 3 — Advanced Capabilities (3-5 days total)

**Goal:** Unlock new flow types and parallel execution.

| Order | PRD | Estimated Effort | Why this order |
|---|---|---|---|
| 3.1 | Playbooks | 1-2 days | Richer flow types (fix-bug, add-feature); builds on Wave 1+2 |
| 3.2 | DAG Support | 2-3 days | Independent engine change; can ship anytime after core is solid |

**Exit criteria:**
- `playbooks/*.md` workflows can be referenced from flow JSON
- Flow JSON supports `depends_on: []` and `parallel: true` for parallel phase execution
- At least 2 example parallel flows shipped (e.g., parallel lint+test, parallel multi-reviewer)

---

## 5. What We Are NOT Adopting (Deliberate Non-Goals)

These Case features are explicitly out of scope — they would either regress Maestro's design or duplicate existing capabilities:

| Case Feature | Why skip |
|---|---|
| Hardcoded 7-phase DAG (replacing JSON flows) | Maestro's JSON-defined flows are *more* flexible; don't lose that |
| Task JSON files as primary state source | Maestro's GitHub-comments-as-bus is a feature (human visibility); keep as primary, add task JSON as secondary |
| No TUI dashboard | Maestro's Textual dashboard is a feature; Case explicitly rejects this — don't regress |
| Standalone binary distribution | Python ecosystem is fine; Bun build complexity not worth it |
| MCP server config | Pi likely has its own mechanism; check before duplicating |
| AST-grep rules | Maestro's Python AST analysis scripts fill this niche |
| Per-agent model config in `~/.config/case/` | Per-phase model in flow JSON works fine; don't add a second config layer |
| Browser approval UI | Not needed for personal use |

---

## 6. Success Metrics

| Metric | Baseline | Wave 1 Target | Wave 2 Target | Wave 3 Target |
|---|---|---|---|---|
| **Build pass rate** (builder → reviewer → success) | ~60% (estimated) | ~70% | ~80% | ~85% |
| **Mean iterations to success** | ~3.5 | ~3.0 | ~2.5 | ~2.0 |
| **Cost per completed slice** (in LLM tokens) | TBD | -10% (scout context reuse) | -15% (evidence gates prevent re-runs) | -20% (parallel phases) |
| **Learnings accumulated** in `.maestro/learnings.md` per repo | 0 | 0 | ~5/week | ~10/week |
| **Phase role violations** (reviewer using Edit, etc.) | Possible | 0 | 0 | 0 |
| **Test coverage** of new modules | — | 90%+ | 90%+ | 90%+ |

Measure via:
- `maestro stats` (new command — counts outcomes from `verdict.json` and session logs)
- `.maestro/learnings.md` diffs (line count over time)
- Per-flow telemetry in `state/` directory

---

## 7. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Tool allowlists break existing flows** (a phase currently relies on a tool the new allowlist forbids) | Medium | High | Default to most-permissive allowlist per phase type; add a `--unsafe` flag to bypass; require explicit test coverage for new allowlists |
| **Scout phase wastes time on simple issues** | Medium | Low | Make scout opt-out per flow via `"scout_enabled": true\|false`; set a tight 4-min default timeout |
| **Working memory schema drift** (agents write different fields each run) | High | Medium | Use Pydantic-style validation in `lib/working_memory.py`; treat unknown fields as warnings, not errors |
| **Evidence gates cause false negatives** (legitimate work rejected because no marker) | Medium | High | Evidence is a *gate*, not the only signal; LLM verdict + human override remain as fallbacks. Log when evidence blocks what LLM would have approved |
| **Retrospective adds significant runtime per flow** | Low | Low | Default 5-min timeout, async background option; if fails, log to `state/retrospective-skipped.log` |
| **Repo onboarding interview takes too long** | Medium | Medium | Cap at 5 questions; allow `--skip-interview` for mechanical-only mode |
| **DAG changes break linear flow compatibility** | Low | Critical | All existing flow JSONs must continue working unchanged; DAG features are opt-in per phase |
| **Cross-PRD assumption drift** (e.g., Working Memory ships a different schema than Retrospective expects) | Medium | High | Single source of truth: this roadmap. Every PRD references the others it depends on. Build in dependency order. |

---

## 8. PRDs in This Set

| # | PRD | File | Wave |
|---|---|---|---|
| 1 | Tool Allowlists | `maestro-tool-allowlists.md` | 1 |
| 2 | Scout Phase | `maestro-scout-phase.md` | 1 |
| 3 | Working Memory | `maestro-working-memory.md` | 1 |
| 4 | Evidence Gates | `maestro-evidence-gates.md` | 2 |
| 5 | Retrospective | `maestro-retrospective.md` | 2 |
| 6 | Repo Onboarding | `maestro-repo-onboarding.md` | 2 |
| 7 | Playbooks | `maestro-playbooks.md` | 3 |
| 8 | DAG Support | `maestro-dag-support.md` | 3 |

---

## 9. References

### External (Case)
- **Repo:** https://github.com/workos/case
- **README:** https://github.com/workos/case/blob/main/README.md — "Case is the reliability layer for agent-authored pull requests"
- **Philosophy:** https://github.com/workos/case/blob/main/docs/philosophy.md — "Humans steer. Agents execute. The harness keeps the work reviewable."
- **Key Case files referenced in PRDs:**
  - `agents/scout.md` — Read-only exploration agent
  - `agents/implementer.md` — Code implementation agent
  - `agents/verifier.md` — Evidence production agent
  - `agents/reviewer.md` — Code review agent
  - `agents/closer.md` — PR opening agent
  - `agents/retrospective.md` — Self-improvement agent
  - `agents/interviewer.md` — Repo onboarding agent
  - `src/scout/findings.ts` — Scout findings schema + synthesis
  - `src/phases/scout.ts` — Scout phase execution
  - `src/phases/implement.ts` — Implementer phase with context assembler
  - `src/memory/working-memory.ts` — Per-task structured memory
  - `src/context/assembler.ts` — Context assembly (scout findings + memory + playbook)
  - `src/context/prefetch.ts` — Repo context prefetching
  - `src/dag/` — DAG execution engine (builder, executor, fingerprint, merge, restore, status)
  - `src/commands/mark-tested.ts`, `mark-reviewed.ts`, `mark-manual-tested.ts` — Evidence commands
  - `src/commands/onboard.ts` — Repo onboarding
  - `docs/playbooks/` — Reusable task-type recipes

### Internal (Maestro)
- **Project root:** `/home/david/projects/pi-pos-v1/.pi/maestro/`
- **Key files referenced in PRDs:**
  - `orchestrate.py` — CLI entry point
  - `app_shell.py` — High-level workflow manager
  - `flow_engine.py` — Core execution engine (phase loop, transitions, prompt building)
  - `dashboard.py` + `panels/` — Textual TUI
  - `pipelines/` — Higher-level pipeline abstraction with `PipelineContext`
  - `flows/*.json` — JSON-defined flow topology (5 flows currently)
  - `prompts/*.tmpl` — Prompt templates (11 currently)
  - `lib/comment_parser.py` — Parses `PHASE_OUTPUT` blocks
  - `lib/github_client.py` — Wraps `gh` CLI
  - `lib/rpc_client.py` — Spawns Pi RPC client
  - `lib/session_reader.py` — Parses JSONL session logs
  - `lib/verdict_extractor.py` — Regex-based verdict extraction
  - `lib/state_manager.py` — Local resume/rollback state
  - `lib/terminal.py` — Formatted console output
  - `lib/dashboard_api.py` — Shared data layer for dashboard
  - `config.json` — Runtime config (model, provider, session dir)
  - `tests/` — 12 test files, ~143 tests

### Process
- **Issue tracking:** `gh` CLI on the `pi-pos-v1` repo
- **Triage labels:** `needs-triage`, `needs-info`, `ready-for-agent` (per `docs/agents/triage-labels.md`)
- **PRDs in this project:** `docs/35-prds/` (see `_index.md` for existing PRDs)

---

## 10. Recommended First Sprint

**Goal:** Land Wave 1 in one focused sprint (1-2 days).

**Sprint backlog:**
1. `maestro-tool-allowlists.md` (3 hrs) → migration of `.tmpl` → `.md` with YAML frontmatter
2. `maestro-scout-phase.md` (2 hrs) → new scout phase + flow integration
3. `maestro-working-memory.md` (3 hrs) → per-task JSON + context assembly

**Definition of done for sprint:**
- All existing tests pass
- New tests added for each module (target: 90%+ coverage)
- `flows/builder-reviewer.json` updated to include scout + working memory
- At least one end-to-end run on a real issue demonstrates the new behavior
- No regression in build pass rate

**After sprint:** Re-measure baseline metrics, then proceed to Wave 2.
