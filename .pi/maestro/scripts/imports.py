#!/usr/bin/env python3
"""
scripts/imports.py — Python import graph scanner.

Scans a directory or file and outputs its dependency graph: what each module
imports from where, categorized as stdlib / third-party / local.

Usage:
    python scripts/imports.py [path]                      # Markdown table (default)
    python scripts/imports.py [path] --json               # Machine-readable JSON
    python scripts/imports.py [path] --help               # Show usage information

Examples:
    python scripts/imports.py .pi/maestro/lib/github_client.py
    python scripts/imports.py .pi/maestro/pipelines/ --depth 1
"""

import ast
import json
import sys
from pathlib import Path
from typing import Optional
import argparse


# Known stdlib modules (common ones, not exhaustive)
STDLIB_MODULES = {
    "abc", "aifc", "argparse", "array", "ast", "asynchat", "asyncio",
    "asyncore", "atexit", "audioop", "base64", "bdb", "binascii",
    "binhex", "bisect", "builtins", "bz2", "calendar", "cgi", "cgitb",
    "chunk", "cmath", "cmd", "code", "codecs", "codeop", "collections",
    "colorsys", "compileall", "concurrent", "configparser", "contextlib",
    "contextvars", "copy", "copyreg", "cProfile", "crypt", "csv",
    "ctypes", "curses", "dataclasses", "datetime", "dbm", "decimal",
    "difflib", "dis", "distutils", "doctest", "email", "encodings",
    "enum", "errno", "faulthandler", "fcntl", "filecmp", "fileinput",
    "fnmatch", "formatter", "fractions", "ftplib", "functools", "gc",
    "getopt", "getpass", "gettext", "glob", "grp", "gzip", "hashlib",
    "heapq", "hmac", "html", "http", "idlelib", "imaplib", "imghdr",
    "imp", "importlib", "inspect", "io", "ipaddress", "itertools",
    "json", "keyword", "lib2to3", "linecache", "locale", "logging",
    "lzma", "mailbox", "mailcap", "marshal", "math", "mimetypes",
    "mmap", "modulefinder", "multiprocessing", "netrc", "nis", "nntplib",
    "numbers", "operator", "optparse", "os", "ossaudiodev", "parser",
    "pathlib", "pdb", "pickle", "pickletools", "pipes", "pkgutil",
    "platform", "plistlib", "poplib", "posix", "posixpath", "pprint",
    "profile", "pstats", "pty", "pwd", "py_compile", "pyclbr",
    "pydoc", "queue", "quopri", "random", "re", "readline", "reprlib",
    "resource", "rlcompleter", "runpy", "sched", "secrets", "select",
    "selectors", "shelve", "shlex", "shutil", "signal", "site",
    "smtpd", "smtplib", "sndhdr", "socket", "socketserver", "spwd",
    "sqlite3", "sre_compile", "sre_constants", "sre_parse", "ssl",
    "stat", "statistics", "string", "stringprep", "struct", "subprocess",
    "sunau", "symtable", "sys", "sysconfig", "syslog", "tabnanny",
    "tarfile", "telnetlib", "tempfile", "termios", "test", "textwrap",
    "threading", "time", "timeit", "tkinter", "token", "tokenize",
    "trace", "traceback", "tracemalloc", "tty", "turtle", "turtledemo",
    "types", "typing", "unicodedata", "unittest", "urllib", "uu",
    "uuid", "venv", "warnings", "wave", "weakref", "webbrowser",
    "winreg", "winsound", "wsgiref", "xdrlib", "xml", "xmlrpc",
    "zipapp", "zipfile", "zipimport", "zlib", "_thread", "__future__",
}


def _classify_module(module: str, base_dir=None) -> str:
    """Classify a module as stdlib, third-party, or local."""
    if not module:
        return "local"  # relative import
    
    top_level = module.split(".")[0]
    
    # Check if it's a local package (exists in the scanned tree)
    if _is_local_module(module):
        return "local"
    
    if top_level in STDLIB_MODULES:
        return "stdlib"
    
    return "third-party"


