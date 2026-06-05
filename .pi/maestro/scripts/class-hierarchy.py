#!/usr/bin/env python3
"""
scripts/class-hierarchy.py — Python class inheritance tree scanner.

Scans a directory or file and outputs the class hierarchy: which classes
inherit from what, with full depth tracking. Useful for understanding
architecture patterns (interfaces, base classes, concrete implementations).

Usage:
    python scripts/class-hierarchy.py [path]                      # Markdown table (default)
    python scripts/class-hierarchy.py [path] --json               # Machine-readable JSON
    python scripts/class-hierarchy.py [path] --help               # Show usage information

Examples:
    python scripts/class-hierarchy.py .pi/maestro/lib/github_client.py
    python scripts/class-hierarchy.py .pi/maestro/pipelines/ --depth 1"""

import ast
import json
import sys
from pathlib import Path
from typing import Optional
import argparse


class ClassInfo:
    """Represents a class with its inheritance chain."""
    
    def __init__(self, name: str, filepath: str):
        self.name = name
        self.filepath = filepath
        self.bases: list[str] = []
        self.base_names: list[str] = []  # Just the simple names for display
        self.methods: list[dict] = []
        self.docstring: str = ""
    
    def add_base(self, base_expr) -> str:
        """Parse a base expression and return its string representation."""
        try:
            base_str = ast.unparse(base_expr)
            # Extract simple name for display (e.g., "GithubClient" from "lib.github_client.GithubClient")
            self.base_names.append(base_str.split(".")[-1] if "." in base_str else base_str)
            return base_str
        except Exception:
            return "<unknown>"
    
    def add_method(self, node: ast.FunctionDef | ast.AsyncFunctionDef):
        """Extract method info from an AST function node."""
        sig = f"{node.name}({', '.join(arg.arg for arg in node.args.args)})"
        
        # Check decorators
        decorators = []
        for d in getattr(node, 'decorator_list', []):
            if isinstance(d, ast.Name):
                decorators.append(d.id)
            elif isinstance(d, ast.Attribute):
                decorators.append(ast.unparse(d))
        
        self.methods.append({
            "name": node.name,
            "signature": sig,
            "is_static": "staticmethod" in decorators,
            "is_classmethod": "classmethod" in decorators,
            "docstring": (ast.get_docstring(node) or "")[:80],
        })


def _extract_classes(tree: ast.Module, filepath: str) -> list[ClassInfo]:
    """Extract all classes from a parsed AST module."""
    classes = []
    
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            info = ClassInfo(node.name, filepath)
            
            # Parse bases
            for base in node.bases:
                info.add_base(base)
            
            # Extract methods
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    info.add_method(item)
            
            info.docstring = ast.get_docstring(node) or ""
            classes.append(info)
    
    return classes


def _scan_directory(dirpath: Path) -> list[ClassInfo]:
    """Scan a directory for all .py files and extract their classes."""
    all_classes: list[ClassInfo] = []
    
    for py_file in sorted(dirpath.glob("**/*.py")):
        if "__pycache__" in str(py_file):
            continue
        
        try:
            source = py_file.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=str(py_file))
            classes = _extract_classes(tree, str(py_file.relative_to(dirpath)))
            all_classes.extend(classes)
        except SyntaxError:
            continue
    
    return all_classes


def _resolve_inheritance(all_classes: list[ClassInfo]) -> dict[str, list[str]]:
    """Build a map from class name to its resolved base classes."""
    known_names = {c.name for c in all_classes}
    
    # Also check common stdlib bases that won't be in our scan
    stdlib_bases = {"object", "Exception", "BaseException"}
    
    inheritance_map: dict[str, list[str]] = {}
    
    for cls in all_classes:
        resolved_bases = []
        for base_name in cls.base_names:
            if base_name in known_names or base_name in stdlib_bases:
                resolved_bases.append(base_name)
        
        inheritance_map[cls.name] = resolved_bases
    
    return inheritance_map


def _build_hierarchy_tree(all_classes: list[ClassInfo], max_depth: int = 3) -> dict[str, list]:
    """Build a tree structure from the class hierarchy."""
    # Find root classes (those that inherit only from stdlib or nothing)
    known_names = {c.name for c in all_classes}
    
    def _get_roots() -> set[str]:
        roots = set()
        for cls in all_classes:
            non_stdlib_bases = [b for b in cls.base_names if b not in {"object", "Exception"}]
            # A root is one whose bases are either stdlib or external (not in our scan)
            if not any(b in known_names for b in non_stdlib_bases):
                roots.add(cls.name)
        return roots
    
    def _get_children(parent: str, depth: int = 0) -> list[dict]:
        children = []
        if depth >= max_depth:
            return children
        
        for cls in all_classes:
            if parent in cls.base_names:
                child_info = {"name": cls.name, "children": _get_children(cls.name, depth + 1)}
                children.append(child_info)
        
        return children
    
    roots = _get_roots()
    tree = {}
    
    for root in sorted(roots):
        tree[root] = _get_children(root)
    
    return tree


