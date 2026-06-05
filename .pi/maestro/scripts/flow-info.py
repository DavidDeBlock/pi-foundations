#!/usr/bin/env python3
"""
scripts/flow-info.py — Flow configuration analyzer for Maestro.

Parses flow JSON configs and outputs a structured view of phases, transitions,
and retry logic. Useful for understanding workflow structure without reading
all the prompt templates.

Usage:
    python scripts/flow-info.py [flow-name]                 # From flows/ dir (default)
    python scripts/flow-info.py <path-to-flow.json>         # Direct file path
    python scripts/flow-info.py --json                      # Machine-readable output
    python scripts/flow-info.py --help                      # Show usage information

Examples:
    python scripts/flow-info.py builder-reviewer
    python scripts/flow-info.py .pi/maestro/flows/prd-audit.json --json"""

import json
import sys
from pathlib import Path
import argparse


def _load_flow(path_or_name: str) -> dict:
    """Load a flow configuration from file path or name."""
    flows_dir = Path(__file__).parent.parent / "flows"
    
    # Try as direct file path first
    candidate = Path(path_or_name)
    if candidate.exists():
        with open(candidate) as f:
            return json.load(f)
    
    # Try as flow name (lookup in flows/ dir)
    flow_file = flows_dir / f"{path_or_name}.json"
    if flow_file.exists():
        with open(flow_file) as f:
            return json.load(f)
    
    print(f"Error: Flow '{path_or_name}' not found. "
          f"Tried:\n  - {candidate}\n  - {flow_file}", file=sys.stderr)
    sys.exit(1)


def _analyze_flow(config: dict) -> dict:
    """Analyze a flow config and extract structural information."""
    phases = config.get("phases", {})
    transitions = config.get("transitions", [])
    
    # Build transition map for easy lookup
    trans_map = {}
    for t in transitions:
        from_phase = t.get("from", "")
        if from_phase not in trans_map:
            trans_map[from_phase] = []
        trans_map[from_phase].append({
            "on_success": t.get("on_success"),
            "on_reject": t.get("on_reject"),
            "on_error": t.get("on_error"),
        })
    
    # Analyze each phase
    phase_details = {}
    for name, cfg in phases.items():
        skill = cfg.get("skill", "")
        is_local = cfg.get("is_local", False)
        command = cfg.get("command", "")
        retries = cfg.get("retries", 3)
        timeout = cfg.get("timeout_seconds", "default")
        
        phase_details[name] = {
            "type": "local" if is_local else "llm",
            "skill": skill,
            "command": command if is_local else None,
            "retries": retries,
            "timeout_seconds": timeout,
            "transitions": trans_map.get(name, []),
        }
    
    return {
        "name": config.get("name", path_or_name),
        "description": config.get("description", ""),
        "default_provider": config.get("default_provider"),
        "phaseCount": len(phases),
        "phases": phase_details,
    }


def _generate_markdown(analysis: dict) -> str:
    """Generate a Markdown table of flow structure."""
    output = f"# Flow: {analysis['name']}\n\n"
    
    if analysis.get("description"):
        output += f"> {analysis['description']}\n\n"
    
    output += f"**{analysis['phaseCount']} phase(s)** — "
    llm_phases = sum(1 for p in analysis["phases"].values() if p["type"] == "llm")
    local_phases = sum(1 for p in analysis["phases"].values() if p["type"] == "local")
    
    parts = []
    if llm_phases:
        parts.append(f"{llm_phases}x LLM")
    if local_phases:
        parts.append(f"{local_phases}x Local Command")
    output += ", ".join(parts) + "\n\n"
    
    # Phase table
    headers = ["Phase", "Type", "Skill/Command", "Retries", "Timeout"]
    rows = []
    for name, detail in analysis["phases"].items():
        skill_or_cmd = ""
        if detail["type"] == "local":
            cmd = detail.get("command", "")[:50]
            skill_or_cmd = f"`{cmd}`"
        else:
            skill_or_cmd = f"`{detail['skill']}`" if detail["skill"] else "(none)"
        
        rows.append([
            name,
            "LLM" if detail["type"] == "llm" else "Local",
            skill_or_cmd,
            str(detail.get("retries", 3)),
            f"{detail.get('timeout_seconds', 'default')}s",
        ])
    
    # Build table
    col_widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            col_widths[i] = max(col_widths[i], len(str(cell)))
    
    output += "| " + " | ".join(h.ljust(col_widths[i]) for i, h in enumerate(headers)) + " |\n"
    output += "|" + "|".join("-" * (col_widths[i] + 2) for i in range(len(headers))) + "|\n"
    
    for row in rows:
        output += "| " + " | ".join(str(c).ljust(col_widths[i]) for i, c in enumerate(row)) + " |\n"
    
    # Transition map
    if any(detail.get("transitions") for detail in analysis["phases"].values()):
        output += "\n## Transitions\n\n"
        
        for name, detail in analysis["phases"].items():
            trans = detail.get("transitions", [])
            if not trans:
                continue
            
            output += f"**{name}**\n"
            for t in trans:
                outcomes = []
                if t.get("on_success"):
                    outcomes.append(f"success → `{t['on_success']}`")
                if t.get("on_reject"):
                    outcomes.append(f"reject → `{t['on_reject']}`")
                if t.get("on_error"):
                    outcomes.append(f"error → `{t['on_error']}`")
                
                # Check for finish
                for outcome in [t.get(k) for k in ["on_success", "on_reject"]]:
                    if outcome == "finish":
                        outcomes = ["✅ **finish**"]
                        break
            
            output += "  - " + "\n  - ".join(outcomes) + "\n"
    
    return output.strip() + "\n"


def _generate_json(analysis: dict) -> str:
    """Generate JSON output of flow structure."""
    return json.dumps(analysis, indent=2)


def _generate_help() -> str:
    return """Usage: python scripts/flow-info.py [name|path] [options]

Flow configuration analyzer for Maestro orchestrator.
Parses flow JSON configs and outputs phase structure + transitions.

Arguments:
  name            Flow name (e.g., 'builder-reviewer') — looks in flows/ dir
  path            Direct path to a .json flow config file

Options:
  --json          Output detailed JSON with full transition map
  --help          Show this help message

Examples:
  python scripts/flow-info.py builder-reviewer
  python scripts/flow-info.py .pi/maestro/flows/prd-audit.json --json"""


def main():
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Flow configuration analyzer — shows phases and transitions.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=_generate_help()
    )
    parser.add_argument("path", nargs="?", default="builder-reviewer", 
                        help="Flow name or path to .json file (default: builder-reviewer)")
    parser.add_argument("--json", action="store_true", help="Output detailed JSON")
    parser.add_argument("--help-all", action="store_true", help="Show extended help")
    
    args = parser.parse_args()
    global path_or_name  # for use in _analyze_flow
    path_or_name = args.path
    
    if args.help_all:
        print(_generate_help())
        return
    
    try:
        config = _load_flow(path_or_name)
    except json.JSONDecodeError as e:
        print(f"Error parsing JSON: {e}", file=sys.stderr)
        sys.exit(1)
    
    analysis = _analyze_flow(config)
    
    if args.json:
        print(_generate_json(analysis))
    else:
        print(_generate_markdown(analysis))


if __name__ == "__main__":
    main()
