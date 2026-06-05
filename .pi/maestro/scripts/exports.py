#!/usr/bin/env python3
"""
scripts/exports.py — Python export extractor.

Parses a Python file and outputs its public API: classes, functions, methods,
constants, and module-level variables with their signatures and docstrings.

Usage:
    python scripts/exports.py <path>                    # Markdown table (default)
    python scripts/exports.py <path> --json             # Detailed JSON output
    python scripts/exports.py <path> --help             # Show usage information

Examples:
    python scripts/exports.py .pi/maestro/lib/github_client.py
    python scripts/exports.py .pi/maestro/pipelines/context.py --json
"""

import ast
import json
import sys
import argparse
from pathlib import Path


def _get_docstring(node) -> str:
    """Extract docstring from an AST node."""
    return ast.get_docstring(node) or ""


def _format_annotation(annotation) -> str:
    """Convert an AST annotation node to a string representation."""
    if annotation is None:
        return ""
    try:
        return ast.unparse(annotation)
    except Exception:
        return "<unknown>"


def _get_func_sig(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    """Build a compact signature string for a function."""
    args = []
    
    # Positional-only args (Python 3.8+)
    if hasattr(node.args, 'posonlyargs'):
        for arg in node.args.posonlyargs:
            a = f"{arg.arg}"
            if arg.annotation:
                a += f": {_format_annotation(arg.annotation)}"
            args.append(a)
    
    # Regular args
    for i, arg in enumerate(node.args.args):
        a = f"{arg.arg}"
        if arg.annotation:
            a += f": {_format_annotation(arg.annotation)}"
        if i >= len(node.args.posonlyargs) and node.args.vararg is None:
            # Default args only show for non-positional-only
            pass
        args.append(a)
    
    # *args
    if node.args.vararg:
        a = f"*{node.args.vararg.arg}"
        if node.args.vararg.annotation:
            a += f": {_format_annotation(node.args.vararg.annotation)}"
        args.append(a)
    
    # Keyword-only args
    for arg in node.args.kwonlyargs:
        a = f"{arg.arg}"
        if arg.annotation:
            a += f": {_format_annotation(arg.annotation)}"
        args.append(a)
    
    # **kwargs
    if node.args.kwarg:
        a = f"**{node.args.kwarg.arg}"
        if node.args.kwarg.annotation:
            a += f": {_format_annotation(node.args.kwarg.annotation)}"
        args.append(a)
    
    ret = ""
    if node.returns:
        ret = f" -> {_format_annotation(node.returns)}"
    
    prefix = "async " if isinstance(node, ast.AsyncFunctionDef) else ""
    return f"{prefix}{', '.join(args)}{ret}"


def _extract_exports(tree: ast.Module) -> list[dict]:
    """Extract all public exports from an AST module."""
    exports = []
    
    for node in tree.body:
        # Classes
        if isinstance(node, (ast.ClassDef)):
            bases = [ast.unparse(b) for b in node.bases]
            base_str = f"({', '.join(bases)})" if bases else ""
            
            methods = []
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    is_static = any(
                        isinstance(d, ast.Name) and d.id == 'staticmethod'
                        for d in getattr(item, 'decorator_list', [])
                    )
                    methods.append({
                        "name": item.name,
                        "signature": _get_func_sig(item),
                        "docstring": _get_docstring(item)[:100],
                        "is_static": is_static or (not isinstance(item, ast.AsyncFunctionDef) and any(
                            hasattr(d, 'id') and d.id in ('staticmethod', 'classmethod')
                            for d in getattr(item, 'decorator_list', []) if isinstance(d, ast.Name)
                        )),
                    })
            
            exports.append({
                "name": node.name,
                "kind": "class",
                "bases": base_str,
                "docstring": _get_docstring(node)[:100],
                "methods": methods,
            })
        
        # Functions (top-level only)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            exports.append({
                "name": node.name,
                "kind": "function",
                "signature": _get_func_sig(node),
                "docstring": _get_docstring(node)[:100],
            })
        
        # Constants and module-level variables (top-level assignments)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id.isupper():
                    exports.append({
                        "name": target.id,
                        "kind": "constant",
                        "value": str(type(node.value).__name__),
                    })
        
        # Type aliases (Python 3.12+ AnnAssign at module level)
        elif isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name):
                name = node.target.id
                if not name.startswith('_'):
                    exports.append({
                        "name": name,
                        "kind": "type",
                        "signature": f"{name}: {_format_annotation(node.annotation)}",
                    })
    
    return exports


