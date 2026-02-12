#!/usr/bin/env bun
/**
 * Morgen CLI
 */

import {
  listTasks,
  listAllTasks,
  listIntegrationAccounts,
  getTask,
  createTask,
  updateTask,
  closeTask,
  reopenTask,
  deleteTask,
  moveTask,
  decodeIntegrationId,
} from "./tasks";
import {
  listCalendars,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  findFreeSlots,
} from "./calendars";
import { sendChat } from "./chat";
import { MorgenApiError } from "./morgen-api";
import { authenticate } from "./morgen-cdp";
import type { MorgenTask, MorgenEvent, MorgenCalendar, CreateTaskInput, UpdateTaskInput } from "./types";
import { convertToTimezone, formatTimeForDisplay } from "./time";
import pkg from "../package.json";

const VERSION = pkg.version;

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

function success(msg: string) {
  console.log(`${colors.green}\u2713${colors.reset} ${msg}`);
}
function error(msg: string) {
  console.error(`${colors.red}\u2717${colors.reset} ${msg}`);
}
function info(msg: string) {
  console.log(`${colors.blue}\u2139${colors.reset} ${msg}`);
}

// ---------------------------------------------------------------------------
// CLI options interface
// ---------------------------------------------------------------------------
interface CliOptions {
  command: string;
  subCommand?: string;
  positional?: string;
  restArgs: string[];
  title?: string;
  description?: string;
  due?: string;
  duration?: string;
  priority?: string;
  list?: string;
  progress?: string;
  limit?: number;
  json: boolean;
  help: boolean;
  version: boolean;
  tags?: string[];
  after?: string;
  parent?: string;
  account?: string;
  all?: boolean;
  // Calendar/event options
  calendarId?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  location?: string;
  attendees?: string;
  allDay?: boolean;
  minMinutes?: number;
  // Chat calendar filtering
  calendars?: string[];
  excludeCalendars?: string[];
  onlyPrimary?: boolean;
  port?: number;
}

// ---------------------------------------------------------------------------
// Arg parser -- custom, zero-dependency
// ---------------------------------------------------------------------------
function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    command: "",
    restArgs: [],
    json: false,
    help: false,
    version: false,
  };

  const positionals: string[] = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith("--") && arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      const key = arg.slice(2, eqIdx);
      const value = arg.slice(eqIdx + 1);
      setNamedArg(opts, key, value);
      i++;
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);

      if (key === "json") { opts.json = true; i++; continue; }
      if (key === "help") { opts.help = true; i++; continue; }
      if (key === "version") { opts.version = true; i++; continue; }
      if (key === "all") { opts.all = true; i++; continue; }
      if (key === "all-day") { opts.allDay = true; i++; continue; }
      if (key === "only-primary") { opts.onlyPrimary = true; i++; continue; }

      const next = args[i + 1];
      if (next !== undefined) {
        setNamedArg(opts, key, next);
        i += 2;
        continue;
      }

      i++;
      continue;
    }

    if (arg === "-h") { opts.help = true; i++; continue; }
    if (arg === "-v") { opts.version = true; i++; continue; }

    positionals.push(arg);
    i++;
  }

  if (positionals.length > 0) opts.command = positionals[0];
  if (positionals.length > 1) opts.subCommand = positionals[1];
  if (positionals.length > 2) opts.positional = positionals[2];

  // Capture all positionals after the command for commands like "chat"
  // that consume all remaining words as a single prompt
  if (positionals.length > 1) opts.restArgs = positionals.slice(1);

  return opts;
}

