#!/usr/bin/env python3
"""
Maestro CLI Demo — Showcasing the Rich Terminal Library

Demonstrates 3 key features:
  1. Tables          — Structured data with styling, alignment, and headers
  2. Syntax Highlighting — Beautiful code rendering with language detection
  3. Live Progress    — Real-time progress bars with live console updates

Run: python3 .pi/maestro/cli-demo.py
"""

import time
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.syntax import Syntax
from rich.progress import (
    Progress,
    BarColumn,
    TextColumn,
    SpinnerColumn,
    TimeRemainingColumn,
)
from rich.markdown import Markdown
from rich.align import Align

console = Console()


# ── Feature 1: Tables ────────────────────────────────────────────────

def demo_tables():
    """Showcase Rich tables with styling, alignment, and multi-column layouts."""

    console.print(
        Panel(
            "[bold cyan]Feature 1: Tables[/]",
            border_style="cyan",
            subtitle="Structured data with headers, alignment & inline markup",
        )
    )

    # Feature comparison table
    table = Table(
        title="Rich Library — Key Features Comparison",
        show_header=True,
        header_style="bold magenta",
        border_style="blue",
        caption="Built-in rendering, no external dependencies required",
    )
    table.add_column("Feature", style="cyan", width=28)
    table.add_column("Complexity", justify="center")
    table.add_column("Use Case", style="yellow")
    table.add_column("Lines of Code", justify="right")

    features = [
        ("Tables & Grids", "Low", "Dashboards, reports", "~15"),
        ("Syntax Highlighting", "Medium", "Code snippets, docs", "~20"),
        ("Progress Bars", "Low", "Long-running tasks", "~10"),
        ("Markdown Rendering", "Low", "Docs, changelogs", "~5"),
        ("Live Terminal Updates", "Medium", "Monitoring, CLI tools", "~30"),
        ("Panel Layouts", "Low", "Modular UI sections", "~8"),
    ]

    for row in features:
        table.add_row(*row)

    console.print(table)

    # Stats table — right-aligned numbers
    stats_table = Table(
        title="Project Statistics",
        show_header=True,
        header_style="bold green",
        border_style="green",
    )
    stats_table.add_column("Metric", style="white")
    stats_table.add_column("Count", justify="right", style="bright_cyan")

    stats = [
        ("Total Exports", "45+"),
        ("API Routes", "12"),
        ("Test Files", "38"),
        ("Lines of Code (server)", "6,200"),
        ("Documentation Pages", "27"),
    ]

    for metric, count in stats:
        stats_table.add_row(metric, f"[bold]{count}[/]")

    console.print(stats_table)


# ── Feature 2: Syntax Highlighting ───────────────────────────────────

def demo_syntax():
    """Showcase Rich syntax highlighting with language-specific themes."""

    console.print()
    console.print(
        Panel(
            "[bold cyan]Feature 2: Syntax Highlighting[/]",
            border_style="cyan",
            subtitle="Language-aware code rendering with customizable themes",
        )
    )

    # Python snippet
    python_code = '''\
from dataclasses import dataclass
from typing import Optional


@dataclass
class Task:
    """Represents a work item in the pipeline."""

    name: str
    status: str = "pending"
    priority: int = 1

    def complete(self) -> None:
        self.status = "done"
        print(f"[green]✓[/] {self.name} completed")


def create_task(name: str, priority: int = 1) -> Task:
    """Factory function for creating new tasks."""
    task = Task(name=name, priority=priority)
    return task'''

    console.print(
        Panel(
            Syntax(python_code, "python", theme="monokai", line_numbers=True),
            title="[bold]Python — Data Model[/]",
            border_style="green",
            padding=(1, 2),
        )
    )

    # TypeScript snippet
    ts_code = '''\
interface PipelineStage {
  name: string;
  status: 'idle' | 'running' | 'done';
  progress: number;
}

function runStage(stage: PipelineStage): void {
  stage.status = 'running';
  console.log(`▶ ${stage.name}`);

  // Simulate work
  const result = process(stage);
  stage.progress = 100;
  stage.status = 'done';
}'''

    console.print(
        Panel(
            Syntax(ts_code, "typescript", theme="dracula", line_numbers=True),
            title="[bold]TypeScript — Pipeline Runner[/]",
            border_style="magenta",
            padding=(1, 2),
        )
    )


# ── Feature 3: Live Progress Bars ────────────────────────────────────

def demo_progress():
    """Showcase Rich live progress bars with spinners and timing."""

    console.print()
    console.print(
        Panel(
            "[bold cyan]Feature 3: Live Progress Bars[/]",
            border_style="cyan",
            subtitle="Real-time updates with spinners, ETA & custom columns",
        )
    )

    tasks = [
        ("Initializing pipeline...", {"style": "green"}),
        ("Running data validation...", {"style": "yellow"}),
        ("Processing 1,247 records...", {"style": "blue"}),
        ("Generating reports...", {"style": "magenta"}),
        ("Cleaning up resources...", {"style": "cyan"}),
    ]

    with Progress(
        SpinnerColumn("dots"),
        TextColumn("[bold blue]{task.description}"),
        BarColumn(bar_width=40),
        TextColumn("{task.percentage:.0f}%"),
        TimeRemainingColumn(),
        console=console,
    ) as progress:
        for task_name, style_kwargs in tasks:
            task = progress.add_task(task_name, total=100, **style_kwargs)
            while not progress.finished:
                # Simulate variable-speed work
                speed = progress.tasks[task].speed or 2
                advance = min(speed * 3, 100 - progress.tasks[task].elapsed)
                progress.update(task, advance=advance + (hash(task_name) % 5))
                time.sleep(0.08)

    # Show a completed summary
    console.print()
    console.print(Panel("[bold green]✓[/] All pipeline stages completed successfully!", border_style="green"))


# ── Bonus: Markdown Rendering ────────────────────────────────────────

def demo_markdown():
    """Bonus feature: Rich markdown rendering."""

    console.print()
    md_text = """\
### Why Rich?

Rich makes your terminal **beautiful** with zero config. It provides:

- 📊 **Tables** — Sortable, styled data grids
- 🎨 **Syntax Highlighting** — 20+ language themes
- ⏳ **Progress Bars** — Live updates with ETA
- 📝 **Markdown** — Render markdown directly in the terminal
- 🧩 **Panels & Layouts** — Modular UI composition

> *"The best CLI rendering library for Python."* — [GitHub Trending](https://github.com/textualize/rich)
"""

    console.print(Panel(Markdown(md_text), title="[bold]Bonus: Markdown Rendering[/]", border_style="yellow", padding=(1, 2)))


# ── Main Entry Point ─────────────────────────────────────────────────

def main():
    """Run the full CLI demo."""

    # Opening header
    console.print()
    console.rule("[bold red]🎭[/] [bold cyan]Maestro CLI Demo[/] [dim]| Rich Library Showcase[/]")
    console.print(
        Align.center(
            "[dim]Demonstrating 3 key features of the Rich terminal rendering library[/]\n"
            "[dim]Run: python3 .pi/maestro/cli-demo.py[/]"
        )
    )

    # Run each demo in sequence
    demo_tables()
    console.print()
    demo_syntax()
    console.print()
    demo_progress()
    demo_markdown()

    # Closing
    console.print()
    console.rule("[bold green]✓ Done![/] [dim]| All features demonstrated[/]")
    console.print(Align.center("[dim]Thanks for watching — rich.dev[/]"))


if __name__ == "__main__":
    main()
