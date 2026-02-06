# Spec: Morgen CLI

## Problem

Morgen is a calendar + task management app that aggregates Microsoft To Do and Google Tasks into a unified view. We need a CLI + MCP server to automate task and calendar management from LLM agents (like Claude Code). This follows the same pattern as superhuman-cli.

**Key discovery:** Morgen has a **documented public API** at https://docs.morgen.so/ with full CRUD for tasks, events, calendars, and tags. Authentication is via API key from https://platform.morgen.so. This eliminates the need for CDP reverse-engineering for most operations.

## Architecture (from exploration)

### API Layer (Primary)
- **Base URL:** `https://api.morgen.so/v3/`
- **Auth:** `Authorization: ApiKey <API_KEY>` header
- **Endpoints discovered:**
  - Tasks: `/tasks/list`, `/tasks`, `/tasks/create`, `/tasks/update`, `/tasks/move`, `/tasks/delete`, `/tasks/close`, `/tasks/reopen`
  - Events: `/events/list`, `/events/create`, `/events/update`, `/events/delete`
  - Calendars: `/calendars/list`, `/calendars/update`
  - Tags: `/tags/list`, `/tags`, `/tags/create`, `/tags/update`, `/tags/delete`
  - Integrations: `/integrations/accounts/list`, `/integrations/list`

### CDP Layer (Secondary - for token/config extraction)
- Morgen is Electron app at `/Applications/Morgen.app/Contents/MacOS/Morgen`
- Data dir: `~/Library/Application Support/Morgen/`
- Config: `~/Library/Application Support/Morgen/config.json` contains:
  - `morgen-refresh-token` (JWT)
  - `morgen-user-id`
  - `morgen-email`
- Can launch with `--remote-debugging-port=XXXX` for CDP

### Reference Implementation: superhuman-cli
- TypeScript/Bun, custom arg parser (no yargs/commander)
- Dual-mode entry: CLI (`src/cli.ts`) + MCP server (`src/index.ts --mcp`)
- ConnectionProvider abstraction: CachedTokenProvider (no CDP) vs CDPConnectionProvider
- Token persistence: `~/.config/superhuman-cli/tokens.json`
- Dependencies: `@modelcontextprotocol/sdk`, `chrome-remote-interface`, `zod`
- Custom ANSI color helpers, `--json` flag for structured output

### Reference Implementation: mstodo-raycast
- MS Graph API: `https://graph.microsoft.com/v1.0/me/todo/lists/{listId}/tasks`
- Task data model: title, body, dueDateTime, reminderDateTime, status, importance, recurrence
- MSAL OAuth with scopes: Tasks.ReadWrite, User.Read
- Caching with 5-min TTL

## Requirements

