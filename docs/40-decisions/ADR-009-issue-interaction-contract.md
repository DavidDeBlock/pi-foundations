# ADR-009: Issue Interaction Contract for Multi-Agent Flows

**Status**: Accepted  
**Date**: 2026-05-28  
**Authors**: David, Pi Agent  

---

## Context

Multiple agent skills (PRD Auditor, Issue Readiness, Archivist, Triage) interact with GitHub issues as part of their workflows. Previously, there was no deterministic contract governing how agents manipulate issue metadata (labels), persist information between handoffs (comments/body edits), or discover each other's work. This caused fragile handoff chains where:

- Labels were not updated consistently when verdicts changed
- Agents couldn't reliably find previous agent findings among human comments
- No clear rule existed for body edits vs append-only comments
- Circular rejection loops occurred because agents worked in isolation

Verdicts and JSON code blocks in templates already provide agent-to-agent consistency. This ADR extends that contract to the **issue layer** — how agents read from and write to GitHub issues.

---

## Decision Drivers

- Agents must be able to parse each other's work without ambiguity
- Issues must remain human-readable for maintainer review
- Label state must reflect flow state deterministically
- Original issue requirements must never be overwritten by agents
- Single source of truth for conventions (not scattered across skills)

---

## Options Considered

### Verdict Format: Separate vs Unified

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A: Keep Separate | Skills use one format, templates use another | No breaking changes to pipeline | Duplication; drift risk; two formats maintained |
| **B: Unified Verdict** | Single JSON block serves both pipeline (`status`) and agents (`labels`, `verdict`) | One source of truth; backward compatible (extractor ignores extra fields) | Slightly larger verdict blocks |

**Selected**: Option B — eliminates duplication while maintaining backward compatibility.

---

### Labels: Verdict-Driven vs Static Table

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A: Verdict-Driven** | Each skill's JSON verdict includes a `labels` field with add/remove instructions | Coupled to reasoning; no separate lookup table | Slightly larger verdict payloads |
| B: Static Table | Labels defined in docs, skills reference by flow state | Centralized label definitions | Decoupled from context; drift risk |

**Selected**: Option A — labels stay coupled to the decision that produced them.

### Comments: Structured Markdown+JSON vs JSON-Only

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A: Structured Markdown + Collapsible JSON** | Human-readable prose top, `<details>` wrapped JSON bottom | Readable by humans; parseable by agents | Slightly more verbose |
| B: JSON-Only | Pure JSON code block comments | Fully machine-parseable | Hard for humans to scan |

**Selected**: Option A — issues are read by humans too; collapsible JSON keeps it clean.

### Body Edits vs Comments

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A: Strict Separation** | Agents never edit body; comments only | Clean audit trail | Issues less self-contained |
| B: Structured Agent Sections | All agents can edit designated body sections | Self-contained issues | Conflict risk; complex parsing |
| C: Hybrid (Archivist-only) | Archivist edits body via markers; all others use comments | Best of both — self-contained + clean history | One exception to the rule |

**Selected**: Option C — Archivist's job is enriching with codebase context, which belongs in the issue body for builders. Evaluators (Auditor, Readiness) stay in comments only.

### Comment Discovery: Prefix vs JSON Tag

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A: Emoji Prefix** | `🤖 Agent Handoff: <skill-name>` at top of comment | Visible to humans; simple string matching | Convention-based |
| B: JSON Meta Tag | `"_meta": {"type": "agent-handoff"}` in JSON | Machine-verifiable; versioned | Requires full JSON parsing |

**Selected**: Option A — immediately visible, easy to implement, sufficient for our use case.

### Enforcement: Shared Doc vs Inline Skills

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A: Shared Reference Doc** | Single `.pi/ISSUE-INTERACTION.md`; skills reference it | One source of truth; easy to update | Extra file load per skill |
| B: Inline Each Skill | Full conventions baked into each SKILL.md | Self-contained | Drift risk across 5+ files |

**Selected**: Option A — conventions will evolve; single doc prevents drift.

### Handoff Awareness

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A: Always Read Previous** | Agents parse all `🤖 Agent Handoff:` comments before acting | Prevents duplication; builds on prior work | Minor parsing overhead |
| B: Selective Reading | Only certain agents read others' handoffs | Less overhead | Complex matrix to maintain |

**Selected**: Option A — prevents circular rejection loops and wasted effort.

### Re-Review Trigger

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A: Archivist Drives Transition** | After enriching, Archivist applies labels signaling readiness for re-review | Clean separation; label-based pipeline signals | Requires label enforcement |
| B: Manual Trigger | Maintainer manually re-runs review after Archivist comment | Full human control | Defeats automation purpose |

