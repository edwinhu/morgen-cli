---
name: morgen
description: This skill should be used when the user asks to "check tasks", "list tasks", "create task", "complete task", "schedule task on calendar", "check calendar", "list events", "create event", "find free time", "check availability", "ask ai about calendar", "ask ai about tasks", or needs to interact with Morgen calendar and task management.
allowed-tools: Bash(morgen:*)
---

# Morgen Calendar & Task Management

CLI for [Morgen](https://morgen.so) calendar and task management. Manage tasks, calendars, events, and chat with an AI assistant — all from the terminal.

## Install

```bash
bun install
bun build src/cli.ts --compile --outfile morgen
```

## Auth

Two auth modes:

1. **API key** (basic): Set `MORGEN_API_KEY` from [platform.morgen.so](https://platform.morgen.so)
2. **Session token** (full access): Run `morgen auth` with the Morgen desktop app open:
   ```bash
   /Applications/Morgen.app/Contents/MacOS/Morgen --remote-debugging-port=9223
   morgen auth
   ```

Session auth enables close/reopen on integration tasks (Google Tasks, MS To Do) and AI chat.

## Commands

### Tasks

```bash
morgen tasks                          # List Morgen-native tasks
morgen tasks --all                    # List from all connected accounts
morgen tasks --account <id>           # List from specific account
morgen tasks get <id>                 # Get task details
morgen tasks create --title "Do X"    # Create task
morgen tasks update <id> --title "Y"  # Update task
morgen tasks close <id>               # Mark complete
morgen tasks reopen <id>              # Reopen completed task
morgen tasks delete <id>              # Delete task
morgen tasks move <id> --after <id>   # Reorder task
morgen tasks schedule <id> --start 2026-02-10T10:00:00  # Schedule on calendar
```

Options: `--title`, `--description`, `--due`, `--duration`, `--priority` (1-9), `--tags`, `--list`, `--calendar-id`

> `tasks schedule` creates a linked task-event on the calendar. The task shows as scheduled in Morgen and can be completed directly from the calendar.

### Calendar

```bash
morgen calendar                       # List all calendars
morgen calendar events                # Today's events
morgen calendar events --start 2026-02-10 --end 2026-02-11
morgen calendar create --title "Meeting" --start 2026-02-10T14:00:00 --end 2026-02-10T15:00:00
morgen calendar update <event-id> --title "New Title"
morgen calendar delete <event-id>
morgen calendar free --start 2026-02-10T09:00:00 --end 2026-02-10T17:00:00
```

Options: `--calendar-id`, `--start`, `--end`, `--timezone`, `--location`, `--attendees`, `--all-day`, `--min-minutes`

### AI Chat

```bash
morgen chat "What's on my calendar today?"
morgen chat "Create a task to review the PR"
morgen chat "Find me 2 free hours this week"
```

The AI assistant has access to calendar and task tools — it can read events, create/update/delete events, list/create/update/close/reopen/delete tasks, and schedule tasks on the calendar with proper task linkage.

**Calendar filtering** for availability queries:

```bash
morgen chat "find free time" --calendars Work,Personal
morgen chat "am I free Friday?" --exclude-calendars Family,Holidays
morgen chat "schedule focus time" --only-primary
```

### Other

```bash
morgen accounts                       # Show connected task accounts
morgen auth                           # Authenticate via Morgen app
morgen --json <any command>           # JSON output
morgen --help                         # Full help
```

## Common Workflows

### Task Management

```bash
# Create and schedule a task
morgen tasks create --title "Review PR" --due 2026-02-12
morgen tasks schedule <task-id> --start 2026-02-11T14:00:00

# Complete a task
morgen tasks close <task-id>

# List all tasks including integrations
morgen tasks --all
```

### Calendar Management

```bash
# Check today's schedule
morgen calendar events

# Find free time
morgen calendar free --start 2026-02-10T09:00:00 --end 2026-02-10T17:00:00

# Create a meeting
morgen calendar create --title "Team Sync" --start 2026-02-10T15:00:00 --end 2026-02-10T16:00:00
```

### AI Assistant

```bash
# Natural language queries
morgen chat "What's my schedule tomorrow?"
morgen chat "Do I have time for a 2-hour meeting this week?"
morgen chat "Create a task to finish the report by Friday"

# With calendar filtering
morgen chat "Am I free Thursday afternoon?" --calendars Work
morgen chat "Find 3 hours of focus time" --exclude-calendars Personal,Family
```

## Development

```bash
bun install
bun test                              # Run tests (62 pass)
bun run src/cli.ts <command>          # Run without building
```
