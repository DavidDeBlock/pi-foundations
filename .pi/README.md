# Pi Agent Configuration

This directory contains configuration, skills, and orchestration tools for the Pi agent system.

## Structure

- **`skills/`** — Skill definitions (one per specialized role). Each skill is a `SKILL.md` with instructions that LLM agents follow.
- **`maestro/`** — Autonomous loop orchestrator. Runs builder↔reviewer flows against GitHub issues automatically.
- **`SYSTEM.md`** — Core runtime behavior and path conventions for all agents.
- **`FLOW.md`** — Standard workflow: grill-with-docs → to-prd → to-issues → maestro autonomous loop.
- **`INDEX.md`** — Quick reference for available skills and project conventions.

## How to Use

### As a Project Skeleton

Copy this entire `.pi/` directory into any new project:

```bash
cp -r /path/to/pi-skeleton/.pi ./my-project/.pi
```

Then customize:
1. **`.pi/SYSTEM.md`** — Update path examples for your environment
2. **`.pi/WORLD.md.EXAMPLE` → `WORLD.md`** — Fill in your project's domain map
3. **`.pi/AGENTS.md.EXAMPLE` → `~/.pi/agent/AGENTS.md`** — Register agents for your skill set

### Autonomous Loop

Run the autonomous builder↔reviewer loop against GitHub issues:

```bash
# Process all pending issues (needs-triage label)
python3 .pi/maestro/orchestrate.py --flow builder-reviewer

# Process a single issue directly
python3 .pi/maestro/orchestrate.py --flow builder-reviewer --issue 42

# Dry-run: simulate without side effects
python3 .pi/maestro/orchestrate.py --flow builder-reviewer --dry-run
```

### Manual Agent Use

Outside the autonomous loop, agents work sequentially via skill invocation:

```
planner → architect/db-engineer (if needed) → typescript-implementer → reviewer
```

Each agent stays in its lane. Context passes between them via documented outputs.

## Global vs Local Config

| Level | Location | Purpose |
|-------|----------|---------|
| **Global** (`~/.pi/`) | LLM model definitions, global agents | One per user, shared across projects |
| **Local** (`.pi/`) | Skills, system rules, domain map | One per project, customized per repo |

## Reference

- Agent routing & handoffs: `~/.pi/agent/AGENTS.md`
- Skill details: Each skill's `SKILL.md` in `.pi/skills/<name>/`
- Archived implementations: `.pi/archive/` (obsolete code kept for reference)
