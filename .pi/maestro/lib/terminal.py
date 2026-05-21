#!/usr/bin/env python3
"""
terminal.py — Structured console output with tree layout and progress indicators.

Provides formatted, colorful terminal output for the orchestrator loop,
including issue headers, attempt blocks, feedback lines, and session metadata.

Usage:
    from lib.terminal import Terminal
    
    term = Terminal(verbose=True)
    
    # Issue header
    term.issue_header(issue_num=9, title="Add payment gateway", comments_count=3, created_at="2024-01-15")
    
    # Attempt block with metadata
    term.attempt_start(phase_name="builder", attempt_num=1, max_retries=3)
    term.attempt_metadata(model="llama-cpp-3090/qwen-35b-a3b-118k-bf16", duration_seconds=42.5, file_ops_written=37, file_ops_failed=4)
    
    # Feedback (rejection)
    term.feedback("TS6059: server/src/... outside rootDir")
    
    # Phase approval
    term.phase_approved(phase_name="builder", is_retry=True)
"""

import sys
from pathlib import Path


# ANSI color codes
CYAN = "\033[0;36m"
GREEN = "\033[0;32m"
YELLOW = "\033[1;33m"
RED = "\033[0;31m"
MAGENTA = "\033[0;35m"
BLUE = "\033[0;34m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


def _print(color: str, prefix: str, message: str):
    """Print a colored line with prefix to stderr."""
    print(f"{color}{prefix}{RESET} {message}", file=sys.stderr)


