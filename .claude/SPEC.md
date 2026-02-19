# Spec: Fix --timezone flag to convert output times (Issue #7)

> **For Claude:** After writing this spec, use `Read("/Users/vwh7mb/.claude/plugins/cache/edwinhu-plugins/workflows/4.0.0/lib/skills/dev-explore/SKILL.md")` for Phase 2.

## Problem

The `--timezone` flag on `morgen calendar events` only affects how `--start`/`--end` input parameters are interpreted. The output times (both JSON and human-readable) remain in UTC regardless of the `--timezone` flag. Users expect output times to be converted to their requested timezone.

## Requirements

- When `--timezone` is specified, all output times must be converted to that timezone
- JSON times should use ISO 8601 with offset format (e.g., `2026-02-12T05:00:00-05:00`)
- Human-readable output should also display times in the requested timezone
- When `--timezone` is NOT specified, keep current behavior (UTC)
- All time-displaying commands should respect `--timezone`: calendar events, calendar free, task schedule times, etc.
- No new dependencies — use Intl.DateTimeFormat or equivalent built-in APIs

## Success Criteria

- [ ] `morgen calendar events --timezone America/New_York --json` returns times with `-05:00` offset (EST) or `-04:00` (EDT)
- [ ] `morgen calendar events --timezone America/New_York` (human output) shows local times
- [ ] `morgen calendar free --timezone America/New_York` shows free/busy in local time
- [ ] Without `--timezone`, output remains UTC (backward compatible)
- [ ] Unit tests pass for timezone conversion logic

## Constraints

- Zero runtime dependencies (use built-in Intl APIs)
- Must handle DST transitions correctly
- Must not break existing `--start`/`--end` timezone interpretation

## Exploration Findings

### Time Data Model

Events have **floating local time** in `start` (e.g., `"2026-02-10T09:00:00"`) with a separate `timeZone` field (e.g., `"America/New_York"`). The start time is already in the event's timezone — it's NOT UTC despite sometimes having a Z suffix in test data.

Tasks have **floating local time** in `due` (e.g., `"2026-02-15T09:00:00"`) with optional `timeZone` field.

Free slots are computed internally in UTC ms, then output via `toFloatingLocal()` which strips the Z suffix — producing floating UTC times.

### Current Output Formatting (no shared utility)

| Command | JSON | Human-readable | File:Line |
|---------|------|----------------|-----------|
| `calendar events` | Raw `JSON.stringify(events)` | `event.start.split("T")[1]?.slice(0,5)` → "09:00" | cli.ts:671, cli.ts:617 |
| `calendar free` | Raw `JSON.stringify(slots)` | `slot.start.split("T")[1]?.slice(0,5)` → "09:00" | cli.ts:805, cli.ts:813 |
| `tasks list/get` | Raw `JSON.stringify(task)` | `task.due.split("T")[0]` → "2026-02-15" | cli.ts:394-397, cli.ts:213 |

### Timezone flag usage

- **Parsed at:** cli.ts:184 (`case "timezone": case "tz": opts.timeZone = value`)
- **Used for input only:** task create/update (cli.ts:435,471), event create (cli.ts:709), task schedule (cli.ts:563)
- **NOT used for output:** events listing, free slots, task display

### Conversion Strategy

For **events**: interpret `event.start` as being in `event.timeZone`, convert to target `--timezone`, format with offset.

For **free slots**: `toFloatingLocal()` currently produces UTC floating times. Need to convert UTC ms to target timezone instead.

For **tasks**: `task.due` is floating local in `task.timeZone`. Convert similarly to events.

### Code Paths

| Path | Protocol | Entry | Data Flow |
|------|----------|-------|-----------|
| Events display | CLI args -> listEvents -> formatEvent/JSON | cli.ts:652 | API response -> raw string output |
| Free slots | CLI args -> findFreeSlots -> format/JSON | cli.ts:787 | UTC ms -> toFloatingLocal -> string output |
| Task display | CLI args -> listTasks -> formatTask/JSON | cli.ts:387 | API response -> raw string output |

### Test Infrastructure

- **Framework:** bun:test, 74 passing, 1 skipped
- **Test command:** `bun test`
- **Mocking patterns:** `globalThis.fetch` spy + `mock.module()` for CDP
- **Existing pure function tests:** `decodeIntegrationId`, `parseDurationToMs`, free slot logic
- **Test dir:** `src/__tests__/`

## Testing Strategy (MANDATORY - USER APPROVED)

- **User's chosen approach:** Unit tests
- **Framework:** bun:test
- **Command:** `bun test`
- **Testing skill to use:** Standard unit tests (bun:test)

### REAL Test Definition (MANDATORY)

| Field | Value |
|-------|-------|
| **User workflow to replicate** | `morgen calendar events --timezone America/New_York --json` -> verify times have correct offset |
| **Code paths that must be exercised** | Floating local time + source tz -> Date -> target tz -> ISO 8601 with offset |
| **What user actually sees/verifies** | Times in JSON/human output with correct timezone offset |
| **Protocol/transport** | Direct function calls to pure conversion utilities |

### First Failing Test

- **Test name:** `converts floating local time to ISO with offset in target timezone`
- **What it tests:** Given "2026-02-12T10:00:00" in UTC, convert to America/New_York -> "2026-02-12T05:00:00-05:00"
- **Expected failure message:** Function does not exist yet

## Clarified Requirements

### JSON Output Shape
- **Decision:** Modify `start` field in-place with offset (e.g., `"start": "2026-02-12T05:00:00-05:00"`)
- **Rationale:** Simpler for consumers, original UTC derivable from offset

### Task Due Dates
- **Decision:** Yes, convert task due dates when `--timezone` is specified
- **Rationale:** Consistent behavior across all time-displaying commands, even if timezone conversion shifts the date

## Open Questions

- None — all clarified
