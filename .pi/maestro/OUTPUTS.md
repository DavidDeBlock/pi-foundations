# Maestro — Artifact & Output Contracts

This document defines every data artifact produced, consumed, or exchanged by the Maestro orchestrator. It is the **single source of truth** for schemas, formats, and handoff rules across phases, skills, and engine logic.

---

## 📦 Artifact Registry

| Artifact | Producer | Format / Location | Schema Reference | Consumer(s) |
|----------|----------|-------------------|------------------|-------------|
| Phase Verdict (Primary) | Session log parsing (`verdict_extractor`) | `.pi/maestro/sessions/<issue>/<flow>-<phase>-<timestamp>.jsonl` | [§1a](#1a-session-logs-jsonl-primary-verdict-source) | `flow_engine.py`, fallback chain |
| Phase Result JSON (Fallback) | LLM Agents (via RPC) | `.pi/maestro/state/slice-result.json` | [§1b](#1b-phase-result-slice-resultjson-fallback) | `rpc_client.py`, legacy compatibility |
| GitHub Phase Comment | Engine (`github_client`) | Issue comments on GitHub | [§2](#2-github-phase-comments) | Resume logic, human review, comment parser |
| Drift Report (`.md`) | `analyze` phase agent | `.pi/maestro/state/drift-report.md` | [§3](#3-drift-report-drift-reportmd) | Human reviewer, future PRD generator |
| PRD (GitHub Issue) | `to-prd` skill | GitHub Issue body + `[PRD]` label | [§4](#4-prd-github-issue-body) | `to-issues`, gap-check pipeline |
| Implementation Issues | `to-issues` skill | GitHub Issue bodies + `needs-triage` label | [§5](#5-implementation-issues-github-issue-bodies) | Builder phase, autonomous loop |

---

---

## 1a. Session Logs (`.jsonl`) — Primary Verdict Source

**Location:** `.pi/maestro/sessions/<issue_num>/<flow>-<phase>-<ISO8601>.jsonl`  
**Producer:** Pi agent runtime during skill execution  
**Consumer:** `verdict_extractor.extract_phase_verdict()`, `session_reader.parse_session_log()`

### Session Directory Layout (Phase 1+)
```
.pi/maestro/sessions/
└── <issue_num>/
    ├── builder-reviewer-builder-2026-05-26T10:30:00.jsonl   # Builder phase
    └── builder-reviewer-reviewer-2026-05-26T10:35:00.jsonl  # Reviewer phase
```

### Expected Events
| Event Type | Role | Key Fields |
|------------|------|----------|
| `model_change` | system | `provider`, `modelId` |
| `toolCall` | assistant | `id`, `name`, `arguments` |
| `text` | assistant/toolResult | `content` (array or string) |
| `error` / `exception` | any | `message`, `stackTrace` |

### Verdict Extraction Contract
`verdict_extractor.extract_phase_verdict()` returns:
```json
{
  "status": "approved" | "rejected" | "no_gaps" | null,
  "issues": [],
  "raw_text": "..."
}
```

**Patterns matched (in priority order):**
1. ✅/❌ emoji + verdict text (`✅ APPROVED`, `❌ REJECTED`)
2. JSON-like status field (`"status":"approved"`, `STATUS: rejected`)
3. Standalone approved/rejected keywords
4. No gaps / no significant gaps found

**Fallback chain:** If `extract_phase_verdict()` returns `null` → read `.pi/maestro/state/slice-result.json`. If both fail → error state.

### Rules
- Each session log is a single JSONL file with one event per line.
- Malformed or truncated logs are silently skipped (never crash).
- The most recent `.jsonl` file in an issue directory is the active session.
- Old subdirectory layout (`<issue>-<flow>-<phase>-<ts>/`) is deprecated but still supported by `resolve_session_log()` for backward compatibility.

---

## 1b. Phase Result (`slice-result.json`) — Fallback Source

**Location:** `.pi/maestro/state/slice-result.json` (relative to project root)  
**Writer:** Any LLM-driven phase agent invoked via RPC  
**Reader:** `rpc_client.read_result_file()` — **only used when session log parsing returns no verdict**

### Canonical Schema
```json
{
  "status": "success" | "rejected" | "no_gaps",
  "issues": [],            // Array of strings. Required if status === "rejected". Empty otherwise.
  "details": "",           // Optional summary for terminal display (max 500 chars)
  "verdict": ""            // Optional phase-specific label (e.g., "reviewer-approved", "self-rejected")
}
```

### Rules
- `status` must match one of the three enum values exactly. No aliases, no typos.
- `issues` is always an array of human-readable strings describing what failed or needs fixing. Omit entirely or set to `[]` when approved/no_gaps.
- `details` and `verdict` are optional metadata. The flow engine ignores them for transitions but uses them in terminal output.
- **No phase-specific top-level keys** (e.g., old `"slice": 42` fields must be removed).
- File must be valid JSON. Malformed files → treat as `error`.

### Engine Mapping (Historical Note)
Previously, the engine mapped `"approved"` → `"success"`, `"no_gaps"` → `"no_gaps"`, everything else → `"reject"`. This contract removes that mapping: agents now write the exact status string used in transition tables.

---

## 2. GitHub Phase Comments

**Format:** Strict markdown block posted as an issue comment  
**Writer:** `github_client.post_phase_comment()`  
**Reader:** `comment_parser.parse_phase_output()`, resume logic, human review

### Template
```markdown
---
### PHASE_OUTPUT: {status}
{phase_name}: {details}
Issues: [{json_array_of_issues_or_empty}]
### END_PHASE_OUTPUT
---
```

### Status Enum
- `success` — Phase completed without rejection
- `rejected` — Phase found issues (builder self-reject, reviewer critique, etc.)
- `no_gaps` — Audit/analysis phase found no significant drift or missing work
- `system_error` — Engine/RPC/timeout failure

### Rules
- Must use exact markdown fence format (`---` on separate lines).
- `{status}` must match the canonical enum above.
- `{issues}` is a JSON string array for machine parsing (e.g., `[\"TS6059\", \"Missing test\"]`). Empty array `[]` when approved.
- Regex pattern: `/---\s*\n### PHASE_OUTPUT:\s*(success|rejected|no_gaps|system_error)\s*\n(.+?)\nIssues:\s*(\[.*?\])\s*\n### END_PHASE_OUTPUT\s*\n---/ms`
- Comments are appended, never edited. Resume logic reads the latest matching block.

---

## 3. Drift Report (`drift-report.md`)

**Location:** `.pi/maestro/state/drift-report.md`  
**Writer:** `analyze` phase agent (via `context-sync-audit` skill)  
**Consumer:** Human reviewer, future PRD generator, gap-check pipeline

### Required Structure
```markdown
# Drift Report — {phase_name} on #{issue_number}
Generated: {ISO8601 timestamp with timezone}
Agent Model: {provider/model used}

## Summary
- 🔴 Critical: {N} | 🟡 Medium: {M} | 🟢 Low/Verified: {L}

## Findings
### 🔴 Critical
| # | Category | Description | Evidence (file:line) |
|---|----------|-------------|----------------------|
| 1 | stale-description | ... | `docs/20-architecture/_index.md:42` |

### 🟡 Medium
| # | Category | Description | Evidence |
|---|----------|-------------|----------|

### 🟢 Low / Verified
| # | Category | Description | Evidence |
|---|----------|-------------|----------|

## Recommendations
- Actionable items for the next phase (e.g., to-prd, to-issues) to address.
```

### Categories
- `undocumented-feature` — Code exists but docs don't mention it
- `stale-description` — Docs describe behavior that no longer matches code
- `renamed-moved` — Files/modules relocated without doc updates
- `removed-but-documented` — Docs reference deleted/retired functionality

### Rules
- Must include all four sections: Header, Summary, Findings, Recommendations.
- Severity counts must match the number of rows in their respective tables.
- Evidence references must be valid relative paths or file:line pairs when available.
- If no findings exist, tables may be empty but section headers must remain.

---

## 4. PRD (GitHub Issue Body)

**Producer:** `to-prd` skill  
**Consumer:** `to-issues` skill, gap-check pipeline (`run_gap_check`)  
**Labels:** `[PRD]` prefix in title, `parent-prd` label

### Required Sections
1. **Problem Statement** — User-facing problem description
2. **Solution** — High-level approach from user perspective
3. **User Stories** — Numbered list: `As an <actor>, I want a <feature>, so that <benefit>`
4. **Implementation Decisions** — Modules, interfaces, architecture notes (no file paths or code snippets)
5. **Testing Decisions** — What to test, why external behavior matters, prior art references
6. **Out of Scope** — Explicitly excluded areas
7. **Further Notes** — Anything else relevant

### Rules
- Title must start with `[PRD] `.
- Must use `parent-prd` label (never `needs-triage`).
- User stories must be extensive and cover all feature aspects.
- Implementation Decisions must stay architectural; never commit to file paths or code structure that will rot quickly.

---

## 5. Implementation Issues (GitHub Issue Bodies)

**Producer:** `to-issues` skill  
**Consumer:** Builder phase, autonomous loop (`app_shell.py`)  
**Labels:** `needs-triage`

### Required Sections
```markdown
## Parent

A reference to the parent issue on the issue tracker (if applicable).
Format: `#NNN` or full URL. Omit if no parent.

## What to build

Concise description of this vertical slice. Describe end-to-end behavior, not layer-by-layer steps.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

- `#NNN` (reference blocking ticket)
Or: "None - can start immediately" if no blockers.
```

### Rules
- Each issue must represent a **tracer bullet** (thin vertical slice cutting through all layers).
- Acceptance criteria must use markdown checkboxes (`- [ ]`).
- Parent reference format: `## Parent\n\n#NNN` (parsed by `_extract_parent_issue()` in `flow_engine.py`)
- Labels must include `needs-triage`. No other triage labels at creation time.
- Issues are published in dependency order (blockers first).

---

## 6. Session Logs (`.jsonl`)

**Location:** `/tmp/maestro-sessions/<uuid>.jsonl` (managed by RPC client)  
**Producer:** Pi agent runtime during skill execution  
**Consumer:** `session_reader.py`, terminal metadata display

### Expected Events
| Event Type | Role | Key Fields |
|------------|------|------------|
| `model_change` | system | `provider`, `modelId` |
| `toolCall` | assistant | `id`, `name`, `arguments` |
| `text` | assistant/toolResult | `content` (array or string) |
| `error` / `exception` | any | `message`, `stackTrace` |

### Consumer Contract
- `session_reader.py` pairs `toolCall` IDs with matching `toolResult` events.
- Extracts: model name, duration (start→end timestamps), file operations count/success-fail split, error summary.
- Malformed or truncated logs → graceful fallback in terminal display (no crash).

---

## 🔄 Data Flow Mapping

```
GitHub Issue (needs-triage)
       │
       ▼
app_shell.run() ──► flow_engine.load_flow() ──► build_prompt(phase.tmpl + context vars)
       │                                                    │
       │                                                    ▼
       │                                           rpc_client.run_rpc()
       │                                                    │
       │                                                    ▼
       │                                             Agent executes skill
       │                                                    │
       │                         ┌──────────────────────────┤
       │                         │ Session log (.jsonl)     │
       │                         │ Primary verdict source   │
       │                         ▼                          │
       │               extract_phase_verdict()              │
       │                         │                          │
       │           null ─────────┘ (fallback)
       │           │                            │
       │           ▼                            ▼
       │  slice-result.json            verdict found
       │  Fallback source              │
       │           │                    ▼
       │           └────► flow_engine.run_phase() maps status
       │                             │
       │              success → next phase / finish
       │              rejected  → post PHASE_OUTPUT comment → context["previous_output"] → retry/review
       │              no_gaps   → finish (gap-check only)
       │              error     → diagnostic pass → context["diagnostic_insights"] → retry
```

**Gap-Check Pipeline:**
```
parent-prd issue body
       │
       ▼
analyze phase ──► writes drift-report.md + slice-result.json (no_gaps or approved)
       │
       ▼ (if gaps found)
to-prd skill ──► creates/updates GitHub PRD issue with [PRD] label
       │
       ▼
to-issues skill ──► publishes vertical slice issues with needs-triage label
       │
       ▼
Gap-check closes parent PRD issue
```

---

## 📏 Global Rules & Conventions

1. **Path Standardization:** All file artifacts use paths relative to project root: `.pi/maestro/state/<name>.<ext>`
2. **No Inline State in Prompts:** Context variables (`{previous_output}`, `{diagnostic_insights}`) are injected at runtime, never hardcoded in templates.
3. **Idempotent Writes:** Overwriting `slice-result.json` or `drift-report.md` is safe; they are recreated each phase run.
4. **Error Fallbacks:** If a required artifact file is missing/malformed, the engine treats it as an error and routes to diagnostic pass (not silent failure).
5. **Versioning:** This document follows semantic versioning for schema changes. Backward-compatible additions allowed; breaking changes require version bump + migration notes.

---

## 🔜 Future Enforcement (Out of Scope for Now)

These mechanisms will be added later to automatically validate compliance with this contract:

- [ ] JSON Schema validation for `slice-result.json` before engine reads it
- [ ] Markdown linting/structural checks for `drift-report.md` and issue bodies
- [ ] PRD checkbox parser wired into gap-check pipeline (`parse_prd_checkboxes()` is currently dead code)
- [ ] CI step to verify all `.tmpl` files contain required variable placeholders before phase execution
- [ ] Comment format validator in `github_client.py` with unit tests

*This document is reference-only. Implementations will be hooked up separately when ready.*