### Core: Task CRUD (Priority 1)
- List all tasks (unified across MS To Do, Google Tasks via Morgen API)
- Create tasks (title, description, due date, estimated duration, priority, tags, taskListId)
- Update tasks (partial updates)
- Delete tasks
- Close/reopen tasks (Morgen's completion model)
- Move tasks (reorder, reparent for subtask hierarchy)

### Tags Management
- List/create/update/delete tags
- Assign tags to tasks

### Calendar Management (Priority 2)
- List events across all connected calendars
- Create/update/delete events
- Support recurring events

### Infrastructure
- TypeScript/Bun runtime (matching superhuman-cli)
- API key auth (from platform.morgen.so, stored in `~/.config/morgen-cli/config.json`)
- Same subcommand structure as superhuman-cli
- MCP server mode (`morgen --mcp`)
- Claude Code skill layer

### Future (Not in Scope Now)
- CDP-based operations (only if API proves insufficient)
- Morgen chat/AI system integration
- Direct MS Graph / Google Tasks API bypass

## Task Data Model (from Morgen API)

```typescript
interface MorgenTask {
  "@type": "Task";
  id: string;
  accountId: string;
  integrationId: string;     // "morgen", "o365", "google", etc.
  taskListId: string;
  title: string;
  description?: string;
  due?: string;               // LocalDateTime: YYYY-MM-DDTHH:mm:ss
  timeZone?: string;          // IANA timezone
  estimatedDuration?: string; // ISO 8601 duration (e.g. "PT30M")
  priority?: number;          // 0 (undefined) to 9 (lowest)
  progress?: "needs-action" | "in-process" | "completed" | "failed" | "cancelled";
  position?: number;
  relatedTo?: object;         // Parent/child task relations
  tags?: string[];
  created?: string;
  updated?: string;
}
```

## Success Criteria

- [ ] `morgen tasks` lists all tasks in unified format
- [ ] `morgen tasks create --title "Test"` creates a task via Morgen API
- [ ] `morgen tasks update <id> --title "Updated"` updates a task
- [ ] `morgen tasks close <id>` marks a task complete
- [ ] `morgen tasks delete <id>` removes a task
- [ ] `morgen calendar` lists upcoming events
- [ ] `morgen calendar create --title "Meeting" --start "2pm" --duration 30` creates event
- [ ] `morgen tags` lists all tags
- [ ] API key auth works (stored in config file)
- [ ] `--json` flag outputs structured JSON
- [ ] MCP server mode works (`morgen --mcp`)
- [ ] Unit tests pass for API client, parsers, formatters
- [ ] Integration tests verify actual API round-trips
- [ ] E2E tests verify CLI command sequences

## Constraints

- Morgen API is in "early access" - new fields may be added without notice
- Task list endpoint: max 100 tasks per request (pagination via `updatedAfter`)
- Rate limits exist (10 points per /tasks/list request)
- API key must be obtained manually from platform.morgen.so

## Testing Strategy (MANDATORY - USER APPROVED)

- **User's chosen approach:** Unit tests + Integration tests + E2E automation
- **Framework:** bun:test
- **Command:** `bun test`
- **Testing skills:** Standard unit tests (bun:test) + dev-test-electron (CDP for E2E)

### REAL Test Definition (MANDATORY)

| Field | Value |
|-------|-------|
| **User workflow to replicate** | `morgen tasks` -> see task list -> `morgen tasks create --title X` -> verify task appears |
| **Code paths exercised** | API key loading -> HTTP client -> Morgen API -> response parsing -> CLI output |
| **What user sees/verifies** | CLI stdout shows tasks in readable format |
| **Protocol/transport** | HTTPS REST to `api.morgen.so/v3/` |

### First Failing Test

- **Test name:** `test_tasks_list_returns_tasks`
- **What it tests:** CLI `tasks` subcommand fetches and displays tasks
- **How it replicates workflow:** Run `morgen tasks` -> parse stdout -> verify task fields
- **Expected failure:** "Expected task list output but got empty/error"

## Open Questions (RESOLVED)

- ~~What are Morgen's API endpoints?~~ **RESOLVED: Documented at docs.morgen.so**
- ~~What auth mechanism?~~ **RESOLVED: API key via `Authorization: ApiKey <KEY>`**
- ~~How does Morgen differentiate task backends?~~ **RESOLVED: `integrationId` field on tasks**
- ~~Task data model?~~ **RESOLVED: See Task Data Model section above**
- ~~REST, GraphQL, or WebSocket?~~ **RESOLVED: REST with JSON**

## Clarified Requirements

### Auth Pattern
- **Decision:** API key via `MORGEN_API_KEY` environment variable
- **Rationale:** User already has API key, simple env var pattern

### Task States
- **Decision:** Simple close/reopen commands only
- **Rationale:** Advanced states (in-process, failed, cancelled) can be set via `update --progress X` if needed
- `morgen tasks close <id>` -> sets progress to "completed"
- `morgen tasks reopen <id>` -> sets progress to "needs-action"

## Remaining Open Questions

- What are the exact rate limit values?
- Does the tasks API support filtering by taskListId, progress, tags?
- How does task list management work (listing task lists, not just tasks)?
