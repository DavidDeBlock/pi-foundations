#!/usr/bin/env python3
"""
breaker.py — Circuit-breaker policy for the flow engine (issue #47).

A pure, side-effect-free module: it takes flow state and limits and
returns a *decision*. The flow engine (``flow_engine.run_flow``) asks
this module what to do; it never performs I/O, never touches GitHub,
never reads the clock. That makes every cap boundary exhaustively
unit-testable.

Why this module exists (the incident):
    The builder↔reviewer transition loop (``reviewer.on_reject →
    builder``) once ran ~900 iterations across repeated autonomous
    runs and consumed a weekly token allowance in hours. The engine
    had a blunt ``_MAX_ITERATIONS`` guard, but reviewer rejections
    were never *counted*, and when the guard tripped nothing
    changed — the issue was re-picked on the next backlog scan.
    This module is the counting layer; parking (state change that
    removes the issue from pickup) is what closes the cross-run
    loop.

Design rules:

  * A **round** is one reviewer rejection that routes back to
    builder. Only ``reviewer`` rejections count — ``test_runner``
    already has its own escalation (``max_rejects_before_diagnostic``).
  * At the cap, the decision is **park immediately** — no diagnostic
    detour, no model escalation. The last reviewer verdict becomes
    the park-comment content.
  * Limits come from the flow config's optional ``breaker`` key;
    absent or invalid values fall back to safe defaults (fail
    closed: any sane configuration ends in a park, never in an
    unbounded loop).
"""

from __future__ import annotations

from dataclasses import dataclass

# ─── Defaults ────────────────────────────────────────────────────────────

#: Default number of reviewer rejection rounds tolerated before
#: parking. 2 means: reviewer rejects → builder gets one more
#: attempt → reviewer rejects again → park. Round N+1 never starts.
DEFAULT_MAX_REVIEW_ROUNDS = 2

#: Decision actions. Stringly-typed (not Enum) to stay consistent
#: with the rest of the engine's status strings ("success",
#: "reject", ...).
ACTION_CONTINUE = "continue"
ACTION_PARK = "park"


# ─── Value objects ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class BreakerLimits:
    """Configured caps. Immutable."""
    max_review_rounds: int = DEFAULT_MAX_REVIEW_ROUNDS


@dataclass(frozen=True)
class BreakerState:
    """The counters the policy reads. Maintained by the flow engine,
    passed in fresh on every evaluation. Immutable."""
    review_rounds: int = 0


@dataclass(frozen=True)
class BreakerDecision:
    """The policy's answer: what to do, and why (human-readable,
    suitable for the park comment)."""
    action: str  # ACTION_CONTINUE | ACTION_PARK
    reason: str = ""


# ─── Policy ──────────────────────────────────────────────────────────────


def evaluate(state: BreakerState, limits: BreakerLimits) -> BreakerDecision:
    """Decide whether the flow may continue or must park.

    Parks when ``state.review_rounds`` has reached
    ``limits.max_review_rounds``. The check is ``>=`` (not ``==``)
    so a state that somehow overshoots still parks — fail closed.

    Pure: same inputs → same decision, always.
    """
    if state.review_rounds >= limits.max_review_rounds:
        return BreakerDecision(
            action=ACTION_PARK,
            reason=(
                f"review round cap reached "
                f"({state.review_rounds}/{limits.max_review_rounds})"
            ),
        )
    return BreakerDecision(action=ACTION_CONTINUE)


def record_reviewer_rejection(state: BreakerState) -> BreakerState:
    """Return a new state with ``review_rounds`` incremented.

    The engine calls this on every ``reviewer → reject`` outcome,
    then passes the result to :func:`evaluate`. Kept as a function
    (rather than inline ``+ 1`` at the call site) so the *definition
    of a round* lives in exactly one place.
    """
    return BreakerState(review_rounds=state.review_rounds + 1)


# ─── Config parsing ──────────────────────────────────────────────────────


def limits_from_config(raw: object) -> BreakerLimits:
    """Build :class:`BreakerLimits` from a flow config's ``breaker``
    value (arbitrary JSON). Defensive and fail-closed:

      * non-dict / missing → defaults
      * missing ``max_review_rounds`` → default
      * non-int or < 1 → default (never allow an unbounded loop)
      * unknown keys → ignored (forward-compat, matches the
        evidence-policy convention)
    """
    if not isinstance(raw, dict):
        return BreakerLimits()
    value = raw.get("max_review_rounds", DEFAULT_MAX_REVIEW_ROUNDS)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        return BreakerLimits()
    return BreakerLimits(max_review_rounds=value)


# ─── Park comment ────────────────────────────────────────────────────────


def format_park_comment(
    review_rounds: int,
    max_review_rounds: int,
    last_verdict: str,
    evidence_summary: str,
) -> str:
    """Render the structured park comment posted on the issue.

    Pure text formatting. The content contract (per the issue AC):
    rounds attempted, the last reviewer verdict, and the evidence
    state — enough for a human to triage the failure in seconds.
    """
    verdict = (last_verdict or "").strip() or "(no verdict text captured)"
    return (
        f"🅿️ **PARKED — review round cap reached "
        f"({review_rounds}/{max_review_rounds})**\n\n"
        f"**Rounds attempted:** {review_rounds}\n\n"
        f"**Last reviewer verdict:**\n{verdict}\n\n"
        f"**Evidence state:** {evidence_summary}\n\n"
        f"The builder and reviewer could not reach agreement within "
        f"the configured round cap. This issue is parked: it will "
        f"not be retried automatically. A human must investigate and "
        f"re-apply `ready-for-agent` to re-enter it."
    )
