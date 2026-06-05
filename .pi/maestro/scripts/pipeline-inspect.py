#!/usr/bin/env python3
"""
scripts/pipeline-inspect.py — Pipeline script inspector.

Loads a pipeline .py file and extracts its setup() and run() functions,
their signatures, docstrings, and context variable usage patterns.

Usage:
    python scripts/pipeline-inspect.py <path>                    # Markdown table (default)
    python scripts/pipeline-inspect.py <path> --json             # Detailed JSON output
    python scripts/pipeline-inspect.py <path> --help             # Show usage information

Examples:
    python scripts/pipeline-inspect.py .pi/maestro/pipelines/autonomous.py
    python scripts/pipeline-inspect.py .pi/maestro/pipelines/dashboard.py --json"""

import ast
import json
import sys
from pathlib import Path
import argparse


def _extract_pipeline_info(filepath: str) -> dict:
    """Extract pipeline structure from a Python file."""
    source = Path(filepath).read_text(encoding="utf-8")
    tree = ast.parse(source, filename=filepath)
    
    result = {
        "file": filepath,
        "has_setup": False,
        "setup_docstring": "",
        "has_run": False,
        "run_docstring": "",
        "ctx_variables_set": [],
        "ctx_variables_get": [],
        "imports": [],
        "other_functions": [],
    }
    
    for node in tree.body:
        # Top-level setup() function
        if isinstance(node, ast.FunctionDef) and node.name == "setup":
            result["has_setup"] = True
            result["setup_docstring"] = ast.get_docstring(node) or ""
        
        # Top-level run() function
        elif isinstance(node, ast.FunctionDef) and node.name == "run":
            result["has_run"] = True
            result["run_docstring"] = ast.get_docstring(node) or ""
            
            # Walk the run function to find ctx variable patterns
            for child in ast.walk(node):
                if isinstance(child, ast.Call):
                    func = child.func
                    # ctx.set_variable(...)
                    if (isinstance(func, ast.Attribute) and 
                        isinstance(func.value, ast.Name) and 
                        func.value.id == "ctx" and 
                        func.attr == "set_variable"):
                        if child.args:
                            arg_str = ast.unparse(child.args[0])[:50]
                            result["ctx_variables_set"].append(arg_str)
                    
                    # ctx.get_variable(...)
                    elif (isinstance(func, ast.Attribute) and 
                          isinstance(func.value, ast.Name) and 
                          func.value.id == "ctx" and 
                          func.attr == "get_variable"):
                        if child.args:
                            arg_str = ast.unparse(child.args[0])[:50]
                            result["ctx_variables_get"].append(arg_str)
                    
                    # ctx.run_flow(...)
                    elif (isinstance(func, ast.Attribute) and 
                          isinstance(func.value, ast.Name) and 
                          func.value.id == "ctx" and 
                          func.attr == "run_flow"):
                        if child.args:
                            arg_str = ast.unparse(child.args[0])[:50]
                            result["ctx_variables_set"].append(f"flow:{arg_str}")
                    
                    # ctx.artifact_write(...) / ctx.artifact_read(...)
                    elif (isinstance(func, ast.Attribute) and 
                          isinstance(func.value, ast.Name) and 
                          func.value.id == "ctx"):
                        if func.attr in ("artifact_write", "artifact_read", "record_error"):
                            result["ctx_variables_set"].append(f"artifact:{func.attr}")
        
        # Other top-level functions (not setup/run)
        elif isinstance(node, ast.FunctionDef):
            sig = f"{node.name}({', '.join(arg.arg for arg in node.args.args)})"
            if hasattr(node.args, 'vararg') and node.args.vararg:
                sig += f", *{node.args.vararg.arg}"
            if hasattr(node.args, 'kwarg') and node.args.kwarg:
                sig += f", **{node.args.kwarg.arg}"
            
            result["other_functions"].append({
                "name": node.name,
                "signature": sig,
                "docstring": ast.get_docstring(node) or "",
            })
        
        # Module-level imports
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    result["imports"].append(f"import {alias.name}")
            else:
                module = node.module or ""
                names = [a.name for a in node.names]
                level = "." * node.level if node.level > 0 else ""
                result["imports"].append(f"from {level}{module} import {', '.join(names)}")
    
    return result


