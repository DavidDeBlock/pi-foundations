# 📚 Pi-Skeleton Documentation

**Status:** Foundation Phase - Ready for Review  
**Last Updated:** 2026-04-18  
**Maintained By:** Development Team

---

## Welcome

This is the documentation hub for the Pi-Skeleton project. Use this index to find what you need quickly.

---

## Quick Navigation

| Category | Purpose | Audience | Priority |
|----------|---------|----------|----------|
| [Quick Start](../01-quickstart/) | Get started in 30 minutes | New developers | 🔴 Critical |
| [Architecture](../02-architecture/) | System design & decisions | All developers | 🟡 Important |
| [Contracts](../03-contracts/) | Interface specifications | Developers, reviewers | 🟡 Important |
| [Features](../04-features/) | Feature documentation | Feature developers | 🟢 Standard |
| [Workflows](../05-workflows/) | Development processes | All team members | 🟡 Important |
| [Reference](../06-reference/) | Technical reference | Developers | 🟢 Standard |
| [Operations](../07-operations/) | Maintenance & troubleshooting | DevOps, all devs | 🟡 Important |
| [Handover](../08-handover/) | Onboarding & transitions | New developers, managers | 🔴 Critical |

---

## Common Tasks

### I want to...

| Task | Go To |
|------|-------|
| Set up my development environment | [Setup Guide](../01-quickstart/setup.md) |
| Build a new feature | [Feature Contract Template](../templates/feature-contract-template.md) |
| Make an architectural decision | [ADR Process](../02-architecture/adr/index.md) |
| Understand the tech stack | [Tech Stack Doc](../02-architecture/tech-stack.md) |
| Troubleshoot a common issue | [Troubleshooting Guide](../07-operations/troubleshooting.md) |
| Review someone's code | [Code Review Checklist](../05-workflows/code-review.md) |

---

## Documentation Standards

### Format Rules

- All docs use **Markdown** format (`.md`)
- Files are named with `kebab-case` (e.g., `setup-guide.md`)
- Use consistent heading hierarchy: H1 → H2 → H3
- Include "Last Updated" date in every doc
- Link to related documentation where relevant

### Status Indicators

| Badge | Meaning |
|-------|---------|
| 🔴 Critical | Must have before first release |
| 🟡 Important | Should have before first commit |
| 🟢 Standard | Nice to have, as needed |

---

## Getting Started

### For New Developers

1. Read this README.md (you're here!)
2. Go to [Setup Guide](../01-quickstart/setup.md) and set up your environment
3. Complete the [First Feature Tutorial](../01-quickstart/first-feature.md)
4. Review [Coding Conventions](../01-quickstart/conventions.md)

### For Existing Developers

- Check [Development Workflow](../05-workflows/development-workflow.md) for current processes
- Read [Code Review Checklist](../05-workflows/code-review.md) before submitting PRs
- Reference [Tech Stack Doc](../02-architecture/tech-stack.md) when making technology decisions

---

## Contributing to Documentation

### When to Update Docs

| Document Type | When to Update | Who Updates |
|---------------|----------------|-------------|
| Quick Start | Tools/frameworks change, setup breaks | DevOps/Lead |
| Architecture | Major architectural changes | Architect/Lead |
| Contracts | API/interface changes | Feature Developer + Reviewer |
| Features | Feature is created/modified | Feature Developer |
| Workflows | Process changes agreed by team | All Contributors |

### Documentation Quality Checklist

Before submitting a PR that changes documentation:

- [ ] Is the content accurate and up-to-date?
- [ ] Are all links working (no broken references)?
- [ ] Is the formatting consistent with other docs?
- [ ] Does it follow the naming conventions?
- [ ] Is there an "Last Updated" date?
- [ ] Are related documents linked?

---

## File Structure

```
docs/
├── README.md                    # This file - navigation hub
├── review/                      # Review folder (temporary)
│   └── foundation/              # Foundation docs awaiting approval
├── 01-quickstart/               # Onboarding docs
├── 02-architecture/             # System design & ADRs
│   └── adr/                     # Architecture Decision Records
├── 03-contracts/                # Interface specifications
├── 04-features/                 # Feature documentation
├── 05-workflows/                # Process documentation
├── 06-reference/                # Technical reference
├── 07-operations/               # Operations & maintenance
├── 08-handover/                 # Handover documentation
├── 09-examples/                 # Code examples & samples
├── 10-changelog/                # Release history
└── templates/                   # Documentation templates
```

---

## Review Process

### Foundation Phase (Current)

The following files are in `docs/review/foundation/` awaiting approval:

| File | Purpose | Status |
|------|---------|--------|
| README.md | Main navigation hub | ✅ Ready for review |
| adr-template.md | ADR format standard | ✅ Ready for review |
| handover-checklist.md | Handover process template | ✅ Ready for review |
| tech-stack.md | Technology choices rationale | 🟡 In progress |

### Moving Files to Production

1. Review the files in `docs/review/foundation/`
2. Confirm they meet project standards
3. Move approved files to their permanent locations
4. Remove from review folder
5. Update this index if needed

---

## Contact & Support

- **Documentation Questions:** Open an issue on GitHub
- **Process Changes:** Discuss in team meetings
- **Urgent Issues:** Tag @documentation-team in Slack

---

**Last Updated:** 2026-04-18  
**Review Status:** Foundation Phase - Awaiting Team Approval  
**Next Review Date:** 2026-04-25
