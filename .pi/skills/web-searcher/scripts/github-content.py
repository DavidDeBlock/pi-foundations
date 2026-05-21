#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GitHub Content Access — Read files and directories from public GitHub repos

This script provides CLI access to read file contents and directory structures
from public GitHub repositories using the GitHub API.

Usage:
    # List directory tree
    python3 github-content.py tree <owner>/<repo> [path]
    
    # Read file content
    python3 github-content.py read <owner>/<repo> <file-path>
    
    # Get README
    python3 github-content.py readme <owner>/<repo> [branch]

Examples:
    python3 github-content.py tree badlogic/pi-mono packages/coding-agent
    python3 github-content.py read badlogic/pi-mono README.md
    python3 github-content.py readme badlogic/pi-mono main
"""

import base64
import io
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, List, Any

# Fix UTF-8 output on Windows
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# Use shared path constants to avoid hardcoded paths
try:
    from paths import PROJECT_ROOT
except ImportError:
    # Fallback if paths.py not available (for standalone usage)
    PROJECT_ROOT = Path(__file__).parent.parent.parent.parent

# Load .env using shared path constant
try:
    from dotenv import load_dotenv
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        load_dotenv(env_path)
except ImportError:
    pass

# GitHub API endpoints
GITHUB_API = "https://api.github.com"


def get_headers() -> dict:
    """Get headers for GitHub API requests."""
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "pi-agent-web-searcher/1.0"
    }
    # Optional: Add token for higher rate limits (5000 req/hr vs 60 req/hr)
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"token {token}"
    return headers


def parse_repo_ref(repo_ref: str) -> tuple[str, str, Optional[str]]:
    """
    Parse repository reference into owner, repo, and optional branch.
    
    Args:
        repo_ref: String in format "owner/repo" or "owner/repo@branch"
        
    Returns:
        Tuple of (owner, repo, branch) where branch may be None
        
    Examples:
        parse_repo_ref("badlogic/pi-mono") -> ("badlogic", "pi-mono", None)
        parse_repo_ref("badlogic/pi-mono@main") -> ("badlogic", "pi-mono", "main")
    """
    if "@" in repo_ref:
        repo_part, branch = repo_ref.split("@", 1)
    else:
        repo_part, branch = repo_ref, None
    
    parts = repo_part.split("/")
    if len(parts) != 2:
        raise ValueError(f"Invalid repo reference format: '{repo_ref}'. Expected 'owner/repo' or 'owner/repo@branch'")
    
    owner, repo = parts
    return owner, repo, branch


def exponential_backoff(max_retries: int = 3, base_delay: float = 1.0) -> callable:
    """
    Decorator for retry logic with exponential backoff on rate limit errors (403).
    
    Args:
        max_retries: Maximum number of retry attempts
        base_delay: Base delay in seconds before first retry
        
    Returns:
        Decorated function with retry logic
    """
    def decorator(func):
        def wrapper(*args, **kwargs):
            last_error = None
            
            for attempt in range(max_retries + 1):
                try:
                    return func(*args, **kwargs)
                except urllib.error.HTTPError as e:
                    last_error = e
                    
                    if e.code == 403 and attempt < max_retries:
                        # Rate limited - calculate backoff delay
                        delay = base_delay * (2 ** attempt)
                        print(f"[WARN] GitHub API rate limit exceeded. Retrying in {delay:.1f}s... (attempt {attempt + 1}/{max_retries})", file=sys.stderr)
                        time.sleep(delay)
                    elif e.code == 404:
                        # Not found - don't retry, just fail
                        raise
                    else:
                        # Other HTTP errors - don't retry
                        raise
                        
            # All retries exhausted
            if last_error and last_error.code == 403:
                print("[ERROR] GitHub API rate limit exceeded. Please try again later or set GITHUB_TOKEN.", file=sys.stderr)
            raise last_error
            
        return wrapper
    return decorator


import urllib.request
import urllib.error


@exponential_backoff(max_retries=3, base_delay=1.0)
def get_repo_tree(owner: str, repo: str, path: str = "", branch: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Get directory tree structure for a GitHub repository.
    
    Uses the Contents API (more reliable than Git Tree API).
    Lists immediate children of the specified path.
    
    Args:
        owner: Repository owner (username or organization)
        repo: Repository name
        path: Path within repo to list (default: root)
        branch: Branch name (defaults to default branch if not specified)
        
    Returns:
        List of file/directory entries with metadata
        
    Raises:
        ValueError: If repo reference is invalid
        HTTPError: If repository doesn't exist or access denied
    """
    # First, get repo info to find default branch if not specified
    if not branch:
        try:
            url = f"{GITHUB_API}/repos/{owner}/{repo}"
            req = urllib.request.Request(url, headers=get_headers())
            with urllib.request.urlopen(req, timeout=10) as response:
                repo_data = json.loads(response.read().decode('utf-8'))
                branch = repo_data.get("default_branch", "main")
        except Exception:
            # Fallback to common branch names
            for default_branch in ["main", "master"]:
                try:
                    url = f"{GITHUB_API}/repos/{owner}/{repo}"
                    req = urllib.request.Request(url, headers=get_headers())
                    with urllib.request.urlopen(req, timeout=5) as response:
                        repo_data = json.loads(response.read().decode('utf-8'))
                        branch = repo_data.get("default_branch", "main")
                        break
                except Exception:
                    continue
            else:
                raise ValueError(f"Could not determine default branch for {owner}/{repo}")
    
    # Use Contents API (more reliable than Git Tree API)
    # Path goes in URL, ref as query param
    if path:
        content_path = f'/{path.lstrip("/")}'
    else:
        content_path = ''  # Empty string for root
    url = f"{GITHUB_API}/repos/{owner}/{repo}/contents{content_path}?ref={branch}"
    
    req = urllib.request.Request(url, headers=get_headers())
    
    with urllib.request.urlopen(req, timeout=30) as response:
        data = json.loads(response.read().decode('utf-8'))
    
    entries = []
    for item in data:
        # Contents API returns: name, path, type (file/dir), size, sha, download_url
        entry = {
            "path": item.get("path"),
            "name": item.get("name"),
            "type": item.get("type"),  # "file" or "dir"
            "size": item.get("size", 0),
            "sha": item.get("sha"),
            "download_url": item.get("download_url")
        }
        entries.append(entry)
    
    return entries