def _is_local_module(module: str, base_dir: Optional[Path] = None) -> bool:
    """Check if a module name corresponds to a local package/module."""
    # Resolve relative to the scanned directory
    if base_dir is None:
        base_dir = Path.cwd()
    
    parts = module.split(".")
    
    # Check for direct file match (e.g., "github_client" -> github_client.py)
    for part in [module, parts[0]]:
        py_file = base_dir / f"{part}.py"
        if py_file.exists():
            return True
        
        pkg_dir = base_dir / part
        init_file = pkg_dir / "__init__.py"
        if pkg_dir.exists() and init_file.exists():
            return True
    
    return False


def _extract_imports(tree: ast.Module) -> list[dict]:
    """Extract all imports from an AST module."""
    imports = []
    
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                name = alias.name
                asname = alias.asname
                imports.append({
                    "module": name,
                    "asname": f" as {asname}" if asname else "",
                    "type": _classify_module(name),
                    "line": node.lineno,
                })
        
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            level = node.level  # 0 = absolute, >0 = relative
            
            for alias in node.names:
                name = alias.name
                asname = alias.asname
                
                if level > 0:
                    rel_prefix = "." * level
                    full_module = f"{rel_prefix}{module}" if module else rel_prefix
                else:
                    full_module = module
                
                imports.append({
                    "module": full_module,
                    "names": name + (f" as {asname}" if asname else ""),
                    "level": level,
                    "type": _classify_module(full_module),
                    "line": node.lineno,
                })
    
    return imports


def _scan_directory(dirpath: Path) -> list[dict]:
    """Scan a directory for all .py files and extract their imports."""
    results = []
    
    # Use the parent of maestro dir as base for local detection
    base_dir = dirpath.parent.parent  # .pi/maestro/scripts → .pi → project root
    
    for py_file in sorted(dirpath.glob("**/*.py")):
        if "__pycache__" in str(py_file):
            continue
        
        try:
            source = py_file.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=str(py_file))
            imports = _extract_imports(tree)
            
            # Classify each import relative to base_dir
            for imp in imports:
                imp["type"] = _classify_module(imp.get("module", ""), base_dir)
            
            results.append({
                "file": str(py_file.relative_to(dirpath)),
                "imports": imports,
            })
        except SyntaxError:
            continue
    
    return results


