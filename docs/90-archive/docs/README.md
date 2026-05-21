# Documentation Index

**Last Updated:** 2026-04-18  
**Version:** 1.0.0  

---

## Welcome to Pi Skeleton Documentation

This is the complete documentation system for the project, designed to help both humans and AI agents understand, build, extend, and maintain the codebase safely over time.

---

## Quick Navigation

### 🚀 Getting Started
- [`index.md`](index.md) - Master documentation index (start here!)
- [`01-onboarding/quickstart.md`](01-onboarding/quickstart.md) - Get running in 5 minutes
- [`01-onboarding/full-setup.md`](01-onboarding/full-setup.md) - Complete environment setup

### 🏗️ Architecture & Design
- [`02-architecture/overview.md`](02-architecture/overview.md) - System design overview
- [`02-architecture/adr/index.md`](02-architecture/adr/index.md) - Architecture Decision Records (includes ADR-004: event system)
- [`02-architecture/patterns/state-management.md`](02-architecture/patterns/state-management.md) - State management patterns

### 🎯 Features & Patterns
- [`03-features/README.md`](03-features/README.md) - Feature documentation index
- [`03-features/patterns/crud-pattern.md`](03-features/patterns/crud-pattern.md) - CRUD implementation pattern

### ⚙️ Operations
- [`04-operations/README.md`](04-operations/README.md) - Operations documentation index
- [`04-operations/development.md`](04-operations/development.md) - Development workflow guide
- [`04-operations/testing.md`](04-operations/testing.md) - Testing strategy and examples
- [`04-operations/deployment.md`](04-operations/deployment.md) - Deployment guide
- [`04-operations/troubleshooting.md`](04-operations/troubleshooting.md) - Common issues and fixes

### 🔌 APIs
- [`05-apis/README.md`](05-apis/README.md) - API documentation index
- [`05-apis/client-api.md`](05-apis/client-api.md) - Frontend API usage patterns
- [`05-apis/server-api.md`](05-apis/server-api.md) - Backend REST API reference

### 📋 Templates
- [`06-templates/feature-contract-template.md`](06-templates/feature-contract-template.md) - Feature specification template
- [`06-templates/app-contract-template.md`](06-templates/app-contract-template.md) - App-level contract template
- [`06-templates/handover-checklist.md`](06-templates/handover-checklist.md) - Knowledge transfer checklist

### 💻 Examples
- [`07-examples/README.md`](07-examples/README.md) - Code examples index
- [`07-examples/minimal/zustand-store.ts`](07-examples/minimal/zustand-store.ts) - Minimal Zustand example
- [`07-examples/snippets/zod-validation.ts`](07-examples/snippets/zod-validation.ts) - Zod validation patterns
- [`07-examples/production/auth-pattern.tsx`](07-examples/production/auth-pattern.tsx) - Authentication pattern
- [`07-examples/integration/todo-feature-example.md`](07-examples/integration/todo-feature-example.md) - Complete feature example

### 📚 Reference
- [`08-reference/tech-stack.md`](08-reference/tech-stack.md) - Technology choices and rationale
- [`08-reference/changelog.md`](08-reference/changelog.md) - Release history
- [`08-reference/migration-guide.md`](08-reference/migration-guide.md) - Upgrade instructions

---

## Documentation Categories

### For New Developers (Onboarding)
**Goal**: Get productive in < 1 hour

1. Read [`quickstart.md`](01-onboarding/quickstart.md) to run the app
2. Review [`full-setup.md`](01-onboarding/full-setup.md) for complete configuration
3. Study [`conventions.md`](01-onboarding/conventions.md) for coding standards
4. Understand terminology in [`glossary.md`](01-onboarding/glossary.md)

### For Feature Development
**Goal**: Find patterns and constraints quickly

1. Check [`architecture/overview.md`](02-architecture/overview.md) for system design
2. Review relevant ADRs in [`adr/index.md`](02-architecture/adr/index.md)
3. Study feature patterns in [`features/patterns/crud-pattern.md`](03-features/patterns/crud-pattern.md)
4. Look at examples in [`examples/integration/todo-feature-example.md`](07-examples/integration/todo-feature-example.md)

### For Operations & Maintenance
**Goal**: Execute tasks without guessing

1. Follow [`development.md`](04-operations/development.md) for daily workflow
2. Understand testing strategy in [`testing.md`](04-operations/testing.md)
3. Use [`deployment.md`](04-operations/deployment.md) for releases
4. Reference [`troubleshooting.md`](04-operations/troubleshooting.md) for common issues

### For Technical Reference
**Goal**: Quick lookup of technical details

1. Check [`tech-stack.md`](08-reference/tech-stack.md) for technology choices
2. Review API docs in [`apis/server-api.md`](05-apis/server-api.md) and [`client-api.md`](05-apis/client-api.md)
3. Consult examples in [`examples/`](07-examples/) for code patterns

---

## Documentation Quality

All documentation follows these principles:

✅ **Just-in-time**: Created when needed, not before  
✅ **Living documents**: Updated alongside code changes  
✅ **Single source of truth**: One canonical location per topic  
✅ **AI-readable**: Structured enough for agents to parse  
✅ **Human-first**: Clear, scannable, practical  

---

## Maintenance

### Update Triggers
- New feature implemented → Add/update feature docs
- Architecture decision made → Create ADR
- Workflow changes → Update operations docs
- Technology upgrade → Update tech stack and migration guide

### Review Cadence
- **Per PR**: Check if code changes need doc updates
- **Monthly**: Review P0 docs for accuracy
- **Quarterly**: Full documentation audit
- **Per Release**: Update changelog, verify links

---

## Related Project Files

- [`README.md`](../README.md) - Project overview and quick start
- [`.pi/WORLD.md`](../.pi/WORLD.md) - Domain map and project structure
- [`.pi/SYSTEM.md`](../.pi/SYSTEM.md) - System rules and behavior
- [`~/.pi/agent/AGENTS.md`](https://github.com/david/pi-agent) - Agent task routing

---

**Last Updated:** 2026-04-18  
**Review Status:** Active  
**Next Review Date:** 2026-05-18
