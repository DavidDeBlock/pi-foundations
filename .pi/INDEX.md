# Pi Skeleton — Skills Quick Reference

**Location:** `.pi/INDEX.md`  
**Purpose:** Quick lookup for available skills and project conventions. For complete agent definitions and routing rules, see `~/.pi/agent/AGENTS.md`.

👉 **Start here when looking up a skill quickly.**
👉 **For full agent system details: read `~/.pi/agent/AGENTS.md`**

---

## 📚 Related Documentation

| Document | Location | Purpose |
|----------|----------|---------|
| **Agent Definitions** | `~/.pi/agent/AGENTS.md` | Complete agent-to-skill mappings and routing rules |
| System Rules | `.pi/SYSTEM.md` | Core runtime behavior and path conventions |
| Domain Map | `.pi/WORLD.md` | Project structure and domain boundaries |
| **Architecture** | `docs/02-architecture/overview.md` | System design and patterns |
| **Conventions** | `docs/01-onboarding/conventions.md` | Coding standards and style guide |
| **Testing** | `docs/04-operations/testing.md` | Testing strategy and examples |
| **Tech Stack** | `docs/08-reference/tech-stack.md` | Technology choices and versions |

---

## 🎯 Project Conventions (Quick Reference)

### File Organization
```
client/src/
├── features/[name]/        # Self-contained feature modules
│   ├── components/         # Feature-specific UI
│   ├── hooks/              # Custom hooks
│   ├── services/           # API calls
│   └── store.ts            # Zustand state (if needed)
├── components/ui/          # Atomic components (Button, Input)
├── components/layout/      # Layout wrappers (Header, Sidebar)
└── shared/lib/             # Utilities (api-client, etc.)
```

**Note:** Zod validation schemas live in `shared/validations/`, not per-feature. This keeps them shared between frontend and backend.

### State Management Hierarchy
| Level | Scope | Technology |
|-------|-------|------------|
| Local | Single component | React `useState` |
| Feature | One feature module | Zustand |
| Global | Entire app | Context (rarely) |

**Rule:** Prefer local → feature → global. Avoid global monolith stores.

### Layer Boundaries
```
Route → Service → Repository → Database
   ↑        ↑           ↑            ↑
Response ← Response ← Response ← Result
```
- Routes: HTTP concerns only (status codes, headers)
- Services: Business logic and orchestration
- Repositories: Database operations only
- **No layer skips** - routes can't call repositories directly

### Testing Strategy
| Component Type | Min Coverage | Critical Paths |
|----------------|--------------|----------------|
| Services | 80% | All public methods |
| Components | 70% | User interaction flows |
| Utilities | 90% | Edge cases included |
| Hooks | 75% | State transitions tested |

**Test Pyramid:** Unit (70%) → Integration (20%) → E2E (10%)

### Technology Stack Summary
- **Frontend:** React 18 + TypeScript 5 + Vite + Tailwind CSS 3
- **State:** Zustand (per-feature stores, not global monoliths)
- **Routing:** React Router 7.x (data API pattern with loaders/actions)
- **Backend:** Hono 4 + Drizzle ORM + SQLite
- **Validation:** Zod (shared schemas frontend/backend)
- **Testing:** Vitest 1.x

### Git Conventions
```
Branch: type/scope/description
  feat/add-todo-delete-functionality
  fix/handle-null-api-responses
  docs/update-adr-guidelines

Commit: type(scope): description
  feat(todos): add delete functionality with confirmation dialog
  fix(api): handle null response from todo service
```

### ADRs (Architecture Decision Records)
Located in `docs/02-architecture/adr/index.md`.
- **Status:** ✅ Accepted, ⏭️ Superseded, ❌ Rejected, 🚧 Proposed
- **Never edit accepted ADRs** - create superseding ADR instead
- **Current decisions:** Feature folders, React Router data API, Zustand per-feature stores

---

## 🧰 Available Skills

Quick reference — see `~/.pi/agent/AGENTS.md` for complete agent definitions.

| Skill | Path | Workflow Role |
|-------|------|---------------|
| **grill-with-docs** | `.pi/skills/grill-with-docs/SKILL.md` | Sparring + doc updates (step 1) |
| **to-prd** | `.pi/skills/to-prd/SKILL.md` | Conversation → PRD (step 2) |
| **to-issues** | `.pi/skills/to-issues/SKILL.md` | Plan → GitHub issues (step 3) |
| **tdd** | `.pi/skills/tdd/SKILL.md` | TDD builder in run-slices.sh (step 4a) |
| **reviewer** | `.pi/skills/reviewer/SKILL.md` | Review loop in run-slices.sh (step 4b) |
| **planner** | `.pi/skills/planner/SKILL.md` | Task decomposition |
| **typescript-implementer** | `.pi/skills/typescript-implementer/SKILL.md` | Implementation |
| **architect** | `.pi/skills/architect/SKILL.md` | Structural decisions |
| **db-engineer** | `.pi/skills/db-engineer/SKILL.md` | Schema design |
| **triage** | `.pi/skills/triage/SKILL.md` | Issue state management |
| **vertical-slice-planner** | `.pi/skills/vertical-slice-planner/SKILL.md` | Slice-specific planning |
| **archivist** | `.pi/skills/archivist/SKILL.md` | Documentation lookup |
| **web-searcher** | `.pi/skills/web-searcher/SKILL.md` | External research |
| **browser-automation** | `.pi/skills/browser-automation/SKILL.md` | Headless browser |
| **debugger** | `.pi/skills/debugger/SKILL.md` | Debug sessions |

---

## 📖 How to Use This Reference

- **Quick skill lookup**: See the skills table above, then read the specific `SKILL.md` file
- **Agent routing & handoffs**: Read `~/.pi/agent/AGENTS.md` for complete workflow diagrams
- **Detailed processes**: Each skill's `SKILL.md` contains step-by-step instructions

## 🔄 Role Handoffs

See `~/.pi/agent/AGENTS.md` for complete handoff diagrams and workflow patterns.

---

## 📁 Directory Structure

```
.pi/
├── INDEX.md                    ← You are here (skills quick reference)
├── SYSTEM.md                   Core system rules
├── WORLD.md                    Domain map and project structure
├── FLOW.md                     Workflow guide
└── skills/                     Skill implementations
    ├── grill-with-docs/        Sparring + doc updates (workflow step 1)
    ├── to-prd/                 Conversation → PRD (workflow step 2)
    ├── to-issues/              Plan → GitHub issues (workflow step 3)
    ├── tdd/                    TDD builder (run-slices.sh step 4a)
    ├── reviewer/               Review loop (run-slices.sh step 4b)
    ├── planner/                Task decomposition
    ├── typescript-implementer/ Implementation
    ├── architect/              Structural decisions
    ├── db-engineer/            Schema design
    ├── triage/                 Issue state management
    ├── vertical-slice-planner/ Slice-specific planning
    ├── archivist/              Documentation lookup
    ├── web-searcher/           External research
    ├── browser-automation/     Headless browser
    └── debugger/               Debug sessions
```

For agent definitions and routing rules, see `~/.pi/agent/AGENTS.md`.

---

## 📋 Definition of Done by Role

See `~/.pi/agent/AGENTS.md` for complete role completion criteria.

*Last updated: 2026-05-14*
