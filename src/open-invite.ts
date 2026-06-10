/**
 * Open Invites Module
 *
 * Create / list / delete Morgen "Open Invites" — one-off, time-boxed booking links that offer an
 * invitee specific proposed time windows for a 1:1. Unlike recurring booking pages, these are
 * `type: "one-time-link"` scheduling links.
 *
 * Open Invites are Firestore documents under `users/{uid}/schedulingLinks` in the Firebase
 * project `morgen-d34db` (NOT a REST resource on api.morgen.so). The shareable id is minted
 * client-side. See docs/investigations/2026-06-10_open-invites.md.
 */

import { getFirebaseSession, FIREBASE_PROJECT_ID } from "./morgen-firebase";
import { listCalendars } from "./calendars";
import type { MorgenCalendar } from "./types";

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const SCHEDULER_BASE = "https://api.morgen.so/scheduler";
export const BOOKING_BASE = "https://book.morgen.so";

// ---------------------------------------------------------------------------
// Firestore value helpers (typed JSON <-> Firestore "Value" encoding)
// ---------------------------------------------------------------------------

type FsValue = Record<string, unknown>;

const fs = {
  str: (v: string): FsValue => ({ stringValue: v }),
  int: (v: number): FsValue => ({ integerValue: String(v) }),
  bool: (v: boolean): FsValue => ({ booleanValue: v }),
  nil: (): FsValue => ({ nullValue: null }),
  arr: (vals: FsValue[]): FsValue => ({ arrayValue: vals.length ? { values: vals } : {} }),
  map: (fields: Record<string, FsValue>): FsValue => ({ mapValue: { fields } }),
};

/** Decode a single Firestore Value back to a plain JS value. */
function decodeValue(v: any): unknown {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return parseInt(v.integerValue, 10);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in v) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = decodeValue(val);
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// IDs minted client-side (mirrors the app's generateBookingHref/HrefShort)
// ---------------------------------------------------------------------------

