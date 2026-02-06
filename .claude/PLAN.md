# Implementation Plan: Morgen CLI - Tasks MVP

> **For Claude:** REQUIRED SUB-SKILL: Invoke `Read("/Users/vwh7mb/.claude/plugins/cache/edwinhu-plugins/workflows/2.36.1/lib/skills/dev-implement/SKILL.md")` to implement this plan.

## Chosen Approach

**Clone superhuman-cli structure** applied to Morgen's public REST API.

Mirrors superhuman-cli's proven architecture:
- `src/index.ts` - Dual-mode entry (CLI vs MCP server)
- `src/cli.ts` - Command router with custom arg parser
- `src/morgen-api.ts` - HTTP client for api.morgen.so/v3/
- `src/tasks.ts` - Task operations module
- `src/mcp/` - MCP server (Phase 2, not in this MVP)

## Rationale

- Proven patterns from superhuman-cli eliminate design risk
- Public REST API eliminates CDP complexity (biggest simplification)
- API key auth is trivial compared to OAuth token management
- Bun + TypeScript stack is already working in superhuman-cli

## Testing Strategy (MANDATORY - GATE)

| Field | Value | Status |
|-------|-------|--------|
| **Framework** | bun:test | [x] Filled |
| **Test Command** | `bun test` | [x] Filled |
| **First Failing Test** | `test_tasks_list` - invokes CLI, expects task output | [x] Filled |
| **Test File Location** | `src/__tests__/tasks.test.ts` | [x] Filled |
| **Testing Skill** | Standard unit tests (bun:test) | [x] Filled |

## REAL Test Criteria (MANDATORY - PREVENTS FAKE TESTS)

| Criteria | Value | Verified |
|----------|-------|----------|
| **User workflow to replicate** | `morgen tasks` -> see task list -> `morgen tasks create --title X` -> verify in list | [x] |
| **Protocol/transport** | HTTPS REST to `api.morgen.so/v3/` with `ApiKey` header | [x] |
| **UI elements to interact with** | CLI stdout/stderr (terminal) | [x] |
| **What user sees/verifies** | Task titles, due dates, progress in formatted output | [x] |
| **Code path exercised** | env var -> API client -> fetch() -> JSON parse -> format -> stdout | [x] |

### Fake Test Prevention Checklist

```
[x] Test uses SAME protocol as production (HTTPS REST)
[x] Test follows user's EXACT workflow (CLI invocation)
[x] Test interacts with ACTUAL UI elements (stdout parsing)
[x] Test verifies what USER sees (formatted output)
[x] Test uses the SPECIFIED testing skill (bun:test)
```

## New Files

| File | Purpose |
|------|---------|
| `package.json` | Bun project config, dependencies |
| `tsconfig.json` | TypeScript config (from superhuman-cli) |
| `src/index.ts` | Entry point (CLI only for MVP, MCP later) |
| `src/cli.ts` | Command router + arg parser + help + output formatting |
| `src/morgen-api.ts` | HTTP client: base fetch wrapper, auth header, error handling |
| `src/tasks.ts` | Task operations: list, get, create, update, close, reopen, delete, move |
| `src/types.ts` | TypeScript interfaces for MorgenTask, MorgenTag, API responses |
| `src/__tests__/tasks.test.ts` | Unit tests for task operations |
| `src/__tests__/cli.test.ts` | CLI integration tests (invoke binary, check stdout) |

## Implementation Order

| Task | Failing Test (write FIRST) | Verify Command |
|------|----------------------------|----------------|
| 0. Project scaffold | N/A (meta-task) | `bun --version && ls src/` |
| 1. Types + API client | `test_api_client_makes_request` | `bun test src/__tests__/morgen-api.test.ts` |
| 2. Tasks module | `test_tasks_list_returns_tasks` | `bun test src/__tests__/tasks.test.ts` |
| 3. CLI router + tasks commands | `test_cli_tasks_list` | `bun test src/__tests__/cli.test.ts` |
| 4. Output formatting (human + JSON) | `test_format_tasks_human_readable` | `bun test` |
| 5. Integration test with real API | Manual + recorded fixture test | `MORGEN_API_KEY=xxx bun run src/cli.ts tasks` |

### Task 0: Project Scaffold
- `bun init` in morgen-cli/
- Copy tsconfig.json from superhuman-cli
- Add dependencies: `zod` (validation)
- Create src/ directory structure
- Set up `bin` in package.json pointing to src/cli.ts

### Task 1: Types + API Client
- Define MorgenTask, MorgenTaskList, ApiResponse types in `src/types.ts`
- Build `morgenFetch()` wrapper in `src/morgen-api.ts`:
  - Reads `MORGEN_API_KEY` from env
  - Sets `Authorization: ApiKey <key>` header
  - Base URL: `https://api.morgen.so/v3`
  - JSON parsing, error handling (401, 429, 5xx)

### Task 2: Tasks Module
- `listTasks(options?)` -> GET `/tasks/list`
- `getTask(id)` -> GET `/tasks?id=<id>`
- `createTask(input)` -> POST `/tasks/create`
- `updateTask(id, updates)` -> POST `/tasks/update`
- `closeTask(id)` -> POST `/tasks/close`
- `reopenTask(id)` -> POST `/tasks/reopen`
- `deleteTask(id)` -> POST `/tasks/delete`
- `moveTask(id, previousId?, parentId?)` -> POST `/tasks/move`

### Task 3: CLI Router + Task Commands
- Custom arg parser (from superhuman-cli pattern)
- Command structure:
  ```
  morgen tasks                          # list all tasks
  morgen tasks --json                   # list as JSON
  morgen tasks get <id>                 # get single task
  morgen tasks create --title "X"       # create task
  morgen tasks update <id> --title "Y"  # update task
  morgen tasks close <id>              # complete task
  morgen tasks reopen <id>             # reopen task
  morgen tasks delete <id>             # delete task
  morgen help                          # help text
  ```
- ANSI colors for human output (from superhuman-cli)
- `--json` flag for LLM-friendly output

### Task 4: Output Formatting
- Human-readable task list (title, due, progress, tags, integration source)
- JSON output mode
- Success/error messages with ANSI colors

### Task 5: Integration Test
- Test with real MORGEN_API_KEY against live API
- Verify round-trip: create -> list -> close -> delete
