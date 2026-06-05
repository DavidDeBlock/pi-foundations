---
name: python-implementer
description: Implements Python features and fixes from GitHub issues. Follows a lightweight "Explore -> Implement -> Verify" flow using AST-based scripts for safe codebase exploration. Use when implementing Python tasks, fixing bugs in Python files, or adding new modules to the project.
---

# Python Implementer

**CRITICAL RULE**: Always use **`python3`**, never bare `python`. This ensures compatibility on systems where `python` might point to Python 2 or be missing.

## Quick Start

1. **Context**: Receive issue details (usually via `process-adapt`). If only an Issue ID is provided, fetch it using `gh issue view <ID> --json title,body`.
2. **Explore**: Use bundled scripts in `scripts/` to understand existing code structure before modifying files.
3. **Implement**: Write Python code following project conventions (type hints, docstrings).
4. **Verify**: Run the **Smoke Test** suite (see below) to ensure no syntax errors or import failures.

## The "Explore" Toolkit (`scripts/`)

Use these scripts instead of raw `grep` or `cat`. They are lightweight Python tools using only stdlib (`ast`, `json`).

| Script | Purpose | Example Usage |
|--------|---------|---------------|
| **find-usages.py** | Find where a symbol (function/class) is defined and used. | `python3 .pi/skills/python-implementer/scripts/find-usages.py my_function` |
| **list-exports.py** | List public classes, functions, and constants in a file. | `python3 .pi/skills/python-implementer/scripts/list-exports.py src/module.py --json` |

*All scripts support `--help` for usage details.*

## Implementation Workflow

1. **Analyze**:
   - Identify the files that need changing.
   - Use `find-usages.py` to see how existing functions are called (to match signatures).
2. **Code**:
   - Write clean, type-hinted Python code.
   - Follow existing naming conventions in the target directory.
3. **Verify (Smoke Test)**:
   Run these checks immediately after saving changes:

   | Check | Command | Purpose |
   |-------|---------|---------|
   | **Syntax** | `python3 -m py_compile <file>` | Catches indentation/grammar errors instantly. |
   | **Imports** | `python3 -c "import module_name"` | Ensures dependencies are installed and path is correct. |
   | **Regres.** | `pytest tests/test_module.py` (if exists) | Verifies existing functionality wasn't broken. |

## Non-Goals

- Does not run full test suites unless specifically requested.
- Does not manage virtual environments or install packages automatically (assumes env is active).
- Does not create complex architecture—follows the simplest path to working code.