def _generate_markdown(all_classes: list[ClassInfo], filepath: str, max_depth: int = 3) -> str:
    """Generate a Markdown table of class hierarchy."""
    output = f"# Class Hierarchy: {filepath}\n\n"
    
    if not all_classes:
        output += "> No classes found.\n"
        return output.strip() + "\n"
    
    # Summary counts
    inheritance_map = _resolve_inheritance(all_classes)
    multi_inherit = sum(1 for bases in inheritance_map.values() if len(bases) > 1)
    with_methods = sum(1 for c in all_classes if c.methods)
    
    output += f"**{len(all_classes)} class(es)** — "
    parts = []
    parts.append(f"{with_methods} with methods")
    if multi_inherit:
        parts.append(f"{multi_inherit} multiple inheritance")
    output += ", ".join(parts) + "\n\n"
    
    # Build hierarchy tree for display
    tree = _build_hierarchy_tree(all_classes, max_depth)
    
    def _print_tree(name: str, children: list[dict], indent: int = 0, is_last: bool = True) -> str:
        prefix = "└── " if is_last else "├── "
        connector = ""
        for i in range(indent - (1 if is_last else 0)):
            connector += "    "
        
        cls_info = next((c for c in all_classes if c.name == name), None)
        method_count = len(cls_info.methods) if cls_info else 0
        
        lines = [f"{connector}{prefix}{name}"]
        if method_count:
            lines.append(f"{' ' * (len(prefix) + len(name) + 2)}({method_count} methods)")
        
        for i, child in enumerate(children):
            child_lines = _print_tree(child["name"], child.get("children", []), indent + 1, i == len(children) - 1)
            lines.append(child_lines)
        
        return "\n".join(lines)
    
    # Print root tree
    output += "\n## Hierarchy Tree\n"
    roots = list(tree.keys())
    for i, root in enumerate(roots):
        output += _print_tree(root, tree[root]) + "\n"
    
    if not roots:
        output += "*No clear roots (all classes inherit from external types)*\n"
    
    # Per-class detail table (only if few classes)
    if len(all_classes) <= 20:
        output += "\n## Classes\n"
        
        headers = ["Class", "Bases", "Methods"]
        rows: list[list[str]] = []
        
        for cls in all_classes:
            bases_str = ", ".join(cls.base_names[:3])
            if len(cls.base_names) > 3:
                bases_str += f" (+{len(cls.base_names)-3})"
            
            method_list = [m["name"] for m in cls.methods[:5]]
            methods_str = ", ".join(method_list)
            if len(cls.methods) > 5:
                methods_str += f" (+{len(cls.methods)-5} more)"
            
            rows.append([cls.name, bases_str or "(object)", methods_str])
        
        col_widths = [len(h) for h in headers]
        for row in rows:
            for i, cell in enumerate(row):
                col_widths[i] = max(col_widths[i], len(str(cell)))
        
        output += "| " + " | ".join(h.ljust(col_widths[i]) for i, h in enumerate(headers)) + " |\n"
        output += "|" + "|".join("-" * (col_widths[i] + 2) for i in range(len(headers))) + "|\n"
        
        for row in rows:
            output += "| " + " | ".join(str(c).ljust(col_widths[i]) for i, c in enumerate(row)) + " |\n"
    
    return "\n".join(output) if isinstance(output, list) else output.strip() + "\n"


def _generate_json(all_classes: list[ClassInfo], filepath: str) -> str:
    """Generate JSON output of class hierarchy."""
    data = {
        "path": filepath,
        "classCount": len(all_classes),
        "classes": [
            {
                "name": cls.name,
                "file": cls.filepath,
                "bases": cls.base_names,
                "methodCount": len(cls.methods),
                "methods": [
                    {"name": m["name"], "signature": m["signature"]}
                    for m in cls.methods[:10]  # Limit to first 10 methods per class
                ],
            }
            for cls in all_classes
        ],
    }
    
    return json.dumps(data, indent=2)


def _generate_help() -> str:
    return """Usage: python scripts/class-hierarchy.py [path] [options]

Python class inheritance tree scanner. Scans files and outputs the class
hierarchy with inheritance chains and method counts.

Arguments:
  path            Path to .py file or directory (default: current dir)

Options:
  --json          Output detailed JSON with full method signatures
  --help          Show this help message

Output Formats:
  Default       Markdown hierarchy tree + per-class table
  --json        Detailed JSON with all classes and their methods

Examples:
  python scripts/class-hierarchy.py .pi/maestro/lib/github_client.py
  python scripts/class-hierarchy.py .pi/maestro/pipelines/ --json"""


def main():
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Class inheritance tree scanner — maps class relationships.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=_generate_help()
    )
    parser.add_argument("path", nargs="?", default=".", help="Path to .py file or directory")
    parser.add_argument("--json", action="store_true", help="Output detailed JSON")
    parser.add_argument("--help-all", action="store_true", help="Show extended help")
    
    args = parser.parse_args()
    
    if args.help_all:
        print(_generate_help())
        return
    
    target = Path(args.path).resolve()
    
    if not target.exists():
        print(f"Error: Path not found at '{target}'", file=sys.stderr)
        sys.exit(1)
    
    if target.is_file():
        # Single file mode
        try:
            source = target.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=str(target))
            classes = _extract_classes(tree, str(target.relative_to(Path.cwd())))
        except SyntaxError as e:
            print(f"Error parsing Python file: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        # Directory mode
        classes = _scan_directory(target)
    
    if args.json:
        print(_generate_json(classes, str(target)))
    else:
        output = _generate_markdown(classes, str(target))
        print(output)


if __name__ == "__main__":
    main()