**Selected**: Option A — keeps agents focused on their own job while using labels as the signal between them.

---

## Decision Outcome

### Eight Conventions Established

#### 0. Unified Verdict Format (Dual Consumer)
Every agent emits **one JSON verdict block** that serves two consumers:
- `status` (`approved`/`rejected`) → consumed by Maestro Pipeline (`verdict_extractor.py`) for phase control
- `verdict`, `labels`, `findings` → consumed by agents reading GitHub issues for handoffs

This eliminates the previous duplication where skills and prompt templates maintained separate verdict formats.

```json
{
  "status": "approved",
  "verdict": "ready",
  "details": "All ACs verified",
  "issues": [],
  "labels": { "add": ["ready-for-agent"], "remove": [] },
  "findings": []
}
```

`verdict_extractor.py` only reads `status` — extra fields are ignored (safe to add).

---

### Seven Additional Conventions

#### 1. Verdict-Driven Labels
Every skill's JSON verdict includes a `labels` field:

```json
{
  "verdict": "rejected",
  "reasons": ["missing ACs"],
  "labels": {
    "add": ["needs-info"],
    "remove": ["ready-for-agent"]
  }
}
```

The consuming agent executes `gh issue edit <number> --add-label/--remove-label` based on this data.

#### 2. Structured Comment Format
All handoff comments follow this template:

```markdown
## 🤖 Agent Handoff: `<skill-name>`

> *This was generated by AI during [flow name].*

### Summary
One-line summary of what this agent did and found.

### Findings / Advice
- Point 1
- Point 2

---
<details><summary>Structured Data</summary>

```json
{
  "agent": "<skill-name>",
  "flow": "<flow-name>",
  "verdict": "<verdict>",
  "labels": { "add": [], "remove": [] },
  "findings": [ ... ]
}
```

</details>
```

#### 3. Body Edits: Archivist Only
- **Archivist** may edit the issue body within `<!-- AGENT-FINDINGS-START -->` / `<!-- AGENT-FINDINGS-END -->` markers
- All other agents use comments only — never edit the body
- If markers don't exist, Archivist creates them and appends its findings

#### 4. Comment Discovery Prefix
Agents identify machine-readable handoffs by scanning for:
```
🤖 Agent Handoff: <skill-name>
```

Human comments without this prefix are ignored during structured parsing.

#### 5. Shared Reference Doc
All conventions documented in `.pi/ISSUE-INTERACTION.md`. Every relevant skill references this file rather than duplicating conventions inline.

#### 6. Always Read Previous Handoffs
Before acting on an issue, agents scan for `🤖 Agent Handoff:` comments and parse their JSON blocks to:
- Skip already-resolved gaps
- Build on Archivist's codebase findings
- Avoid asking the same questions twice

Previous handoffs are treated as **context**, not authority. The agent still makes its own verdict.

#### 7. Archivist Drives Re-Review Transition
After enriching the issue body, Archivist posts a handoff comment with labels that signal readiness:

```json
{
  "agent": "archivist",
  "verdict": "enriched",
  "labels": { "add": ["ready-for-agent"], "remove": ["needs-info"] }
}
```

This signals the pipeline (or maintainer) that the issue is ready for another review pass.

### Consequences

**Positive:**
- Single verdict format serves both pipeline and agents — no duplication
- `verdict_extractor.py` unchanged (only reads `status`) — backward compatible
- Deterministic label transitions tied to agent verdicts
- Clean audit trail of agent interactions via structured comments
- Issues remain self-contained through Archivist body enrichment
- No circular rejection loops — agents build on each other's work
- Single source of truth for conventions prevents drift

**Negative:**
- Verdict blocks are slightly larger (extra `labels`, `findings` fields) but still fit within token limits
- Slightly larger comment payloads due to collapsible JSON blocks
- Agents must parse previous handoffs before acting (minor overhead)
- One exception rule (Archivist edits body) that must be remembered

---

## References

- [triage-labels.md](../agents/triage-labels.md) — Canonical label definitions
- [.pi/skills/triage/SKILL.md](../../.pi/skills/triage/SKILL.md) — Triage skill implementation
- [.pi/skills/prd-auditor/SKILL.md](../../.pi/skills/prd-auditor/SKILL.md) — PRD Auditor skill
- [.pi/skills/issue-readiness/SKILL.md](../../.pi/skills/issue-readiness/SKILL.md) — Issue Readiness skill
- [ADR-008: Flow-First Architecture](./ADR-008-flow-first-architecture.md) — Related flow design decisions

---

## History

| Date | Change | Author |
|------|--------|--------|
| 2026-05-28 | Created and accepted | David, Pi Agent |
