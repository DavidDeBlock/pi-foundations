#!/usr/bin/env bash
# pre-builder.sh — Runs before each builder phase.
# Args: $1 = issue_number, $2 = attempt
# Remove this file or leave empty to skip.

ISSUE=$1
ATTEMPT=$2
echo "[HOOK] pre-builder — Issue #${ISSUE}, Attempt ${ATTEMPT}" >&2