const HREF_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SHORT_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomFrom(alphabet: string, length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

/** 15 url-safe chars + trailing "-", matching observed real hrefs. */
function generateHref(): string {
  return randomFrom(HREF_ALPHABET, 15) + "-";
}

function generateHrefShort(): string {
  return randomFrom(SHORT_ALPHABET, 6);
}

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface OpenInviteSlot {
  start: string; // ISO
  end: string; // ISO
}

/**
 * Video conferencing to attach to the booked meeting:
 *   - "auto"       (default) attach the personal meeting room if one exists, else none
 *   - "room"       attach a personal meeting room (your static Zoom/etc.); see `room`
 *   - "google-meet" auto-create a Google Meet per booking (Google-hosted calendar)
 *   - "teams"      auto-create a Teams meeting per booking (Microsoft-hosted calendar)
 *   - "none"       no conferencing link
 */
export type Conferencing = "auto" | "room" | "google-meet" | "teams" | "none";

export interface CreateOpenInviteInput {
  /** Proposed availability windows the invitee chooses from. */
  slots: OpenInviteSlot[];
  title?: string;
  description?: string;
  location?: string;
  /** Meeting length in minutes the invitee books. Default 30. */
  duration?: number;
  /** Calendar name (partial match) to host the booked event on. Default: writable default. */
  calendar?: string;
  /** IANA timezone for predefinedSlots. Default America/New_York. */
  timeZone?: string;
  /** If true, do not also check live calendar availability (just offer the windows). */
  disableAvailabilityCheck?: boolean;
  /** Video conferencing to attach. Default "auto". */
  conferencing?: Conferencing;
  /** Personal meeting room name (partial match) when more than one exists. */
  room?: string;
  port?: number;
}

export interface OpenInvite {
  href: string;
  hrefShort: string;
  link: string;
  providerId: string;
  id: string;
  type: string;
  title?: string;
  durations: number[];
  timeZone?: string;
  slots: string[]; // "startISO/endISO" windows
  conferencing?: string; // human-readable conferencing label, if attached
}

/** A Morgen personal meeting room (static conferencing URL, e.g. a personal Zoom room). */
export interface MeetingRoom {
  id: string; // providerId (e.g. "<uuid>@morgen.so")
  displayName: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Calendar selection -> target fields
// ---------------------------------------------------------------------------

interface CalendarTarget {
  targetCalendar: string;
  targetAccount: string;
  organizerAccountEmail: string;
  calendarName: string;
}

function pickCalendar(calendars: MorgenCalendar[], name?: string): MorgenCalendar {
  const writable = calendars.filter((c) => c.myRights?.mayWriteAll || c.myRights?.mayWriteOwn);
  const first = writable[0];
  if (!first) {
    throw new Error("No writable calendar found to host the Open Invite.");
  }
  if (name) {
    const lower = name.toLowerCase();
    const match = writable.find((c) => c.name.toLowerCase().includes(lower));
    if (!match) {
      throw new Error(
        `No writable calendar matching "${name}". Available: ${writable.map((c) => c.name).join(", ")}`
      );
    }
    return match;
  }
  // Prefer the provider's default calendar, else first writable.
  return writable.find((c) => c.isDefault) || first;
}

async function resolveTarget(name?: string): Promise<CalendarTarget> {
  const calendars = await listCalendars();
  const cal = pickCalendar(calendars, name);
  const ownedBy = (cal as any).ownedBy as { email?: string } | undefined;
  return {
    targetCalendar: cal.id,
    targetAccount: cal.accountId,
    organizerAccountEmail: ownedBy?.email || "",
    calendarName: cal.name,
  };
}

// ---------------------------------------------------------------------------
// Firestore document builder
// ---------------------------------------------------------------------------

function buildBookingOptions(
  input: CreateOpenInviteInput,
  target: CalendarTarget,
  timeZone: string,
  duration: number,
  virtualRoom: FsValue | null
): FsValue {
  const slotStrings = input.slots.map((s) => fs.str(`${toUtcZ(s.start)}/${toUtcZ(s.end)}`));
  const fields: Record<string, FsValue> = {
    durations: fs.arr([fs.int(duration)]),
    minNotice: fs.int(60),
    futureLimit: fs.int(40320),
    buffer: fs.int(0),
    stride: fs.int(0),
    startGranularity: fs.int(15),
    targetCalendar: fs.str(target.targetCalendar),
    targetAccount: fs.str(target.targetAccount),
    organizerAccountEmail: fs.str(target.organizerAccountEmail),
    disableAvailabilityCheck: fs.bool(!!input.disableAvailabilityCheck),
    recurrent: fs.bool(false),
    predefinedSlotsTimezone: fs.str(timeZone),
    predefinedSlots: fs.arr(slotStrings),
    customQuestions: fs.arr([]),
    reminders: fs.map({
      useDefault: fs.bool(false),
      overrides: fs.arr([
        fs.map({
          method: fs.str("email"),
          recipients: fs.str("organizerAndInvitee"),
          minutes: fs.int(10),
        }),
      ]),
    }),
  };
  if (virtualRoom) fields.virtualRoom = virtualRoom;
  return fs.map(fields);
}

/** Normalize an ISO string to UTC with a trailing Z (Firestore stores window strings in UTC). */
function toUtcZ(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) throw new Error(`Invalid slot time: ${iso}`);
  // Format without milliseconds, matching the app's predefinedSlots format.
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Firestore REST calls
// ---------------------------------------------------------------------------

async function firestoreCommit(idToken: string, write: object): Promise<void> {
  const resp = await fetch(`${FIRESTORE_BASE}:commit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ writes: [write] }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Firestore commit failed (${resp.status}): ${body.slice(0, 300)}`);
  }
}

async function firestoreList(
  idToken: string,
  uid: string,
  collection = "schedulingLinks"
): Promise<any[]> {
  const resp = await fetch(
    `${FIRESTORE_BASE}/users/${uid}/${collection}?pageSize=200`,
    { headers: { Authorization: `Bearer ${idToken}` } }
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Firestore list failed (${resp.status}): ${body.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { documents?: any[] };
  return data.documents || [];
}

/** Fetch the user's personal meeting rooms (static conferencing URLs). */
async function fetchRooms(idToken: string, uid: string): Promise<MeetingRoom[]> {
  const docs = await firestoreList(idToken, uid, "rooms");
  const rooms: MeetingRoom[] = [];
  for (const doc of docs) {
    const f = doc.fields || {};
    if ((decodeValue(f.mtInternalSync) as string | null) === "deleted") continue;
    const url = decodeValue(f.url) as string | null;
    const providerId = decodeValue(f.providerId) as string | null;
    if (!url || !providerId) continue;
    rooms.push({
      id: providerId,
      displayName: (decodeValue(f.displayName) as string) || "Meeting Room",
      url,
    });
  }
  return rooms;
}

/**
 * Resolve the `bookingOptions.virtualRoom` value (and a human label) for the requested
 * conferencing mode. Returns null when no conferencing should be attached.
 *
 * Shapes mirror the Morgen app's scheduling editor:
 *   personal room → { serviceName: "morgen", accountId/meetingId: <room id>, meetingUrl }
 *   Google Meet   → { serviceName: "googleMeet", accountId: "google::<acct>", meetingId/Url: null }
 *   Teams         → { serviceName: "teams", accountId: "o365::<acct>", meetingId/Url: null }
 */
async function resolveVirtualRoom(
  input: CreateOpenInviteInput,
  target: CalendarTarget,
  idToken: string,
  uid: string
): Promise<{ value: FsValue; label: string } | null> {
  const mode: Conferencing = input.conferencing || "auto";
  if (mode === "none") return null;

  if (mode === "google-meet") {
    return {
      value: fs.map({
        serviceName: fs.str("googleMeet"),
        accountId: fs.str(`google::${target.targetAccount}`),
        meetingId: fs.nil(),
        meetingUrl: fs.nil(),
      }),
      label: "Google Meet (auto-created per booking)",
    };
  }
  if (mode === "teams") {
    return {
      value: fs.map({
        serviceName: fs.str("teams"),
        accountId: fs.str(`o365::${target.targetAccount}`),
        meetingId: fs.nil(),
        meetingUrl: fs.nil(),
      }),
      label: "Microsoft Teams (auto-created per booking)",
    };
  }

  // "room" or "auto" → personal meeting room.
  const rooms = await fetchRooms(idToken, uid);
  if (rooms.length === 0) {
    if (mode === "room") {
      throw new Error("No personal meeting room found. Add one in Morgen, or use --conferencing none.");
    }
    return null; // auto: nothing to attach
  }
  let room: MeetingRoom | undefined;
  if (input.room) {
    const lower = input.room.toLowerCase();
    room = rooms.find((r) => r.displayName.toLowerCase().includes(lower));
    if (!room) {
      throw new Error(
        `No meeting room matching "${input.room}". Available: ${rooms.map((r) => r.displayName).join(", ")}`
      );
    }
  } else {
    room = rooms[0];
  }
  return {
    value: fs.map({
      serviceName: fs.str("morgen"),
      accountId: fs.str(room!.id),
      meetingId: fs.str(room!.id),
      meetingUrl: fs.str(room!.url),
    }),
    label: room!.displayName,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolve a booking link's public info (verification). Returns null on 404. */
export async function fetchBookingInfo(href: string): Promise<any | null> {
  const resp = await fetch(`${SCHEDULER_BASE}/fetchBookingInfo?href=${encodeURIComponent(href)}`);
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(`fetchBookingInfo failed (${resp.status})`);
  }
  return resp.json();
}

/** Create a one-off Open Invite and return the shareable link. */
export async function createOpenInvite(input: CreateOpenInviteInput): Promise<OpenInvite> {
  if (!input.slots || input.slots.length === 0) {
    throw new Error("At least one proposed slot window is required (--slots).");
  }
  const duration = input.duration ?? 30;
  const timeZone = input.timeZone || "America/New_York";
  const title = input.title || "Meeting";

  const session = await getFirebaseSession(input.port);
  const target = await resolveTarget(input.calendar);
  const conferencing = await resolveVirtualRoom(input, target, session.idToken, session.uid);

  const id = crypto.randomUUID();
  const providerId = `${id}@morgen.so`;
  const docId = encodeURIComponent(providerId); // "@" -> "%40"
  const href = generateHref();
  const hrefShort = generateHrefShort();
  const mtStamp = new Date().toISOString();

  const eventFields: Record<string, FsValue> = { summary: fs.str(title) };
  if (input.description) eventFields.description = fs.str(input.description);
  if (input.location) eventFields.location = fs.str(input.location);

  const fields: Record<string, FsValue> = {
    _id: fs.str(id),
    _acl: fs.arr([]),
    providerId: fs.str(providerId),
    type: fs.str("one-time-link"),
    visibility: fs.str("private"),
    bookingOptions: buildBookingOptions(input, target, timeZone, duration, conferencing?.value ?? null),
    event: fs.map(eventFields),
    attendee: fs.nil(),
    additionalAttendees: fs.arr([]),
    cohosts: fs.arr([]),
    cohostsAssignment: fs.nil(),
    bookedEvents: fs.arr([]),
    error: fs.nil(),
    isPreview: fs.bool(false),
    href: fs.str(href),
    hrefShort: fs.str(hrefShort),
    mtStamp: fs.str(mtStamp),
    mtInternalSync: fs.str("synced"),
    __v: fs.int(3),
  };

  const name = `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${session.uid}/schedulingLinks/${docId}`;
  await firestoreCommit(session.idToken, {
    update: { name, fields },
    updateTransforms: [{ fieldPath: "__stamp", setToServerValue: "REQUEST_TIME" }],
  });

  return {
    href,
    hrefShort,
    link: `${BOOKING_BASE}/${href}`,
    providerId,
    id,
    type: "one-time-link",
    title,
    durations: [duration],
    timeZone,
    slots: input.slots.map((s) => `${toUtcZ(s.start)}/${toUtcZ(s.end)}`),
    conferencing: conferencing?.label,
  };
}

/** List the user's personal meeting rooms (static conferencing URLs). */
export async function listRooms(port?: number): Promise<MeetingRoom[]> {
  const session = await getFirebaseSession(port);
  return fetchRooms(session.idToken, session.uid);
}

/** List the user's Open Invites (one-time links), excluding soft-deleted ones. */
export async function listOpenInvites(port?: number): Promise<OpenInvite[]> {
  const session = await getFirebaseSession(port);
  const docs = await firestoreList(session.idToken, session.uid);
  const out: OpenInvite[] = [];
  for (const doc of docs) {
    const f = doc.fields || {};
    const type = decodeValue(f.type) as string | null;
    const sync = decodeValue(f.mtInternalSync) as string | null;
    if (type !== "one-time-link" || sync === "deleted") continue;
    const href = (decodeValue(f.href) as string) || "";
    if (!href) continue;
    const bo = (decodeValue(f.bookingOptions) as any) || {};
    const event = (decodeValue(f.event) as any) || {};
    out.push({
      href,
      hrefShort: (decodeValue(f.hrefShort) as string) || "",
      link: `${BOOKING_BASE}/${href}`,
      providerId: (decodeValue(f.providerId) as string) || "",
      id: (decodeValue(f._id) as string) || "",
      type,
      title: event.summary,
      durations: bo.durations || [],
      timeZone: bo.predefinedSlotsTimezone,
      slots: bo.predefinedSlots || [],
      conferencing: bo.virtualRoom?.meetingUrl || bo.virtualRoom?.serviceName,
    });
  }
  return out;
}

/**
 * Delete an Open Invite by href or id. Uses Morgen's soft-delete semantics — overwrites the doc
 * to the minimal `mtInternalSync: "deleted"` shape (dropping `href`) so the public link 404s and
 * a running app agrees with the deletion rather than re-pushing it.
 */
export async function deleteOpenInvite(hrefOrId: string, port?: number): Promise<boolean> {
  const session = await getFirebaseSession(port);
  const docs = await firestoreList(session.idToken, session.uid);
  let providerId: string | null = null;
  for (const doc of docs) {
    const f = doc.fields || {};
    const href = decodeValue(f.href);
    const pid = decodeValue(f.providerId) as string | null;
    const id = decodeValue(f._id) as string | null;
    if (href === hrefOrId || pid === hrefOrId || id === hrefOrId) {
      providerId = pid || (id ? `${id}@morgen.so` : null);
      break;
    }
  }
  if (!providerId) return false;

  const docId = encodeURIComponent(providerId);
  const name = `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${session.uid}/schedulingLinks/${docId}`;
  // Full overwrite (no updateMask) => drops href/type/event, leaving the deleted shape.
  await firestoreCommit(session.idToken, {
    update: {
      name,
      fields: {
        providerId: fs.str(providerId),
        mtInternalSync: fs.str("deleted"),
        __v: fs.int(3),
      },
    },
    updateTransforms: [{ fieldPath: "__stamp", setToServerValue: "REQUEST_TIME" }],
  });
  return true;
}

/** Parse a --slots string: "startISO/endISO,startISO/endISO". */
export function parseSlots(raw: string): OpenInviteSlot[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [start, end] = pair.split("/").map((p) => p.trim());
      if (!start || !end) {
        throw new Error(`Invalid slot "${pair}". Expected "startISO/endISO".`);
      }
      return { start, end };
    });
}
