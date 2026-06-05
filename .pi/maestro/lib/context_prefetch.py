#!/usr/bin/env python3
"""
context_prefetch.py — Static repo context prefetch for Maestro.

Computes a ``PrefetchedContext`` once per git SHA and caches it on disk so
the builder phase doesn't waste context window / time on ``cat package.json``
runs. The cache key is ``<repo-hash>-<git_sha>`` — different SHAs get
different cache files, and old files accumulate harmlessly (a few KB each).

Detection scope:

- **JS/TS** (npm / pnpm / yarn / bun) — extracts ``scripts``, ``dependencies``,
  ``devDependencies``, ``test`` / ``build`` / ``lint`` commands. We don't try
  to distinguish npm vs pnpm vs bun here; the lockfile would tell us, but the
  PRD deliberately keeps this heuristic.
- **Python** — defaults ``test_command`` to ``pytest`` (heuristic). Doesn't
  introspect ``pyproject.toml`` deeply; that's a follow-up.
- **Rust / Go** — detected as package manager, no deep introspection.

Test file discovery is capped at 20 results to bound the cache size and
avoid glob explosions on large repos.

Public API:
    - ``CACHE_DIR`` — default location for cached context files.
    - ``PrefetchedContext`` — dataclass holding the prefetched info.
    - ``get_git_sha(repo_path)`` — returns HEAD SHA or ``"unknown"``.
    - ``cache_key(repo_path, git_sha)`` — returns the cache file path.
    - ``prefetch_context(repo_path)`` — cache-aware main entry point.
    - ``format_prefetched_context(ctx)`` — markdown rendering for prompt
      injection.
    - ``clear_cache(repo_path=None)`` — drop cached entries (for tests).
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional


# Default cache location. Resolved relative to cwd.
CACHE_DIR = Path(".maestro/prefetch_cache")

#: How many test files to surface in the cache (and in the prompt).
MAX_TEST_FILES = 20

#: Glob patterns that look like test files, in priority order.
TEST_FILE_PATTERNS: list = [
    "**/*.test.ts",
    "**/*.test.js",
    "**/*.spec.ts",
    "**/*.spec.js",
    "**/test_*.py",
    "**/*_test.py",
]


@dataclass
class PrefetchedContext:
    """Static repo context, computed once per git SHA.

    All fields default to empty so a partial cache hit or a half-detected
    repo still produces a usable object.
    """

    git_sha: str
    test_command: str = ""
    build_command: str = ""
    lint_command: str = ""
    package_manager: str = ""
    dependencies: dict = field(default_factory=dict)  # name -> version string
    scripts: dict = field(default_factory=dict)  # name -> command
    test_files: list = field(default_factory=list)  # list[str], relative to repo
    convention_hints: list = field(default_factory=list)  # e.g. "uses ESLint"

    def to_dict(self) -> dict:
        return asdict(self)


# ─── Git SHA resolution ─────────────────────────────────────────────────


def get_git_sha(repo_path: Path) -> str:
    """Return the current git HEAD SHA, or ``"unknown"``.

    Handles non-git directories, timeouts, and missing ``git`` binary by
    falling back to ``"unknown"`` rather than raising.
    """
    repo_path = Path(repo_path)
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(repo_path),
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
        sha = result.stdout.strip()
        return sha if sha else "unknown"
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return "unknown"


# ─── Cache key + I/O ─────────────────────────────────────────────────────


def cache_key(repo_path: Path, git_sha: str, cache_dir: Path = CACHE_DIR) -> Path:
    """Return the cache file path keyed on ``repo_path`` + ``git_sha``.

    The repo path is hashed (8 hex chars) so very long absolute paths don't
    blow past filesystem name limits. The SHA is included verbatim so
    different SHAs of the same repo get separate cache files.
    """
    repo_path = Path(repo_path)
    try:
        resolved = str(repo_path.resolve())
    except OSError:
        resolved = str(repo_path)
    repo_hash = hashlib.sha256(resolved.encode("utf-8")).hexdigest()[:8]
    safe_sha = git_sha if git_sha and git_sha != "unknown" else "unknown"
    return Path(cache_dir) / f"{repo_hash}-{safe_sha}.json"


def _read_cache(cache_path: Path) -> Optional[PrefetchedContext]:
    """Load a cached PrefetchedContext, or return None on miss / corruption."""
    if not cache_path.exists():
        return None
    try:
        raw = cache_path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        return PrefetchedContext(**data)
    except (TypeError, ValueError):
        # Cache from an older schema — drop it and recompute
        return None


def _write_cache(cache_path: Path, ctx: PrefetchedContext) -> None:
    """Persist a PrefetchedContext to disk. Best-effort; never raises."""
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(
            json.dumps(ctx.to_dict(), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError as e:
        print(f"[prefetch] Failed to write cache {cache_path}: {e}", file=sys.stderr)


# ─── Detection helpers ──────────────────────────────────────────────────


def _detect_package_manager(repo_path: Path) -> str:
    """Identify the project's package manager.

    Returns a short string. We don't try to distinguish npm vs pnpm vs bun
    from the lockfile here — the PRD scopes that as a follow-up. The label
    is informational; the actual commands come from ``package.json``.
    """
    if (repo_path / "package.json").exists():
        return "npm/pnpm/bun"
    if (repo_path / "pyproject.toml").exists() or (repo_path / "setup.py").exists():
        return "python"
    if (repo_path / "Cargo.toml").exists():
        return "rust"
    if (repo_path / "go.mod").exists():
        return "go"
    return ""


def _extract_js_context(repo_path: Path) -> dict:
    """Read package.json and return test/build/lint commands + scripts + deps.

    Returns an empty dict if package.json is missing or malformed.
    """
    pkg_file = repo_path / "package.json"
    if not pkg_file.exists():
        return {}
    try:
        pkg = json.loads(pkg_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return {}
    if not isinstance(pkg, dict):
        return {}

    scripts = pkg.get("scripts", {}) or {}
    if not isinstance(scripts, dict):
        scripts = {}

    deps: dict = {}
    for key in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        section = pkg.get(key) or {}
        if isinstance(section, dict):
            deps.update(section)

    return {
        "test_command": scripts.get("test", "") or "",
        "build_command": scripts.get("build", "") or "",
        "lint_command": scripts.get("lint", "") or "",
        "scripts": dict(scripts),
        "dependencies": deps,
    }


def _extract_python_context(repo_path: Path) -> dict:
    """Best-effort Python context. Defaults to pytest; doesn't introspect deeply."""
    return {
        "test_command": "pytest",
        "build_command": "",
        "lint_command": "",
        "scripts": {},
        "dependencies": {},
    }


