#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Shared Path Constants for Web Searcher Scripts

This module provides consistent path resolution across all web-searcher scripts.
Prevents the "levels up" inconsistency bug where different scripts used 4 vs 5 levels.

Usage:
    from paths import PROJECT_ROOT, LIBRARY_ROOT
"""

from pathlib import Path

# ============================================================================
# PATH RESOLUTION (Fixed - always uses same calculation)
# ============================================================================

# Scripts directory (where this file lives)
SCRIPTS_DIR = Path(__file__).resolve().parent

# Project root: 4 levels up from scripts/
# Directory structure:
#   pos-dev/ (root)
#   └── .pi/
#       └── skills/
#           └── web-searcher/
#               └── scripts/ (here)
PROJECT_ROOT = SCRIPTS_DIR.parent.parent.parent.parent

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================


def get_project_root() -> Path:
    """Return the project root directory."""
    return PROJECT_ROOT


def get_library_root() -> Path:
    """Return the library documentation root directory."""
    return LIBRARY_ROOT


def verify_paths() -> bool:
    """Verify all critical paths exist. Returns True if all OK."""
    checks = [
        ("Project Root", PROJECT_ROOT.exists()),
        ("Library Root", LIBRARY_ROOT.exists()),
    ]
    
    all_ok = True
    for name, exists in checks:
        status = "✅" if exists else "❌"
        print(f"{status} {name}: {PROJECT_ROOT if 'Root' in name else LIBRARY_ROOT}")
        if not exists:
            all_ok = False
    
    return all_ok


# ============================================================================
# VALIDATION ON IMPORT (Optional - can be disabled)
# ============================================================================

# Uncomment to auto-validate paths on import:
# if __name__ == "__main__":
#     verify_paths()
