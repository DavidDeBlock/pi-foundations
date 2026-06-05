#!/usr/bin/env python3
"""List public exports (classes, functions, constants) from a Python file."""

import ast
import argparse
from pathlib import Path


class ExportVisitor(ast.NodeVisitor):
    def __init__(self):
        self.exports = []

    def visit_FunctionDef(self, node):
        if not node.name.startswith("_"):
            args = ", ".join(arg.arg for arg in node.args.args)
            self.exports.append(f"  - {node.name}({args})")
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node):
        if not node.name.startswith("_"):
            args = ", ".join(arg.arg for arg in node.args.args)
            self.exports.append(f"  - async {node.name}({args})")
        self.generic_visit(node)

    def visit_ClassDef(self, node):
        if not node.name.startswith("_"):
            bases = f" ({', '.join(b.id for b in node.bases if isinstance(b, ast.Name))})" if node.bases else ""
            self.exports.append(f"  - class {node.name}{bases}")
        self.generic_visit(node)

    def visit_Assign(self, node):
        # Simple constants (uppercase names at module level)
        if all(isinstance(t, ast.Name) and t.id.isupper() for t in node.targets):
            self.exports.append(f"  - {node.targets[0].id} = ...")


def main():
    parser = argparse.ArgumentParser(description="List public exports from a Python file.")
    parser.add_argument("file", help="Path to the Python file")
    parser.add_argument("--json", action="store_true", help="Output as JSON array")
    
    args = parser.parse_args()
    
    try:
        source = Path(args.file).read_text()
        tree = ast.parse(source)
        
        visitor = ExportVisitor()
        visitor.visit(tree)
        
        if not visitor.exports:
            print(f"ℹ️  No public exports found in {args.file}")
            return

        if args.json:
            import json
            # Simple JSON output of names
            names = []
            for line in visitor.exports:
                name = line.split("(")[0].split("class ")[-1].replace("-", "").strip()
                names.append(name)
            print(json.dumps(names))
        else:
            print(f"📦 Exports from {args.file}:")
            for exp in visitor.exports:
                print(exp)

    except FileNotFoundError:
        print(f"❌ File not found: {args.file}")
    except SyntaxError as e:
        print(f"❌ Syntax error in {args.file}: {e}")


if __name__ == "__main__":
    main()
