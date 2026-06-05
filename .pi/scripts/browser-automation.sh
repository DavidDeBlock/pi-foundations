#!/usr/bin/env bash
# browser-automation.sh — Headless browser CLI wrapper.
# Dispatches subcommands to browser.mjs (Node ESM, uses @playwright/test).
#
# Usage:
#   .pi/scripts/browser-automation.sh open "https://example.com"
#   .pi/scripts/browser-automation.sh screenshot "https://example.com" /tmp/page.png --full-page
#   .pi/scripts/browser-automation.sh extract "https://example.com" "h1"
#   .pi/scripts/browser-automation.sh search "playwright documentation"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ $# -lt 1 ]; then
  echo "Usage: $(basename "$0") <open|navigate|screenshot|extract|search> [args...]" >&2
  echo "" >&2
  echo "Commands:" >&2
  echo "  open <url>                  Navigate headless; print title, url, console errors" >&2
  echo "  navigate <url>              Alias for open" >&2
  echo "  screenshot <url> <file>     Capture viewport to <file> (--full-page, --wait-selector=X)" >&2
  echo "  extract <url> [selector]    Print cleaned text of <selector> (default: body)" >&2
  echo "  search <query...>           Google search via Serper API" >&2
  echo "" >&2
  echo "Examples:" >&2
  echo "  $(basename "$0") open https://example.com" >&2
  echo "  $(basename "$0") screenshot https://example.com /tmp/page.png --full-page" >&2
  echo "  $(basename "$0") extract https://example.com 'h1, p'" >&2
  echo "  $(basename "$0") search 'playwright best practices 2026'" >&2
  exit 1
fi

cd "$PROJECT_ROOT"
exec node --env-file=.env "$SCRIPT_DIR/browser.mjs" "$@"
