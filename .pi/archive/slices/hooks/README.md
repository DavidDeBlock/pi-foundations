# Hooks Directory

Place executable scripts here to run at specific points in the slice lifecycle.

## Available Hooks

| Hook | When It Runs | Arguments |
|------|-------------|-----------|
| `pre-builder.sh` | Before each builder phase | `$1`=issue_number, `$2`=attempt |
| `post-builder.sh` | After each builder phase (success or failure) | `$1`=issue_number, `$2`=status |
| `pre-reviewer.sh` | Before each reviewer phase | `$1`=issue_number |
| `post-reviewer.sh` | After each reviewer phase (success or failure) | `$1`=issue_number, `$2`=verdict |
| `on-success.sh` | When a slice passes all checks | `$1`=issue_number |
| `on-failure.sh` | When a slice fails all retries | `$1`=issue_number, `$2`=attempts_made |

## Example: Slack Notification on Failure

```bash
#!/usr/bin/env bash
# hooks/on-failure.sh
ISSUE=$1
ATTEMPTS=$2
curl -X POST -H 'Content-type: application/json' \
  --data "{\"text\":\"Slice #${ISSUE} failed after ${ATTEMPTS} attempts\"}" \
  "$SLACK_WEBHOOK_URL"
```

## Notes

- Hooks are optional — missing hooks are silently skipped
- Hooks must be executable (`chmod +x`)
- Non-zero exit from a hook does NOT abort the orchestrator (use `set -e` inside the hook if you want strict behavior)
