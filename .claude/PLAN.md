# Implementation Plan: --timezone output conversion (Issue #7)

> **For Claude:** REQUIRED SUB-SKILL: Invoke `Read("/Users/vwh7mb/.claude/plugins/cache/edwinhu-plugins/workflows/4.0.0/lib/skills/dev-implement/SKILL.md")` to implement this plan.

## Chosen Approach

**Utility module + call sites**: New `src/time.ts` with pure timezone conversion functions. Modify `cli.ts` output paths to apply conversion when `--timezone` is set.

## Rationale

- Pure functions in `src/time.ts` are easy to test in isolation
- Call sites in `cli.ts` get minimal changes (wrap existing output with conversion)
- Clean separation — time logic doesn't pollute CLI or API modules
- ~80 lines new code, ~30 lines changed

## Testing Strategy (MANDATORY - GATE)

| Field | Value | Status |
|-------|-------|--------|
| **Framework** | bun:test | [x] Filled |
| **Test Command** | `bun test` | [x] Filled |
| **First Failing Test** | `convertToTimezone("2026-02-12T10:00:00", "UTC", "America/New_York")` returns `"2026-02-12T05:00:00-05:00"` | [x] Filled |
| **Test File Location** | `src/__tests__/time.test.ts` | [x] Filled |
| **Testing Skill** | Standard unit tests (bun:test) | [x] Filled |

## REAL Test Criteria (MANDATORY - PREVENTS FAKE TESTS)

| Criteria | Value | Verified |
|----------|-------|----------|
| **User workflow to replicate** | `morgen calendar events --timezone America/New_York --json` → times have offset | [x] |
| **Protocol/transport** | Pure function calls (timezone conversion is stateless computation) | [x] |
| **UI elements to interact with** | CLI output (JSON strings, human-readable time display) | [x] |
| **What user sees/verifies** | ISO 8601 times with correct offset in output | [x] |
| **Code path exercised** | floating local time + source tz → Date → target tz → ISO with offset | [x] |

### Fake Test Prevention Checklist

```
[x] Test uses SAME protocol as production (pure function calls — same as CLI internals)
[x] Test follows user's EXACT workflow (input string → conversion → output string)
[x] Test interacts with ACTUAL UI elements (verifies string output format)
[x] Test verifies what USER sees (ISO 8601 with offset)
[x] Test uses the SPECIFIED testing skill (bun:test)
```

## New Files

| File | Purpose |
|------|---------|
| `src/time.ts` | Timezone conversion utilities: `convertToTimezone()`, `formatTimeForDisplay()` |
| `src/__tests__/time.test.ts` | Unit tests for timezone conversion |

## Files to Modify

| File | Change |
|------|--------|
| `src/cli.ts` | Apply timezone conversion in event/free/task output paths |
| `src/calendars.ts` | Accept optional timezone param in `findFreeSlots()` for `toFloatingLocal()` |

## Implementation Order

| Task | Deps | Failing Test (write FIRST) | Verify Command |
|------|------|----------------------------|----------------|
| 1. Create `src/time.ts` with conversion functions | — | `convertToTimezone` returns ISO with offset | `bun test src/__tests__/time.test.ts` |
| 2. Wire events output in cli.ts | after 1 | N/A (integration — verified by existing + manual) | `bun test` |
| 3. Wire free slots output in cli.ts + calendars.ts | after 1 | N/A (integration) | `bun test` |
| 4. Wire task output in cli.ts | after 1 | N/A (integration) | `bun test` |

### Task 1: Create `src/time.ts` and tests

**New file `src/time.ts`** with:

1. `convertToTimezone(floatingLocal: string, sourceTz: string, targetTz: string): string`
   - Interprets `floatingLocal` as a time in `sourceTz`
   - Converts to `targetTz`
   - Returns ISO 8601 with offset (e.g., `"2026-02-12T05:00:00-05:00"`)
   - Uses `Intl.DateTimeFormat` with `timeZone` option to get parts, then manual offset calculation

2. `formatTimeForDisplay(floatingLocal: string, sourceTz: string, targetTz: string): string`
   - Returns just `HH:mm` in the target timezone (for human-readable output)

**Test cases:**
- EST conversion: `"2026-02-12T10:00:00"` UTC → `"2026-02-12T05:00:00-05:00"` in America/New_York
- Same timezone (no-op): source === target → still adds offset
- DST boundary: summer time uses `-04:00` not `-05:00`
- Date rollover: `"2026-02-12T02:00:00"` UTC → `"2026-02-11T21:00:00-05:00"` (date changes)
- Passthrough: when no target timezone, return original string unchanged

### Task 2: Wire events output

In `cli.ts` `handleCalendar` events section:
- When `opts.timeZone` is set, map events through `convertToTimezone(event.start, event.timeZone, opts.timeZone)` before JSON output
- Update `formatEvent()` to accept optional timezone and use `formatTimeForDisplay()` for human output

### Task 3: Wire free slots output

In `calendars.ts`:
- Add optional `timeZone` param to `findFreeSlots()`
- When set, `toFloatingLocal()` converts to target timezone instead of UTC
- In `cli.ts`, pass `opts.timeZone` to `findFreeSlots()`

### Task 4: Wire task output

In `cli.ts`:
- When `opts.timeZone` is set and task has `due` + `timeZone`, convert task due dates
- Apply to both JSON and human-readable output paths
