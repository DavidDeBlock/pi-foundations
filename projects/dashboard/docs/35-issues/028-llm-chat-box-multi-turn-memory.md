# 028 — LLM chat box + multi-turn conversation memory

**Labels**: `email`, `v4`, `llm`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-002](../35-prds/PRD-002-email-mirror.md)

## What to build

The user can have a multi-turn conversation with the LLM over their email corpus. A chat box on `/email` (or a new `/email/chat` route) accepts a free-text question, sends it to the LLM with the four read-only email tools from 027, persists the conversation across requests, and renders the answer with citations. The user can ask follow-up questions in the same conversation; the LLM has memory of prior turns.

## Acceptance criteria

- [ ] Migration adds `email_conversations` table (`id`, `account_id`, `messages` JSON, `created_at`, `updated_at`)
- [ ] `POST /api/email/chat` with body `{conversation_id?, message}` returns `{conversation_id, message, tool_calls_made}`
- [ ] First call (no `conversation_id`) creates a new conversation; subsequent calls with the same `conversation_id` continue it
- [ ] Conversation messages are persisted to `email_conversations.messages` as a JSON array of `{role, content, tool_calls, tool_results}`
- [ ] `EmailChatHandler` runs the full tool-calling loop: while the LLM returns `tool_calls`, execute them, append results, call the LLM again, until the LLM returns a final message
- [ ] Chat UI on `/email` (or `/email/chat`): input box at bottom, message history above, citations rendered inline as clickable links to source emails
- [ ] Conversation history persists across page reloads
- [ ] LLM still only has the four read-only tools (same `ToolRegistry` from 027)
- [ ] LLM queries filter `WHERE hidden_at IS NULL` (hidden emails not surfaced even in chat)
- [ ] Max conversation length is bounded (e.g. last 50 messages) to keep context windows sane
- [ ] `GET /api/email/conversations` lists past conversations for the UI; `GET /api/email/conversations/:id` returns the full message history
- [ ] Tests: multi-turn tool calling (mocked LLM), conversation persistence across requests, conversation history endpoint, hidden-email exclusion, max-length truncation, no-mutation-tools invariant holds

## Blocked by

- [027](./027-llm-client-tool-registry-summarize-button.md)