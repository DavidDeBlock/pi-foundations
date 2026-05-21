#!/usr/bin/env python3
"""
runner.py — Core PipelineRunner module for loading and executing pipeline scripts.

Handles:
- Loading Python pipeline scripts from the pipelines/ directory
- Executing them with a rich PipelineContext
- Robust error handling with configurable retry logic
- Continue-on-error mode for batch processing
- Summary reporting of failures at end

Pipeline Definition Format:
    Each pipeline is a .py file in pipelines/ that defines setup() and/or run() functions.
    
    Example (dummy_pipeline.py):
        def setup(ctx):
            ctx.set_variable("status", "initialized")
        
        def run(ctx):
            # Pipeline logic here
            pass

Usage:
    runner = PipelineRunner(term=term)
    pipeline_func = runner.load_pipeline("dummy_pipeline.py")
    result = runner.execute_pipeline(pipeline_func, pipeline_name="dummy")
"""

import sys
from pathlib import Path
from typing import Callable, Optional


class PipelineRunner:
    """Loads and executes Python pipeline scripts with error handling.
    
    Attributes:
        term: Terminal instance for output (injected at init).
        continue_on_error: If True, record errors but keep executing.
        max_retries: Maximum retry attempts for transient failures.
    """
    
    def __init__(self, term=None, gh_client=None, continue_on_error: bool = True, max_retries: int = 3):
        """Initialize PipelineRunner.
        
        Args:
            term: Terminal instance for output (optional).
            gh_client: GithubClient instance for GitHub API operations (optional).
            continue_on_error: Continue executing on failure (default True).
            max_retries: Max retry attempts for transient errors (default 3).
        """
        self.term = term
        self.gh_client = gh_client
        self.continue_on_error = continue_on_error
        self.max_retries = max_retries
    
    # ── Pipeline Loading ────────────────────────────────────────────────
    
    def load_pipeline_from_dir(
        self,
        test_pipeline: str,
        pipelines_dir: Path
    ) -> Optional[Callable]:
        """Load a pipeline script from a specific directory.
        
        Convenience method for testing — loads from any directory, not just
        the default pipelines/ folder.
        
        Args:
            test_pipeline: Name of the pipeline file (e.g., 'dummy_pipeline.py').
            pipelines_dir: Directory containing the pipeline files.
            
        Returns:
            A callable dict with setup/run functions, or None on failure.
            
        Raises:
            FileNotFoundError: If the pipeline file doesn't exist.
            ValueError: If the pipeline has syntax errors.
        """
        if not (pipelines_dir / test_pipeline).exists():
            raise FileNotFoundError(
                f"Pipeline '{test_pipeline}' not found in {pipelines_dir}"
            )
        
        try:
            import importlib.util
            
            spec = importlib.util.spec_from_file_location(
                f"pipeline_{test_pipeline.replace('.py', '')}",
                pipelines_dir / test_pipeline
            )
            
            if spec is None or spec.loader is None:
                raise ValueError(f"Could not load module spec for {test_pipeline}")
            
            module = importlib.util.module_from_spec(spec)
            sys.modules[f"pipeline_{test_pipeline.replace('.py', '')}"] = module
            spec.loader.exec_module(module)
            
            result = {}
            if hasattr(module, 'setup'):
                result['setup'] = module.setup
            if hasattr(module, 'run'):
                result['run'] = module.run
            
            if not result:
                raise ValueError(
                    f"Pipeline '{test_pipeline}' must define setup() and/or run()"
                )
            
            return result
            
        except SyntaxError as e:
            raise ValueError(f"Syntax error in pipeline '{test_pipeline}': {e}")
        except Exception as e:
            if isinstance(e, (FileNotFoundError, ValueError)):
                raise
            raise ValueError(
                f"Failed to load pipeline '{test_pipeline}': {e}"
            )
    
    def load_pipeline(self, pipeline_name: str) -> Optional[Callable]:
        """Load a pipeline script from the pipelines/ directory.
        
        The loaded module must define at least one of: setup(), run()
        
        Args:
            pipeline_name: Name of the pipeline file (e.g., 'dummy_pipeline.py').
            
        Returns:
            A callable dict with setup/run functions, or None on failure.
            
        Raises:
            FileNotFoundError: If the pipeline file doesn't exist.
            ValueError: If the pipeline has syntax errors.
        """
        pipelines_dir = Path(__file__).parent
        
        if not (pipelines_dir / pipeline_name).exists():
            raise FileNotFoundError(
                f"Pipeline '{pipeline_name}' not found in {pipelines_dir}"
            )
        
        try:
            # Import the pipeline module dynamically
            import importlib.util
            
            spec = importlib.util.spec_from_file_location(
                f"pipeline_{pipeline_name.replace('.py', '')}",
                pipelines_dir / pipeline_name
            )
            
            if spec is None or spec.loader is None:
                raise ValueError(f"Could not load module spec for {pipeline_name}")
            
            module = importlib.util.module_from_spec(spec)
            sys.modules[f"pipeline_{pipeline_name.replace('.py', '')}"] = module
            spec.loader.exec_module(module)
            
            # Extract setup and run functions
            result = {}
            
            if hasattr(module, 'setup'):
                result['setup'] = module.setup
            
            if hasattr(module, 'run'):
                result['run'] = module.run
            
            if not result:
                raise ValueError(
                    f"Pipeline '{pipeline_name}' must define setup() and/or run()"
                )
            
            return result
            
        except SyntaxError as e:
            raise ValueError(f"Syntax error in pipeline '{pipeline_name}': {e}")
        except Exception as e:
            if isinstance(e, (FileNotFoundError, ValueError)):
                raise
            raise ValueError(
                f"Failed to load pipeline '{pipeline_name}': {e}"
            )
    
    # ── Pipeline Execution ────────────────────────────────────────────────
    
    def execute_pipeline(self, pipeline_func: Callable, 
                         pipeline_name: str = "unnamed",
                         continue_on_error: Optional[bool] = None) -> dict:
        """Execute a loaded pipeline function with error handling.
        
        Runs the setup() phase first (if present), then run().
        Retries transient failures up to max_retries times.
        
        Args:
            pipeline_func: Dict of {setup, run} functions from load_pipeline().
            pipeline_name: Name for reporting purposes.
            continue_on_error: Override instance default for this execution.
            
        Returns:
            Dict with success status and optional error details.
        """
        if continue_on_error is None:
            continue_on_error = self.continue_on_error
        
        result = {
            "success": True,
            "pipeline": pipeline_name,
            "error": None
        }
        
        # Create context for pipeline execution
        from .context import PipelineContext
        ctx = PipelineContext(term=self.term, gh_client=self.gh_client)
        
        try:
            # Run setup phase (if present)
            if 'setup' in pipeline_func:
                def _run_setup():
                    pipeline_func['setup'](ctx)
                
                success, error_msg = self._execute_with_retry(
                    _run_setup,
                    f"{pipeline_name}:setup",
                    continue_on_error=continue_on_error
                )
                if not success:
                    result["success"] = False
                    result["error"] = error_msg
                    return result
            
            # Run main phase (if present)
            if 'run' in pipeline_func:
                def _run_main():
                    pipeline_func['run'](ctx)
                
                success, error_msg = self._execute_with_retry(
                    _run_main,
                    f"{pipeline_name}:run",
                    continue_on_error=continue_on_error
                )
                if not success:
                    result["success"] = False
                    result["error"] = error_msg
            
        except Exception as e:
            error_msg = str(e)[:500]  # Truncate very long errors
            if self.term:
                self.term.failure(f"[pipeline] {pipeline_name}: {error_msg}")
            
            result["success"] = False
            result["error"] = error_msg
            
            if not continue_on_error:
                raise
        
        return result
    
    def _execute_with_retry(self, func: Callable, step_name: str,
                            continue_on_error: bool = True) -> tuple[bool, Optional[str]]:
        """Execute a function with retry logic for transient failures.
        
        Args:
            func: Function to execute (receives ctx as argument).
            step_name: Name for error reporting.
            continue_on_error: Whether to catch and record errors instead of raising.
            
        Returns:
            Tuple of (success, last_error_message). Success is True if execution
            succeeded on any attempt. Error message is set when all retries exhausted.
            
        Raises:
            Exception: If all retries exhausted and continue_on_error is False.
        """
        last_exception = None
        
        for attempt in range(1, self.max_retries + 1):
            try:
                func()
                return True, None  # Success — exit retry loop
                
            except KeyboardInterrupt:
                # Don't retry keyboard interrupts
                raise
                
            except Exception as e:
                last_exception = e
                error_msg = str(e)[:200]
                
                if attempt < self.max_retries:
                    if self.term:
                        self.term.warning(
                            f"[pipeline] {step_name} attempt {attempt}/{self.max_retries}: {error_msg}"
                        )
                else:
                    # All retries exhausted
                    error_detail = (
                        f"{step_name} failed after {self.max_retries} attempts: "
                        f"{error_msg}"
                    )
                    
                    if self.term:
                        self.term.failure(f"[pipeline] {error_detail}")
                    
                    if not continue_on_error:
                        raise last_exception
        
        return False, str(last_exception)  # All retries exhausted
    
    # ── Single Flow Execution ──────────────────────────────────────────
    
    def run_single_flow(
        self,
        term=None,
        gh_client=None,
        flow_name: str = "",
        issue_num: int = 0,
        max_retries: Optional[int] = None,
        continue_on_error: bool = True
    ) -> dict:
        """Execute a single flow on an issue with retry and error handling.
        
        This is the bridge between pipelines and the existing flow_engine.py.
        It handles automatic retries for transient failures, accumulates errors
        in context when continue_on_error is enabled, and returns structured
        state information (success/failure/retry).
        
        Args:
            term: Terminal instance for output (uses self.term if None).
            gh_client: GithubClient instance for GitHub operations.
            flow_name: Name of the flow to execute (e.g., 'builder-reviewer').
            issue_num: GitHub issue number to process.
            max_retries: Override default retry count. Defaults to self.max_retries.
            continue_on_error: If True, record errors but keep executing;
                              if False, raise on first failure after retries.
        
        Returns:
            Dict with keys:
                - success (bool): Whether the flow completed successfully
                - flow (str): Flow name that was executed
                - issue (int): Issue number processed
                - state (str): 'success', 'failure', or 'retry'
                - error (Optional[str]): Error message if failed
                - context (PipelineContext): Context object with accumulated errors
        """
        term = term or self.term
        max_retries = max_retries if max_retries is not None else self.max_retries
        
        # Create a fresh context for this flow execution
        from .context import PipelineContext
        ctx = PipelineContext(term=term, gh_client=gh_client)
        
        result = {
            "success": False,
            "flow": flow_name,
            "issue": issue_num,
            "state": "failure",
            "error": None,
            "context": ctx
        }
        
        try:
            success = ctx.run_flow(
                flow_name=flow_name,
                issue_num=issue_num,
                max_retries=max_retries
            )
            
            if success:
                result["success"] = True
                result["state"] = "success"
            else:
                result["success"] = False
                # Determine state based on whether there were errors
                if ctx.errors:
                    last_error = ctx.errors[-1].get("message", "Unknown error")
                    result["error"] = last_error[:500]
                    result["state"] = "failure"
                else:
                    result["error"] = f"Flow '{flow_name}' returned False for issue #{issue_num}"
                    result["state"] = "failure"
                
                # If continue_on_error is False and there's a last exception,
                # re-raise it; otherwise wrap in RuntimeError
                if not continue_on_error:
                    error_msg = result.get("error", f"Flow '{flow_name}' failed")
                    raise RuntimeError(error_msg)
        
        except Exception as e:
            error_msg = str(e)[:500]
            if term:
                term.failure(f"[pipeline] {flow_name} on issue #{issue_num}: {error_msg}")
            
            result["success"] = False
            result["error"] = error_msg
            result["state"] = "failure"
            
            if not continue_on_error:
                raise
        
        return result
    
    # ── Batch Operations ────────────────────────────────────────────────
    
    def list_pipelines(self, pipelines_dir: Optional[Path] = None) -> list[str]:
        """List available pipeline scripts in a directory.
        
        Args:
            pipelines_dir: Directory to scan (defaults to this module's dir).
            
        Returns:
            List of .py filenames in the directory.
        """
        if pipelines_dir is None:
            pipelines_dir = Path(__file__).parent
        
        return sorted([
            f.name for f in pipelines_dir.glob("*.py")
            if f.is_file() and f.name != "__init__.py"
        ])
    
    def run_all_pipelines(self, pipelines_dir: Optional[Path] = None) -> list[dict]:
        """Load and execute all pipeline scripts in a directory.
        
        Each pipeline is loaded independently; failures in one don't block others
        (continue_on_error mode).
        
        Args:
            pipelines_dir: Directory containing .py pipeline files.
            
        Returns:
            List of result dicts from execute_pipeline().
        """
        if pipelines_dir is None:
            pipelines_dir = Path(__file__).parent
        
        results = []
        pipeline_names = self.list_pipelines(pipelines_dir)
        
        for name in pipeline_names:
            try:
                pipeline_func = self.load_pipeline_from_dir(
                    test_pipeline=name,
                    pipelines_dir=pipelines_dir
                )
                result = self.execute_pipeline(
                    pipeline_func,
                    pipeline_name=name.replace('.py', ''),
                    continue_on_error=True  # Always continue on error in batch mode
                )
                results.append(result)
                
            except (FileNotFoundError, ValueError) as e:
                if self.term:
                    self.term.warning(f"[pipeline] Skipping {name}: {e}")
                results.append({
                    "success": False,
                    "pipeline": name.replace('.py', ''),
                    "error": str(e)
                })
        
        return results