def _generate_markdown(info: dict) -> str:
    """Generate a Markdown table of pipeline structure."""
    output = f"# Pipeline: {Path(info['file']).name}\n\n"
    
    # Structure summary
    if info["has_setup"] and info["has_run"]:
        output += "✅ **Has setup() + run()**\n\n"
    elif info["has_setup"]:
        output += "⚠️  Has setup() only (missing run())\n\n"
    elif info["has_run"]:
        output += "⚠️  Has run() only (missing setup())\n\n"
    else:
        output += "> No setup/run functions found.\n\n"
    
    # Docstrings
    if info["setup_docstring"]:
        output += f"**setup():** {info['setup_docstring'][:100]}\n\n"
    if info["run_docstring"]:
        output += f"**run():** {info['run_docstring'][:100]}\n\n"
    
    # Context variable usage table
    if info["ctx_variables_set"] or info["ctx_variables_get"]:
        headers = ["Type", "Key/Pattern"]
        rows: list[list[str]] = []
        
        for key in info["ctx_variables_set"]:
            rows.append(["set", key])
        for key in info["ctx_variables_get"]:
            rows.append(["get", key])
        
        col_widths = [len(h) for h in headers]
        for row in rows:
            for i, cell in enumerate(row):
                col_widths[i] = max(col_widths[i], len(str(cell)))
        
        output += "## Context Variables\n\n"
        output += "| " + " | ".join(h.ljust(col_widths[i]) for i, h in enumerate(headers)) + " |\n"
        output += "|" + "|".join("-" * (col_widths[i] + 2) for i in range(len(headers))) + "|\n"
        
        for row in rows:
            output += "| " + " | ".join(str(c).ljust(col_widths[i]) for i, c in enumerate(row)) + " |\n"
        
        output += "\n"
    
    # Other functions table
    if info["other_functions"]:
        headers = ["Function", "Signature"]
        rows = []
        col_widths = [len(h) for h in headers]
        
        for func in info["other_functions"]:
            sig_preview = func["signature"][:50]
            rows.append([func["name"], sig_preview])
            col_widths[1] = max(col_widths[1], len(sig_preview))
        
        output += "## Other Functions\n\n"
        output += "| " + " | ".join(h.ljust(col_widths[i]) for i, h in enumerate(headers)) + " |\n"
        output += "|" + "|".join("-" * (col_widths[i] + 2) for i in range(len(headers))) + "|\n"
        
        for row in rows:
            output += "| " + " | ".join(str(c).ljust(col_widths[i]) for i, c in enumerate(row)) + " |\n"
        
        output += "\n"
    
    # Imports (if few)
    if info["imports"] and len(info["imports"]) <= 15:
        output += f"**{len(info['imports'])} import(s):**\n\n"
        for imp in sorted(set(info["imports"])):
            output += f"- `{imp}`\n"
    
    return output.strip() + "\n"


def _generate_json(info: dict) -> str:
    """Generate JSON output of pipeline structure."""
    # Deduplicate imports and context vars for cleaner JSON
    info["imports"] = sorted(set(info["imports"]))
    info["ctx_variables_set"] = list(dict.fromkeys(info["ctx_variables_set"]))  # dedupe while preserving order
    
    return json.dumps(info, indent=2)


def _generate_help() -> str:
    return """Usage: python scripts/pipeline-inspect.py <path> [options]

Pipeline script inspector. Extracts setup/run functions, context variable usage,
and other structural information from pipeline .py files.

Arguments:
  path            Path to the .py file to analyze

Options:
  --json          Output detailed JSON (includes full function signatures)
  --help          Show this help message

Output Formats:
  Default       Markdown table with structure summary and context variable usage
  --json        Detailed JSON with all extracted metadata

Examples:
  python scripts/pipeline-inspect.py .pi/maestro/pipelines/autonomous.py
  python scripts/pipeline-inspect.py .pi/maestro/pipelines/context.py --json"""


def main():
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Pipeline script inspector — extracts setup/run structure.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=_generate_help()
    )
    parser.add_argument("path", help="Path to the .py file to analyze")
    parser.add_argument("--json", action="store_true", help="Output detailed JSON")
    parser.add_argument("--help-all", action="store_true", help="Show extended help")
    
    args = parser.parse_args()
    
    if args.help_all:
        print(_generate_help())
        return
    
    filepath = str(Path(args.path).resolve())
    
    try:
        info = _extract_pipeline_info(filepath)
    except FileNotFoundError:
        print(f"Error: File not found at '{filepath}'", file=sys.stderr)
        sys.exit(1)
    except SyntaxError as e:
        print(f"Error parsing Python file: {e}", file=sys.stderr)
        sys.exit(1)
    
    if args.json:
        print(_generate_json(info))
    else:
        print(_generate_markdown(info))


if __name__ == "__main__":
    main()
