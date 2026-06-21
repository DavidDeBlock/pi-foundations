#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GitHub Repository Search — .pi/library Collection System

Searches GitHub for repositories by topic/keyword using the GitHub API.
Public repos only.
"""

import io
import json
import os
import sys
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime
from pathlib import Path
from typing import Optional

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

# Load .env using stdlib-only helper (no python-dotenv dependency)
from env_loader import load_env
load_env()

# Note: Library index feature removed - search-github.py now returns results only
# To save repos, use the library skill instead

# GitHub API
GITHUB_API = "https://api.github.com"


def get_headers() -> dict:
    """Get headers for GitHub API requests."""
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "pi-agent-library/1.0"
    }
    # Optional: Add token for higher rate limits
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"token {token}"
    return headers


def search_repos(query: str, max_results: int = 10, sort: str = "stars") -> list:
    """
    Search GitHub repositories.
    
    Args:
        query: Search query (e.g., "python requests", "topic:api")
        max_results: Max results to return (default: 10, max: 100)
        sort: Sort by "stars", "forks", "updated"
    
    Returns:
        List of repository data
    """
    max_results = min(max_results, 100)
    
    # Build search URL
    params = urllib.parse.urlencode({
        "q": query,
        "per_page": max_results,
        "sort": sort,
        "order": "desc"
    })
    url = f"{GITHUB_API}/search/repositories?{params}"
    
    try:
        req = urllib.request.Request(url, headers=get_headers())
        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.loads(response.read().decode('utf-8'))
        
        repos = []
        for item in data.get("items", [])[:max_results]:
            repo = {
                "name": item.get("name"),
                "full_name": item.get("full_name"),
                "description": item.get("description") or "",
                "url": item.get("html_url"),
                "api_url": item.get("url"),
                "stars": item.get("stargazers_count", 0),
                "forks": item.get("forks_count", 0),
                "language": item.get("language"),
                "topics": item.get("topics", []),
                "updated_at": item.get("updated_at"),
                "pushed_at": item.get("pushed_at"),
                "default_branch": item.get("default_branch"),
                "has_wiki": item.get("has_wiki", False),
                "search_query": query,
                "searched_at": datetime.now().isoformat()
            }
            repos.append(repo)
        
        return repos
    
    except urllib.error.HTTPError as e:
        if e.code == 403:
            print("[ERROR] GitHub API rate limit exceeded. Try using GITHUB_TOKEN.", file=sys.stderr)
        else:
            print(f"[ERROR] GitHub API error: {e.code} {e.reason}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"[ERROR] Failed to connect to GitHub: {e}", file=sys.stderr)
        sys.exit(1)


def search_topics(topic: str, max_results: int = 10) -> list:
    """Search repos by topic."""
    return search_repos(f"topic:{topic}", max_results)


def search_language(lang: str, max_results: int = 10) -> list:
    """Search repos by language."""
    return search_repos(f"language:{lang}", max_results)


def main():
    """CLI interface."""
    if len(sys.argv) < 2:
        print("Usage: search-github.py <query> [max_results]")
        print("")
        print("Options:")
        print("  <query>         Search query (e.g., 'fastapi', 'python api framework')")
        print("  [max_results]   Max results (default: 10, max: 100)")
        print("")
        print("Examples:")
        print("  search-github.py \"fastapi\" 5")
        print("  search-github.py \"python requests library\"")
        print("  search-github.py \"topic:api language:python\"")
        sys.exit(1)
    
    args = sys.argv[1:]
    
    query = args[0]
    max_results = int(args[1]) if len(args) > 1 else 10
    
    repos = search_repos(query, max_results)
    
    if repos:
        print(f"\n=== GitHub Repos: \"{query}\" ({len(repos)} results) ===\n")
        for i, r in enumerate(repos, 1):
            stars = f"{r['stars']:,}".rjust(6)
            forks = f"{r['forks']:,}".rjust(5)
            lang = (r['language'] or "N/A").ljust(10)
            print(f"{i}. {r['full_name']}")
            print(f"   [{stars} stars] [{forks} forks] [{lang}]")
            if r['description']:
                print(f"   {r['description'][:100]}")
            print(f"   {r['url']}\n")
    else:
        print("[EMPTY] No repositories found.")


if __name__ == "__main__":
    main()
