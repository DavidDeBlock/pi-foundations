# Pi Hub — Workflow Guide

**Location:** `.pi/FLOW.md`  
**Purpose:** Standard workflow for task execution through the agent system.

---

## 🔄 Standard Task Flow

### Autonomous Loop Workflow (maestro)

> **Note:** The maestro orchestrator runs autonomously via `orchestrate.py`. Agents do not execute this directly.

```
User Request
    ↓
[grill-with-docs] — Sparring + doc updates against domain model
    ↓
[to-prd] — Conversation → PRD on issue tracker
    ↓
[to-issues] — Plan → GitHub issues (vertical slices)
    ↓
[orchestrate.py --flow builder-reviewer] — Loop per issue:
    ├── [tdd] (builder) — Implement with TDD red-green-refactor
    └── [reviewer] — Quality check + test execution
            │
            ├── approved → Post artifacts, update labels ✓
            └── rejected → Retry builder with critique (flow engine handles retries)
```

**Quick start:**
```bash
# Process all pending issues in the needs-triage queue
python3 .pi/maestro/orchestrate.py --flow builder-reviewer

# Process a single issue directly
python3 .pi/maestro/orchestrate.py --flow builder-reviewer --issue 42
```

### Ad-Hoc Workflow (Manual Agent Use)

When working outside the autonomous loop:

```
User Request
    ↓
[planner] - Break down into slices, define scope
    ↓
┌─────────────────────┬─────────────────────┐
│   STRUCTURAL DECISIONS?   │   SCHEMA CHANGES?     │
├─────────────────────┼─────────────────────┤
│      YES            │        NO           │
│         ↓           │         ↓           │
│  [architect]    →   │   [db-engineer] →   │
│  (if needed)        │   (if needed)       │
│         ↓           │         ↓           │
└─────────┴───────────┴─────────┬───────────┘
                               ↓
                    [typescript-implementer]
                           ↓
                    [reviewer] - Quality check
                           ↓
                      Done / Fixes needed
```

**Note:** The maestro `builder-reviewer` flow uses `/skill:tdd` as the builder (not typescript-implementer).
The TDD skill enforces red-green-refactor discipline with integration-style tests.

---

## 🧭 TDD vs Direct Implementation Decision Guide

When choosing between the **TDD workflow** (`/skill:tdd`) and **Direct Implementation** (`typescript-implementer`):

| Scenario | Recommended Approach |
|----------|---------------------|
| Complex business logic / algorithms | ✅ Use **TDD** (red-green-refactor) |
| Bug fixes or regression scenarios | ✅ Use **TDD** |
| New feature with clear requirements | ⏭️ Use **Direct Implementation** |
| UI component creation | ⏭️ Use **Direct Implementation** |
| Refactoring existing code | ✅ Use **TDD** (safety first) |
| Quick prototype / exploration | ⏭️ Use **Direct Implementation** |

**Rule:** When in doubt, use TDD for anything touching business logic or data integrity.

---

## 📋 Role Handoff Patterns

### Planning Phase
```
planner → architect (if structural decisions needed)
        → db-engineer (if schema changes needed)  
        → typescript-implementer (ready to build)
```

### Implementation Phase
```
architect → db-engineer (for schema design)
          → typescript-implementer (with approval)

typescript-implementer → reviewer (for quality check)
                       → architect (if structural conflict found)
                       → db-engineer (if schema assumptions wrong)

db-engineer → typescript-implementer (for integration)
            → reviewer (for consistency review)
```

### Review Phase
```
reviewer → typescript-implementer (for fixes)
         → architect (for structural issues)
         → db-engineer (for data integrity issues)
```

---

## 🎯 When to Use Each Agent

| Task Type | Start With | May Need |
|-----------|------------|----------|
| Broad request | planner | architect, db-engineer |
| Feature implementation | typescript-implementer | reviewer |
| Database changes | db-engineer | architect, reviewer |
| Structural decisions | architect | planner, reviewer |
| Quality review | reviewer | architect, db-engineer |
| Documentation lookup | archivist | - |
| Web research | web-searcher | - |
| Browser automation | browser-automation | - |
| Debug sessions | debugger | - |

---

## ✅ Definition of Done by Phase

| Role | When Work is Complete |
|------|----------------------|
| **planner** | Task is clear enough for another role to execute without reinterpretation |
| **architect** | Feature has a clear structural place; project is more consistent |
| **db-engineer** | Schema and migration plan are clear, safe, and domain-aligned |
| **typescript-implementer** | Slice works, respects architecture, fits naturally into project |
| **reviewer** | Quality and safety are clearly understood; next action is obvious |

---

## 🚧 Execution Gates

### Before Planning
- ✅ User request received
- ✅ Context available (project structure, conventions)

### Before Implementation  
- ✅ Scope defined by planner
- ✅ Architect approval (if structural changes needed)
- ✅ DB plan ready (if schema changes needed)

### Before Review
- ✅ Implementation complete
- ✅ Tests passing (if applicable)
- ✅ Documentation updated (if needed)

---

## 📝 Notes

- Agents work **sequentially** - one completes before next begins
- No role mixing allowed - each agent stays in its lane
- Context passes between agents via documented outputs
- If uncertainty arises, return to previous role for clarification

*Last updated: 2026-04-15*
