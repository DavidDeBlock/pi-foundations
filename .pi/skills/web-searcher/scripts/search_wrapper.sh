#!/bin/bash
# Web Searcher Wrapper - Enables /skill:web-searcher command
# Usage:
#   /skill:web-searcher "search query"
#   /skill:web-searcher github "playwright" 5

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT=$(dirname "$SCRIPT_DIR"/../../..)
SEARCH_SCRIPT="$SCRIPT_DIR/search.py"
GITHUB_SCRIPT="$SCRIPT_DIR/search-github.py"
GITHUB_CONTENT_SCRIPT="$SCRIPT_DIR/github-content.py"

# Verify required scripts exist
if [ ! -f "$SEARCH_SCRIPT" ]; then
    echo "Error: search.py not found at $SEARCH_SCRIPT" >&2
    exit 1
fi

if [ ! -f "$GITHUB_CONTENT_SCRIPT" ]; then
    echo "Error: github-content.py not found at $GITHUB_CONTENT_SCRIPT" >&2
    exit 1
fi

if [ $# -lt 1 ]; then
    echo "Usage: /skill:web-searcher <command> [args]"
    echo ""
    echo "Commands:"
    echo "  search query        - Google search via Serper API"
    echo "  github query [n]    - Search GitHub repos (default: 10 results)"
    echo "  tree <repo> [path]  - List directory structure from GitHub"
    echo "  read <repo> <file>  - Read file contents from GitHub"
    echo "  readme <repo>       - Get README with metadata"
    echo ""
    echo "Examples:"
    echo "  /skill:web-searcher \"Herbalife products\""
    echo "  /skill:web-searcher github \"playwright\" 5"
    echo "  /skill:web-searcher tree badlogic/pi-mono packages/coding-agent"
    echo "  /skill:web-searcher read badlogic/pi-mono README.md"
    exit 1
fi

# Route to appropriate script based on command
case "$1" in
    github)
        # GitHub search mode
        if [ -z "$2" ]; then
            echo "Error: github requires a query argument" >&2
            exit 1
        fi
        # Extract count (default to 5) and query
        COUNT="${3:-5}"
        QUERY="$2"
        python3 "$GITHUB_SCRIPT" "$QUERY" "$COUNT"
        ;;
    tree|read|readme)
        # GitHub content access mode
        if [ -z "$2" ]; then
            echo "Error: $1 command requires a repo reference argument" >&2
            exit 1
        fi
        python3 "$GITHUB_CONTENT_SCRIPT" "$@"
        ;;
    search|*)
        # Default: basic Serper search (pass all arguments)
        python3 "$SEARCH_SCRIPT" "$@"
        ;;
esac
