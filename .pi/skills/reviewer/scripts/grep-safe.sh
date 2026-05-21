#!/usr/bin/env bash
# grep-safe — Wrapper around grep that always exits 0 and annotates results.
#
# Problem: `grep` returns exit code 1 when no matches found, which the session
# parser flags as an error even though "no matches" is often the desired result
# during reviews (e.g. checking for remaining inline math).
#
# Usage: grep-safe [grep-options] <pattern> <path...>
# Example: grep-safe -rn '/ 100' server/src/api/
#
# Output:
#   - Matches found: prints them normally, exits 0
#   - No matches:    prints "✓ no matches found", exits 0

# Do NOT use set -e — we need to capture grep's exit code

grep "$@"
exit_code=$?

if [ $exit_code -eq 0 ]; then
    # Matches found — grep already printed them
    exit 0
elif [ $exit_code -eq 1 ]; then
    # No matches — this is often success for absence checks
    echo "✓ no matches found"
    exit 0
else
    # Real error (bad path, permission denied, etc.)
    echo "✗ grep exited with code $exit_code" >&2
    exit $exit_code
fi
