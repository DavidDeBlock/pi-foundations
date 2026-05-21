# Issue Tracker Labels & Workflow

This file defines the canonical labels used in this repo's issue tracker. It is split into three categories: **Triage Roles** (skill mappings), **Priority/Status** (workflow signals), and **Informational** (visual tags).

---

## 1. Canonical Triage Roles
The skills speak in terms of five canonical triage roles. This table maps those roles to the actual label strings used here.

| Label in Skill | Label in Tracker | Meaning                                  |
|----------------|------------------|------------------------------------------|
| `needs-triage` | `needs-triage`   | Maintainer needs to evaluate this issue  |
| `wontfix`      | `wontfix`        | Will not be actioned                     |

*Note: `ready-for-agent` and `ready-for-human` have been consolidated into a single `ready-for-agent` label to streamline the pipeline flow.*

---

## 2. Priority (Scheduling)
Used by pipelines to determine execution order.

| Label | Color | Meaning |
|-------|-------|---------|
| `priority:p0` | 🔴 Red | **Critical** — Stop everything, fix/do now. |
| `priority:p1` | 🔵 Blue | **Normal** — The standard backlog work. |
| `priority:p2` | 🟢 Green | **Low** — Nice to have, do when free. |

---

## 3. Status/Flow (Pipeline Triggers)
These are the labels your pipelines will watch for to decide what action to take next.

| Label | Meaning | Pipeline Trigger |
|-------|---------|------------------|
| `needs-triage` | New entry point | **Triage Pipeline** (assigns priority, moves to next step) |
| `status:investigating` | Needs debugging first | **Debugger Agent** (runs diagnostics) |
| `ready-for-agent` | Fully scoped, waiting for builders | **Implementation Pipeline** (runs Builder/Reviewer) |
| `awaiting-manual-check` | Code done, needs human review | **Manual Review** (you check it before closing) |
| `status:blocked` | Waiting on external dependency | Skipped by all pipelines until unblocked |

---

## 4. Informational (Visual Tags)
These don't trigger pipelines automatically — they're purely for visual clarity on your board.

| Label | Meaning |
|-------|---------|
| `info:brainstorming` | Raw idea, needs refinement/grilling. |
| `info:planning` | PRD written or slices being defined. |
| `info:documentation` | Fully sliced/ready for build (replaces 'sliced'). |

---

## Usage Examples
- **New Issue**: Created with `needs-triage`. Triage pipeline picks it up, assigns priority (`p0`, `p1`, or `p2`), and moves it to the next stage.
- **Bug Report**: If a bug needs investigation before implementation, apply `status:investigating`. Once the root cause is found and fixed, change to `ready-for-agent`.
- **Feature Request**: Created with `info:brainstorming`. After you grill the idea and write the PRD, change to `info:planning`. Once slices are published, change to `info:documentation` and add `ready-for-agent`.
