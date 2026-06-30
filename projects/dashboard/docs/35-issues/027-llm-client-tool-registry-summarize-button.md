# 027 — LlmClient + ToolRegistry + "Summarize this thread" button

**Labels**: `email`, `v4`, `llm`, `needs-triage`
**Type**: AFK (after env vars are configured)
**Parent**: [PRD-002](../35-prds/PRD-002-email-mirror.md)

## What to build

The user can ask an LLM to summarize an email thread, with citations. The detail view's "Summarize this thread" button (placeholder from 023) now wires through to `POST /api/email/:id/summarize`, which calls the configured LLM (via an OpenAI-compatible client) with a typed tool surface. The LLM gets exactly four read-only tools — `query_emails`, `semantic_search_emails`, `get_email`, `get_thread` — and no mutating tools whatsoever. The same `LlmClient` works against OpenAI, Anthropic, llama.cpp, LM Studio, or any OpenAI-API-shaped endpoint — the swap is two env vars.

## Acceptance criteria

- [ ] `LlmClient` POSTs to `{LLM_BASE_URL}/chat/completions` with OpenAI JSON shape (messages + tools + tool_choice)
- [ ] `LLM_BASE_URL` can point at `https://api.openai.com/v1` (cloud) OR `http://localhost:8080/v1` (local llama.cpp server) — verified by integration test using a mock server that responds to both
- [ ] `LLM_API_KEY` is sent as `Authorization: Bearer` header; for local servers, value `not-needed` is accepted
- [ ] `ToolRegistry` exposes exactly four tools with JSON Schema definitions: `query_emails`, `semantic_search_emails`, `get_email`, `get_thread`
- [ ] `ToolRegistry` has NO tools for `send_email`, `delete_email`, `archive_email`, `label_email`, `apply_tag`, `set_hidden`, or any mutation — verified by a test that enumerates the registry and asserts the four-tool invariant
- [ ] `PromptBuilder.summarizeThreadPrompt(thread)` builds a system prompt that asks for: 3-bullet summary, key dates, action items, and citations (sender + date + id per cited email)
- [ ] `SummarizeEmailHandler` runs the tool-calling loop: fetch thread → build prompt → call LLM → execute any tool_calls → return final structured response
- [ ] `POST /api/email/:id/summarize` returns `{summary: string, citations: [{sender, date, id, subject}]}`
- [ ] Detail view "Summarize this thread" button calls the endpoint and renders the summary inline (bullets) + a "Sources" list with clickable links to each cited email
- [ ] LLM queries filter `WHERE hidden_at IS NULL` — verified by integration test (hide an email in the thread, ask LLM to summarize, assert the hidden email is not cited)
- [ ] Env vars documented: `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` (with example values for OpenAI and for llama.cpp)
- [ ] Tests: `LlmClient` against mocked HTTP (simple chat, tool-call round-trip, error responses), `ToolRegistry` schema validity + four-tool invariant, `SummarizeEmailHandler` end-to-end with mocked LLM, hidden emails excluded from LLM context, prompt structure stable

## Blocked by

- [024](./024-email-soft-delete-hide-unhide-hidden-view.md)
- [025](./025-email-dashboard-tags-crud-autocomplete-filter.md)
- [026](./026-email-background-poll-sync-observability.md)