def _generate_markdown(data: list[dict], filepath: str) -> str:
    """Generate a Markdown table of import dependencies."""
    output = f"# Imports: {filepath}\n\n"
    
    if not data:
        output += "> No Python files found.\n"
        return output.strip() + "\n"
    
    # Summary counts
    total_files = len(data)
    type_counts = {"stdlib": 0, "third-party": 0, "local": 0}
    for entry in data:
        for imp in entry["imports"]:
            t = imp.get("type", "unknown")
            type_counts[t] = type_counts.get(t, 0) + 1
    
    output += f"**{total_files} file(s)** — "
    parts = []
    for t, v in sorted(type_counts.items()):
        if v > 0:
            parts.append(f"{v}x {t}")
    output += ", ".join(parts) + "\n\n"
    
    # Group imports by category
    stdlib_imports = set()
    third_party_imports = set()
    local_imports = set()
    
    for entry in data:
        for imp in entry["imports"]:
            mod = imp.get("module", "")
            t = imp.get("type", "unknown")
            if t == "stdlib":
                stdlib_imports.add(mod)
            elif t == "third-party":
                third_party_imports.add(mod)
            else:
                local_imports.add(mod)
    
    # Show unique dependencies by category
    output += "## 📦 Unique Dependencies\n\n"
    
    if stdlib_imports:
        output += f"**stdlib ({len(stdlib_imports)}):** " + ", ".join(sorted(stdlib_imports)) + "\n\n"
    
    if third_party_imports:
        output += f"**third-party ({len(third_party_imports)}):** " + ", ".join(sorted(third_party_imports)) + "\n\n"
    
    if local_imports:
        output += f"**local ({len(local_imports)}):** " + ", ".join(sorted(local_imports)) + "\n\n"
    
    # Per-file breakdown (only if few files)
    if len(data) <= 20:
        output += "## 📋 Per-File Breakdown\n\n"
        
        for entry in data[:20]:
            file_name = entry["file"]
            imports = entry["imports"]
            
            # Group by type
            stdlib = [i["module"] + i.get("asname", "") for i in imports if i.get("type") == "stdlib"]
            third_party = [i["module"] + i.get("names", "") for i in imports if i.get("type") == "third-party"]
            local = [i["module"] + (f".{i['names']}" if 'names' in i else "") for i in imports if i.get("type") == "local"]
            
            output += f"### `{file_name}`\n\n"
            
            table_rows = []
            for mod in stdlib:
                table_rows.append(["stdlib", "", mod])
            for mod in third_party:
                table_rows.append(["third-party", "", mod])
            for mod in local:
                table_rows.append(["local", "", mod])
            
            if table_rows:
                headers = ["Type", "Line", "Import"]
                col_widths = [len(h) for h in headers]
                for row in table_rows:
                    for i, cell in enumerate(row):
                        col_widths[i] = max(col_widths[i], len(str(cell)))
                
                output += "| " + " | ".join(h.ljust(col_widths[i]) for i, h in enumerate(headers)) + " |\n"
                output += "|" + "|".join("-" * (col_widths[i] + 2) for i in range(len(headers))) + "|\n"
                
                for row in table_rows:
                    line = ""
                    if len(row) > 1 and str(row[1]):
                        line = f"{row[1]} "
                    output += "| " + " | ".join(
                        (str(c) + line).ljust(col_widths[i]) if c else "".ljust(col_widths[i] + len(line)) 
                        for i, c in enumerate(row[:2])
                    ) + f" | {row[2]} |\n"
            
            output += "\n"
    elif len(data) > 0:
        output += f"*{len(data)} files scanned — use --json for full per-file breakdown*\n\n"
    
    return output.strip() + "\n"


def _generate_json(data: list[dict], filepath: str) -> str:
    """Generate JSON output of import graph."""
    data_out = {
        "path": filepath,
        "fileCount": len(data),
        "files": data,
    }
    return json.dumps(data_out, indent=2)


def _generate_help() -> str:
    return """Usage: python scripts/imports.py [path] [options]

Python import graph scanner. Scans files and outputs dependency graphs
categorized as stdlib / third-party / local.

Arguments:
  path          Path to .py file or directory (default: current dir)

Options:
  --json        Output detailed JSON with full per-file breakdown
  --help        Show this help message

Output Formats:
  Default       Markdown table of unique dependencies + per-file summary
  --json        Detailed JSON with per-file import lists and classifications

Examples:
  python scripts/imports.py .pi/maestro/lib/github_client.py
  python scripts/imports.py .pi/maestro/pipelines/ --json"""


def main():
    parser = argparse.ArgumentParser(
        description="Python import graph scanner — maps module dependencies.",
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
            imports = _extract_imports(tree)
            
            # Classify relative to parent of maestro dir as base
            base_dir = Path("/home/david/projects/pi-pos-v1")
            for imp in imports:
                imp["type"] = _classify_module(imp.get("module", ""), base_dir)
            
            data = [{"file": target.name, "imports": imports}]
        except SyntaxError as e:
            print(f"Error parsing Python file: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        # Directory mode
        data = _scan_directory(target)
    
    if args.json:
        print(_generate_json(data, str(target)))
    else:
        print(_generate_markdown(data, str(target)))


if __name__ == "__main__":
    main()