class Terminal:
    """Formatted terminal output handler with tree layout support."""
    
    def __init__(self, verbose: bool = False):
        self.verbose = verbose
    
    # ── Verbose helpers (legacy raw markers) ──────────────────────────
    
    def _print_verbose(self, message: str):
        """Print raw debug marker if verbose mode is enabled."""
        if self.verbose:
            print(message, file=sys.stderr)
            sys.stderr.flush()
    
    # ── Header & Summary ──────────────────────────────────────────────
    
    def heading(self, title: str):
        """Print main heading with separator lines."""
        width = 50
        border = "━" * width
        print(f"\n{BOLD}{CYAN}🚀 Maestro — {title}{RESET}", file=sys.stderr)
        print(border, file=sys.stderr)
    
    def issue_header(self, issue_num: int, title: str = None, 
                     comments_count: int = None, created_at: str = None):
        """Print issue header with metadata.
        
        Example output:
           ────────────────────────────────────────
           🔍 Issue #9: Processing — "Add payment gateway" (3 comments, created 2024-01-15)
        """
        print(f"\n{DIM}{'─' * 40}{RESET}", file=sys.stderr)
        
        meta_parts = []
        if title:
            meta_parts.append(f"— \"{title}\"")
        if comments_count is not None:
            meta_parts.append(f"{comments_count} comment(s)")
        if created_at:
            meta_parts.append(f"created {created_at}")
        
        meta_str = " ".join(meta_parts) if meta_parts else ""
        
        header_text = f"{BOLD}{BLUE}🔍 Issue #{issue_num}: Processing{RESET}"
        if meta_str:
            header_text += f" — {meta_str}"
        
        print(header_text, file=sys.stderr)
    
    def summary(self, issues_completed: int, issues_failed: int = 0):
        """Print final batch summary."""
        border = "━" * 50
        print(f"\n{border}", file=sys.stderr)
        
        if issues_failed == 0 and issues_completed > 0:
            print(f"{GREEN}{BOLD}✅ All {issues_completed} issue(s) completed successfully!{RESET}", file=sys.stderr)
        elif issues_completed > 0:
            print(f"{YELLOW}{BOLD}⚠️  Completed with {issues_failed} failure(s){RESET}", file=sys.stderr)
            print(f"   {issues_completed} succeeded, {issues_failed} failed", file=sys.stderr)
        else:
            print(f"{DIM}No issues were processed.{RESET}", file=sys.stderr)
        
        print(border, file=sys.stderr)
    
    # ── Attempt Blocks ────────────────────────────────────────────────
    
    def attempt_start(self, phase_name: str, attempt_num: int, max_retries: int):
        """Print the attempt row header.
        
        Example output (first attempt):
           ├─ Attempt 1/3 | Phase: Builder ⏳
           
        Example output (retry):
           ├─ Attempt 2/3 | Phase: Builder (retry) ⏳
        """
        retry_suffix = " (retry)" if attempt_num > 1 else ""
        print(f"{DIM}├─ Attempt {attempt_num}/{max_retries} | Phase: {phase_name.title()}{retry_suffix} ⏳{RESET}", file=sys.stderr)
    
    def attempt_metadata(self, model: str = None, duration_seconds: float = None,
                         file_ops_written: int = 0, file_ops_failed: int = 0):
        """Print inline metadata bullets under an attempt block.
        
        Example output:
           • 🤖 Model: llama-cpp-3090/qwen-35b-a3b-118k-bf16
           • ⏱️  Session lasted 2m 41s
           • 📄 File Operations: 37 written, 4 failed
        """
        lines = []
        
        if model:
            lines.append(f"{DIM}   • {BOLD}{RESET}🤖 Model: {model}")
        
        if duration_seconds and duration_seconds > 0:
            mins = int(duration_seconds // 60)
            secs = int(duration_seconds % 60)
            lines.append(f"{DIM}   • {BOLD}{RESET}⏱️  Session lasted {mins}m {secs}s")
        
        if file_ops_written > 0 or file_ops_failed > 0:
            parts = [f"{file_ops_written} written"]
            if file_ops_failed > 0:
                parts.append(f"{file_ops_failed} failed")
            lines.append(f"{DIM}   • {BOLD}{RESET}📄 File Operations: {', '.join(parts)}")
        
        for line in lines:
            print(line, file=sys.stderr)
    
    # ── Feedback (Rejection) ──────────────────────────────────────────
    
    def feedback(self, details: str):
        """Print rejection feedback indented under the attempt block.
        
        Example output:
           ↺ Reviewer → Rejected
              └─ TS6059: server/src/... outside rootDir
        """
        print(f"\n{YELLOW}   ↺ Feedback → Rejected{RESET}", file=sys.stderr)
        if details:
            truncated = details[:200] if len(details) > 200 else details
            print(f"{DIM}      └─ {truncated}{RESET}", file=sys.stderr)
    
    # ── Phase Approval ────────────────────────────────────────────────
    
    def phase_approved(self, phase_name: str, is_retry: bool = False):
        """Print green approval line with optional (retry) suffix.
        
        Example output:
           ✓ builder approved
           ✓ builder approved (retry)
        """
        retry_suffix = " (retry)" if is_retry else ""
        _print(GREEN, "✓", f"{phase_name} approved{retry_suffix}")
    
    # ── Legacy Helpers (kept for backward compatibility & verbose mode) ──
    
    def success(self, message: str):
        """Print green success indicator."""
        self._print_verbose(f"[SUCCESS] {message}")
        _print(GREEN, "✓", message)
    
    def failure(self, message: str):
        """Print red failure indicator."""
        self._print_verbose(f"[FAILURE] {message}")
        _print(RED, "✗", message)
    
    def warning(self, message: str):
        """Print yellow warning indicator."""
        self._print_verbose(f"[WARNING] {message}")
        _print(YELLOW, "!", message)
    
    def info(self, message: str):
        """Print blue info indicator."""
        self._print_verbose(f"[INFO] {message}")
        _print(BLUE, "•", message)
    
    # ── Batch Progress (unchanged) ────────────────────────────────────
    
    def issue_progress(self, completed: int, total: int = None):
        """Print batch progress indicator."""
        if total and total > 0:
            pct = (completed / total) * 100
            bar_len = 30
            filled = int(bar_len * completed / total)
            bar = "█" * filled + "░" * (bar_len - filled)
            print(f"\n{DIM}Progress: [{bar}] {pct:.0f}% ({completed}/{total}){RESET}", file=sys.stderr)
        else:
            print(f"\n{DIM}Progress: {completed} issue(s) processed{RESET}", file=sys.stderr)
    