function setNamedArg(opts: CliOptions, key: string, value: string): void {
  switch (key) {
    case "title": opts.title = value; break;
    case "description": opts.description = value; break;
    case "due": opts.due = value; break;
    case "duration": opts.duration = value; break;
    case "priority": opts.priority = value; break;
    case "list": opts.list = value; break;
    case "progress": opts.progress = value; break;
    case "limit": opts.limit = parseInt(value, 10); break;
    case "tags": opts.tags = value.split(",").map((t) => t.trim()); break;
    case "after": opts.after = value; break;
    case "parent": opts.parent = value; break;
    case "account": opts.account = value; break;
    // Calendar/event options
    case "calendar": case "calendar-id": opts.calendarId = value; break;
    case "start": opts.start = value; break;
    case "end": opts.end = value; break;
    case "timezone": case "tz": opts.timeZone = value; break;
    case "location": opts.location = value; break;
    case "attendees": opts.attendees = value; break;
    case "min-minutes": opts.minMinutes = parseInt(value, 10); break;
    case "port": opts.port = parseInt(value, 10); break;
    // Chat calendar filtering
    case "calendars": opts.calendars = value.split(",").map((s) => s.trim()); break;
    case "exclude-calendars": opts.excludeCalendars = value.split(",").map((s) => s.trim()); break;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function providerBadge(integrationId: string): string {
  if (integrationId === "googleTasks") return `${colors.blue}[google]${colors.reset}`;
  if (integrationId === "microsoftToDo") return `${colors.magenta}[mstodo]${colors.reset}`;
  if (integrationId === "morgen") return "";
  return `${colors.dim}[${integrationId}]${colors.reset}`;
}

function formatTask(task: MorgenTask, targetTz?: string): string {
  const progress =
    task.progress === "completed"
      ? `${colors.green}\u2713${colors.reset}`
      : task.progress === "in-process"
        ? `${colors.yellow}\u25D0${colors.reset}`
        : `${colors.dim}\u25CB${colors.reset}`;
  let due = "";
  if (task.due) {
    if (targetTz && task.timeZone) {
      const converted = convertToTimezone(task.due, task.timeZone, targetTz);
      due = `  ${colors.dim}due ${converted.split("T")[0]}${colors.reset}`;
    } else {
      due = `  ${colors.dim}due ${task.due.split("T")[0]}${colors.reset}`;
    }
  }
  const pri =
    task.priority && task.priority > 0 && task.priority <= 3
      ? ` ${colors.red}!${colors.reset}`
      : "";
  const badge = providerBadge(task.integrationId);
  const source = badge ? `  ${badge}` : "";

  return `${progress} ${task.title}${pri}${due}${source}  ${colors.dim}${task.id}${colors.reset}`;
}

function formatTaskList(tasks: MorgenTask[], targetTz?: string): string {
  if (tasks.length === 0)
    return `${colors.dim}No tasks found${colors.reset}`;
  return tasks.map((t) => formatTask(t, targetTz)).join("\n");
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------
function printHelp() {
  console.log(`
${colors.bold}Morgen CLI${colors.reset} v${VERSION}

${colors.bold}USAGE${colors.reset}
  morgen <command> [subcommand] [options]

${colors.bold}COMMANDS${colors.reset}
  ${colors.cyan}auth${colors.reset}               Authenticate via running Morgen app (CDP)
  ${colors.cyan}accounts${colors.reset}           Show connected task accounts
  ${colors.cyan}tasks${colors.reset}              List Morgen-native tasks
  ${colors.cyan}tasks${colors.reset} --all         List tasks from ALL connected accounts
  ${colors.cyan}tasks${colors.reset} --account <id> List tasks from a specific account
  ${colors.cyan}tasks get${colors.reset} <id>      Get a specific task
  ${colors.cyan}tasks create${colors.reset}        Create a new task (Morgen-native)
  ${colors.cyan}tasks update${colors.reset} <id>   Update a task (Morgen-native)
  ${colors.cyan}tasks close${colors.reset} <id>    Mark task as complete (all providers)
  ${colors.cyan}tasks reopen${colors.reset} <id>   Reopen a completed task (all providers)
  ${colors.cyan}tasks delete${colors.reset} <id>   Delete a task (Morgen-native)
  ${colors.cyan}tasks move${colors.reset} <id>    Move/reorder a task (--after, --parent)
  ${colors.cyan}tasks schedule${colors.reset} <id> Schedule a task on the calendar (--start)
  ${colors.cyan}calendar${colors.reset}           List all calendars
  ${colors.cyan}calendar events${colors.reset}    List events (--start, --end)
  ${colors.cyan}calendar create${colors.reset}    Create an event (--title, --start, --end)
  ${colors.cyan}calendar update${colors.reset} <id> Update an event
  ${colors.cyan}calendar delete${colors.reset} <id> Delete an event
  ${colors.cyan}calendar free${colors.reset}      Find free time slots (--start, --end)
  ${colors.cyan}chat${colors.reset} <prompt>       Chat with Morgen AI assistant
  ${colors.cyan}help${colors.reset}               Show this help message

${colors.bold}OPTIONS${colors.reset}
  --title <text>      Task title (for create/update)
  --description <text> Task description
  --due <datetime>    Due date (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)
  --duration <dur>    Estimated duration (e.g. PT30M, PT1H)
  --priority <n>      Priority 1-9 (1=highest, 9=lowest, 0=none)
  --list <id>         Task list ID
  --progress <state>  Progress: needs-action, in-process, completed
  --limit <n>         Max results (default: 100)
  --tags <ids>        Comma-separated tag IDs
  --after <id>        Place task after this task ID (for move)
  --parent <id>       Set parent task ID (for move)
  --account <id>      Filter tasks by integration account ID
  --all               List tasks from all connected accounts
  --calendar-id <id>  Calendar ID (for event create)
  --start <datetime>  Start time (ISO format or YYYY-MM-DD)
  --end <datetime>    End time (ISO format or YYYY-MM-DD)
  --timezone <tz>     Timezone (e.g. America/New_York)
  --location <text>   Event location
  --attendees <emails> Comma-separated attendee emails
  --all-day           Create an all-day event
  --min-minutes <n>   Minimum free slot duration (default: 30)
  --calendars <names> Filter: only include these calendars (for chat/free)
  --exclude-calendars <names> Filter: exclude these calendars
  --only-primary      Filter: only primary calendar (for chat)
  --port <number>     CDP port (default: from CDP_PORT env or 9400)
  --json              Output as JSON
  --help              Show this help
  --version           Show version

${colors.bold}AUTH${colors.reset}
  Two auth paths (tried in order):
    1. Morgen desktop app (Electron) — run with:
       /Applications/Morgen.app/Contents/MacOS/Morgen --remote-debugging-port=9400
    2. Chrome browser with app.morgen.so open — run with:
       nanoclaw-chrome start

  Use --port to specify the CDP port (default: 9400 or CDP_PORT env).
  Session tokens are cached in ~/.config/morgen-cli/session.json.
  Alternatively, set MORGEN_API_KEY for basic read + Morgen-native CRUD.

${colors.bold}EXAMPLES${colors.reset}
  ${colors.dim}# Authenticate (extracts session from Morgen app)${colors.reset}
  morgen auth

  ${colors.dim}# List tasks from all accounts${colors.reset}
  morgen tasks --all

  ${colors.dim}# Close an integration task${colors.reset}
  morgen tasks close <base64-task-id>

  ${colors.dim}# Create a Morgen-native task${colors.reset}
  morgen tasks create --title "Review PR" --due 2026-02-10

  ${colors.dim}# List calendars and events${colors.reset}
  morgen calendar
  morgen calendar events --start 2026-02-10 --end 2026-02-11

  ${colors.dim}# Create a calendar event${colors.reset}
  morgen calendar create --title "Meeting" --start 2026-02-10T14:00:00 --end 2026-02-10T15:00:00

  ${colors.dim}# Schedule a task on the calendar${colors.reset}
  morgen tasks schedule <task-id> --start 2026-02-10T10:00:00

  ${colors.dim}# Find free time slots${colors.reset}
  morgen calendar free --start 2026-02-10T09:00:00 --end 2026-02-10T17:00:00

  ${colors.dim}# Chat with Morgen AI${colors.reset}
  morgen chat "What is on my calendar today?"
  morgen chat "find me 2 hours free" --calendars Work,Personal
  morgen chat summarize my week --json

${colors.bold}ENVIRONMENT${colors.reset}
  MORGEN_API_KEY      API key from https://platform.morgen.so
`);
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------
async function handleAuth(opts: CliOptions) {
  try {
    const result = await authenticate(opts.port);
    if (opts.json) {
      console.log(JSON.stringify({
        email: result.email,
        expiresAt: new Date(result.expiresAt).toISOString(),
        source: result.source,
      }));
    } else {
      const sourceLabel = result.source === "electron" ? "Morgen app" : "Chrome browser";
      success(`Authenticated as ${result.email} (via ${sourceLabel})`);
      info(`Session expires: ${new Date(result.expiresAt).toLocaleString()}`);
    }
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function handleAccounts(opts: CliOptions) {
  const accounts = await listIntegrationAccounts();

  if (opts.json) {
    console.log(JSON.stringify(accounts, null, 2));
  } else {
    if (accounts.length === 0) {
      console.log(`${colors.dim}No task integration accounts found${colors.reset}`);
    } else {
      console.log(`${colors.bold}Connected Task Accounts${colors.reset}\n`);
      for (const acct of accounts) {
        const badge = providerBadge(acct.integrationId);
        const display = acct.providerUserDisplayName || acct.providerUserId || "";
        console.log(`  ${badge} ${display}  ${colors.dim}${acct._id}${colors.reset}`);
      }
    }
  }
}

async function handleTasks(opts: CliOptions) {
  const sub = opts.subCommand;

  // Default: list tasks
  if (!sub || sub === "list") {
    let tasks;
    if (opts.all) {
      tasks = await listAllTasks({ limit: opts.limit });
    } else {
      tasks = await listTasks({ limit: opts.limit, accountId: opts.account });
    }
    if (opts.json) {
      const output = opts.timeZone
        ? tasks.map((t) => t.due && t.timeZone
            ? { ...t, due: convertToTimezone(t.due, t.timeZone, opts.timeZone!) }
            : t)
        : tasks;
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(formatTaskList(tasks, opts.timeZone));
    }
    return;
  }

  if (sub === "get") {
    if (!opts.positional) {
      error("Usage: morgen tasks get <id>");
      process.exit(1);
    }
    const task = await getTask(opts.positional);
    if (opts.json) {
      const output = opts.timeZone && task.due && task.timeZone
        ? { ...task, due: convertToTimezone(task.due, task.timeZone, opts.timeZone) }
        : task;
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(formatTask(task, opts.timeZone));
      if (task.description) console.log(`\n${task.description}`);
    }
    return;
  }

  if (sub === "create") {
    if (!opts.title) {
      error("--title is required for task creation");
      process.exit(1);
    }
    if (opts.priority) {
      const p = parseInt(opts.priority);
      if (isNaN(p) || p < 0 || p > 9) {
        error("--priority must be 0-9 (1=highest, 9=lowest, 0=none)");
        process.exit(1);
      }
    }
    const input: CreateTaskInput = {
      title: opts.title,
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.due
        ? {
            due: opts.due,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }
        : {}),
      ...(opts.duration ? { estimatedDuration: opts.duration } : {}),
      ...(opts.priority ? { priority: parseInt(opts.priority) } : {}),
      ...(opts.list ? { taskListId: opts.list } : {}),
      ...(opts.tags ? { tags: opts.tags } : {}),
    };
    const id = await createTask(input);
    if (opts.json) {
      console.log(JSON.stringify({ id }));
    } else {
      success(`Task created: ${id}`);
    }
    return;
  }

  if (sub === "update") {
    if (!opts.positional) {
      error("Usage: morgen tasks update <id> [options]");
      process.exit(1);
    }
    if (opts.priority) {
      const p = parseInt(opts.priority);
      if (isNaN(p) || p < 0 || p > 9) {
        error("--priority must be 0-9 (1=highest, 9=lowest, 0=none)");
        process.exit(1);
      }
    }
    const input: UpdateTaskInput = {
      id: opts.positional,
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.due
        ? {
            due: opts.due,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }
        : {}),
      ...(opts.duration ? { estimatedDuration: opts.duration } : {}),
      ...(opts.priority ? { priority: parseInt(opts.priority) } : {}),
      ...(opts.progress ? { progress: opts.progress as UpdateTaskInput["progress"] } : {}),
      ...(opts.list ? { taskListId: opts.list } : {}),
      ...(opts.tags ? { tags: opts.tags } : {}),
    };
    await updateTask(input);
    if (opts.json) {
      console.log(JSON.stringify({ success: true }));
    } else {
      success("Task updated");
    }
    return;
  }

  if (sub === "close") {
    if (!opts.positional) {
      error("Usage: morgen tasks close <id>");
      process.exit(1);
    }
    await closeTask(opts.positional);
    if (opts.json) {
      console.log(JSON.stringify({ success: true }));
    } else {
      success("Task closed");
    }
    return;
  }

  if (sub === "reopen") {
    if (!opts.positional) {
      error("Usage: morgen tasks reopen <id>");
      process.exit(1);
    }
    await reopenTask(opts.positional);
    if (opts.json) {
      console.log(JSON.stringify({ success: true }));
    } else {
      success("Task reopened");
    }
    return;
  }

  if (sub === "delete") {
    if (!opts.positional) {
      error("Usage: morgen tasks delete <id>");
      process.exit(1);
    }
    await deleteTask(opts.positional);
    if (opts.json) {
      console.log(JSON.stringify({ success: true }));
    } else {
      success("Task deleted");
    }
    return;
  }

  if (sub === "move") {
    if (!opts.positional) {
      error("Usage: morgen tasks move <id> [--after <id>] [--parent <id>]");
      process.exit(1);
    }
    await moveTask(opts.positional, opts.after, opts.parent);
    if (opts.json) {
      console.log(JSON.stringify({ success: true }));
    } else {
      success("Task moved");
    }
    return;
  }

  if (sub === "schedule") {
    if (!opts.positional) {
      error("Usage: morgen tasks schedule <task-id> --start <datetime>");
      process.exit(1);
    }
    if (!opts.start) {
      error("--start is required for scheduling a task");
      process.exit(1);
    }

    // Integration tasks can't be scheduled
    if (decodeIntegrationId(opts.positional)) {
      error("Only Morgen-native tasks can be scheduled. Integration tasks are not supported.");
      process.exit(1);
    }

    // Fetch the task to get title and estimatedDuration
    const task = await getTask(opts.positional);
    const tz = opts.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const duration = opts.duration || task.estimatedDuration || "PT1H";

    // Find a writable calendar
    const calendars = await listCalendars();
    const cal = opts.calendarId
      ? calendars.find((c) => c.id === opts.calendarId)
      : calendars.find((c) => c.myRights?.mayWriteAll || c.myRights?.mayWriteOwn);

    if (!cal) {
      error("No writable calendar found. Use --calendar-id to specify one.");
      process.exit(1);
    }

    const eventId = await createEvent({
      accountId: cal.accountId,
      calendarId: cal.id,
      title: task.title,
      start: opts.start,
      duration,
      timeZone: tz,
      showWithoutTime: false,
      "morgen.so:metadata": {
        taskId: opts.positional,
        isAutoScheduled: true,
      },
    });

    if (opts.json) {
      console.log(JSON.stringify({ eventId, taskId: task.id, calendar: cal.name }));
    } else {
      success(`Task "${task.title}" scheduled on "${cal.name}"`);
    }
    return;
  }

  error(`Unknown tasks subcommand: ${sub}`);
  info("Run 'morgen help' for usage");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Calendar/Event formatting
// ---------------------------------------------------------------------------
function formatCalendar(cal: MorgenCalendar): string {
  const write = (cal.myRights?.mayWrite || cal.myRights?.mayWriteAll)
    ? `${colors.green}rw${colors.reset}`
    : `${colors.dim}ro${colors.reset}`;
  return `  ${write} ${cal.name}  ${colors.dim}${cal.id}${colors.reset}`;
}

function formatEvent(event: MorgenEvent & { calendarName?: string }, targetTz?: string): string {
  let timeStr: string;
  if (event.showWithoutTime) {
    timeStr = `${colors.cyan}all-day${colors.reset}`;
  } else if (targetTz) {
    timeStr = `${colors.cyan}${formatTimeForDisplay(event.start, event.timeZone, targetTz)}${colors.reset}`;
  } else {
    timeStr = `${colors.cyan}${event.start.split("T")[1]?.slice(0, 5) || event.start}${colors.reset}`;
  }
  const dur = event.duration ? `  ${colors.dim}${event.duration}${colors.reset}` : "";
  const cal = event.calendarName
    ? `  ${colors.dim}[${event.calendarName}]${colors.reset}`
    : "";
  const status = event.freeBusyStatus && event.freeBusyStatus !== "busy"
    ? `  ${colors.yellow}(${event.freeBusyStatus})${colors.reset}`
    : "";
  return `${timeStr} ${event.title}${dur}${status}${cal}  ${colors.dim}${event.id}${colors.reset}`;
}

// ---------------------------------------------------------------------------
// Calendar handler
// ---------------------------------------------------------------------------
async function handleCalendar(opts: CliOptions) {
  const sub = opts.subCommand;

  // Default: list calendars
  if (!sub || sub === "list") {
    const calendars = await listCalendars();
    if (opts.json) {
      console.log(JSON.stringify(calendars, null, 2));
    } else {
      if (calendars.length === 0) {
        console.log(`${colors.dim}No calendars found${colors.reset}`);
      } else {
        console.log(`${colors.bold}Calendars${colors.reset}\n`);
        for (const cal of calendars) {
          console.log(formatCalendar(cal));
        }
      }
    }
    return;
  }

  if (sub === "events") {
    if (!opts.start) {
      // Default to today
      const now = new Date();
      opts.start = now.toISOString().split("T")[0];
    }
    if (!opts.end) {
      // Default to start + 1 day
      const startDate = new Date(opts.start);
      startDate.setDate(startDate.getDate() + 1);
      opts.end = startDate.toISOString().split("T")[0];
    }

    const events = await listEvents({
      start: opts.start,
      end: opts.end,
      calendarIds: opts.calendars,
    });

    if (opts.json) {
      const output = opts.timeZone
        ? events.map((e) => ({
            ...e,
            start: e.showWithoutTime ? e.start : convertToTimezone(e.start, e.timeZone, opts.timeZone!),
          }))
        : events;
      console.log(JSON.stringify(output, null, 2));
    } else {
      if (events.length === 0) {
        console.log(`${colors.dim}No events found${colors.reset}`);
      } else {
        for (const event of events) {
          console.log(formatEvent(event, opts.timeZone));
        }
      }
    }
    return;
  }

  if (sub === "create") {
    if (!opts.title) {
      error("--title is required for event creation");
      process.exit(1);
    }
    if (!opts.start) {
      error("--start is required for event creation");
      process.exit(1);
    }
    if (!opts.end && !opts.duration) {
      error("--end or --duration is required for event creation");
      process.exit(1);
    }

    const calendars = await listCalendars();
    const cal = opts.calendarId
      ? calendars.find((c) => c.id === opts.calendarId)
      : calendars.find((c) => c.myRights?.mayWrite || c.myRights?.mayWriteAll);

    if (!cal) {
      error("No writable calendar found. Use --calendar-id to specify one.");
      process.exit(1);
    }

    const tz = opts.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Compute duration from start/end or use provided duration
    let duration = opts.duration || "PT1H";
    if (opts.end && !opts.duration) {
      const durationMs = new Date(opts.end).getTime() - new Date(opts.start).getTime();
      const totalMins = Math.round(durationMs / 60000);
      const hours = Math.floor(totalMins / 60);
      const mins = totalMins % 60;
      duration = hours > 0
        ? `PT${hours}H${mins > 0 ? mins + "M" : ""}`
        : `PT${mins}M`;
    }

    const id = await createEvent({
      accountId: cal.accountId,
      calendarId: cal.id,
      title: opts.title,
      start: opts.start,
      duration,
      timeZone: tz,
      showWithoutTime: opts.allDay ?? false,
      ...(opts.description ? { description: opts.description } : {}),
    });

    if (opts.json) {
      console.log(JSON.stringify({ id }));
    } else {
      success(`Event created: ${id}`);
    }
    return;
  }

  if (sub === "update") {
    if (!opts.positional) {
      error("Usage: morgen calendar update <event-id> [options]");
      process.exit(1);
    }

    const body: Record<string, unknown> = { id: opts.positional };
    if (opts.title) body.title = opts.title;
    if (opts.description) body.description = opts.description;
    if (opts.location) body.locations = [{ name: opts.location }];
    if (opts.start) body.start = opts.start;
    if (opts.start && opts.end) {
      const durationMs = new Date(opts.end).getTime() - new Date(opts.start).getTime();
      const totalMins = Math.round(durationMs / 60000);
      const hours = Math.floor(totalMins / 60);
      const mins = totalMins % 60;
      body.duration = hours > 0
        ? `PT${hours}H${mins > 0 ? mins + "M" : ""}`
        : `PT${mins}M`;
    }
    if (opts.allDay !== undefined) body.showWithoutTime = opts.allDay;

    await updateEvent(body);
    if (opts.json) {
      console.log(JSON.stringify({ success: true }));
    } else {
      success("Event updated");
    }
    return;
  }

  if (sub === "delete") {
    if (!opts.positional) {
      error("Usage: morgen calendar delete <event-id>");
      process.exit(1);
    }
    await deleteEvent(opts.positional);
    if (opts.json) {
      console.log(JSON.stringify({ success: true }));
    } else {
      success("Event deleted");
    }
    return;
  }

  if (sub === "free") {
    if (!opts.start) {
      const now = new Date();
      opts.start = now.toISOString();
    }
    if (!opts.end) {
      const startDate = new Date(opts.start);
      startDate.setDate(startDate.getDate() + 1);
      opts.end = startDate.toISOString();
    }

    const slots = await findFreeSlots({
      start: opts.start,
      end: opts.end,
      calendarIds: opts.calendars,
      minMinutes: opts.minMinutes,
      timeZone: opts.timeZone,
    });

    if (opts.json) {
      console.log(JSON.stringify(slots, null, 2));
    } else {
      if (slots.length === 0) {
        console.log(`${colors.dim}No free slots found${colors.reset}`);
      } else {
        console.log(`${colors.bold}Free Slots${colors.reset}\n`);
        for (const slot of slots) {
          const start = slot.start.includes("T")
            ? slot.start.split("T")[1]?.slice(0, 5)
            : slot.start;
          const end = slot.end.includes("T")
            ? slot.end.split("T")[1]?.slice(0, 5)
            : slot.end;
          console.log(
            `  ${colors.green}${start}${colors.reset} - ${colors.green}${end}${colors.reset}  ${colors.dim}(${slot.duration})${colors.reset}`
          );
        }
      }
    }
    return;
  }

  error(`Unknown calendar subcommand: ${sub}`);
  info("Run 'morgen help' for usage");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Chat handler
// ---------------------------------------------------------------------------
async function handleChat(opts: CliOptions) {
  const prompt = opts.restArgs.join(" ").trim();

  if (!prompt) {
    error("Usage: morgen chat <prompt>");
    info("Provide a prompt, e.g.: morgen chat \"What is on my calendar today?\"");
    process.exit(1);
  }

  // Resolve calendar filters to IDs
  let calendarFilter: import("./chat").CalendarFilter | undefined;
  if (opts.calendars || opts.excludeCalendars || opts.onlyPrimary) {
    const allCals = await listCalendars();
    let filtered = allCals;

    if (opts.onlyPrimary) {
      // Use only the first writable calendar as "primary"
      const primary = allCals.find((c) => c.myRights?.mayWrite || c.myRights?.mayWriteAll);
      filtered = primary ? [primary] : [];
    } else if (opts.calendars) {
      // Include only calendars whose name matches (case-insensitive partial match)
      filtered = allCals.filter((c) =>
        opts.calendars!.some((name) =>
          c.name.toLowerCase().includes(name.toLowerCase())
        )
      );
    }

    if (opts.excludeCalendars) {
      filtered = filtered.filter((c) =>
        !opts.excludeCalendars!.some((name) =>
          c.name.toLowerCase().includes(name.toLowerCase())
        )
      );
    }

    if (filtered.length === 0) {
      error("No calendars matched the filter. Check --calendars / --exclude-calendars names.");
      process.exit(1);
    }

    calendarFilter = { calendarIds: filtered.map((c) => c.id) };
  }

  if (opts.json) {
    const result = await sendChat(prompt, { calendarFilter });
    console.log(JSON.stringify(result, null, 2));
  } else {
    const result = await sendChat(prompt, {
      onToken: (text: string) => process.stdout.write(text),
      onToolCall: (name: string, args: string) => {
        process.stderr.write(
          `${colors.dim}[tool] ${name}(${args.length > 80 ? args.slice(0, 80) + "..." : args})${colors.reset}\n`
        );
      },
      calendarFilter,
    });
    process.stdout.write("\n");
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }

  const opts = parseArgs(args);

  try {
    if (opts.command === "help") { printHelp(); return; }
    if (opts.command === "auth") { await handleAuth(opts); return; }
    if (opts.command === "accounts") { await handleAccounts(opts); return; }
    if (opts.command === "tasks") { await handleTasks(opts); return; }
    if (opts.command === "calendar") { await handleCalendar(opts); return; }

    if (opts.command === "chat") {
      await handleChat(opts);
      return;
    }

    error(`Unknown command: ${opts.command}`);
    info("Run 'morgen help' for usage");
    process.exit(1);
  } catch (err) {
    if (err instanceof MorgenApiError) {
      error(err.message);
      if (err.status === 401) info("Run 'morgen auth' or set MORGEN_API_KEY.");
    } else if (err instanceof Error) {
      error(err.message);
    }
    process.exit(1);
  }
}

main();
