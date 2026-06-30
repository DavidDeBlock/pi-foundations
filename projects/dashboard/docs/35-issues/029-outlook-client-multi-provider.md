# 029 — Outlook (Microsoft Graph) client + multi-provider UI

**Labels**: `email`, `v4`, `outlook`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-002](../35-prds/PRD-002-email-mirror.md)

## What to build

Add Microsoft Outlook as a second email provider behind the same `EmailClient` interface. Users connect Outlook via Microsoft OAuth (`Mail.Read` scope only — read-only equivalent of `gmail.readonly`). Both providers sync through the same `EmailSyncWorker` logic. The inbox view gets a provider filter (Gmail | Outlook | All). LLM tools work across providers — `query_emails({from: 'sarah@...'})` returns Sarah's mail whether it lives in Gmail or Outlook.

## Acceptance criteria

- [ ] `OutlookClient` implements the same interface as `GmailClient`: `listMessages({since, pageToken})`, `getMessage(id)`, `getThread(id)` over Microsoft Graph API
- [ ] Microsoft OAuth flow: `/api/email/oauth/start` (Outlook variant) + `/api/email/oauth/callback` — uses Azure AD app registration, scope `https://graph.microsoft.com/Mail.Read` only
- [ ] `email_accounts.provider` column accepts `'gmail'` or `'outlook'` (migration if not already polymorphic)
- [ ] Both providers sync through the same `EmailSyncWorker` — the worker dispatches to the right `EmailClient` based on `provider`
- [ ] Inbox view provider filter: `?provider=gmail`, `?provider=outlook`, `?provider=all` (default)
- [ ] LLM tools work cross-provider: `query_emails({from})` returns matches across both Gmail and Outlook; `semantic_search_emails` searches both; `get_email` works on either provider's IDs
- [ ] `/settings/email` shows both providers separately with their own Connect/Disconnect buttons
- [ ] Tokens are encrypted with the same `EMAIL_TOKEN_ENCRYPTION_KEY`
- [ ] Documentation: one-time Azure AD app registration steps + env vars (`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`)
- [ ] Tests: `OutlookClient` against mocked Graph HTTP responses, multi-account sync (one Gmail + one Outlook), provider filter, cross-provider LLM tool call

## Blocked by

- [027](./027-llm-client-tool-registry-summarize-button.md)