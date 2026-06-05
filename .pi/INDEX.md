# Pi Foundations — Skills Quick Reference

Quick index of all skills available in this project. Skills are loaded on-demand when their trigger phrase matches.

## Available Skills

Skills are located in `.pi/skills/<skill-name>/SKILL.md` unless noted otherwise.

| Skill | Purpose | Trigger Phrase |
|-------|---------|----------------|
| `typescript-implementer` | TypeScript feature implementation | "implement", "build", "code" |
| `python-implementer` | Python feature implementation | "implement python", "python code" |
| `planner` | Task decomposition & scoping | "plan", "break down", "scope" |
| `vertical-slice-planner` | Vertical slice planning | "vertical slice", "slice plan" |
| `vertical-slice-builder` | Orchestrate Plan→Build→Review with blueprint + quality gates | "vertical slice build", "end-to-end implementation" |
| `reviewer` | Quality & consistency review | "review", "check", "verify" |
| `architect` | Structural decisions & boundaries | "architecture", "structure", "design decision" |
| `db-engineer` | Database schema & migrations | "schema", "migration", "database design" |
| `debugger` | Debug sessions with console capture | "debug", "fix bug", "error" |
| `diagnose` | Deep debugging for complex issues | "diagnose", "what's wrong" |
| `tdd` | Test-driven development | "TDD", "test-first", "red-green-refactor" |
| `e2e-testing` | Playwright E2E tests with Page Object Model (Pi POS) | "E2E test", "playwright test", "page object" |
| `web-searcher` | External research via Serper API | "search", "look up", "find docs" |
| `browser-automation` | Headless browser automation | "browse", "screenshot", "automate" |
| `archivist` | Codebase pattern search & synthesis | "find pattern", "how is X done", "summarize" |
| `docs-manager` | Documentation lifecycle management | "update docs", "doc inventory", "reorganize docs" |
| `context-sync-audit` | Docs vs codebase drift audit | "sync docs", "doc drift", "context sync" |
| `improve-codebase-architecture` | Find deepening opportunities | "improve architecture", "refactor opportunities" |
| `zoom-out` | Broader context or higher-level perspective | "zoom out", "big picture", "how does this fit" |
| `session-parser` | Parse agent session logs | "parse session", "session log" |
| `prd-auditor` | Verify PRD implementation status | "audit PRD", "check implementation" |
| `issue-readiness` | Validate issue builder readiness | "is this ready", "validate issue" |
| `triage` | Issue workflow management | "triage", "label issue" |
| `to-issues` | Convert plans to GitHub issues | "create issues", "break into tickets" |
| `to-prd` | Create PRD from context | "create PRD", "write spec" |
| `obsidian-vault` | Manage Obsidian notes | "add note", "find note in obsidian" |
| `discovery` | Q&A, sparring, decision-shaping before planning | "discuss", "think through", "help me decide" |
| `grill-me` | Stress-test plans via interview | "grill me", "challenge my plan" |
| `grill-with-docs` | Grilling with project docs context | "grill me against docs" |
| `prompt-optimizer` | Improve LLM prompts | "improve prompt", "optimize prompt" |
| `edit-article` | Restructure and improve articles | "edit article", "revise draft" |
| `scaffold-exercises` | Create exercise directories | "create exercises", "exercise stubs" |
| `migrate-to-shoehorn` | Replace `as` with shoehorn in tests | "shoehorn", "replace as in tests" |
| `setup-pre-commit` | Configure Husky + lint-staged hooks | "pre-commit", "husky setup" |
| `setup-matt-pocock-skills` | Register repo context (tracker, labels, domain layout) in AGENTS.md | "setup skills", "register skills", "matt pocock setup" |
| `git-guardrails-claude-code` | Block dangerous git commands | "block push", "git safety" |
| `write-a-skill` | Create new agent skills | "create skill", "new skill" |
| `handoff` | Compact session into a handoff document | "handoff", "compact session" |
| `caveman` | Ultra-compressed communication | "caveman mode", "be brief" |

### Global Skills (not in this project)
| Skill | Purpose | Trigger Phrase |
|-------|---------|----------------|
| `find-skills` ⭐ | Discover and install agent skills | "find a skill for X", "is there a skill" |

⭐ Located at `~/.pi/agent/skills/find-skills/` (global, not project-local).

## Maestro Flow Skills

[Maestro](maestro/README.md) is the configurable loop orchestrator. Its **6 flows** (`flows/*.json`) define sequences of **phases**, each of which invokes a skill. Of the 39 project skills, **14 are used as maestro flow phases**, grouped below by their role in the orchestration loop.

