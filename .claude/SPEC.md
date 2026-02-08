# Spec: Morgen AI Chat Integration

## Problem
Morgen has an AI chat feature in its desktop app that understands natural language requests about calendar and task management. The API is undocumented but has been reverse-engineered via CDP network interception.

## Discovery Results (2026-02-08)

### Endpoint
`POST https://ai.cf.morgen.so/openrouter/chat/completions`

### Authentication
- `Authorization: Bearer <JWT_SESSION_TOKEN>` — NOT the MORGEN_API_KEY
- JWT from Morgen session token (already implemented in `src/morgen-cdp.ts`)
- Session token obtained via refresh token exchange at `POST /identity/refresh`
- TTL ~1 hour, auto-refreshable via stored refresh token

### Request Format
OpenAI-compatible chat completions (proxied through Cloudflare AI Gateway → OpenRouter):
```json
{
  "model": "anthropic/claude-haiku-4.5",
  "response_format": { "type": "text" },
  "messages": [
    { "role": "system", "content": "<scheduling agent system prompt>" },
    { "role": "user", "content": "what's on my calendar today?" }
  ],
  "tools": [...],
  "parallel_tool_calls": true,
  "stream": true
}
```

### Response Format
- SSE streaming (`text/event-stream`)
- Standard OpenAI chunk format via OpenRouter
- Tool calls returned as `finish_reason: "tool_calls"` with function name + args
- Usage stats in final chunk

### Architecture
- Multi-agent system ("Agents SDK") with Agents and Handoffs
- Primary: "Scheduling Agent" — executive assistant persona
- Tools: `calendarRead`, `calendarComputeOptimalSchedule`, `taskEditContext`
- Agent handoffs via `transfer_to_<agent_name>` function calls
- Client-side tool execution: Morgen app runs tools, sends results back in follow-up request

### Two-Request Pattern
1. First POST: user message → AI may respond with tool calls (e.g., `calendarRead`)
2. Second POST: tool results included → AI responds with final text answer

## Requirements
1. Build `src/chat.ts` — chat API client with SSE streaming support
2. Add `morgen chat "prompt"` CLI command with streaming terminal output
3. Add `morgen chat --json "prompt"` for structured JSON output
4. Handle tool calls gracefully (either execute locally or show tool call info)
5. Require session token auth (CDP or cached session)

## Success Criteria
- [x] AI chat API endpoint discovered and documented
- [ ] `morgen chat "what's on my calendar today?"` works from terminal
- [ ] `morgen chat --json "..."` returns structured JSON output
- [ ] Streaming output displays tokens as they arrive
- [ ] Unit tests pass with mocked SSE responses
- [ ] Integration test passes against live API

## Constraints
- Requires session token (not API key) — user must run `morgen auth` first
- SSE streaming needs incremental parsing
- Tool calls from AI are informational only (we don't execute `calendarRead` etc. server-side)
- System prompt is injected server-side by Morgen, we only send user messages
- CORS restricted to `morgen://.` origin — may need to omit or spoof origin header

## Testing Strategy (MANDATORY - USER APPROVED)

- **User's chosen approach:** Both unit + integration tests
- **Framework:** bun:test
- **Command:** `bun test`

### REAL Test Definition (MANDATORY)

| Field | Value |
|-------|-------|
| **User workflow to replicate** | `morgen chat "prompt"` → see AI response in terminal |
| **Code paths exercised** | Session token → fetch SSE → parse chunks → display text |
| **What user sees/verifies** | AI response text streamed to terminal |
| **Protocol/transport** | HTTPS POST with SSE response to `ai.cf.morgen.so` |

### First Failing Test

- **Test name:** `test_chat_sends_prompt_and_streams_response`
- **What it tests:** Chat client sends prompt via SSE, collects streamed response
- **How it replicates user workflow:** Calls `sendChat("prompt")`, verifies response text returned
- **Expected failure message:** "sendChat is not a function" (module doesn't exist yet)

## Key Files

| File | Purpose |
|------|---------|
| `src/morgen-cdp.ts:76-100` | Session token exchange (already works) |
| `src/morgen-api.ts:29-45` | Auth header logic (session token preferred) |
| `src/cli.ts:462-497` | Main entry + command router |
| `src/types.ts` | Type definitions |
| `src/__tests__/tasks.test.ts:69-77` | Mock fetch pattern to follow |

## Clarified Requirements

### Tool Call Handling
- **Decision:** Simple passthrough — show AI text only
- **Behavior:** If AI calls a tool (calendarRead, etc.), show informational message like "AI is reading your calendar..." but don't execute it
- **Rationale:** Keeps implementation simple; full tool execution can be added later

### CORS Origin
- **Decision:** Try without origin header first, fall back to spoofed `Origin: morgen://.` if rejected
- **Rationale:** CLI (non-browser) requests may not need CORS; test both approaches

### Auth Requirement
- **Decision:** Session token required (not API key)
- **Behavior:** If no session token available, error with "Run 'morgen auth' first"
- **Reference:** `src/morgen-cdp.ts` already handles session token extraction + caching

## Open Questions (RESOLVED)
- ~~What endpoint?~~ **`POST https://ai.cf.morgen.so/openrouter/chat/completions`**
- ~~What auth?~~ **Bearer JWT session token (NOT API key)**
- ~~Streamed?~~ **Yes, SSE (`text/event-stream`)**
- ~~What context?~~ **Server injects system prompt with scheduling preferences + tools**
- ~~Can we pass context?~~ **No, system prompt is server-side; we send user messages only**
