/**
 * Chat Tool Definitions & Execution
 *
 * Defines the tools available to the AI chat assistant and
 * implements their execution against the Morgen API.
 *
 * Tools are a subset of what the Morgen desktop app provides,
 * focused on calendar/task reading and event management.
 */

import { morgenFetch } from "./morgen-api";
import {
  listCalendars,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  resetCalendarCache as resetCalCache,
  participantsFromCsv,
  buildLocations,
  buildAlerts,
} from "./calendars";
import {
  listTasks,
  listAllTasks,
  createTask,
  updateTask,
  closeTask,
  reopenTask,
  deleteTask,
} from "./tasks";
import type { MorgenTask } from "./types";

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function calling format)
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "calendarRead",
      description:
        "Get events, meetings or tasks scheduled in the user calendar within a given time range. Keep range short and call the tool again if more events are needed.",
      parameters: {
        type: "object",
        properties: {
          start: {
            type: "string",
            description:
              "Start time as floating ISO datetime without timezone offset.",
          },
          end: {
            type: "string",
            description:
              "End time as floating ISO datetime without timezone offset.",
          },
          includeBody: {
            type: "boolean",
            description:
              "Whether to include the body of the event in the response. Use sparingly.",
          },
          calendarIds: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional list of calendar IDs to filter events. If provided, only events from these calendars are returned.",
          },
        },
        required: ["start", "end"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "calendarList",
      description:
        "Get the list of available calendars. Includes calendar and account name, access rights, and visibility.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "eventCreate",
      description:
        "Schedule a new event on a calendar. ALWAYS read the calendar around the date you are scheduling using 'calendarRead' first to find the right calendar id and avoid conflicts.",
      parameters: {
        type: "object",
        properties: {
          calendarId: {
            type: "string",
            description: "The id of the calendar to schedule the event on.",
          },
          summary: { type: "string", description: "The title of the event" },
          start: {
            type: "string",
            description:
              'Start time. For timed events: ISO format with time (e.g., "2025-01-15T09:00:00"). For all-day events: date only in YYYY-MM-DD format.',
          },
          end: {
            type: "string",
            description:
              "End time. For timed events: ISO format with time. For all-day events: date in YYYY-MM-DD format (exclusive).",
          },
          isAllDay: { type: "boolean", description: "Whether all-day event." },
          timeZone: {
            type: "string",
            description: 'Timezone in IANA format (e.g., "America/New_York").',
          },
          attendees: {
            type: "string",
            description: "Comma-separated list of attendee emails.",
          },
          taskId: {
            type: "string",
            description:
              "If scheduling a task on the calendar, provide the task ID here. This links the event to the task so it can be completed from the calendar.",
          },
          alerts: {
            type: "string",
            description:
              'Comma-separated reminder lead times before the event start (e.g. "30m,10m,1h,1d"). Use "0" or "at-time" for an alert at the event start.',
          },
        },
        required: ["summary", "start", "end", "timeZone"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "eventUpdate",
      description:
        "Update an event on the calendar. The id is required and can be obtained from 'calendarRead'.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The unique identifier of the event to update.",
          },
          summary: { type: "string", description: "New title for the event." },
          description: {
            type: "string",
            description: "New description/notes.",
          },
          location: { type: "string", description: "New location." },
          start: {
            type: "string",
            description:
              "New start time in ISO format without timezone offset.",
          },
          end: {
            type: "string",
            description: "New end time in ISO format without timezone offset.",
          },
          isAllDay: { type: "boolean", description: "Whether all-day event." },
          alerts: {
            type: "string",
            description:
              'Comma-separated reminder lead times before the event start (e.g. "30m,10m"). Use "0" or "at-time" for an alert at the event start. Added alongside any existing alerts (merged by the server).',
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "eventDelete",
      description:
        "Delete an event from the calendar. Use 'calendarRead' to find the event id.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The id of the event to delete.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  // Task tools
  {
    type: "function" as const,
    function: {
      name: "taskList",
      description:
        "List the user's tasks. Returns open tasks by default. Use 'allAccounts' to include tasks from connected integrations (Google Tasks, Microsoft To Do).",
      parameters: {
        type: "object",
        properties: {
          allAccounts: {
            type: "boolean",
            description:
              "If true, fetch tasks from all connected accounts (Google Tasks, MS To Do). Default: false (Morgen-native tasks only).",
          },
          limit: {
            type: "number",
            description: "Maximum number of tasks to return.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "taskCreate",
      description:
        "Create a new task. Only works for Morgen-native tasks (not integration accounts).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The title of the task." },
          description: {
            type: "string",
            description: "Optional description or notes for the task.",
          },
          due: {
            type: "string",
            description:
              "Due date/time as ISO datetime without timezone offset (e.g. '2025-01-15T09:00:00').",
          },
          estimatedDuration: {
            type: "string",
            description:
              "Estimated duration as ISO 8601 duration (e.g. 'PT30M', 'PT1H').",
          },
          priority: {
            type: "number",
            description:
              "Priority: 1 (highest) to 9 (lowest). 0 or omitted means undefined.",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "taskUpdate",
      description:
        "Update an existing task's properties. Use 'taskList' to find the task id. Only works for Morgen-native tasks.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The id of the task to update." },
          title: { type: "string", description: "New title for the task." },
          description: {
            type: "string",
            description: "New description/notes.",
          },
          due: {
            type: "string",
            description:
              "New due date/time as ISO datetime without timezone offset.",
          },
          estimatedDuration: {
            type: "string",
            description: "New estimated duration as ISO 8601 duration.",
          },
          priority: { type: "number", description: "New priority (1-9, 0 = undefined)." },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "taskClose",
      description:
        "Mark a task as completed/done. Works on both Morgen-native and integration tasks.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The id of the task to close." },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "taskReopen",
      description:
        "Reopen a previously completed task. Works on both Morgen-native and integration tasks.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The id of the task to reopen." },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "taskDelete",
      description:
        "Permanently delete a task. This cannot be undone. Only works for Morgen-native tasks.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The id of the task to delete.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
];

/** Reset calendar cache (for testing). */
export function resetCalendarCache(): void {
  resetCalCache();
}

// ---------------------------------------------------------------------------
// Calendar/Event tool execution
// ---------------------------------------------------------------------------

async function executeCalendarRead(args: {
  start: string;
  end: string;
  includeBody?: boolean;
  calendarIds?: string[];
}): Promise<string> {
  const events = await listEvents({
    start: args.start,
    end: args.end,
    calendarIds: args.calendarIds,
    includeBody: args.includeBody,
  });

  const formatted = events.map((e) => ({
    id: e.id,
    title: e.title,
    start: e.start,
    duration: e.duration,
    timeZone: e.timeZone,
    calendar: e.calendarName || e.calendarId,
    status: e.freeBusyStatus || "busy",
    ...(e.participants?.length ? { attendees: e.participants } : {}),
    ...(e.locations?.length ? { location: e.locations[0]?.name } : {}),
    ...(args.includeBody && e.description
      ? { description: e.description }
      : {}),
    ...(e.showWithoutTime ? { allDay: true } : {}),
  }));

  return JSON.stringify(formatted);
}

async function executeCalendarList(): Promise<string> {
  const calendars = await listCalendars();
  const formatted = calendars.map((c) => ({
    id: c.id,
    name: c.name,
    accountId: c.accountId,
    color: c.color,
    canWrite: c.myRights?.mayWrite || c.myRights?.mayWriteAll || false,
  }));
  return JSON.stringify(formatted);
}

async function executeEventCreate(args: {
  calendarId?: string;
  summary: string;
  start: string;
  end: string;
  timeZone: string;
  isAllDay?: boolean;
  attendees?: string;
  taskId?: string;
  alerts?: string;
}): Promise<string> {
  const calendars = await listCalendars();
  const cal = args.calendarId
    ? calendars.find((c) => c.id === args.calendarId)
    : calendars.find((c) => c.myRights?.mayWrite || c.myRights?.mayWriteAll);

  if (!cal) {
    return JSON.stringify({ error: "Calendar not found or not writable" });
  }

  // Compute duration from start/end
  const startDate = new Date(args.start);
  const endDate = new Date(args.end);
  const durationMs = endDate.getTime() - startDate.getTime();
  const durationMins = Math.round(durationMs / 60000);
  const hours = Math.floor(durationMins / 60);
  const mins = durationMins % 60;
  const duration =
    hours > 0 ? `PT${hours}H${mins > 0 ? mins + "M" : ""}` : `PT${mins}M`;

  const body: Record<string, unknown> = {
    accountId: cal.accountId,
    calendarId: cal.id,
    title: args.summary,
    start: args.start,
    duration,
    timeZone: args.timeZone,
    showWithoutTime: args.isAllDay ?? false,
  };

  const participants = participantsFromCsv(args.attendees);
  if (participants) body.participants = participants;

  const alerts = buildAlerts(args.alerts);
  if (alerts) body.alerts = alerts;

  if (args.taskId) {
    body["morgen.so:metadata"] = {
      taskId: args.taskId,
      isAutoScheduled: true,
    };
  }

  const id = await createEvent(body as any);
  return JSON.stringify({ success: true, id });
}

async function executeEventUpdate(args: {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  isAllDay?: boolean;
  alerts?: string;
}): Promise<string> {
  const body: Record<string, unknown> = { id: args.id };
  if (args.summary) body.title = args.summary;
  if (args.description) body.description = args.description;
  if (args.location) body.locations = buildLocations(args.location);
  if (args.start) body.start = args.start;
  if (args.start && args.end) {
    const durationMs =
      new Date(args.end).getTime() - new Date(args.start).getTime();
    const mins = Math.round(durationMs / 60000);
    const hours = Math.floor(mins / 60);
    const m = mins % 60;
    body.duration =
      hours > 0 ? `PT${hours}H${m > 0 ? m + "M" : ""}` : `PT${m}M`;
  }
  if (args.isAllDay !== undefined) body.showWithoutTime = args.isAllDay;
  const alerts = buildAlerts(args.alerts);
  if (alerts) body.alerts = alerts;

  await updateEvent(body);
  return JSON.stringify({ success: true });
}

async function executeEventDelete(args: { id: string }): Promise<string> {
  await deleteEvent(args.id);
  return JSON.stringify({ success: true });
}

// ---------------------------------------------------------------------------
// Task execution
// ---------------------------------------------------------------------------

async function executeTaskList(args: {
  allAccounts?: boolean;
  limit?: number;
}): Promise<string> {
  const tasks = args.allAccounts
    ? await listAllTasks({ limit: args.limit })
    : await listTasks({ limit: args.limit });

  const formatted = tasks.map((t: MorgenTask) => ({
    id: t.id,
    title: t.title,
    ...(t.description ? { description: t.description } : {}),
    ...(t.due ? { due: t.due } : {}),
    ...(t.estimatedDuration ? { estimatedDuration: t.estimatedDuration } : {}),
    ...(t.priority && t.priority > 0 ? { priority: t.priority } : {}),
    progress: t.progress || "needs-action",
    ...(t.tags?.length ? { tags: t.tags } : {}),
  }));

  return JSON.stringify(formatted);
}

async function executeTaskCreate(args: {
  title: string;
  description?: string;
  due?: string;
  estimatedDuration?: string;
  priority?: number;
}): Promise<string> {
  const id = await createTask({
    title: args.title,
    ...(args.description ? { description: args.description } : {}),
    ...(args.due ? { due: args.due } : {}),
    ...(args.estimatedDuration
      ? { estimatedDuration: args.estimatedDuration }
      : {}),
    ...(args.priority ? { priority: args.priority } : {}),
  });

  return JSON.stringify({ success: true, id });
}

async function executeTaskUpdate(args: {
  id: string;
  title?: string;
  description?: string;
  due?: string;
  estimatedDuration?: string;
  priority?: number;
}): Promise<string> {
  await updateTask({
    id: args.id,
    ...(args.title ? { title: args.title } : {}),
    ...(args.description ? { description: args.description } : {}),
    ...(args.due ? { due: args.due } : {}),
    ...(args.estimatedDuration
      ? { estimatedDuration: args.estimatedDuration }
      : {}),
    ...(args.priority !== undefined ? { priority: args.priority } : {}),
  });

  return JSON.stringify({ success: true });
}

async function executeTaskClose(args: { id: string }): Promise<string> {
  await closeTask(args.id);
  return JSON.stringify({ success: true });
}

async function executeTaskReopen(args: { id: string }): Promise<string> {
  await reopenTask(args.id);
  return JSON.stringify({ success: true });
}

async function executeTaskDelete(args: { id: string }): Promise<string> {
  const { deletedEventIds } = await deleteTask(args.id);
  return JSON.stringify({ success: true, deletedEventIds });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Execute a tool call by name with the given JSON arguments.
 * Returns a JSON string result for the AI to consume.
 */
export async function executeTool(
  name: string,
  argsJson: string
): Promise<string> {
  const args = argsJson ? JSON.parse(argsJson) : {};

  switch (name) {
    case "calendarRead":
      return executeCalendarRead(args);
    case "calendarList":
      return executeCalendarList();
    case "eventCreate":
      return executeEventCreate(args);
    case "eventUpdate":
      return executeEventUpdate(args);
    case "eventDelete":
      return executeEventDelete(args);
    case "taskList":
      return executeTaskList(args);
    case "taskCreate":
      return executeTaskCreate(args);
    case "taskUpdate":
      return executeTaskUpdate(args);
    case "taskClose":
      return executeTaskClose(args);
    case "taskReopen":
      return executeTaskReopen(args);
    case "taskDelete":
      return executeTaskDelete(args);
    default:
      return JSON.stringify({
        error: `Tool "${name}" is not available in CLI mode.`,
      });
  }
}