def _generate_markdown(exports: list[dict], filepath: str) -> str:
    """Generate a Markdown table of exports."""
    filename = Path(filepath).name
    
    output = f"# Exports: {filename}\n\n"
    
    if not exports:
        output += "> No public exports found in this file.\n"
        return output.strip() + "\n"
    
    # Group by kind
    grouped: dict[str, list[dict]] = {}
    for exp in exports:
        k = exp["kind"]
        if k not in grouped:
            grouped[k] = []
        grouped[k].append(exp)
    
    kind_icons = {
        "class": "🏗️",
        "function": "⚡",
        "constant": "📦",
        "type": "🔤",
    }
    kind_labels = {
        "class": "Classes",
        "function": "Functions",
        "constant": "Constants",
        "type": "Type Aliases",
    }
    
    output += f"**{len(exports)} export(s)** — "
    counts: dict[str, int] = {}
    for exp in exports:
        counts[exp["kind"]] = counts.get(exp["kind"], 0) + 1
    
    parts = []
    for k, v in sorted(counts.items()):
        label = kind_labels.get(k, k.title())
        parts.append(f"{v}x {label}")
    output += ", ".join(parts) + "\n\n"
    
    for kind, items in grouped.items():
        icon = kind_icons.get(kind, "📄")
        label = kind_labels.get(kind, kind.title())
        output += f"## {icon} {label}\n\n"
        
        headers = ["Name", "Signature"]
        if kind == "class":
            headers.append("Methods")
        elif kind in ("function",):
            headers.append("JSDoc (truncated)")
        rows: list[list[str]] = []
        
        for exp in items:
            if kind == "class":
                methods_str = ", ".join(m["name"] for m in exp.get("methods", [])[:5])
                if len(exp.get("methods", [])) > 5:
                    methods_str += f" (+{len(exp['methods'])-5} more)"
                rows.append([exp["name"], exp.get("bases", ""), methods_str])
            elif kind == "function":
                rows.append([exp["name"], exp.get("signature", "")[:80], exp.get("docstring", "")[:60]])
            else:
                val = exp.get("value", exp.get("signature", ""))
                rows.append([exp["name"], str(val)[:80]])
        
        # Build markdown table manually (no external dependency)
        num_cols = len(headers)
        col_widths = [len(h) for h in headers]
        
        # Pad rows to match header count
        padded_rows: list[list[str]] = []
        for row in rows:
            while len(row) < num_cols:
                row.append("")
            padded_rows.append(row)
        
        for row in padded_rows:
            for i, cell in enumerate(row):
                col_widths[i] = max(col_widths[i], len(str(cell)))
        
        header_row = "| " + " | ".join(h.ljust(col_widths[i]) for i, h in enumerate(headers)) + " |"
        sep_row = "|" + "|".join("-" * (col_widths[i] + 2) for i in range(num_cols)) + "|"
        
        output += header_row + "\n" + sep_row + "\n"
        for row in padded_rows:
            cells = [str(c).ljust(col_widths[i]) if c else "".ljust(col_widths[i]) for i, c in enumerate(row)]
            output += "| " + " | ".join(cells) + " |\n"
        
        output += "\n"
    
    return output.strip() + "\n"


def _generate_json(exports: list[dict], filepath: str) -> str:
    """Generate JSON output of exports."""
    data = {
        "file": Path(filepath).name,
        "path": filepath,
        "exportCount": len(exports),
        "exports": exports,
    }
    return json.dumps(data, indent=2)


def _generate_help() -> str:
    return """Usage: python scripts/exports.py <path> [options]

Python export extractor. Parses a Python file and outputs its public API
with signatures, docstrings, and type information.

Arguments:
  path          Path to the .py file to analyze

Options:
  --json        Output detailed JSON (includes full parameter lists, return types)
  --help        Show this help message

Output Formats:
  Default       Markdown table grouped by kind (Name | Signature | Details)
  --json        Detailed JSON with full signatures and metadata

Examples:
  python scripts/exports.py .pi/maestro/lib/github_client.py
  python scripts/exports.py .pi/maestro/pipelines/context.py --json"""


def main():
    parser = argparse.ArgumentParser(
        description="Python export extractor — lists classes, functions, constants with signatures.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=_generate_help()
    )
    parser.add_argument("path", nargs="?", default=".", help="Path to the .py file to analyze")
    parser.add_argument("--json", action="store_true", help="Output detailed JSON")
    parser.add_argument("--help-all", action="store_true", help="Show extended help")
    
    args = parser.parse_args()
    
    if args.help_all:
        print(_generate_help())
        return
    
    filepath = str(Path(args.path).resolve())
    
    try:
        source = Path(filepath).read_text(encoding="utf-8")
    except FileNotFoundError:
        print(f"Error: File not found at '{filepath}'", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error reading file: {e}", file=sys.stderr)
        sys.exit(1)
    
    try:
        tree = ast.parse(source, filename=filepath)
    except SyntaxError as e:
        print(f"Error parsing Python file: {e}", file=sys.stderr)
        sys.exit(1)
    
    exports = _extract_exports(tree)
    
    if args.json:
        print(_generate_json(exports, filepath))
    else:
        print(_generate_markdown(exports, filepath))


if __name__ == "__main__":
    main()
