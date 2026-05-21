# Domain Docs

This repo uses a **single-context** layout. All domain language, architectural decisions, and project context live in one place:

- `CONTEXT.md` — The canonical source of truth for the project's domain model, key terminology, and architectural principles.
- `docs/40-decisions/` — Architectural Decision Records (ADRs) documenting past structural choices and their rationale.

## Consumer Rules

When a skill (e.g., `improve-codebase-architecture`, `diagnose`, `tdd`) needs to understand the project domain:

1. **Read `CONTEXT.md`** first for current state, terminology, and boundaries.
2. **Consult `docs/40-decisions/`** for historical context on why certain decisions were made.
3. **Never assume** — if something isn't documented, ask or infer conservatively.

If this repo ever grows into a monorepo with distinct domains, move to a multi-context layout and update this file accordingly.
