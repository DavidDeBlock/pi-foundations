# Session Logs Reference

## Location

All project sessions are stored at:

```
/home/david/.pi/agent/sessions/--home-david-projects-pi-pos-v0--/
```

## Today's Sessions (2026-05-07)

| File | Timestamp | Size | Purpose |
|------|-----------|------|---------|
| `2026-05-07T11-14-38-181Z_...jsonl` | 11:14 | ~125KB | Reviewer — validating Issue #14 (remove cash/change columns) |
| `2026-05-07T11-13-33-098Z_...jsonl` | 11:13 | ~4.5KB | Short session |
| `2026-05-07T11-09-38-032Z_...jsonl` | 11:09 | ~142KB | — |
| `2026-05-07T10-44-20-400Z_...jsonl` | 10:44 | ~228KB | — |
| `2026-05-07T10-54-52-492Z_...jsonl` | 10:54 | ~86KB | — |
| `2026-05-07T08-59-38-417Z_019e01a9-fe30-706a-815e-7ed75be34f0d.jsonl` | 08:59 | ~360KB | **grill-with-docs session** — universal split payments plan (12 questions resolved) |

## JSONL Structure

Each file is **JSON Lines** — one JSON object per line, no commas between lines.

### Event Types

| Type | Purpose |
|------|---------|
| `session` | Header: id, timestamp, cwd |
| `model_change` | Which LLM model/provider was used |
| `thinking_level_change` | Thinking depth (none/low/medium/high) |
| `message` | Conversation events (user/assistant/tool calls/results) |

### Message Structure

```json
{
  "type": "message",
  "id": "...",
  "parentId": "...",          // links to parent event (tree structure)
  "timestamp": 1778144692231,
  "message": {
    "role": "user|assistant",
    "content": [              // array of parts
      {"type": "text", "text": "..."},
      {"type": "thinking", "thinking": "...", "thinkingSignature": "..."},
      {"type": "toolCall", "id": "...", "name": "bash|read|edit|write", "arguments": {...}}
    ]
  }
}
```

### Tool Call / Result Chain

1. **Tool call** (assistant message with `toolCall` content part)
2. **Tool result** (separate message with `role: "toolResult"`, linked by `toolCallId`)

Example chain:
```
message (assistant, role=assistant, content=[{type:"toolCall", name:"read"}])
  → parentId links to thinking event
message (toolResult, toolCallId="abc123", isError=false)
  → parentId links to the toolCall message
```

### Key Fields

| Field | Meaning |
|-------|---------|
| `id` | Unique event ID (UUID) |
| `parentId` | Links events into a tree (assistant → thinking → toolCall → toolResult chain) |
| `timestamp` | Millisecond epoch |
| `provider` / `modelId` | LLM backend used (e.g. `llama-cpp-main`, `qwen-27b-64k-q8`) |

### Reading Sessions

```bash
# Read first 50 lines
head -n 50 /home/david/.pi/agent/sessions/--home-david-projects-pi-pos-v0--/<filename>

# Count events
wc -l /home/david/.pi/agent/sessions/--home-david-projects-pi-pos-v0--/<filename>

# Search for specific content (e.g., user messages)
grep '"role":"user"' <file>.jsonl | head -5
```

### Session Tree

Events form a tree via `parentId`. The root is the `session` event. A typical conversation turn looks like:

```
session (root)
  └── model_change
        └── thinking_level_change
              └── message (user)
                    └── message (assistant, has toolCall)
                          ├── message (toolResult — bash)
                          └── message (toolResult — read)
```
