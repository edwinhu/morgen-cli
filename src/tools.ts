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
import type {
  MorgenCalendar,
  MorgenEvent,
  CalendarListApiResponse,
  EventListResponse,
} from "./types";

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
];

// ---------------------------------------------------------------------------
// Calendar cache (avoids repeated /calendars/list calls within one session)
// ---------------------------------------------------------------------------

let cachedCalendars: MorgenCalendar[] | null = null;

async function getCalendars(): Promise<MorgenCalendar[]> {
  if (cachedCalendars) return cachedCalendars;
  const resp = await morgenFetch<CalendarListApiResponse>("/calendars/list");
  cachedCalendars = resp.data.calendars;
  return cachedCalendars;
}

/** Reset calendar cache (for testing). */
export function resetCalendarCache(): void {
  cachedCalendars = null;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeCalendarRead(args: {
  start: string;
  end: string;
  includeBody?: boolean;
}): Promise<string> {
  const calendars = await getCalendars();

  // Group calendars by accountId
  const byAccount = new Map<string, string[]>();
  for (const cal of calendars) {
    const ids = byAccount.get(cal.accountId) || [];
    ids.push(cal.id);
    byAccount.set(cal.accountId, ids);
  }

  // Query events for each account in parallel
  const allEvents: MorgenEvent[] = [];
  const queries = [...byAccount.entries()].map(
    async ([accountId, calendarIds]) => {
      const resp = await morgenFetch<EventListResponse>("/events/list", {
        params: {
          accountId,
          calendarIds: calendarIds.join(","),
          start: args.start.includes("T")
            ? args.start + (args.start.includes("Z") ? "" : "Z")
            : args.start + "T00:00:00Z",
          end: args.end.includes("T")
            ? args.end + (args.end.includes("Z") ? "" : "Z")
            : args.end + "T23:59:59Z",
        },
      });
      allEvents.push(...resp.data.events);
    }
  );
  await Promise.all(queries);

  // Sort by start time
  allEvents.sort((a, b) => a.start.localeCompare(b.start));

  // Format response — include calendar name for context
  const calMap = new Map(calendars.map((c) => [c.id, c.name]));
  const formatted = allEvents.map((e) => ({
    id: e.id,
    title: e.title,
    start: e.start,
    duration: e.duration,
    timeZone: e.timeZone,
    calendar: calMap.get(e.calendarId) || e.calendarId,
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
  const calendars = await getCalendars();
  const formatted = calendars.map((c) => ({
    id: c.id,
    name: c.name,
    accountId: c.accountId,
    color: c.color,
    canWrite: c.myRights?.mayWrite ?? false,
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
}): Promise<string> {
  // Find the accountId for the given calendarId
  const calendars = await getCalendars();
  const cal = args.calendarId
    ? calendars.find((c) => c.id === args.calendarId)
    : calendars.find((c) => c.myRights?.mayWrite); // default to first writable

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

  if (args.attendees) {
    body.participants = args.attendees.split(",").map((email) => ({
      email: email.trim(),
    }));
  }

  const resp = await morgenFetch<{ data: { id: string } }>("/events/create", {
    method: "POST",
    body,
  });

  return JSON.stringify({ success: true, id: resp.data.id });
}

async function executeEventUpdate(args: {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  isAllDay?: boolean;
}): Promise<string> {
  const body: Record<string, unknown> = { id: args.id };
  if (args.summary) body.title = args.summary;
  if (args.description) body.description = args.description;
  if (args.location) body.locations = [{ name: args.location }];
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

  await morgenFetch<void>("/events/update", { method: "POST", body });
  return JSON.stringify({ success: true });
}

async function executeEventDelete(args: { id: string }): Promise<string> {
  await morgenFetch<void>("/events/delete", {
    method: "POST",
    body: { id: args.id },
  });
  return JSON.stringify({ success: true });
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
    default:
      return JSON.stringify({
        error: `Tool "${name}" is not available in CLI mode.`,
      });
  }
}