@exponential_backoff(max_retries=3, base_delay=1.0)
def read_github_file(owner: str, repo: str, file_path: str, branch: Optional[str] = None) -> Dict[str, Any]:
    """
    Read the contents of a file from a GitHub repository.
    
    Args:
        owner: Repository owner (username or organization)
        repo: Repository name
        file_path: Path to the file within the repo
        branch: Branch name (defaults to default branch if not specified)
        
    Returns:
        Dictionary with file metadata and decoded content
        
    Raises:
        ValueError: If repo reference is invalid
        HTTPError: If file doesn't exist or access denied
    """
    branch_param = f"?ref={branch}" if branch else ""
    url = f"{GITHUB_API}/repos/{owner}/{repo}/contents/{file_path}{branch_param}"
    
    req = urllib.request.Request(url, headers=get_headers())
    
    with urllib.request.urlopen(req, timeout=30) as response:
        data = json.loads(response.read().decode('utf-8'))
    
    # Handle case where path is a directory (returns error in GitHub API)
    if isinstance(data, dict) and "message" in data:
        raise ValueError(f"Path '{file_path}' is a directory, not a file")
    
    # Decode base64 content
    content = base64.b64decode(data.get("content", "")).decode('utf-8')
    
    result = {
        "path": data.get("path"),
        "name": data.get("name"),
        "size": data.get("size"),
        "sha": data.get("sha"),
        "type": data.get("type"),  # "file"
        "encoding": data.get("encoding"),
        "content": content,
        "download_url": data.get("download_url"),
        "html_url": data.get("html_url"),
        "branch": branch or "default",
        "read_at": datetime.now().isoformat()
    }
    
    return result


def parse_readme_content(content: str, repo_info: Dict[str, Any]) -> str:
    """
    Format README content with metadata and proper markdown structure.
    
    Args:
        content: Raw README.md content
        repo_info: Repository information dictionary
        
    Returns:
        Formatted Markdown string with metadata header
    """
    metadata = f"""---
source: {repo_info.get('html_url', 'N/A')}
file: {repo_info.get('path', 'README.md')}
read_at: {repo_info.get('read_at', datetime.now().isoformat())}
branch: {repo_info.get('branch', 'unknown')}
size: {repo_info.get('size', 0)} bytes
---

"""
    return metadata + content


