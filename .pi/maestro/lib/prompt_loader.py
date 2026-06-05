#!/usr/bin/env python3
"""
prompt_loader.py — Load Maestro phase prompts with tool-allowlist metadata.

Supports two on-disk formats:

1. **Markdown with YAML frontmatter** (`.md`) — preferred. Frontmatter declares
   the prompt's ``name``, ``description``, and the ``tools`` list that should
   be enforced when the phase is executed by Pi's agent runtime.

2. **Legacy text templates** (`.tmpl`) — plain text with ``{variable}``
   substitution. Still supported for backward compatibility, but emits a
   deprecation warning to stderr and falls back to phase-type default tools
   (or ``PERMISSIVE_FALLBACK`` if no default is registered).

Precedence for the resolved ``tools`` list (highest wins):

    explicit_tools  >  meta.tools (frontmatter)  >  DEFAULT_TOOLS[phase_name]  >  PERMISSIVE_FALLBACK

Public API:
    - ``DEFAULT_TOOLS``: phase-type → default tool list.
    - ``PERMISSIVE_FALLBACK``: most-permissive list used when nothing else applies.
    - ``LoadedPrompt``: dataclass returned by ``load_prompt``.
    - ``load_prompt(prompts_dir, phase_name, explicit_tools=None)`` — main loader.
    - ``validate_flow_tools(flow_config, prompts_dir)`` — validates a flow's phases.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import yaml


# ─── Tool Defaults ───────────────────────────────────────────────────────

#: Default tool allowlist per phase type.
DEFAULT_TOOLS: dict[str, list[str]] = {
    "scout": ["Read", "Bash", "Grep", "Glob"],
    "builder": ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
    "reviewer": ["Read", "Bash", "Grep", "Glob"],
    "test_runner": ["Read", "Bash"],
    "diagnostic": ["Read", "Bash", "Grep", "Glob"],
    "retrospective": ["Read", "Edit", "Write"],
    "interviewer": ["Read", "Bash", "Write"],
}

#: Most-permissive tool set — used when no other source declares tools.
PERMISSIVE_FALLBACK: list[str] = [
    "Read", "Edit", "Write", "Bash", "Grep", "Glob",
]

#: Recognised tool names — used by ``validate_flow_tools`` to flag typos.
KNOWN_TOOLS: set[str] = {
    "Read", "Edit", "Write", "Bash", "Grep", "Glob",
}


# ─── Result Dataclass ────────────────────────────────────────────────────


@dataclass
class LoadedPrompt:
    """A loaded phase prompt with its tool-allowlist metadata.

    Attributes:
        name: Phase name (from frontmatter, ``phase_name`` argument, or default).
        description: Short description (from frontmatter; empty for ``.tmpl``).
        tools: Resolved tool allowlist, after applying the precedence rules.
        body: The actual prompt text (frontmatter stripped for ``.md`` files,
              or the raw file contents for ``.tmpl``/default).
        source_format: One of ``"md"``, ``"tmpl"``, or ``"default"`` — which
                       on-disk format was used (or the in-memory default).
        deprecation_warning: Non-None for ``.tmpl`` files; the message that
                             was already (or should be) printed to stderr.
    """

    name: str
    description: str
    tools: list[str] = field(default_factory=list)
    body: str = ""
    source_format: str = "default"
    deprecation_warning: Optional[str] = None


# ─── Frontmatter Parsing ─────────────────────────────────────────────────

#: Regex that captures YAML between two ``---`` lines, with a body following.
#: Group 1 = YAML payload, group 2 = body. ``re.DOTALL`` makes ``\n`` match all.
_FRONTMATTER_RE = re.compile(
    r"^---\s*\n(.*?)\n---\s*\n?(.*)",
    re.DOTALL,
)


def _parse_frontmatter(text: str, path: Path) -> tuple[dict, str]:
    """Parse ``---\\n...\\n---\\nbody`` frontmatter from ``text``.

    Returns ``(meta_dict, body)``. Raises ``ValueError`` on malformed input —
    the message includes the file path to help operators locate the issue.
    """
    match = _FRONTMATTER_RE.match(text)
    if not match:
        raise ValueError(
            f"{path} has malformed frontmatter: missing '---' delimiters. "
            f"Expected a YAML block between two '---' lines at the start of the file."
        )

    yaml_payload, body = match.group(1), match.group(2)

    try:
        meta = yaml.safe_load(yaml_payload)
    except yaml.YAMLError as exc:
        raise ValueError(
            f"{path} has invalid YAML in frontmatter: {exc}"
        ) from exc

    if meta is None:
        meta = {}
    if not isinstance(meta, dict):
        raise ValueError(
            f"{path} frontmatter must be a YAML mapping, got {type(meta).__name__}."
        )

    return meta, body.strip()


# ─── Tool Resolution ─────────────────────────────────────────────────────


def _resolve_tools(
    phase_name: str,
    meta: dict,
    explicit_tools: Optional[list[str]],
) -> list[str]:
    """Apply the precedence rules to determine the tool allowlist.

    Precedence (highest first):
        1. ``explicit_tools`` — from flow JSON or caller override.
        2. ``meta["tools"]`` — declared in the prompt's frontmatter.
        3. ``DEFAULT_TOOLS[phase_name]`` — registered default for the phase.
        4. ``PERMISSIVE_FALLBACK`` — last-resort permissive set.
    """
    if explicit_tools is not None:
        return list(explicit_tools)
    meta_tools = meta.get("tools")
    if meta_tools is not None:
        return list(meta_tools)
    if phase_name in DEFAULT_TOOLS:
        return list(DEFAULT_TOOLS[phase_name])
    return list(PERMISSIVE_FALLBACK)


# ─── Default Prompt Body ─────────────────────────────────────────────────


def _default_body(phase_name: str) -> str:
    """Minimal fallback body used when no on-disk prompt exists."""
    return (
        f"## Phase: {phase_name}\n\n"
        f"[default prompt — no .md or .tmpl found for phase '{phase_name}']\n"
    )


# ─── Public API: load_prompt ─────────────────────────────────────────────


def load_prompt(
    prompts_dir: Path,
    phase_name: str,
    explicit_tools: Optional[list[str]] = None,
) -> LoadedPrompt:
    """Load a phase prompt from ``prompts_dir``.

    Looks first for ``<phase_name>.md`` (preferred), then ``<phase_name>.tmpl``
    (legacy). If neither exists, returns an in-memory default with the
    permissive tool set.

    Args:
        prompts_dir: Directory containing ``.md``/``.tmpl`` prompt files.
        phase_name: Phase identifier (e.g., ``"reviewer"``).
        explicit_tools: Optional caller-supplied tool list (e.g., from
                        flow JSON's ``phase.tools``). Bypasses frontmatter.

    Returns:
        ``LoadedPrompt`` populated with the resolved body, tools, and
        a ``source_format`` tag indicating which on-disk format was used.

    Raises:
        ValueError: If a ``.md`` file exists but has malformed frontmatter.
    """
    md_path = prompts_dir / f"{phase_name}.md"
    tmpl_path = prompts_dir / f"{phase_name}.tmpl"

    # 1. Prefer .md with frontmatter.
    if md_path.exists():
        text = md_path.read_text(encoding="utf-8")
        meta, body = _parse_frontmatter(text, md_path)
        tools = _resolve_tools(phase_name, meta, explicit_tools)
        return LoadedPrompt(
            name=meta.get("name", phase_name),
            description=meta.get("description", ""),
            tools=tools,
            body=body,
            source_format="md",
        )

    # 2. Fall back to legacy .tmpl — emit a deprecation warning.
    if tmpl_path.exists():
        body = tmpl_path.read_text(encoding="utf-8")
        tools = _resolve_tools(phase_name, {}, explicit_tools)
        warning = (
            f"{tmpl_path.name} is deprecated; migrate to {phase_name}.md "
            f"with YAML frontmatter (name, description, tools)."
        )
        return LoadedPrompt(
            name=phase_name,
            description="",
            tools=tools,
            body=body,
            source_format="tmpl",
            deprecation_warning=warning,
        )

    # 3. Nothing on disk — use the in-memory default.
    tools = explicit_tools if explicit_tools is not None else list(PERMISSIVE_FALLBACK)
    return LoadedPrompt(
        name=phase_name,
        description="",
        tools=tools,
        body=_default_body(phase_name),
        source_format="default",
    )


# ─── Public API: Validation ─────────────────────────────────────────────


def validate_flow_tools(
    flow_config: dict,
    prompts_dir: Path,
) -> list[str]:
    """Validate that all phases in a flow have sensible tool sets.

    Checks performed:

    1. Each phase resolves to a non-empty tool list.
    2. Every tool in the resolved list is in ``KNOWN_TOOLS`` (catches typos
       like ``"Bashh"`` or ``"Wrtie"``).
    3. ``.md`` files have valid frontmatter with a parseable ``tools`` field.

    Args:
        flow_config: Parsed flow JSON (``{"phases": {...}, ...}``).
        prompts_dir: Directory where the .md/.tmpl prompts live.

    Returns:
        A list of human-readable error strings. Empty list = all phases valid.
    """
    errors: list[str] = []
    phases = flow_config.get("phases", {})

    if not phases:
        return ["flow has no 'phases' section"]

    for phase_name, phase_config in phases.items():
        if not isinstance(phase_config, dict):
            errors.append(f"phase '{phase_name}' config is not a mapping")
            continue

        explicit_tools = phase_config.get("tools")
        if explicit_tools is not None and not isinstance(explicit_tools, list):
            errors.append(
                f"phase '{phase_name}' has invalid 'tools' override "
                f"(expected list, got {type(explicit_tools).__name__})"
            )
            continue

        try:
            loaded = load_prompt(prompts_dir, phase_name, explicit_tools)
        except ValueError as exc:
            errors.append(f"phase '{phase_name}': {exc}")
            continue

        # Local-only phases (``is_local: true``) don't call an LLM, so
        # they legitimately need zero tools. The ``close`` phase from the
        # evidence-gates PRD is the canonical example: it runs a local
        # command and must NOT be given Bash/Read/etc. — otherwise a
        # malicious prompt injection could fabricate evidence.
        is_local = bool(phase_config.get("is_local"))

        if not loaded.tools and not is_local:
            errors.append(f"phase '{phase_name}' resolved to an empty tool list")
            continue

        unknown = [t for t in loaded.tools if t not in KNOWN_TOOLS]
        if unknown:
            errors.append(
                f"phase '{phase_name}' references unknown tool(s): {unknown}. "
                f"Known tools: {sorted(KNOWN_TOOLS)}"
            )

    return errors


# ─── CLI Helper ──────────────────────────────────────────────────────────


def main(argv: Optional[list[str]] = None) -> int:
    """Tiny CLI for ad-hoc prompt inspection.

    Usage:
        python3 -m lib.prompt_loader <prompts_dir> <phase_name>
        python3 lib/prompt_loader.py <prompts_dir> <phase_name>

    Prints a JSON dump of the loaded prompt and exits with code 0 on success.
    """
    import json

    args = argv if argv is not None else sys.argv[1:]
    if len(args) != 2:
        print(
            "usage: prompt_loader.py <prompts_dir> <phase_name>",
            file=sys.stderr,
        )
        return 2

    prompts_dir = Path(args[0])
    phase_name = args[1]

    try:
        loaded = load_prompt(prompts_dir, phase_name)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if loaded.deprecation_warning:
        print(f"warning: {loaded.deprecation_warning}", file=sys.stderr)

    print(json.dumps(
        {
            "name": loaded.name,
            "description": loaded.description,
            "tools": loaded.tools,
            "source_format": loaded.source_format,
            "body_chars": len(loaded.body),
        },
        indent=2,
    ))
    return 0


if __name__ == "__main__":
    sys.exit(main())