def _discover_test_files(repo_path: Path) -> list:
    """Find test files via capped glob (≤ MAX_TEST_FILES)."""
    found: list = []
    seen: set = set()
    for pattern in TEST_FILE_PATTERNS:
        for p in repo_path.glob(pattern):
            if not p.is_file():
                continue
            try:
                rel = str(p.relative_to(repo_path))
            except ValueError:
                rel = str(p)
            if rel in seen:
                continue
            seen.add(rel)
            found.append(rel)
            if len(found) >= MAX_TEST_FILES:
                return found
    return found


def _discover_convention_hints(repo_path: Path) -> list:
    """Identify project conventions from presence of specific config files."""
    hints: list = []
    checks: list = [
        (".eslintrc.json", "uses ESLint"),
        (".eslintrc.js", "uses ESLint"),
        (".eslintrc.yml", "uses ESLint"),
        ("eslint.config.js", "uses ESLint (flat config)"),
        ("eslint.config.mjs", "uses ESLint (flat config)"),
        ("tsconfig.json", "TypeScript project"),
        ("bunfig.toml", "uses Bun runtime"),
        ("Dockerfile", "has Dockerfile"),
        ("docker-compose.yml", "has docker-compose"),
        ("docker-compose.yaml", "has docker-compose"),
        (".prettierrc", "uses Prettier"),
        ("pyproject.toml", "uses pyproject.toml"),
        ("setup.py", "uses setup.py"),
        ("Cargo.toml", "Rust project"),
        ("go.mod", "Go module"),
    ]
    for filename, hint in checks:
        if (repo_path / filename).exists():
            hints.append(hint)
    return hints


# ─── Public entry point ──────────────────────────────────────────────────


