# morgen-cli

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
morgen tasks                          # List tasks from all connected accounts
morgen tasks --account <id>           # List from specific account
morgen tasks get <id>                 # Get task details
morgen tasks create --title "Do X"    # Create task
morgen tasks update <id> --title "Y"  # Update task
morgen tasks close <id>               # Mark complete (works for MS Todo and Google Tasks)
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

Options: `--calendar-id`, `--start`, `--end`, `--timezone`, `--location`, `--attendees`, `--all-day`, `--min-minutes`, `--calendars`, `--exclude-calendars`

**Calendar filtering** works on all calendar commands:

```bash
morgen calendar --exclude-calendars rjj6        # Hide a calendar from listing
morgen calendar events --exclude-calendars rjj6 # Exclude from event listings
morgen calendar free --exclude-calendars rjj6   # Exclude from free time search
```

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
morgen --help                         # Full help
```

## Output formats

By default, output is human-readable with ANSI colors. Two structured output modes are available:

| Flag | Behavior |
|------|----------|
| `--json` | Full JSON array, printed after all data is fetched |
| `--ndjson` / `--stream` | Newline-delimited JSON, one object per line, streamed as results arrive |

When stdout is **piped** (e.g. to `jq`, a file, or another process), NDJSON is enabled automatically — no flag needed:

```bash
morgen tasks | jq '.title'
morgen calendar events | jq 'select(.title | test("standup"))'
morgen tasks --ndjson | while read line; do echo "$line"; done
```

For `tasks` and `calendar events`, NDJSON streams results **per account in parallel** — you see the first account's tasks immediately while other accounts are still fetching.

## Development

```bash
bun install
bun test                              # Run tests (92 pass)
bun run src/cli.ts <command>          # Run without building
```

## License

Private — not published.
