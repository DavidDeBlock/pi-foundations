#!/usr/bin/env python3
"""
label_machine.py — Pure label state machine for issue lifecycle
(issue #50).

Six state labels, exactly one active per issue, swapped (never
stacked) as work progresses:

    needs-triage ──(human triage)──▶ ready-for-agent
    ready-for-agent ──(loop claims)──▶ status:in-progress
    status:in-progress ──(evidence gates pass)──▶ awaiting-manual-check
    status:in-progress ──(breaker parks)──▶ status:parked
    status:parked ──(human re-entry)──▶ ready-for-agent
    status:blocked — human-applied hold from several states

This module is **pure**: no I/O, no GitHub, no clock. It decides;
``flow_dispatcher`` (claim/finalize) and ``GithubClient`` execute.

Why the single-swap rule matters:
    Pickup is gated on ``ready-for-agent``. The moment a run claims
    an issue, that label is *removed* (swapped for
    ``status:in-progress``) — no second run can pick the issue up,
    even if local locks are bypassed (same repo cloned twice, two
    machines). GitHub is the authoritative claim store.

Why parked ≠ awaiting-manual-check:
    ``awaiting-manual-check`` means "done, please verify".
    ``status:parked`` means "I failed, please rescue". Merging them
    would hide failures on the board.

Label names are defaults via :class:`LabelConfig` — overridable per
project once the config cascade (#51) lands.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


# ─── Config ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class LabelConfig:
    """The label vocabulary. Defaults are the canonical names;
    every pure function takes an optional config so projects can
    rename labels without touching engine code."""
    needs_triage: str = "needs-triage"
    ready: str = "ready-for-agent"
    in_progress: str = "status:in-progress"
    parked: str = "status:parked"
    awaiting_manual_check: str = "awaiting-manual-check"
    blocked: str = "status:blocked"
    type_prd: str = "type:prd"

    @property
    def state_labels(self) -> tuple:
        """The six mutually-exclusive state labels."""
        return (
            self.needs_triage,
            self.ready,
            self.in_progress,
            self.parked,
            self.awaiting_manual_check,
            self.blocked,
        )


#: The default vocabulary. Most callers pass nothing.
DEFAULT_LABELS = LabelConfig()


# ─── Transition table ────────────────────────────────────────────────────
#
# Keys are the *current* state (``None`` = no state label present).
# Values are the states a swap may target. Human and machine
# transitions share one table — the machine simply only ever
# performs a subset (claim, park, success) today.

def _transitions(cfg: LabelConfig) -> dict:
    return {
        None: {cfg.needs_triage, cfg.ready},              # intake
        cfg.needs_triage: {cfg.ready, cfg.blocked},
        cfg.ready: {cfg.in_progress, cfg.needs_triage, cfg.blocked},
        cfg.in_progress: {
            cfg.parked,                 # breaker park (#47)
            cfg.awaiting_manual_check,  # success, evidence passed
            cfg.ready,                  # release claim / abort
        },
        cfg.parked: {cfg.ready},                          # human re-entry only
        cfg.awaiting_manual_check: {cfg.ready, cfg.in_progress},
        cfg.blocked: {cfg.needs_triage, cfg.ready},       # unblocked
    }


# ─── Value objects ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class LabelSwap:
    """The add/remove lists needed to move an issue to a new state.

    ``add`` always has exactly one entry (except no-op swaps, where
    both lists are empty). ``remove`` carries every state label
    currently present except the target — including stacked
    (corrupt) labels, so a swap also *heals* the board.
    """
    add: tuple
    remove: tuple
    to_state: str


# ─── Queries ─────────────────────────────────────────────────────────────


def current_state(labels: list, cfg: LabelConfig = DEFAULT_LABELS) -> Optional[str]:
    """Return the issue's single active state label, or ``None``.

    Returns ``None`` both when no state label is present AND when
    multiple are stacked (corrupt) — callers that need to distinguish
    can inspect :func:`present_state_labels` directly.
    """
    present = present_state_labels(labels, cfg)
    return present[0] if len(present) == 1 else None


def present_state_labels(labels: list, cfg: LabelConfig = DEFAULT_LABELS) -> list:
    """All state labels currently on the issue (ideally 0 or 1)."""
    states = set(cfg.state_labels)
    return [l for l in (labels or []) if l in states]


def can_transition(
    from_state: Optional[str],
    to_state: str,
    cfg: LabelConfig = DEFAULT_LABELS,
) -> bool:
    """True iff the transition table allows ``from_state → to_state``.

    ``from_state=None`` means "no single active state" (unlabeled or
    corrupt) — only intake targets are allowed from there.
    """
    if to_state not in cfg.state_labels:
        return False
    return to_state in _transitions(cfg).get(from_state, set())


def is_pickup_eligible(labels: list, cfg: LabelConfig = DEFAULT_LABELS) -> bool:
    """True iff an autonomous loop may pick this issue up.

    The contract (issue #50):
      * ``ready-for-agent`` is the ONLY state label present
      * ``type:prd`` is absent — PRDs are context, never work items
    """
    if cfg.type_prd in (labels or []):
        return False
    return present_state_labels(labels, cfg) == [cfg.ready]


# ─── Decisions ───────────────────────────────────────────────────────────


def apply_swap(
    labels: list,
    to_state: str,
    cfg: LabelConfig = DEFAULT_LABELS,
) -> Optional[LabelSwap]:
    """Decide the label mutation to move an issue to ``to_state``.

    Returns ``None`` when the transition is forbidden. Returns a
    no-op swap (empty add/remove) when the issue is already solely
    in ``to_state``. When multiple state labels are stacked
    (corrupt board), any swap is allowed and *heals*: every stacked
    state label is removed.
    """
    if to_state not in cfg.state_labels:
        return None
    present = present_state_labels(labels, cfg)
    if present == [to_state]:
        return LabelSwap(add=(), remove=(), to_state=to_state)
    if len(present) > 1:
        # Corrupt board (stacked states) — heal unconditionally.
        return LabelSwap(
            add=(to_state,),
            remove=tuple(l for l in present if l != to_state),
            to_state=to_state,
        )
    from_state = present[0] if present else None
    if not can_transition(from_state, to_state, cfg):
        return None
    return LabelSwap(
        add=(to_state,),
        remove=tuple(present),
        to_state=to_state,
    )


def filter_pickup(issues: list, cfg: LabelConfig = DEFAULT_LABELS) -> list:
    """Filter issue-like objects down to the pickup-eligible ones.

    "Issue-like" = anything with a ``labels`` attribute (e.g.
    :class:`github_client.Issue`). Returns a new list; input order
    is preserved.
    """
    return [i for i in issues if is_pickup_eligible(getattr(i, "labels", []), cfg)]
