#!/usr/bin/env python3
"""
rpcs.py — Click CLI subcommands for monitoring and managing running Pi RPC clients.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import click
from rich.console import Console
from rich.table import Table

# Add parent's parent to path so we can import lib
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

import process_manager


@click.group()
def rpcs_cli() -> None:
    """Inspect and manage running Pi RPC client processes."""
    pass


@rpcs_cli.command("list")
def list_cmd() -> None:
    """List all active and orphaned Pi RPC client processes."""
    console = Console()
    procs = process_manager.get_active_processes()
    
    if not procs:
        console.print("[yellow]No active Pi RPC processes running.[/yellow]")
        return

    table = Table(title="Active Pi RPC Client Processes")
    table.add_column("PID", style="cyan")
    table.add_column("Status", style="bold")
    table.add_column("Issue", style="magenta")
    table.add_column("Flow", style="blue")
    table.add_column("Phase", style="green")
    table.add_column("Started", style="yellow")
    table.add_column("Elapsed", style="yellow")
    table.add_column("Command", style="dim")

    now = time.time()

    for p in procs:
        status = p["status"]
        status_style = "green" if status == "registered" else "yellow"
        
        issue_str = f"#{p['issue_num']}" if p["issue_num"] > 0 else "—"
        flow_str = p["flow_name"] if p["flow_name"] != "unknown" else "—"
        phase_str = p["phase_name"] if p["phase_name"] != "unknown" else "—"
        started_str = p["start_time_iso"] if p["start_time_iso"] != "unknown" else "—"
        
        elapsed_str = "—"
        if p["start_time"]:
            elapsed = int(now - p["start_time"])
            if elapsed < 60:
                elapsed_str = f"{elapsed}s"
            elif elapsed < 3600:
                elapsed_str = f"{elapsed // 60}m {elapsed % 60}s"
            else:
                elapsed_str = f"{elapsed // 3600}h {(elapsed % 3600) // 60}m"
                
        cmd_str = " ".join(p["cmd"])
        if len(cmd_str) > 50:
            cmd_str = cmd_str[:47] + "..."

        table.add_row(
            str(p["pid"]),
            f"[{status_style}]{status}[/{status_style}]",
            issue_str,
            flow_str,
            phase_str,
            started_str,
            elapsed_str,
            cmd_str
        )

    console.print(table)


@rpcs_cli.command("kill")
@click.argument("pid", type=int)
@click.option("--force", "-f", is_flag=True, help="Force termination using SIGKILL.")
def kill_cmd(pid: int, force: bool) -> None:
    """Terminate a specific Pi RPC client by PID."""
    console = Console()
    console.print(f"Terminating process [cyan]{pid}[/cyan]...")
    if process_manager.kill_process(pid, force=force):
        console.print(f"[green]Successfully terminated process {pid}[/green]")
    else:
        console.print(f"[red]Failed to terminate process {pid}[/red]", err=True)
        sys.exit(1)


@rpcs_cli.command("kill-all")
@click.option("--force", "-f", is_flag=True, help="Force termination using SIGKILL.")
def kill_all_cmd(force: bool) -> None:
    """Terminate all running Pi RPC clients."""
    console = Console()
    console.print("Terminating all active Pi RPC processes...")
    killed = process_manager.kill_all_processes(force=force)
    console.print(f"[green]Terminated {killed} processes.[/green]")
