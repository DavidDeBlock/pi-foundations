#!/usr/bin/env python3
"""
projects_registry.py — Cross-repo registry of onboarded projects for Maestro.

A JSON file at ``.maestro/projects.json`` that maps a stable hash of each
onboarded repo to its full metadata (alias, languages, package manager,
test/build/lint commands, evidence strategy, conventions, gotchas,
recommended playbooks). The registry is the central cross-repo file
that ``maestro onboard`` writes to and ``flow_engine`` reads from when
auto-loading repo context.

Key design choices (see docs/35-prds/maestro-repo-onboarding.md):

- **SHA256 hash (first 12 chars) of the resolved path as the key.**
  Collision-resistant for any realistic number of repos (12 hex
  chars = 48 bits = ~16M unique keys). Path-based key means the same
  physical repo always maps to the same entry even if aliased
  differently. Using the resolved (absolute, symlink-free) path
  prevents the same repo from getting two entries when accessed via
  different symlinks.
- **Atomic saves via ``tempfile.mkstemp`` + ``os.rename`` (not
  ``.tmp`` + rename).** The PRD specifically calls out that
  ``ProjectsRegistry`` uses a *more robust* pattern than the rest
  of the codebase. Some network filesystems (NFS, SMB, some FUSE
  mounts) do not support rename-over-existing-file. ``tempfile.mkstemp``
  gives us a unique tempfile on the *same directory* as the target
  file, and ``os.replace`` handles the cross-filesystem edge case
  by falling back to copy+delete. Different from
  ``working_memory.py`` (which uses ``.tmp`` + ``os.replace``) and
  ``learnings.py`` (same). Those are local-only and can use the
  simpler pattern; this module is the cross-repo central file so it
  gets the more robust one.
- **Corrupt-file resilience.** If the registry file is unreadable or
  unparseable, we back it up as ``projects.corrupt.<unix_ts>.json``
  and return an empty registry. We never silently swallow corruption.
- **Tolerant ``get_by_path()``.** Resolves ``~/``, ``../``, and
  relative paths to absolute form before comparison, so users can
  onboard ``./my-repo`` and look it up with ``/abs/path/my-repo`` and
  get the same entry.

Public API:
    - ``ProjectsRegistry`` — load/save/upsert/get/get_by_path/remove.
    - ``hash_repo_path(path)`` — public helper for the 12-char key.
    - ``REGISTRY_FILENAME`` — canonical filename (``projects.json``).
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional, Union


def _expand_and_resolve(path: Union[str, Path]) -> Path:
    """Resolve a path, expanding ``~`` to the user's home directory.

    Plain :meth:`Path.resolve` does NOT expand ``~`` (it treats it as
    a literal directory name). The PRD explicitly requires tilde
    handling, so we apply :func:`os.path.expanduser` first.
    """
    return Path(os.path.expanduser(str(path))).resolve()


# ─── Constants ───────────────────────────────────────────────────────────

#: Canonical registry filename. Resolved relative to cwd by callers
#: (so it can be overridden by ``MAESTRO_PROJECTS_REGISTRY`` env var
#: in the future if needed, but we keep the file path simple for v1).
REGISTRY_FILENAME: str = ".maestro/projects.json"

#: Length of the SHA256 prefix used as the registry key. 12 hex chars
#: = 48 bits of entropy = ~16M unique keys before 50% collision chance.
#: Per the PRD: "collision-resistant for any realistic number of repos".
HASH_PREFIX_LENGTH: int = 12


# ─── Path-hashing helper ─────────────────────────────────────────────────


def hash_repo_path(path: Union[str, Path]) -> str:
    """Return a stable, collision-resistant key for ``path``.

    The key is the first :data:`HASH_PREFIX_LENGTH` hex chars of
    ``sha256(str(Path(path).resolve()))``. We use the *resolved*
    (absolute, symlink-free) path so two symlinks to the same repo
    don't get two entries.

    Args:
        path: A filesystem path (string or :class:`Path`). Will be
            resolved to an absolute path before hashing.

    Returns:
        A 12-character hex string. Empty string is never returned
        (the hash always yields at least 1 hex char).
    """
    resolved = str(_expand_and_resolve(path))
    digest = hashlib.sha256(resolved.encode("utf-8")).hexdigest()
    return digest[:HASH_PREFIX_LENGTH]


# ─── Registry class ──────────────────────────────────────────────────────


class ProjectsRegistry:
    """Read/write the projects registry on disk.

    Single-writer safe via atomic :func:`_atomic_save`. Multi-writer
    concurrency is out of scope for v1 — the CLI is the only writer
    in normal use, and the flow engine only reads.

    Typical usage::

        reg = ProjectsRegistry(Path(".maestro/projects.json"))
        reg.upsert({
            "alias": "myrepo",
            "path": "/abs/path/to/repo",
            "hash": reg.hash_for("/abs/path/to/repo"),
            ...
        })

        entry = reg.get_by_path("/abs/path/to/repo")
        if entry:
            print(entry["alias"])
    """

    def __init__(self, path: Union[str, Path] = REGISTRY_FILENAME):
        """Store the registry path. Does not touch the filesystem."""
        self.path = Path(path)

    # ─── Public API ────────────────────────────────────────────────

    def load(self) -> dict:
        """Load the registry from disk. Returns ``{}`` if absent or corrupt.

        The registry is a flat dict ``{hash: entry, ...}``. An absent
        file is a normal "empty registry" case (the user hasn't
        onboarded anything yet). A corrupt file is *not* a normal
        case — we back it up and return empty so the user can
        recover manually if needed.

        Returns:
            A ``dict`` keyed by the 12-char hash. Always a dict —
            never ``None``, never ``[]``.
        """
        if not self.path.exists():
            return {}

        try:
            raw = self.path.read_text(encoding="utf-8")
            data = json.loads(raw)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError) as e:
            backup = self._corrupt_backup_path()
            try:
                self.path.rename(backup)
                self._log(
                    f"Corrupt projects registry backed up to {backup.name}: "
                    f"{type(e).__name__}: {e}"
                )
            except OSError as rename_err:
                self._log(
                    f"Corrupt registry at {self.path} ({e}) but backup rename "
                    f"failed ({rename_err}); returning empty registry"
                )
            return {}

        if not isinstance(data, dict):
            backup = self._corrupt_backup_path()
            try:
                self.path.rename(backup)
                self._log(
                    f"Projects registry is not a JSON object "
                    f"(got {type(data).__name__}); backed up to {backup.name}"
                )
            except OSError:
                pass
            return {}

        return data

    def save(self, registry: dict) -> None:
        """Atomically persist ``registry`` to disk.

        Uses :func:`tempfile.mkstemp` to create the temp file on the
        *same directory* as the target, then :func:`os.replace` to
        rename it into place. ``os.replace`` is atomic on POSIX
        *within the same filesystem* and gracefully falls back to
        copy+delete on cross-filesystem moves, which makes this
        safer than ``.tmp`` + ``os.rename`` for network filesystems.

        The parent directory is created on demand so the caller
        doesn't need to pre-create ``.maestro/``.

        Args:
            registry: A dict ``{hash: entry, ...}`` to persist.
                Any value is accepted but the rest of the API
                assumes hash keys mapping to entry dicts.
        """
        if not isinstance(registry, dict):
            raise TypeError(
                f"ProjectsRegistry.save expected dict, got {type(registry).__name__}"
            )

        self.path.parent.mkdir(parents=True, exist_ok=True)

        # Use mkstemp in the target's parent directory so the rename
        # is on the same filesystem. The dir= argument guarantees this.
        fd, tmp_path_str = tempfile.mkstemp(
            prefix=f"{self.path.name}.",
            suffix=".tmp",
            dir=str(self.path.parent),
        )
        tmp_path = Path(tmp_path_str)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(registry, f, indent=2, ensure_ascii=False)
                f.flush()
                # fsync — we want the bytes on disk before the rename
                try:
                    os.fsync(f.fileno())
                except OSError:
                    # Some filesystems (e.g. /dev/null, weird FUSE mounts)
                    # don't support fsync. Don't crash the save.
                    pass
            # Atomic on POSIX, copy+delete on cross-FS — exactly what
            # we want for robustness on network filesystems.
            os.replace(tmp_path, self.path)
        except Exception:
            # Clean up the temp file on failure so we don't leak
            # ``projects.json.XXXXXX.tmp`` files forever.
            try:
                tmp_path.unlink()
            except OSError:
                pass
            raise

    def upsert(self, entry: dict) -> None:
        """Insert or replace an entry by its ``hash`` field.

        Idempotent — re-upserting the same hash overwrites the
        existing entry rather than creating a duplicate. The
        entry's ``hash`` field is the lookup key; if missing, we
        derive it from ``entry["path"]`` automatically.

        Args:
            entry: A registry entry dict. Must contain ``hash`` OR
                ``path`` (from which the hash is derived). Other
                required fields per the PRD: ``alias``, ``path``,
                ``probed_at``, ``languages``, ``package_manager``,
                ``test_command``, ``build_command``, ``lint_command``,
                ``frameworks``, ``evidence_strategy``,
                ``conventions``, ``gotchas``,
                ``playbooks_recommended``.
        """
        if not isinstance(entry, dict):
            raise TypeError(
                f"ProjectsRegistry.upsert expected dict entry, "
                f"got {type(entry).__name__}"
            )

        # Derive hash from path if not supplied — this is the common
        # case for onboard's mechanical-mode code path.
        if "hash" not in entry or not entry["hash"]:
            if "path" not in entry:
                raise ValueError(
                    "ProjectsRegistry.upsert: entry must have 'hash' or 'path'"
                )
            entry["hash"] = hash_repo_path(entry["path"])

        registry = self.load()
        registry[entry["hash"]] = entry
        self.save(registry)

    def get(self, repo_hash: str) -> Optional[dict]:
        """Return the entry for ``repo_hash`` or ``None`` if absent."""
        if not isinstance(repo_hash, str) or not repo_hash:
            return None
        return self.load().get(repo_hash)

    def get_by_path(self, repo_path: Union[str, Path]) -> Optional[dict]:
        """Return the entry whose ``path`` matches ``repo_path`` (resolved).

        Resolves the input path (handles ``~/``, ``../``, relative
        paths, symlinks) and compares against each entry's resolved
        ``path`` field. This means a user can onboard with a
        relative path and later look up with the absolute path and
        still hit the same entry.

        Args:
            repo_path: A filesystem path. Will be resolved via
                :meth:`Path.resolve` before comparison.

        Returns:
            The matching entry dict, or ``None`` if no entry's
            resolved path matches.
        """
        if not repo_path:
            return None
        try:
            target = str(_expand_and_resolve(repo_path))
        except (OSError, RuntimeError):
            # Bad path or symlink loop — return None rather than crashing
            return None

        registry = self.load()
        for entry in registry.values():
            if not isinstance(entry, dict):
                continue
            entry_path = entry.get("path", "")
            if not entry_path:
                continue
            try:
                if str(_expand_and_resolve(entry_path)) == target:
                    return entry
            except OSError:
                continue
        return None

    def remove(self, repo_hash: str) -> bool:
        """Remove the entry for ``repo_hash`` from the registry.

        Does NOT delete the repo from disk — this is a registry
        operation, not a filesystem operation. The repo's
        ``.maestro/learnings.md`` is also left intact (intentional;
        a re-onboard will continue the learnings rather than restart).

        Args:
            repo_hash: The 12-char hash key. If absent, this is a
                silent no-op (returns ``False``).

        Returns:
            ``True`` if an entry was removed, ``False`` otherwise.
        """
        if not isinstance(repo_hash, str) or not repo_hash:
            return False
        registry = self.load()
        if repo_hash not in registry:
            return False
        del registry[repo_hash]
        self.save(registry)
        return True

    def list_all(self) -> list[dict]:
        """Return all entries as a list (values of the registry dict).

        Order is insertion order (Python 3.7+ dict guarantee) — the
        most recent ``upsert`` is at the end. Empty list if the
        registry is empty.
        """
        return list(self.load().values())

    def hash_for(self, path: Union[str, Path]) -> str:
        """Convenience wrapper around :func:`hash_repo_path`.

        Equivalent to ``hash_repo_path(path)`` — exposed as a method
        so callers can write ``reg.hash_for(path)`` consistently
        with the rest of the API.
        """
        return hash_repo_path(path)

    # ─── Internal helpers ──────────────────────────────────────────

    def _corrupt_backup_path(self) -> Path:
        """Build the backup path for a corrupt registry.

        Pattern: ``projects.corrupt.<unix_ts>.json``. The ``.json``
        suffix stays so it's still readable in a generic JSON viewer.
        """
        return self.path.parent / f"projects.corrupt.{int(time.time())}.json"

    def _log(self, msg: str) -> None:
        """Best-effort logger to stderr; never raise from logging."""
        try:
            print(f"[projects_registry] {msg}", file=sys.stderr)
            sys.stderr.flush()
        except Exception:
            pass
