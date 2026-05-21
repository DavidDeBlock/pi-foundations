# Pi Skeleton Documentation

**Last Updated:** 2026-04-18  
**Version:** 1.0.0  
**Maintained By:** Development Team  

---

## 🚀 Quick Links

| Type | Purpose | Location |
|------|---------|----------|
| **Onboarding** | Get started in 5 minutes | [`01-onboarding/quickstart.md`](01-onboarding/quickstart.md) |
| **Architecture** | System design & decisions | [`02-architecture/overview.md`](02-architecture/overview.md) |
| **Features** | Feature documentation | [`03-features/README.md`](03-features/README.md) |
| **Operations** | Dev, test, deploy | [`04-operations/README.md`](04-operations/README.md) |
| **APIs** | API reference | [`05-apis/README.md`](05-apis/README.md) |
| **Examples** | Code examples | [`07-examples/README.md`](07-examples/README.md) |

---

## 📋 Documentation Categories

### For New Developers
1. [Quick Start](#quick-start) - Get running in 5 minutes
2. [Full Setup](#full-setup) - Complete environment configuration
3. [Coding Conventions](#coding-conventions) - Style & patterns
4. [Glossary](#glossary) - Project terminology

### For Feature Development
1. [Feature Contracts](#feature-contracts) - How to specify features
2. [Architecture Overview](#architecture-overview) - System design
3. [ADRs](#adrs) - Past decisions that constrain current work
4. [Patterns](#patterns) - Reusable architectural patterns

### For Operations & Maintenance
1. [Development Workflow](#development-workflow) - Daily dev process
2. [Testing Strategy](#testing-strategy) - How we test
3. [Deployment Guide](#deployment-guide) - Production deployment
4. [Troubleshooting](#troubleshooting) - Common issues

### For Reference
1. [Tech Stack](#tech-stack) - Technologies & rationale
2. [Changelog](#changelog) - Release history
3. [Migration Guide](#migration-guide) - Upgrade instructions

---

## 📚 Documentation Index

### 01 - Onboarding (P0)
| Document | Purpose | Status |
|----------|---------|--------|
| [`quickstart.md`](01-onboarding/quickstart.md) | First-time setup in 5 minutes | ✅ Current |
| [`full-setup.md`](01-onboarding/full-setup.md) | Complete environment configuration | ✅ Current |
| [`conventions.md`](01-onboarding/conventions.md) | Coding standards & patterns | ✅ Current |
| [`glossary.md`](01-onboarding/glossary.md) | Project terminology | ✅ Current |

### 02 - Architecture (P0)
| Document | Purpose | Status |
|----------|---------|--------|
| [`overview.md`](02-architecture/overview.md) | High-level system design | ✅ Current |
| [`adr/index.md`](02-architecture/adr/index.md) | Registry of all ADRs | ✅ Current |
| [`patterns/state-management.md`](02-architecture/patterns/state-management.md) | State management patterns | 🚧 In Progress |

### 03 - Features (P1)
| Document | Purpose | Status |
|----------|---------|--------|
| [`README.md`](03-features/README.md) | Feature documentation index | ✅ Current |
| [`patterns/crud-pattern.md`](03-features/patterns/crud-pattern.md) | CRUD feature pattern | 🚧 In Progress |

### 04 - Operations (P1)
| Document | Purpose | Status |
|----------|---------|--------|
| [`README.md`](04-operations/README.md) | Operations documentation index | ✅ Current |
| [`development.md`](04-operations/development.md) | Local development workflow | ✅ Current |
| [`testing.md`](04-operations/testing.md) | Testing strategy & examples | ✅ Current |
| [`deployment.md`](04-operations/deployment.md) | Production deployment guide | ✅ Current |
| [`troubleshooting.md`](04-operations/troubleshooting.md) | Common issues & fixes | ✅ Current |

### 05 - APIs (P2)
| Document | Purpose | Status |
|----------|---------|--------|
| [`README.md`](05-apis/README.md) | API documentation index | ✅ Current |
| [`client-api.md`](05-apis/client-api.md) | Frontend API patterns | 🚧 In Progress |
| [`server-api.md`](05-apis/server-api.md) | Backend REST API reference | 🚧 In Progress |

### 06 - Templates (P1)
| Document | Purpose | Status |
|----------|---------|--------|
| [`feature-contract-template.md`](06-templates/feature-contract-template.md) | Feature specification template | ✅ Current |
| [`app-contract-template.md`](06-templates/app-contract-template.md) | App-level contract template | ✅ Current |
| [`handover-checklist.md`](06-templates/handover-checklist.md) | Knowledge transfer checklist | ✅ Current |

### 07 - Examples (P2)
| Document | Purpose | Status |
|----------|---------|--------|
| [`README.md`](07-examples/README.md) | Code examples index | ✅ Current |
| [`minimal/zustand-store.ts`](07-examples/minimal/zustand-store.ts) | Minimal Zustand example | 🚧 In Progress |
| [`snippets/zod-validation.ts`](07-examples/snippets/zod-validation.ts) | Zod validation pattern | 🚧 In Progress |

### 08 - Reference (P1)
| Document | Purpose | Status |
|----------|---------|--------|
| [`tech-stack.md`](08-reference/tech-stack.md) | Technology choices & rationale | ✅ Current |
| [`changelog.md`](08-reference/changelog.md) | Release history | 🚧 In Progress |

---

## 🔍 Search Index by Topic

| Topic | Document | Last Updated |
|-------|----------|--------------|
| Setup | `01-onboarding/quickstart.md` | 2026-04-18 |
| Architecture | `02-architecture/overview.md` | 2026-04-18 |
| ADRs | `02-architecture/adr/index.md` | 2026-04-18 |
| Tech Stack | `08-reference/tech-stack.md` | 2026-04-18 |
| Conventions | `01-onboarding/conventions.md` | 2026-04-18 |
| Testing | `04-operations/testing.md` | 2026-04-18 |
| Deployment | `04-operations/deployment.md` | 2026-04-18 |

---

## 📝 Documentation Maintenance

### Update Triggers

| Document Type | When to Update | Who Updates |
|---------------|----------------|-------------|
| **Master Index** | Any new doc created, any link broken | Documentation Owner |
| **Quick Start** | Setup commands change, deps added/removed | Onboarding Lead |
| **Tech Stack** | New technology adopted, version upgrades | Architect |
| **ADRs** | New decision made, old decision superseded | Decision Maker |
| **Conventions** | Style changes, new patterns established | Architect + Team |
| **Operations** | Workflow changes, deployment updates | DevOps/All |
| **Examples** | Patterns deprecated, new patterns added | Feature Developer |

### Review Cadence

| Frequency | Action | Owner |
|-----------|--------|-------|
| **Per PR** | Check if code changes need doc updates | PR Author |
| **Monthly** | Review P0 docs for accuracy | Documentation Lead |
| **Quarterly** | Full documentation audit | Architect |
| **Per Release** | Update changelog, verify all links | Release Manager |

### Quality Checklist

Before merging a doc:

- [ ] Clear title and purpose stated upfront
- [ ] Links are valid (no broken references)
- [ ] Code examples work (if included)
- [ ] Status/date metadata present
- [ ] Consistent formatting with other docs
- [ ] No stale/temporary content
- [ ] Searchable keywords included

---

## 🎯 Documentation Goals

| Audience | Goal | Target Time |
|----------|------|-------------|
| **New Developer** | Understand system & run locally | < 1 hour |
| **Feature Developer** | Find patterns & constraints | < 5 minutes |
| **Operations** | Execute tasks without guessing | < 10 minutes |
| **Handover** | Transfer knowledge safely | Complete checklist |

---

## 📖 Related Project Files

- [`README.md`](../README.md) - Project overview and quick start
- [`.pi/WORLD.md`](../.pi/WORLD.md) - Domain map and project structure
- [`.pi/SYSTEM.md`](../.pi/SYSTEM.md) - System rules and behavior
- [`~/.pi/agent/AGENTS.md`](https://github.com/david/pi-agent) - Agent task routing

---

**Last Updated:** 2026-04-18  
**Review Status:** Active  
**Next Review Date:** 2026-05-18