### Available Flows
| Flow | Purpose | Phases |
|------|---------|--------|
| `builder-reviewer` | Standard build + review loop (with optional scout) | scout → builder → test_runner → reviewer → close → retrospective |
| `builder-test-reviewer` | 3-phase build → test → review | builder → reviewer → retrospective |
| `full-lifecycle` | End-to-end PRD-driven flow | issue-readiness → archivist → builder → reviewer → retrospective |
| `gap-check` | PRD validation pipeline (audit, no retrospective) | analyze → to-prd → to-issues |
| `prd-audit` | Full PRD audit (audit, no retrospective) | auditor → generate-issues → close |
| `prd-to-issues-reviewer` | PRD-to-issues review flow | issue-readiness → archivist → retrospective |

### Skills Grouped by Flow Role

#### 🔍 Context Gathering (pre-build)
Read-only exploration of repo / docs before implementation begins.
| Skill | Used In | Role |
|-------|---------|------|
| `archivist` | `full-lifecycle`, `prd-to-issues-reviewer` | Repo context enrichment (reads docs/code, never edits) |
| `scout` | `builder-reviewer` (optional) | Read-only exploration with 240s budget |
| `context-sync-audit` | `gap-check` | Drift audit between docs and codebase |

#### 🔨 Build (implementation)
The actual code-writing and self-verification phases.
| Skill | Used In | Role |
|-------|---------|------|
| `tdd` | `builder-reviewer`, `builder-test-reviewer`, `full-lifecycle` | Test-driven development — **acts as the builder** |
| `test_runner` | `builder-reviewer` | Local test execution (writes `tested.json` evidence) |
| `prd-auditor` | `prd-audit` | Verify PRD implementation status |

#### ✅ Quality (review)
Validate output against acceptance criteria.
| Skill | Used In | Role |
|-------|---------|------|
| `reviewer` | `builder-reviewer`, `builder-test-reviewer`, `full-lifecycle` | Quality validation, retry loop on reject |
| `issue-readiness` | `full-lifecycle`, `prd-to-issues-reviewer` | Pre-implementation issue quality check |

#### 📤 Output Generation (post-build)
Convert plans/analyses into PRDs and issues.
| Skill | Used In | Role |
|-------|---------|------|
| `to-prd` | `gap-check`, `prd-audit` | Generate PRDs from analysis |
| `to-issues` | `gap-check`, `prd-audit` | Convert plans/PRDs to GitHub issues |

#### 🪞 Self-Improvement (post-close)
Non-blocking learning loop — runs after success to extract patterns.
| Skill | Used In | Role |
|-------|---------|------|
| `retrospective` | `builder-reviewer`, `builder-test-reviewer`, `full-lifecycle`, `prd-to-issues-reviewer` | Extracts learnings into `.maestro/learnings.md`. Always routes to `finish` on any outcome (non-blocking). |

#### 🛠 Error Recovery
Routed to on phase errors; diagnostic pass after repeated failures.
| Skill | Used In | Role |
|-------|---------|------|
| `diagnose` | `builder-reviewer`, `full-lifecycle`, `prd-to-issues-reviewer` | Deep debugging with discipline loop |
| `debugger` | `builder-test-reviewer`, `gap-check`, `prd-audit` | Debug sessions with console capture |

### Notes
- **`close` is NOT a skill** — it's a local-only phase (`is_local: true`) that runs a Python command (`maestro.commands.evidence check`) to gate evidence before closing. Its prompt lives at `maestro/prompts/close.md`.
- **`interviewer`** is used by `maestro onboard` (CLI) for repo registration, not as a flow phase.
- The `diagnose` and `debugger` skills both fill the `diagnostic` phase slot in different flows — they are interchangeable as error-recovery agents.

## Quick Reference Patterns

### Skill Loading
Skills are loaded on-demand when their trigger phrase matches. Each `SKILL.md` contains:
- Role definition and context
- Step-by-step workflow
- Handoff patterns to other agents
- Example interactions

### Agent → Skill Mapping
| Agent | Skill |
|-------|-------|
| Builder | `typescript-implementer` or `python-implementer` |
| Planner | `planner` or `vertical-slice-planner` |
| Builder (vertical slice) | `vertical-slice-builder` |
| Reviewer | `reviewer` |
| Architect | `architect` |
| DB Engineer | `db-engineer` |
| Archivist | `archivist` |
| Web Researcher | `web-searcher` |
| Browser Automation | `browser-automation` |
| Debugger | `debugger` or `diagnose` |
| Discovery / Sparring | `discovery`, `grill-me`, or `grill-with-docs` |

### Path System
- **Global config**: `~/.pi/` (auto-resolved to `/home/david/.pi/`)
- **Local config**: `.pi/` relative to project root
- **Project root**: `/home/david/projects/pi-foundations`
- **Skill location**: `.pi/skills/<skill-name>/SKILL.md`

### Common Handoffs
```
User Request → discovery (clarify) → planner (decompose)
                                       ↓
                              architect (if structural)
                                       ↓
                              db-engineer (if schema)
                                       ↓
                              builder (typescript-implementer / python-implementer)
                                       ↓
                              reviewer (quality check)
```