def format_tree_output(entries: List[Dict[str, Any]], base_path: str = "") -> str:
    """
    Format directory tree output as human-readable text.
    
    Args:
        entries: List of file/directory entries from GitHub API
        base_path: Base path for display purposes
        
    Returns:
        Formatted tree string
    """
    if not entries:
        return "[EMPTY] No files found in this directory."
    
    lines = []
    lines.append(f"=== Directory Tree: {base_path or 'root'} ===\n")
    
    # Sort: directories first, then files, alphabetically within each group
    dirs = sorted([e for e in entries if e["type"] == "dir"], key=lambda x: x.get("name", x.get("path", "")))
    files = sorted([e for e in entries if e["type"] == "file"], key=lambda x: x.get("name", x.get("path", "")))
    
    # Print directories with trailing slash
    for d in dirs:
        name = d.get("name") or d.get("path", "unknown")
        lines.append(f"📁 {name}/")
    
    # Print files with size indicator
    for f in files:
        name = f.get("name") or f.get("path", "unknown")
        size_str = f"{f['size']}B" if f['size'] < 1024 else f"{f['size']/1024:.1f}KB"
        lines.append(f"📄 {name} ({size_str})")
    
    return "\n".join(lines)


def main():
    """CLI interface for GitHub content access."""
    if len(sys.argv) < 3:
        print("Usage: github-content.py <command> <repo-ref> [args]")
        print("")
        print("Commands:")
        print("  tree <owner>/<repo>[@branch] [path]     - List directory structure")
        print("  read <owner>/<repo>[@branch] <file>    - Read file contents")
        print("  readme <owner>/<repo>[@branch] [branch]- Get README with metadata")
        print("")
        print("Examples:")
        print("  github-content.py tree badlogic/pi-mono packages/coding-agent")
        print("  github-content.py read badlogic/pi-mono README.md")
        print("  github-content.py readme badlogic/pi-mono main")
        print("  github-content.py tree badlogic/pi-mono@dev src/")
        sys.exit(1)
    
    command = sys.argv[1]
    repo_ref = sys.argv[2]
    args = sys.argv[3:]
    
    try:
        owner, repo, branch = parse_repo_ref(repo_ref)
        
        if command == "tree":
            # List directory tree
            path = args[0] if args else ""
            
            entries = get_repo_tree(owner, repo, path, branch)
            display_path = f"{owner}/{repo}/{path}" if path else f"{owner}/{repo}"
            print(format_tree_output(entries, display_path))
            
        elif command == "read":
            # Read file content
            if not args:
                print("[ERROR] read command requires a file path argument", file=sys.stderr)
                sys.exit(1)
                
            file_path = args[0]
            
            result = read_github_file(owner, repo, file_path, branch)
            
            # Output with metadata header for documentation use
            print(f"# File: {result['path']}")
            print(f"Source: {result.get('html_url', 'N/A')}")
            print(f"Branch: {result['branch']}")
            print(f"Size: {result['size']} bytes")
            print(f"Read at: {result['read_at']}")
            print("")
            print("--- Content ---")
            print(result["content"])
            
        elif command == "readme":
            # Get README with formatted metadata (try common case variations)
            readme_branch = args[0] if args else branch
            
            # Try different common README filename cases
            readme_filenames = ["README.md", "Readme.md", "readme.md", "README"]
            result = None
            
            for filename in readme_filenames:
                try:
                    result = read_github_file(owner, repo, filename, readme_branch)
                    break
                except (ValueError, urllib.error.HTTPError):
                    continue
            
            if not result:
                print(f"[ERROR] No README found in {owner}/{repo}", file=sys.stderr)
                sys.exit(1)
            
            formatted = parse_readme_content(result["content"], result)
            print(formatted)
            
        else:
            print(f"[ERROR] Unknown command: {command}", file=sys.stderr)
            sys.exit(1)
            
    except ValueError as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f"[ERROR] Repository or path not found (HTTP {e.code})", file=sys.stderr)
        elif e.code == 403:
            print(f"[ERROR] Access denied or rate limited (HTTP {e.code})", file=sys.stderr)
        else:
            print(f"[ERROR] GitHub API error: HTTP {e.code} {e.reason}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"[ERROR] Failed to connect to GitHub: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
