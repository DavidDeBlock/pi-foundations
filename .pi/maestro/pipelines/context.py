#!/usr/bin/env python3
"""
context.py — Rich PipelineContext passed to every pipeline step.

Provides a clean, object-oriented interface for:
- GitHub operations via ctx.github (delegates to GithubClient)
- Flow execution via ctx.run_flow() (delegates to Terminal.run_flow)
- Artifact management with hybrid in-memory/file storage
- Error recording and context variable storage

Usage in pipeline scripts:
    def setup(ctx):
        issues = ctx.github.fetch_issues_by_label("needs-triage")
        for issue in issues:
            ctx.run_flow("builder-reviewer", issue.number)
"""

import sys
from pathlib import Path
from typing import Any, Optional


class PipelineContext:
    """Rich context object passed to every pipeline step.
    
    Attributes:
        term: Terminal instance for output (injected at init).
        github: GithubClient instance for GitHub API operations.
        variables: Dict for small data storage (<50KB per artifact).
        errors: List of error dicts {step, message} recorded during execution.
        completed_steps: Counter for successfully completed steps.
    """
    
    ARTIFACT_MEMORY_LIMIT = 50 * 1024  # 50KB threshold
    ARTIFACT_FILE_DIR = Path(".pi/pipeline/artifacts")
    
    def __init__(self, term=None, gh_client=None):
        """Initialize PipelineContext.
        
        Args:
            term: Terminal instance for output (optional, can be set later).
            gh_client: GithubClient instance for GitHub operations (optional).
        """
        self.term = term
        self.github = gh_client
        self.variables: dict[str, Any] = {}
        self.errors: list[dict] = []
        self.completed_steps = 0
    
    # ── Variable Storage ────────────────────────────────────────────────
    
    def set_variable(self, key: str, value: Any) -> None:
        """Store a variable in context.
        
        Args:
            key: Variable name (string).
            value: Any serializable value.
        """
        self.variables[key] = value
    
    def get_variable(self, key: str, default: Any = None) -> Any:
        """Retrieve a variable from context.
        
        Args:
            key: Variable name (string).
            default: Default value if key doesn't exist.
            
        Returns:
            The stored value or default.
        """
        return self.variables.get(key, default)
    
    # ── Error Recording ────────────────────────────────────────────────
    
    def record_error(self, step: str, message: str) -> None:
        """Record an error that occurred during pipeline execution.
        
        Args:
            step: Name of the step where the error occurred.
            message: Error description.
        """
        self.errors.append({"step": step, "message": message})
        
        if self.term:
            self.term.failure(f"[pipeline] {step}: {message}")
    
    # ── Flow Execution ────────────────────────────────────────────────
    
    def run_flow(
        self,
        flow_name: str,
        issue_num: int,
        max_retries: Optional[int] = None
    ) -> bool:
        """Execute a flow on a specific GitHub issue with retry logic.
        
        Calls into the existing flow_engine.py with this context's
        Terminal and GithubClient instances. Automatically retries
        transient failures (network blips, LLM timeouts) up to max_retries times.
        Failed attempts are recorded in self.errors for batch reporting.
        
        Args:
            flow_name: Name of the flow to execute (e.g., 'builder-reviewer').
            issue_num: GitHub issue number to process.
            max_retries: Maximum retry attempts for transient failures.
                        Defaults to 3 if not specified.
        
        Returns:
            True if flow completed successfully, False after all retries exhausted.
        """
        from flow_engine import run_flow_on_issue
        
        if not self.term:
            raise RuntimeError("PipelineContext.term not initialized")
        
        if max_retries is None:
            max_retries = 3
        
        step_key = f"{flow_name}:issue-{issue_num}"
        last_exception = None
        
        # Build initial context from variables (skip artifact keys)
        initial_context = {
            key: value for key, value in self.variables.items()
            if not key.startswith('artifact:')
        }
        
        for attempt in range(1, max_retries + 1):
            try:
                success = run_flow_on_issue(
                    term=self.term,
                    gh_client=self.github,
                    flow_name=flow_name,
                    issue_num=issue_num,
                    initial_context=initial_context or None
                )
                
                if success:
                    self.completed_steps += 1
                    return True
                else:
                    # Flow ran but didn't complete successfully (not a transient error)
                    # Record as failure and don't retry
                    self.record_error(step_key, "Flow completed with status: failed")
                    return False
                    
            except KeyboardInterrupt:
                # Don't retry keyboard interrupts — re-raise immediately
                raise
                
            except Exception as e:
                last_exception = e
                error_msg = str(e)[:200]
                
                if attempt < max_retries:
                    if self.term:
                        self.term.warning(
                            f"[pipeline] {step_key} attempt {attempt}/{max_retries}: {error_msg}"
                        )
                else:
                    # All retries exhausted
                    error_detail = (
                        f"{step_key} failed after {max_retries} attempts: "
                        f"{error_msg}"
                    )
                    if self.term:
                        self.term.failure(f"[pipeline] {error_detail}")
        
        # All retries exhausted — record the error
        self.record_error(step_key, str(last_exception)[:300])
        return False
    
    # ── Artifact Management ────────────────────────────────────────────
    
    def artifact_write(self, name: str, data: Any, force_file: bool = False) -> str:
        """Write an artifact to storage (memory or file).
        
        Uses a hybrid approach: small artifacts (<50KB) stay in memory
        for fast access; large blobs are written to disk.
        
        Args:
            name: Artifact identifier (string key).
            data: Data to store (will be serialized if not a string).
            force_file: If True, always write to file regardless of size.
            
        Returns:
            ":memory:" if stored in context variables, or the file path.
        """
        import json
        
        # Serialize non-string data; strings written as-is for efficiency
        if isinstance(data, str):
            content = data
        else:
            content = json.dumps(data, indent=2, default=str)
        
        size = len(content.encode('utf-8'))
        
        # Decide storage location
        use_file = force_file or size > self.ARTIFACT_MEMORY_LIMIT
        
        if use_file:
            return self._artifact_write_file(name, content)
        else:
            key = f"artifact:{name}"
            self.variables[key] = data
            return ":memory:"
    
    def artifact_read(self, name: str) -> Optional[Any]:
        """Read an artifact from storage.
        
        Args:
            name: Artifact identifier (string key).
            
        Returns:
            The stored data, or None if not found.
        """
        import json
        
        # Try memory first
        key = f"artifact:{name}"
        if key in self.variables:
            return self.variables[key]
        
        # Fall back to file
        artifact_path = self.ARTIFACT_FILE_DIR / f"{name}.json"
        if artifact_path.exists():
            try:
                with open(artifact_path) as f:
                    content = f.read()
                # Try JSON first (for dicts/lists), fall back to raw string
                return json.loads(content)
            except (json.JSONDecodeError, IOError):
                # Read as plain text if not valid JSON
                try:
                    with open(artifact_path) as f:
                        return f.read()
                except IOError:
                    return None
        
        return None
    
    def _artifact_write_file(self, name: str, content: str) -> str:
        """Write artifact to disk.
        
        Args:
            name: Artifact identifier.
            content: String content to write.
            
        Returns:
            The file path where the artifact was written.
        """
        self.ARTIFACT_FILE_DIR.mkdir(parents=True, exist_ok=True)
        artifact_path = self.ARTIFACT_FILE_DIR / f"{name}.json"
        
        with open(artifact_path, 'w') as f:
            f.write(content)
        
        return str(artifact_path)
    
    # ── Summary Helpers ────────────────────────────────────────────────
    
    def get_summary(self) -> dict:
        """Get execution summary for reporting.
        
        Returns:
            Dict with completed_steps, failed_steps (from errors), and error list.
        """
        return {
            "completed_steps": self.completed_steps,
            "failed_steps": len(self.errors),
            "errors": self.errors
        }
