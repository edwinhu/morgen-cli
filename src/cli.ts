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
} from "./tasks";
import { sendChat } from "./chat";
import { MorgenApiError } from "./morgen-api";
import { authenticate } from "./morgen-cdp";
import type { MorgenTask, CreateTaskInput, UpdateTaskInput } from "./types";
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

function formatTask(task: MorgenTask): string {
  const progress =
    task.progress === "completed"
      ? `${colors.green}\u2713${colors.reset}`
      : task.progress === "in-process"
        ? `${colors.yellow}\u25D0${colors.reset}`
        : `${colors.dim}\u25CB${colors.reset}`;
  const due = task.due
    ? `  ${colors.dim}due ${task.due.split("T")[0]}${colors.reset}`
    : "";
  const pri =
    task.priority && task.priority > 0 && task.priority <= 3
      ? ` ${colors.red}!${colors.reset}`
      : "";
  const badge = providerBadge(task.integrationId);
  const source = badge ? `  ${badge}` : "";

  return `${progress} ${task.title}${pri}${due}${source}  ${colors.dim}${task.id}${colors.reset}`;
}

function formatTaskList(tasks: MorgenTask[]): string {
  if (tasks.length === 0)
    return `${colors.dim}No tasks found${colors.reset}`;
  return tasks.map(formatTask).join("\n");
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
  --json              Output as JSON
  --help              Show this help
  --version           Show version

${colors.bold}AUTH${colors.reset}
  Session token auth (from 'morgen auth') enables close/reopen on
  Google Tasks and MS To Do. Requires Morgen desktop app running with:
    /Applications/Morgen.app/Contents/MacOS/Morgen --remote-debugging-port=9223

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

  ${colors.dim}# Chat with Morgen AI${colors.reset}
  morgen chat "What is on my calendar today?"
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
    const result = await authenticate();
    if (opts.json) {
      console.log(JSON.stringify({
        email: result.email,
        expiresAt: new Date(result.expiresAt).toISOString(),
      }));
    } else {
      success(`Authenticated as ${result.email}`);
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
      console.log(JSON.stringify(tasks, null, 2));
    } else {
      console.log(formatTaskList(tasks));
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
      console.log(JSON.stringify(task, null, 2));
    } else {
      console.log(formatTask(task));
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

  error(`Unknown tasks subcommand: ${sub}`);
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

  if (opts.json) {
    const result = await sendChat(prompt);
    console.log(JSON.stringify(result, null, 2));
  } else {
    const result = await sendChat(prompt, {
      onToken: (text: string) => process.stdout.write(text),
      onToolCall: (name: string, args: string) => {
        // Show tool execution on stderr so it doesn't mix with streamed output
        process.stderr.write(
          `${colors.dim}[tool] ${name}(${args.length > 80 ? args.slice(0, 80) + "..." : args})${colors.reset}\n`
        );
      },
    });
    // Ensure final newline after streamed output
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
