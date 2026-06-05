# Pi POS v1 — Skills Quick Reference

## Available Skills

| Skill | Purpose | Trigger Phrase |
|-------|---------|----------------|
| `typescript-implementer` | TypeScript feature implementation | "implement", "build", "code" |
| `python-implementer` | Python feature implementation | "implement python", "python code" |
| `planner` | Task decomposition & scoping | "plan", "break down", "scope" |
| `vertical-slice-planner` | Vertical slice planning | "vertical slice", "slice plan" |
| `reviewer` | Quality & consistency review | "review", "check", "verify" |
| `architect` | Structural decisions & boundaries | "architecture", "structure", "design decision" |
| `db-engineer` | Database schema & migrations | "schema", "migration", "database design" |
| `debugger` | Debug sessions with console capture | "debug", "fix bug", "error" |
| `diagnose` | Deep debugging for complex issues | "diagnose", "what's wrong" |
| `tdd` | Test-driven development | "TDD", "test-first", "red-green-refactor" |
| `web-searcher` | External research via Serper API | "search", "look up", "find docs" |
| `browser-automation` | Headless browser automation | "browse", "screenshot", "automate" |
| `archivist` | Codebase pattern search & synthesis | "find pattern", "how is X done", "summarize" |
| `docs-manager` | Documentation lifecycle management | "update docs", "doc inventory", "reorganize docs" |
| `context-sync-audit` | Docs vs codebase drift audit | "sync docs", "doc drift", "context sync" |
| `improve-codebase-architecture` | Find deepening opportunities | "improve architecture", "refactor opportunities" |
| `session-parser` | Parse agent session logs | "parse session", "session log" |
| `prd-auditor` | Verify PRD implementation status | "audit PRD", "check implementation" |
| `issue-readiness` | Validate issue builder readiness | "is this ready", "validate issue" |
| `triage` | Issue workflow management | "triage", "label issue" |
| `to-issues` | Convert plans to GitHub issues | "create issues", "break into tickets" |
| `to-prd` | Create PRD from context | "create PRD", "write spec" |
| `obsidian-vault` | Manage Obsidian notes | "add note", "find note in obsidian" |
| `grill-me` | Stress-test plans via interview | "grill me", "challenge my plan" |
| `grill-with-docs` | Grilling with project docs context | "grill me against docs" |
| `prompt-optimizer` | Improve LLM prompts | "improve prompt", "optimize prompt" |
| `edit-article` | Restructure and improve articles | "edit article", "revise draft" |
| `scaffold-exercises` | Create exercise directories | "create exercises", "exercise stubs" |
| `migrate-to-shoehorn` | Replace `as` with shoehorn in tests | "shoehorn", "replace as in tests" |
| `setup-pre-commit` | Configure Husky + lint-staged hooks | "pre-commit", "husky setup" |
| `git-guardrails-claude-code` | Block dangerous git commands | "block push", "git safety" |
| `write-a-skill` | Create new agent skills | "create skill", "new skill" |
| `find-skills` | Discover and install skills | "find a skill for X", "is there a skill" |
| `caveman` | Ultra-compressed communication | "caveman mode", "be brief" |

## Quick Reference Patterns

### Skill Loading
Skills are loaded on-demand when their trigger phrase matches. Each SKILL.md contains:
- Role definition and context
- Step-by-step workflow
- Handoff patterns to other agents
- Example interactions

### Agent → Skill Mapping
| Agent | Skill |
|-------|-------|
| Builder | `typescript-implementer` or `python-implementer` |
| Planner | `planner` or `vertical-slice-planner` |
| Reviewer | `reviewer` |
| Architect | `architect` |
| DB Engineer | `db-engineer` |
| Archivist | `archivist` |
| Web Researcher | `web-searcher` |
| Browser Automation | `browser-automation` |
| Debugger | `debugger` or `diagnose` |

### Path System
- **Global config**: `~/.pi/` (auto-resolved to `/home/david/.pi/`)
- **Local config**: `.pi/` relative to project root
- **Project root**: `/home/david/projects/pi-pos-v1`
