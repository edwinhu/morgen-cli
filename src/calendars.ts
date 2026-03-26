/**
 * Calendars & Events Module
 *
 * Calendar and event operations via the Morgen API (api.morgen.so/v3).
 */

import { morgenFetch } from "./morgen-api";
import type {
  MorgenCalendar,
  MorgenEvent,
  CalendarListApiResponse,
  EventListResponse,
  CreateEventInput,
} from "./types";
import { convertToTimezone } from "./time";

// ---------------------------------------------------------------------------
// Calendar cache (avoids repeated /calendars/list calls within one session)
// ---------------------------------------------------------------------------

let cachedCalendars: MorgenCalendar[] | null = null;

export async function listCalendars(): Promise<MorgenCalendar[]> {
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
// Event ID decoding
// ---------------------------------------------------------------------------

/**
 * Decode a Morgen event ID to extract calendarId and accountId.
 * Event IDs are base64-encoded JSON arrays: [calendarId, eventId, accountId]
 */
export function decodeEventId(id: string): {
  calendarId: string;
  eventId: string;
  accountId: string;
} | null {
  try {
    const decoded = atob(id);
    const parsed = JSON.parse(decoded);
    if (Array.isArray(parsed) && parsed.length >= 3) {
      return {
        calendarId: parsed[0],
        eventId: parsed[1],
        accountId: parsed[2],
      };
    }
  } catch {
    // Not a base64-encoded JSON array
  }
  return null;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface ListEventsOptions {
  start: string;
  end: string;
  calendarIds?: string[];
  includeBody?: boolean;
}

function buildTimeParams(options: ListEventsOptions): { startParam: string; endParam: string } {
  const startParam = options.start.includes("T")
    ? options.start + (options.start.includes("Z") ? "" : "Z")
    : options.start + "T00:00:00Z";
  const endParam = options.end.includes("T")
    ? options.end + (options.end.includes("Z") ? "" : "Z")
    : options.end + "T23:59:59Z";
  return { startParam, endParam };
}

export async function listEvents(
  options: ListEventsOptions
): Promise<(MorgenEvent & { calendarName?: string })[]> {
  const calendars = await listCalendars();

  // Filter calendars if specific IDs provided
  const filteredCals = options.calendarIds
    ? calendars.filter((c) => options.calendarIds!.includes(c.id))
    : calendars;

  // Group calendars by accountId
  const byAccount = new Map<string, string[]>();
  for (const cal of filteredCals) {
    const ids = byAccount.get(cal.accountId) || [];
    ids.push(cal.id);
    byAccount.set(cal.accountId, ids);
  }

  const { startParam, endParam } = buildTimeParams(options);

  // Query events for each account in parallel
  const allEvents: MorgenEvent[] = [];
  const queries = [...byAccount.entries()].map(
    async ([accountId, calendarIds]) => {
      const resp = await morgenFetch<EventListResponse>("/events/list", {
        params: {
          accountId,
          calendarIds: calendarIds.join(","),
          start: startParam,
          end: endParam,
        },
      });
      allEvents.push(...resp.data.events);
    }
  );
  await Promise.all(queries);

  // Sort by start time
  allEvents.sort((a, b) => a.start.localeCompare(b.start));

  // Add calendar name for context
  const calMap = new Map(calendars.map((c) => [c.id, c.name]));
  return allEvents.map((e) => ({
    ...e,
    calendarName: calMap.get(e.calendarId),
  }));
}

/**
 * Stream events per account: calls onBatch as each account's response arrives,
 * without waiting for all accounts. Events within a batch are in API order;
 * no cross-account sorting is performed.
 */
export async function streamEvents(
  options: ListEventsOptions,
  onBatch: (events: (MorgenEvent & { calendarName?: string })[]) => void
): Promise<void> {
  const calendars = await listCalendars();
  const calMap = new Map(calendars.map((c) => [c.id, c.name]));

  const filteredCals = options.calendarIds
    ? calendars.filter((c) => options.calendarIds!.includes(c.id))
    : calendars;

  const byAccount = new Map<string, string[]>();
  for (const cal of filteredCals) {
    const ids = byAccount.get(cal.accountId) || [];
    ids.push(cal.id);
    byAccount.set(cal.accountId, ids);
  }

  const { startParam, endParam } = buildTimeParams(options);

  await Promise.all(
    [...byAccount.entries()].map(async ([accountId, calendarIds]) => {
      const resp = await morgenFetch<EventListResponse>("/events/list", {
        params: {
          accountId,
          calendarIds: calendarIds.join(","),
          start: startParam,
          end: endParam,
        },
      });
      const batch = resp.data.events.map((e) => ({
        ...e,
        calendarName: calMap.get(e.calendarId),
      }));
      if (batch.length > 0) onBatch(batch);
    })
  );
}

export async function createEvent(input: CreateEventInput): Promise<string> {
  const resp = await morgenFetch<{ data: { event: { id: string } } }>("/events/create", {
    method: "POST",
    body: input,
  });
  return resp.data.event.id;
}

export async function updateEvent(
  input: Record<string, unknown>
): Promise<void> {
  const body = { ...input };
  // Decode accountId and calendarId from event ID if not already provided
  if (body.id && !body.accountId) {
    const decoded = decodeEventId(body.id as string);
    if (decoded) {
      body.accountId = decoded.accountId;
      body.calendarId = decoded.calendarId;
    }
  }
  await morgenFetch<void>("/events/update", { method: "POST", body });
}

export async function deleteEvent(id: string): Promise<void> {
  const body: Record<string, string> = { id };
  // Decode accountId and calendarId from event ID
  const decoded = decodeEventId(id);
  if (decoded) {
    body.accountId = decoded.accountId;
    body.calendarId = decoded.calendarId;
  }
  await morgenFetch<void>("/events/delete", {
    method: "POST",
    body,
  });
}

// ---------------------------------------------------------------------------
// Free/Busy
// ---------------------------------------------------------------------------

export interface FreeSlot {
  start: string;
  end: string;
  duration: string;
}

/**
 * Find free time slots within a given range by subtracting events.
 * Returns slots of at least `minMinutes` duration.
 */
export async function findFreeSlots(options: {
  start: string;
  end: string;
  calendarIds?: string[];
  minMinutes?: number;
  timeZone?: string;
}): Promise<FreeSlot[]> {
  const events = await listEvents({
    start: options.start,
    end: options.end,
    calendarIds: options.calendarIds,
  });

  // Filter out all-day events, only consider timed events for busy slots
  const timedEvents = events.filter(
    (e) => !e.showWithoutTime && e.freeBusyStatus !== "free"
  );

  // Convert events to busy intervals [start, end] in ms
  const busyIntervals: [number, number][] = timedEvents.map((e) => {
    const startMs = new Date(e.start).getTime();
    const durationMs = parseDurationToMs(e.duration);
    return [startMs, startMs + durationMs];
  });

  // Sort and merge overlapping intervals
  busyIntervals.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const interval of busyIntervals) {
    if (merged.length > 0 && interval[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(
        merged[merged.length - 1][1],
        interval[1]
      );
    } else {
      merged.push([...interval]);
    }
  }

  // Find free slots between busy intervals
  const rangeStart = new Date(options.start).getTime();
  const rangeEnd = new Date(options.end).getTime();
  const minMs = (options.minMinutes ?? 30) * 60 * 1000;

  // Format timestamps: if timezone requested, convert; otherwise floating UTC
  const formatTime = (ms: number): string => {
    if (options.timeZone) {
      // Convert UTC ms to target timezone with offset
      const utcIso = new Date(ms).toISOString().replace(/\.000Z$/, "").replace(/Z$/, "");
      return convertToTimezone(utcIso, "UTC", options.timeZone);
    }
    return new Date(ms).toISOString().replace(/\.000Z$/, "").replace(/Z$/, "");
  };

  const freeSlots: FreeSlot[] = [];
  let cursor = rangeStart;

  for (const [busyStart, busyEnd] of merged) {
    if (busyStart > cursor) {
      const gap = busyStart - cursor;
      if (gap >= minMs) {
        freeSlots.push({
          start: formatTime(cursor),
          end: formatTime(busyStart),
          duration: formatDuration(gap),
        });
      }
    }
    cursor = Math.max(cursor, busyEnd);
  }

  // Check gap after last event
  if (rangeEnd > cursor) {
    const gap = rangeEnd - cursor;
    if (gap >= minMs) {
      freeSlots.push({
        start: formatTime(cursor),
        end: formatTime(rangeEnd),
        duration: formatDuration(gap),
      });
    }
  }

  return freeSlots;
}

// ---------------------------------------------------------------------------
// Duration helpers
// ---------------------------------------------------------------------------

function parseDurationToMs(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || "0");
  const mins = parseInt(match[2] || "0");
  const secs = parseInt(match[3] || "0");
  return (hours * 3600 + mins * 60 + secs) * 1000;
}

function formatDuration(ms: number): string {
  const totalMins = Math.round(ms / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours > 0 && mins > 0) return `${hours}h${mins}m`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}
