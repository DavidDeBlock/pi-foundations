#!/usr/bin/env bash
# Wrapper for browser.mjs to match skill command format
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/browser.mjs" "$@"
