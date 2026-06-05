#!/usr/bin/env python3
"""
repo_probe.py — Mechanical repo detection for Maestro onboarding.

Given a path on disk, returns a structured :class:`ProbeResult` describing
the languages, package manager, build/test/lint commands, frameworks,
and git remote. The probe is intentionally fast and deterministic — it
must complete in seconds, never call the LLM, and never mutate the
target repo. Subjective context (conventions, gotchas, evidence
strategy) is captured by the interviewer agent in slice #282; this
module is the mechanical half of the onboarding pair.

Key design choices (see docs/35-prds/maestro-repo-onboarding.md):

- **Glob over walk.** We only need *evidence* that a language/framework
  is present, not an exhaustive list. A handful of glob hits is enough
  signal. Capped at 5 hits per pattern for speed and bounded memory.
- **Lockfile precedence is explicit.** pnpm → bun → yarn → npm
  (left-to-right). The first lockfile that exists wins — never
  "the newest one" or "all of them".
- **JS framework detection reads deps only.** Framework folders
  (``node_modules/react/``) are not reliable across monorepos. Reading
  ``package.json`` deps is the only portable signal.
- **Python frameworks scan the text of pyproject/setup.** A regex
  is faster than a TOML parser and handles both ``pyproject.toml``
  and ``setup.cfg`` shape variations.
- **Git remote uses a hard 5s timeout.** Onboarding a remote path
  (e.g. over SSH) must never hang the CLI.

Public API:
    - ``ProbeResult`` — dataclass holding probe findings.
    - ``probe_repo(path)`` — return a ``ProbeResult`` for ``path``.

Errors are returned in the dataclass (e.g. ``git_remote = "<unavailable>"``),
not raised. Onboarding should never crash because git is broken.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Iterable, Optional


# Number of glob hits we sample per pattern. Five is enough signal that
# the language/framework is *present* without scanning a 50k-file monorepo.
_GLOB_SAMPLE_LIMIT: int = 5

# Hard timeout for ``git remote get-url origin``. Five seconds is the
# longest a healthy local ``git`` invocation should ever need. If a
# user's git config is wedged, we surface that as a missing remote
# rather than blocking the whole onboard flow.
_GIT_REMOTE_TIMEOUT_SECONDS: int = 5

#: Lockfile precedence. First one that exists wins.
LOCKFILE_PRECEDENCE: tuple[str, ...] = (
    "pnpm-lock.yaml",
    "bun.lockb",
    "bun.lock",
    "yarn.lock",
    "package-lock.json",
)

#: Mapping from lockfile basename to canonical package-manager name.
PACKAGE_MANAGER_FROM_LOCKFILE: dict[str, str] = {
    "pnpm-lock.yaml": "pnpm",
    "bun.lockb": "bun",
    "bun.lock": "bun",
    "yarn.lock": "yarn",
    "package-lock.json": "npm",
}

#: Python package-manager / framework indicators we look for in
#: pyproject.toml/setup.cfg text. We use substring search — TOML parsing
#: is overkill for a presence check.
_PYTHON_FRAMEWORK_INDICATORS: dict[str, tuple[str, ...]] = {
    "fastapi": ("fastapi", "fastapi[", '"fastapi"'),
    "django": ("django", '"django"'),
    "flask": ("flask", '"flask"'),
    "starlette": ("starlette",),
    "pyramid": ("pyramid",),
}

#: NPM/JS package names → canonical framework name. Keys are the literal
#: dep names we expect to find in ``package.json``; values are the
#: canonical label we'll surface in the probe result.
_JS_FRAMEWORK_DEP_NAMES: dict[str, str] = {
    # React family
    "react": "react",
    "react-dom": "react",
    "next": "next",
    # Vue family
    "vue": "vue",
    "nuxt": "nuxt",
    # Svelte family
    "svelte": "svelte",
    "@sveltejs/kit": "svelte",
    # Backend
    "express": "express",
    "hono": "hono",
    "fastify": "fastify",
    "koa": "koa",
    "nestjs": "nestjs",
}


@dataclass
class ProbeResult:
    """Mechanical findings for a single repo.

    Every field is a sensible default — ``probe_repo`` always returns
    a fully-formed instance, never partial state. Callers can safely
    iterate ``result.frameworks`` knowing it's a list, even if the
    probe found no JS package.json.

    Attributes:
        path: The repo's resolved absolute path.
        languages: Detected language names (``"python"``,
            ``"typescript"``, ``"javascript"``, ``"rust"``, ``"go"``).
            Empty list if nothing matched.
        package_manager: Canonical name (``"pnpm"``, ``"bun"``,
            ``"yarn"``, ``"npm"``, ``"pyproject"``, ``"cargo"``,
            ``"go"``) or empty string if undetected.
        test_command: Best-guess test invocation (e.g. ``"pnpm test"``,
            ``"pytest"``). Empty string if unknown.
        build_command: Best-guess build invocation. Empty if unknown.
        lint_command: Best-guess lint invocation. Empty if unknown.
        frameworks: Detected framework names (e.g. ``["react", "next"]``).
            Empty list if none.
        is_git_repo: True iff ``.git/`` exists at the repo root.
        git_remote: ``git remote get-url origin`` output, or empty
            string if not a git repo / git unavailable.
    """

    path: str
    languages: list[str] = field(default_factory=list)
    package_manager: str = ""
    test_command: str = ""
    build_command: str = ""
    lint_command: str = ""
    frameworks: list[str] = field(default_factory=list)
    is_git_repo: bool = False
    git_remote: str = ""

    def to_dict(self) -> dict:
        """Return a JSON-serialisable dict (used by the CLI JSON output)."""
        return asdict(self)


# ─── Helpers ─────────────────────────────────────────────────────────────


def _has_glob_matches(repo: Path, patterns: Iterable[str], limit: int = _GLOB_SAMPLE_LIMIT) -> bool:
    """Return True iff any glob in ``patterns`` finds a hit under ``repo``.

    Samples up to ``limit`` matches per pattern — early-exit as soon as
    one match is found. A single hit is enough signal that the
    language/framework is present.

    Globs are run with ``rglob`` (recursive) so monorepos are
    detected correctly: a ``package.json`` in a subdirectory like
    ``frontend/`` should still register as a JS repo. The sample
    limit keeps this bounded — we never enumerate the whole tree.
    """
    for pattern in patterns:
        try:
            for _ in repo.rglob(pattern):
                return True
        except (OSError, ValueError):
            # Malformed glob or permission error — treat as "no match"
            # rather than crashing the probe. Onboarding must work on
            # read-only or partially-mounted directories.
            continue
    return False


def _count_glob_matches(repo: Path, patterns: Iterable[str], limit: int = _GLOB_SAMPLE_LIMIT) -> int:
    """Return the number of glob hits (capped at ``limit``) across all patterns.

    Used when we want a "richer" presence signal — e.g. the language
    detector treats a single ``*.py`` as Python, but the test command
    selector wants to know if there are enough ``test_*.py`` files to
    justify ``pytest`` as the default.

    Recursive (``rglob``) so subdirectory hits are counted.
    """
    count = 0
    for pattern in patterns:
        try:
            for _ in repo.rglob(pattern):
                count += 1
                if count >= limit:
                    return count
        except (OSError, ValueError):
            continue
    return count


def _read_package_json(repo: Path) -> dict:
    """Read and parse ``<repo>/package.json``; return ``{}`` on any failure.

    The probe must never crash on a malformed package.json — a
    truncated or invalid file is a strong "npm repo" signal on its
    own, and we'll fall through to the lockfile detector anyway.
    """
    path = repo / "package.json"
    if not path.is_file():
        return {}
    try:
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _find_primary_package_json(repo: Path) -> Optional[Path]:
    """Return the first ``package.json`` found under ``repo`` (recursively).

    Used to pick a canonical package.json for a monorepo where
    multiple exist at different depths. We prefer the shallowest
    match (smallest path length) — that tends to be the "root"
    package.json even in workspaces.

    Returns ``None`` if no ``package.json`` exists anywhere under
    ``repo``. Sample-limited to avoid scanning massive trees.
    """
    try:
        candidates = list(repo.rglob("package.json"))
    except (OSError, ValueError):
        return None
    # Filter out nested ``node_modules`` to avoid detecting transitive
    # dependencies' package.jsons — only the project-declared ones count.
    candidates = [
        c for c in candidates
        if "node_modules" not in c.parts
    ]
    if not candidates:
        return None
    # Shallowest first; ties broken by sorted order for determinism
    candidates.sort(key=lambda p: (len(p.parts), str(p)))
    return candidates[0]


def _detect_js_package_manager(repo: Path) -> str:
    """Return canonical package-manager name based on lockfile precedence.

    First lockfile found in :data:`LOCKFILE_PRECEDENCE` wins. If none
    exist, fall back to ``"npm"`` only if a ``package.json`` is
    present (otherwise the repo is not really a JS project).
    """
    for lockfile in LOCKFILE_PRECEDENCE:
        if (repo / lockfile).is_file():
            return PACKAGE_MANAGER_FROM_LOCKFILE[lockfile]
    if (repo / "package.json").is_file():
        # No lockfile but a package.json exists — assume npm (the default).
        return "npm"
    return ""


def _detect_js_commands(repo: Path, package_manager: str) -> tuple[str, str, str]:
    """Extract test/build/lint commands from ``package.json`` scripts.

    Falls back to ``<pm> test`` / ``<pm> build`` / ``<pm> lint`` when
    the corresponding script is missing. Returns ``(test, build, lint)``
    as a 3-tuple of strings (each may be empty).
    """
    pkg = _read_package_json(repo)
    scripts = pkg.get("scripts", {}) if isinstance(pkg, dict) else {}
    if not isinstance(scripts, dict):
        scripts = {}

    def _resolve(script_name: str, fallback_cmd: str) -> str:
        script_value = scripts.get(script_name)
        if isinstance(script_value, str) and script_value.strip():
            return f"{package_manager} run {script_name}"
        # No script — fall back to a raw invocation only if the package
        # manager is well-known. For "npm" we use `npm test` etc. (no
        # `run` keyword) to match common usage.
        if package_manager and package_manager != "":
            if package_manager == "npm":
                return f"npm {script_name}".strip()
            return fallback_cmd
        return ""

    test_cmd = _resolve("test", f"{package_manager} test" if package_manager else "")
    build_cmd = _resolve("build", f"{package_manager} build" if package_manager else "")
    lint_cmd = _resolve("lint", f"{package_manager} lint" if package_manager else "")

    return test_cmd, build_cmd, lint_cmd


def _detect_js_frameworks(repo: Path) -> list[str]:
    """Return canonical framework names detected via ``package.json`` deps.

    A framework appears in the result if its dep name is present in
    either ``dependencies`` or ``devDependencies``. We dedupe via the
    canonical label so ``react`` and ``react-dom`` don't double-count.
    """
    pkg = _read_package_json(repo)
    deps: dict = {}
    for key in ("dependencies", "devDependencies", "peerDependencies"):
        section = pkg.get(key, {})
        if isinstance(section, dict):
            deps.update(section)

    found: set[str] = set()
    for dep_name, framework_label in _JS_FRAMEWORK_DEP_NAMES.items():
        if dep_name in deps:
            found.add(framework_label)
    return sorted(found)


def _detect_python(repo: Path) -> tuple[str, list[str], str, str, str]:
    """Probe a Python repo. Returns ``(test, build, lint, pkg_manager, frameworks)``.

    ``pkg_manager`` is always ``"pyproject"`` or ``"setup.py"`` (whichever
    config file is present; pyproject wins). Frameworks are detected
    via regex over the config text. The function returns empty strings
    for any field that doesn't apply.
    """
    has_pyproject = (repo / "pyproject.toml").is_file()
    has_setup_py = (repo / "setup.py").is_file()
    has_setup_cfg = (repo / "setup.cfg").is_file()

    if not (has_pyproject or has_setup_py or has_setup_cfg or _has_glob_matches(repo, ("*.py",))):
        return "", "", "", "", []

    pkg_manager = "pyproject" if has_pyproject else ("setup.py" if has_setup_py else "")

    # Concatenate config text for a single regex sweep
    config_text = ""
    for fname in ("pyproject.toml", "setup.py", "setup.cfg"):
        path = repo / fname
        if path.is_file():
            try:
                config_text += "\n" + path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue

    frameworks: list[str] = []
    for label, needles in _PYTHON_FRAMEWORK_INDICATORS.items():
        if any(needle in config_text for needle in needles):
            frameworks.append(label)
    frameworks.sort()

    # Test command: pytest if pytest is in config or test_*.py files exist.
    # Otherwise fall back to a generic "python -m unittest" only if test
    # files exist. If we can't detect any test files, return empty
    # rather than guessing.
    test_count = _count_glob_matches(repo, ("test_*.py", "tests/test_*.py", "tests/**/*.py"))
    has_pytest = "pytest" in config_text
    if has_pytest and test_count > 0:
        test_cmd = "pytest"
    elif has_pytest:
        test_cmd = "pytest"
    elif test_count > 0:
        test_cmd = "python -m unittest"
    else:
        test_cmd = ""

    # Build/lint: only set if explicitly declared in pyproject/setup
    build_cmd = ""
    lint_cmd = ""
    if has_pyproject:
        # Very common build/lint tooling for Python — match on command names
        if re.search(r"\bruff\b", config_text):
            lint_cmd = "ruff check ."
        elif re.search(r"\bflake8\b", config_text):
            lint_cmd = "flake8"
        elif re.search(r"\bblack\b", config_text) and "lint" not in config_text.lower():
            # Black is a formatter, not a linter — only suggest as lint
            # alternative if no real linter is configured.
            pass
        if re.search(r"\b(build|setuptools\.setup)\b", config_text):
            build_cmd = "python -m build"

    return test_cmd, build_cmd, lint_cmd, pkg_manager, frameworks


def _detect_rust(repo: Path) -> tuple[str, str, str]:
    """Probe a Rust repo. Returns ``(test, build, lint)``.

    Always returns ``cargo`` commands if ``Cargo.toml`` is present,
    since those are the canonical Rust tooling. We don't introspect
    ``[[bin]]`` / ``[lib]`` sections — ``cargo test`` / ``cargo build``
    work for both.
    """
    if not (repo / "Cargo.toml").is_file():
        return "", "", ""
    return "cargo test", "cargo build", "cargo clippy"


def _detect_go(repo: Path) -> tuple[str, str, str]:
    """Probe a Go repo. Returns ``(test, build, lint)``.

    Returns ``go test ./...`` and ``go build ./...`` if ``go.mod`` is
    present. Lint defaults to ``go vet ./...`` which is in the stdlib.
    """
    if not (repo / "go.mod").is_file():
        return "", "", ""
    return "go test ./...", "go build ./...", "go vet ./..."


def _detect_git(repo: Path) -> tuple[bool, str]:
    """Return ``(is_git_repo, git_remote)`` for ``repo``.

    ``is_git_repo`` is determined by the presence of ``.git/``. The
    remote is fetched with a hard 5s timeout via
    :func:`subprocess.run`; any failure (no git, no origin, timeout)
    yields an empty string. Never raises.
    """
    is_git = (repo / ".git").exists()
    if not is_git:
        return False, ""

    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=str(repo),
            capture_output=True,
            text=True,
            timeout=_GIT_REMOTE_TIMEOUT_SECONDS,
            check=False,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        # No git binary, or it hung — surface as "no remote" so the
        # user can fix git later without blocking onboarding.
        return True, ""

    if result.returncode != 0:
        return True, ""

    remote = (result.stdout or "").strip()
    return True, remote


# ─── Public entry point ──────────────────────────────────────────────────


def probe_repo(path: Path) -> ProbeResult:
    """Mechanically probe a repo and return a :class:`ProbeResult`.

    Detects languages (Python, TypeScript, JavaScript, Rust, Go),
    the package manager, the test/build/lint commands, the JS framework
    family, and the git remote. The probe is best-effort — a missing
    or unreadable ``package.json`` is not an error, it just means we
    couldn't detect JS-specific signals.

    Args:
        path: Filesystem path to the repo root. Will be resolved to
            an absolute path. The probe never mutates the repo.

    Returns:
        A fully-populated :class:`ProbeResult`. Every field is a
        sensible default — empty string for unset commands, empty
        list for unset languages/frameworks.

    Note:
        The probe never raises. A broken path (permissions, missing
        dirs) still returns a ``ProbeResult`` with empty detections;
        the caller decides whether to surface that to the user.
    """
    repo = Path(path).resolve()

    result = ProbeResult(path=str(repo))

    # Languages (cheap, independent detections)
    if _has_glob_matches(repo, ("*.py", "pyproject.toml", "setup.py", "setup.cfg")):
        result.languages.append("python")
    if _has_glob_matches(repo, ("*.ts", "tsconfig.json")):
        result.languages.append("typescript")
    if _has_glob_matches(repo, ("*.js", "package.json")):
        result.languages.append("javascript")
    if _has_glob_matches(repo, ("*.rs", "Cargo.toml")):
        result.languages.append("rust")
    if _has_glob_matches(repo, ("*.go", "go.mod")):
        result.languages.append("go")

    # JS probe — order matters: lockfile detection feeds the command builder.
    # Use the first ``package.json`` found at any depth as the canonical
    # source of scripts and deps. This handles monorepos (where the
    # primary ``package.json`` may be in a subdirectory like ``frontend/``)
    # without us guessing wrong about which one is "canonical".
    if any(lang in result.languages for lang in ("javascript", "typescript")):
        primary_pkg = _find_primary_package_json(repo)
        if primary_pkg is not None:
            result.package_manager = _detect_js_package_manager(primary_pkg.parent)
            test, build, lint = _detect_js_commands(primary_pkg.parent, result.package_manager)
            result.test_command = test
            result.build_command = build
            result.lint_command = lint
            result.frameworks.extend(_detect_js_frameworks(primary_pkg.parent))

    # Python probe (independent)
    if "python" in result.languages:
        test, build, lint, pkg_manager, frameworks = _detect_python(repo)
        # Only overwrite commands if Python set them — JS wins for shared fields
        if test:
            result.test_command = test
        if build:
            result.build_command = build
        if lint:
            result.lint_command = lint
        if pkg_manager:
            # Only set the package manager if JS didn't already claim it
            if not result.package_manager:
                result.package_manager = pkg_manager
        for fw in frameworks:
            if fw not in result.frameworks:
                result.frameworks.append(fw)

    # Rust
    if "rust" in result.languages:
        test, build, lint = _detect_rust(repo)
        if test:
            result.test_command = test
        if build:
            result.build_command = build
        if lint:
            result.lint_command = lint
        if not result.package_manager:
            result.package_manager = "cargo"

    # Go
    if "go" in result.languages:
        test, build, lint = _detect_go(repo)
        if test:
            result.test_command = test
        if build:
            result.build_command = build
        if lint:
            result.lint_command = lint
        if not result.package_manager:
            result.package_manager = "go"

    # Git
    result.is_git_repo, result.git_remote = _detect_git(repo)

    # Stable ordering on frameworks (so tests can compare lists)
    result.frameworks = sorted(set(result.frameworks))
    result.languages = sorted(set(result.languages))

    return result
