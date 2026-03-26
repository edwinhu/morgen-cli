# Learnings: Morgen CLI - Tasks MVP

## Test Output Evidence

### Test Run (2026-02-06) - After Review Fixes

```
bun test v1.3.5 (1e86cebd)

 14 pass
 0 fail
 40 expect() calls
Ran 14 tests across 3 files. [243.00ms]
```

### Test Files

| File | Tests | Status |
|------|-------|--------|
| `src/__tests__/morgen-api.test.ts` | 3 tests | PASS |
| `src/__tests__/tasks.test.ts` | 5 tests | PASS |
| `src/__tests__/cli.test.ts` | 6 tests | PASS |

### Test Details

**morgen-api.test.ts (3 tests):**
- `throws when MORGEN_API_KEY not set` - Verifies missing key error message
- `includes API key in Authorization header` - Verifies `ApiKey <key>` header format
- `MorgenApiError has correct properties` - Verifies error class fields

**tasks.test.ts (5 tests):**
- `exports all expected functions` - Verifies 8 functions exported
- `listTasks calls correct URL path and passes params` - Mocks fetch, verifies /v3/tasks/list URL and limit param
- `createTask POSTs to /tasks/create and returns task ID` - Mocks fetch, verifies POST method, body, return value
- `closeTask sends correct body with id` - Mocks fetch, verifies POST to /tasks/close with id
- `propagates API errors as MorgenApiError` - Mocks 404 response, verifies MorgenApiError with status

**cli.test.ts (6 subprocess tests via Bun.spawn):**
- `--help shows help text` - Invokes CLI binary, checks stdout for "Morgen CLI"
- `--version shows version` - Invokes CLI binary, checks semver output
- `no args shows help` - CLI with no args prints help
- `unknown command shows error` - CLI with bad command exits non-zero
- `tasks without API key shows error` - Missing API key gives instructions
- `tasks create without --title shows error` - Validates required args

### Integration Test (Task 5)

Task 5 (integration with live API) requires MORGEN_API_KEY env var to be set.
This test is manual per the PLAN.md and will be verified when the user provides the API key.

## Review Fixes Applied (2026-02-06)

1. Wired `moveTask` into CLI (`tasks move <id> --after <id> --parent <id>`)
2. Fixed no-op API key header test with real assertion
3. Added 4 behavioral unit tests for tasks module with fetch mocking
4. Removed unused `zod` dependency
5. Fixed `UpdateTaskInput.progress` type to use union instead of `string`
6. Read version from package.json instead of hardcoded constant
7. Added `--priority` validation (0-9) in create and update handlers
8. Fixed CLI test path to use absolute path via `import.meta.path`

## Implementation Notes

- Cloned superhuman-cli architecture (custom arg parser, ANSI colors, --json flag)
- Morgen public API at api.morgen.so/v3 with ApiKey auth header
- All 8 task CRUD operations implemented: list, get, create, update, close, reopen, delete, move
- CLI subprocess tests verify the actual binary invocation (real user workflow)
---
Last updated: 2026-02-06 14:03
---

[Compaction at 14:35] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-06 17:54
---

[Compaction at 17:58] (workflow: /dev) - Context was summarized

[Compaction at 18:45] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-08 00:16
---

[Compaction at 00:18] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-08 09:10
---

[Compaction at 09:11] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-08 12:41
---

[Compaction at 12:48] (workflow: /dev) - Context was summarized

[Compaction at 13:07] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-08 14:11
---

[Compaction at 14:22] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-11 20:37
---

[Compaction at 21:19] (workflow: /dev) - Context was summarized
---
Last updated: 2026-03-26 10:34
---
