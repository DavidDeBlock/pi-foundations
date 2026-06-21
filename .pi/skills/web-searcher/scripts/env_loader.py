#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Stdlib-only .env loader. Replaces python-dotenv where it isn't installed.

Supports:
- Blank lines and comments (lines starting with #)
- KEY=VALUE pairs
- Leading/trailing whitespace stripped from both key and value

Does NOT override existing environment variables unless override=True.
This matches python-dotenv's default behaviour.

Returns True if a .env file was found and read, False otherwise.
"""

import os
from pathlib import Path


def load_env(env_path: Path | None = None, override: bool = False) -> bool:
    """Load KEY=VALUE pairs from a .env file into os.environ.

    Args:
        env_path: Path to .env file. If None, defaults to <project_root>/.env
                  resolved via paths.PROJECT_ROOT.
        override: If True, replace existing env vars. Default False (dotenv default).

    Returns:
        True if a .env file was loaded, False otherwise.
    """
    if env_path is None:
        try:
            from paths import PROJECT_ROOT
            env_path = PROJECT_ROOT / ".env"
        except ImportError:
            return False

    if not env_path or not Path(env_path).exists():
        return False

    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if not key:
                continue
            if not override and key in os.environ:
                continue
            os.environ[key] = value

    return True