def prefetch_context(
    repo_path: Path,
    cache_dir: Path = CACHE_DIR,
) -> PrefetchedContext:
    """Prefetch static repo context, using cache if available.

    Cache hit short-circuits all detection work. On miss, we run the
    detectors, build a ``PrefetchedContext``, persist it to the cache, and
    return it.
    """
    repo_path = Path(repo_path)
    git_sha = get_git_sha(repo_path)
    cache_path = cache_key(repo_path, git_sha, cache_dir=cache_dir)

    cached = _read_cache(cache_path)
    if cached is not None:
        return cached

    pkg_manager = _detect_package_manager(repo_path)

    test_cmd = build_cmd = lint_cmd = ""
    scripts: dict = {}
    deps: dict = {}

    if pkg_manager.startswith("npm") or pkg_manager in ("pnpm", "bun", "npm/pnpm/bun"):
        js = _extract_js_context(repo_path)
        test_cmd = js.get("test_command", "")
        build_cmd = js.get("build_command", "")
        lint_cmd = js.get("lint_command", "")
        scripts = js.get("scripts", {})
        deps = js.get("dependencies", {})
    elif pkg_manager == "python":
        py = _extract_python_context(repo_path)
        test_cmd = py.get("test_command", "")
        build_cmd = py.get("build_command", "")
        lint_cmd = py.get("lint_command", "")
        scripts = py.get("scripts", {})
        deps = py.get("dependencies", {})
    # rust / go: no deep introspection; commands stay empty

    test_files = _discover_test_files(repo_path)
    hints = _discover_convention_hints(repo_path)

    ctx = PrefetchedContext(
        git_sha=git_sha,
        test_command=test_cmd,
        build_command=build_cmd,
        lint_command=lint_cmd,
        package_manager=pkg_manager,
        dependencies=deps,
        scripts=scripts,
        test_files=test_files,
        convention_hints=hints,
    )

    _write_cache(cache_path, ctx)
    return ctx


def clear_cache(cache_dir: Path = CACHE_DIR) -> int:
    """Delete all cached PrefetchedContext files. Returns count deleted.

    Used by tests and (in the future) by a ``maestro prefetch clean`` command.
    Never raises — file races on Windows / concurrent runs are best-effort.
    """
    cache_dir = Path(cache_dir)
    if not cache_dir.exists():
        return 0
    count = 0
    for p in cache_dir.glob("*.json"):
        try:
            p.unlink()
            count += 1
        except OSError:
            pass
    return count


# ─── Markdown rendering for prompt injection ─────────────────────────────


def format_prefetched_context(ctx: PrefetchedContext) -> str:
    """Render a PrefetchedContext as a markdown block for prompt injection.

    Sections are omitted entirely when the corresponding field is empty so
    we don't pollute the prompt with placeholders.
    """
    parts: list = ["## Prefetched Repo Context", ""]

    if ctx.package_manager:
        parts.append(f"**Package manager:** {ctx.package_manager}")
    if ctx.test_command:
        parts.append(f"**Test command:** `{ctx.test_command}`")
    if ctx.build_command:
        parts.append(f"**Build command:** `{ctx.build_command}`")
    if ctx.lint_command:
        parts.append(f"**Lint command:** `{ctx.lint_command}`")

    if ctx.convention_hints:
        parts.append("")
        parts.append("**Convention hints:**")
        for h in ctx.convention_hints:
            parts.append(f"- {h}")

    if ctx.test_files:
        parts.append("")
        sample = ctx.test_files[:10]
        parts.append(f"**Test files (sample of {len(ctx.test_files)}):**")
        for f in sample:
            parts.append(f"- `{f}`")
        if len(ctx.test_files) > 10:
            parts.append(f"- _...and {len(ctx.test_files) - 10} more_")

    if ctx.dependencies:
        parts.append("")
        # Show up to 12 dependency names so we don't bloat the prompt
        names = sorted(ctx.dependencies.keys())
        sample = names[:12]
        parts.append(f"**Dependencies ({len(names)}):** {', '.join(f'`{n}`' for n in sample)}")
        if len(names) > 12:
            parts.append(f"- _...and {len(names) - 12} more_")

    # If everything is empty, still produce a heading so the agent knows we
    # tried — but signal "no info" honestly.
    if len(parts) == 2:
        parts.append("_No static repo context detected. Run `maestro memory show <issue>` to inspect._")

    return "\n".join(parts)
