# Agent Skills & System Configuration

## docs/agents/ — System Agent Configuration

This folder defines the operational rules and domain context for all agents. It is **part of the system**, not just documentation. Agents must follow these definitions strictly.

- `domain.md`: Domain map, glossary, and business logic constraints.
- `issue-tracker.md`: GitHub issue workflow (labels, automation).
- `triage-labels.md`: Triage roles mapped to label strings.

---

### Issue tracker

Issues are tracked as GitHub issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical triage roles map directly to default label strings (`needs-triage`, `needs-info`, etc.). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` + `docs/40-decisions/` at the repo root. See `docs/agents/domain.md`.

---

## 📚 Knowledge System Usage

The `docs/` folder is the **planning and context layer**. It feeds into GitHub Issues but does not replace them.

### How Agents Use Docs
1. **Planning Phase**: When a user asks to plan or think through a feature, load relevant `_index.md` files from:
   - `10-domain/_index.md` — For business rules and glossary terms.
   - `20-architecture/_index.md` — For technical constraints and patterns.
   - `31-planning-notes/_index.md` — To check if the idea was already brainstormed.
   - `40-decisions/_index.md` — To avoid contradicting past ADRs.

2. **Implementation Phase**: Implementers work from self-contained GitHub Issues + PRDs. They do not scan `docs/` unless the issue specifically references a doc file.

3. **Index-First Rule**: Always read `<folder>/_index.md` before scanning raw files. This keeps context minimal and prevents hallucination from stale or irrelevant documents.

### Folder Authority
| Category | Folders | Trust Level |
|----------|---------|-------------|
| Current Truth | `00-current`, `10-domain`, `20-architecture`, `25-system-specs`, `30-plans`, `40-decisions` | High — use for active decisions. |
| Reference Only | `90-archive` | Low — background info only. |
| Agent Rules | `agents`, `50-agent-workflows` | System-level — always follow these. |

### Workflow Summary
```
User Request → Grill/Plan (load _index.md for context) → Create GitHub Issue → Implement from Issue
```
The `docs/` folder is the raw material; GitHub Issues are the execution tracker.
