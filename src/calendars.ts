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
import { convertToTimezone, resolveToUtcMs } from "./time";

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
// JSCalendar payload helpers (participants & locations)
// ---------------------------------------------------------------------------

/**
 * Build a JSCalendar `participants` map from attendee emails.
 *
 * Morgen's API (JMAP/JSCalendar, RFC 8984) expects `participants` as a keyed
 * MAP of Participant objects — NOT an array. Sending an array (or nothing) is
 * silently dropped, so guests never get attached and no invites are sent.
 *
 * Each participant is keyed by the base64url-encoded email (matching the keys
 * Morgen itself returns) and carries `roles.attendee`, `participationStatus`,
 * and `expectReply: true` so the calendar provider (Google/O365) emails an
 * invitation to the guest.
 */
export function buildParticipants(
  emails: string[]
): Record<string, unknown> | undefined {
  const participants: Record<string, unknown> = {};
  for (const raw of emails) {
    const email = raw.trim();
    if (!email) continue;
    const key = Buffer.from(email, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    participants[key] = {
      "@type": "Participant",
      email,
      roles: { attendee: true },
      participationStatus: "needs-action",
      expectReply: true,
    };
  }
  return Object.keys(participants).length > 0 ? participants : undefined;
}

/** Split a comma-separated attendee string into a participants map. */
export function participantsFromCsv(
  csv: string | undefined
): Record<string, unknown> | undefined {
  if (!csv) return undefined;
  return buildParticipants(csv.split(","));
}

/**
 * Build a JSCalendar `locations` map from a single location string.
 *
 * The API requires `locations` to be an OBJECT (a keyed map), not a string or
 * array — sending an array 400s with "locations must be an object". Morgen
 * keys locations by a numeric string ("1"); using any other key (e.g. "loc1")
 * is accepted but silently fails to persist on Google calendars.
 */
export function buildLocations(
  location: string | undefined
): Record<string, unknown> | undefined {
  if (!location) return undefined;
  return { "1": { "@type": "Location", name: location } };
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
  // Resolve the requested window to absolute UTC instants, interpreting naive
  // wall-clock input in `timeZone`. The events carry real UTC offsets, so the
  // window MUST be resolved the same way — otherwise busy events sit outside a
  // mis-parsed range (and aren't even fetched) and their time is wrongly
  // reported free. The fetch window is driven by these same instants so the
  // API returns the events that actually overlap the requested local window.
  const rangeStart = resolveToUtcMs(options.start, options.timeZone, false);
  const rangeEnd = resolveToUtcMs(options.end, options.timeZone, true);

  const events = await listEvents({
    start: new Date(rangeStart).toISOString(),
    end: new Date(rangeEnd).toISOString(),
    calendarIds: options.calendarIds,
  });

  // Filter out all-day events, only consider timed events for busy slots
  const timedEvents = events.filter(
    (e) => !e.showWithoutTime && e.freeBusyStatus !== "free"
  );

  // Convert events to busy intervals [start, end] in ms.
  //
  // Morgen-created bookings (open-invite / scheduling-poll / task-event style)
  // come back with no end time (`end: null`) and a falsy or zero `duration`.
  // Parsing that yields a zero-width interval [start, start] that subtracts
  // nothing — so Morgen's own booked events were invisible to the free-finder
  // and their time got reported as free (the double-book bug). Treat any busy
  // timed event with no usable duration as blocking a default meeting length,
  // matching how the Morgen UI renders these bookings.
  const busyIntervals: [number, number][] = timedEvents.map((e) => {
    // e.start usually carries a UTC offset; if it's floating, interpret it in
    // the event's own timeZone so the instant is correct regardless of machine
    // locale.
    const startMs = resolveToUtcMs(e.start, e.timeZone);
    const durationMs = parseDurationToMs(e.duration) || DEFAULT_BUSY_MS;
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

  // Find free slots between busy intervals (rangeStart/rangeEnd resolved above)
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

/**
 * Default block length (ms) for a busy timed event that has no usable
 * duration / end time. One hour is a sane meeting default and ensures such
 * events still remove time from the free-finder rather than being skipped.
 */
const DEFAULT_BUSY_MS = 60 * 60 * 1000;

function parseDurationToMs(iso: string | null | undefined): number {
  if (!iso) return 0;
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
