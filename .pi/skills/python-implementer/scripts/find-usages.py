#!/usr/bin/env python3
"""Find usages of a symbol (function/class) in the codebase."""

import ast
import argparse
import sys
from pathlib import Path


class SymbolVisitor(ast.NodeVisitor):
    def __init__(self, target_name):
        self.target = target_name
        self.definitions = []  # Where it's defined (def/ClassDef)
        self.usages = []       # Where it's used

    def visit_FunctionDef(self, node):
        if node.name == self.target:
            self.definitions.append(f"Line {node.lineno}: def {node.name}")
        self.generic_visit(node)

    def visit_ClassDef(self, node):
        if node.name == self.target:
            self.definitions.append(f"Line {node.lineno}: class {node.name}")
        self.generic_visit(node)

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load) and node.id == self.target:
            self.usages.append(f"Line {node.lineno}: usage of '{node.id}'")


def scan_file(filepath, target_name):
    try:
        source = filepath.read_text()
        tree = ast.parse(source)
        visitor = SymbolVisitor(target_name)
        visitor.visit(tree)

        rel_path = filepath.relative_to(Path.cwd()) if filepath.is_absolute() else filepath
        
        print(f"\n📄 {rel_path}")
        if visitor.definitions:
            print("  ✅ Definitions:")
            for d in visitor.definitions:
                print(f"    - {d}")
        if visitor.usages:
            print("  📍 Usages:")
            for u in visitor.usages[:10]:  # Limit output
                print(f"    - {u}")
            if len(visitor.usages) > 10:
                print(f"    ... and {len(visitor.usages) - 10} more usages")
        return bool(visitor.definitions or visitor.usages)

    except (SyntaxError, UnicodeDecodeError):
        return False


def main():
    parser = argparse.ArgumentParser(description="Find where a symbol is used/defined.")
    parser.add_argument("symbol", help="Function or class name to search for")
    parser.add_argument("--path", default=".", help="Directory to scan (default: current dir)")
    
    args = parser.parse_args()
    
    print(f"🔍 Searching for '{args.symbol}' in {args.path}...")
    found_any = False
    
    for py_file in Path(args.path).rglob("*.py"):
        if scan_file(py_file, args.symbol):
            found_any = True

    if not found_any:
        print(f"\n❌ No usages or definitions of '{args.symbol}' found.")
        sys.exit(1)


if __name__ == "__main__":
    main()
