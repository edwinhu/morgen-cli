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
  RecurrenceRule,
  NDay,
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

/**
 * Parse a single alert lead-time token (e.g. "30m", "2h", "1d", "0", "at-time")
 * into a negative ISO 8601 duration offset for a JSCalendar OffsetTrigger.
 *
 * "0" / "at-time" means fire at the event start (offset "PT0S", no minus sign).
 * Bare numbers default to minutes. Throws on unparseable input.
 */
export function parseAlertOffset(token: string): string {
  const t = token.trim().toLowerCase();
  if (t === "" ) throw new Error("Empty alert token");
  if (t === "0" || t === "at-time" || t === "attime" || t === "at") {
    return "PT0S";
  }
  const m = t.match(/^(\d+)\s*([mhd]?)$/);
  if (!m) throw new Error(`Invalid alert lead time: "${token}" (use e.g. 30m, 2h, 1d, 0)`);
  const [, rawValue = "", rawUnit = ""] = m;
  const value = parseInt(rawValue, 10);
  const unit = rawUnit || "m";
  if (value === 0) return "PT0S";
  switch (unit) {
    case "m": return `-PT${value}M`;
    case "h": return `-PT${value}H`;
    case "d": return `-P${value}D`;
    default: throw new Error(`Invalid alert unit: "${unit}"`);
  }
}

/**
 * Build a JSCalendar `alerts` map from a comma-separated lead-time spec like
 * "30m,10m,1h". Each entry becomes a display Alert with an OffsetTrigger
 * relative to the event start. Returns undefined when no spec is given.
 *
 * The map is keyed by arbitrary stable strings; Morgen re-keys alerts on read,
 * so the keys here only need to be unique within the request.
 */
export function buildAlerts(
  spec: string | undefined
): Record<string, unknown> | undefined {
  if (!spec) return undefined;
  const tokens = spec.split(",").map((s) => s.trim()).filter(Boolean);
  if (tokens.length === 0) return undefined;
  const alerts: Record<string, unknown> = {};
  tokens.forEach((token, i) => {
    const offset = parseAlertOffset(token);
    alerts[`alert${i + 1}`] = {
      "@type": "Alert",
      action: "display",
      trigger: {
        "@type": "OffsetTrigger",
        offset,
        relativeTo: "start",
      },
    };
  });
  return alerts;
}

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

/** Input for {@link buildRecurrenceRules} — the recurrence CLI flags, verbatim. */
export interface RecurrenceSpec {
  /** RFC 5545 RRULE body, e.g. "FREQ=WEEKLY;BYDAY=MO". Exclusive with `repeat`. */
  rrule?: string;
  /** Sugar form: daily｜weekly｜monthly｜yearly｜weekdays, weekly:MO,WE or monthly:15. */
  repeat?: string;
  interval?: string | number;
  /** YYYY-MM-DD (expands to end of day) or a full LocalDateTime. Exclusive with `count`. */
  until?: string;
  count?: string | number;
  /** Event start as a floating LocalDateTime; supplies the weekday for a bare `weekly`. */
  start?: string;
  /** Event timeZone; a Z-suffixed RRULE UNTIL is converted into it. */
  timeZone?: string;
}

const WEEKDAY_CODES = ["su", "mo", "tu", "we", "th", "fr", "sa"] as const;
const FREQUENCIES = ["daily", "weekly", "monthly", "yearly"] as const;
type Frequency = (typeof FREQUENCIES)[number];

function asFrequency(raw: string, label: string): Frequency {
  const f = raw.trim().toLowerCase();
  if ((FREQUENCIES as readonly string[]).includes(f)) return f as Frequency;
  throw new Error(
    `Invalid ${label}: "${raw}" (use daily, weekly, monthly or yearly)`
  );
}

/** Parse an RFC 5545 BYDAY token ("MO", "2MO", "-1FR") into a JSCalendar NDay. */
function parseNDay(token: string): NDay {
  const t = token.trim();
  const m = t.match(/^([+-]?\d+)?([A-Za-z]{2})$/);
  const day = m?.[2]?.toLowerCase();
  if (!m || !day || !(WEEKDAY_CODES as readonly string[]).includes(day)) {
    throw new Error(
      `Invalid weekday token: "${token}" (use MO, TU, WE, TH, FR, SA or SU)`
    );
  }
  const nday: NDay = { "@type": "NDay", day };
  if (m[1] !== undefined) nday.nthOfPeriod = parseInt(m[1], 10);
  return nday;
}

function parseNDayList(csv: string): NDay[] {
  const tokens = csv.split(",").map((s) => s.trim()).filter(Boolean);
  if (tokens.length === 0) throw new Error(`Invalid weekday token: "${csv}"`);
  return tokens.map(parseNDay);
}

function parseIntervalValue(raw: string | number): number {
  const n = typeof raw === "number" ? raw : parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid interval: "${raw}" (must be a whole number >= 1)`);
  }
  return n;
}

function parseCountValue(raw: string | number): number {
  const n = typeof raw === "number" ? raw : parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid count: "${raw}" (must be a whole number >= 1)`);
  }
  return n;
}

function parseIntList(csv: string, label: string): number[] {
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = parseInt(s, 10);
      if (!Number.isFinite(n) || String(n) !== s.replace(/^\+/, "")) {
        throw new Error(`Invalid ${label} value: "${s}"`);
      }
      return n;
    });
}

/**
 * Normalise an UNTIL value to a JSCalendar LocalDateTime in `timeZone`.
 *
 * Accepts the RFC 5545 basic forms (20261130T235959Z, 20261130) and extended
 * ISO forms (2026-11-30T23:59:59Z, 2026-11-30). A date with no time expands to
 * end of day. A trailing `Z` marks a UTC instant, which is converted into the
 * event's timezone — JSCalendar's `until` is local to the event, not UTC.
 */
function normalizeUntil(raw: string, timeZone: string | undefined): string {
  const trimmed = raw.trim();
  const isUtc = /Z$/i.test(trimmed);
  const body = isUtc ? trimmed.slice(0, -1) : trimmed;

  let local: string;
  let m: RegExpMatchArray | null;
  if ((m = body.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/))) {
    local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  } else if ((m = body.match(/^(\d{4})(\d{2})(\d{2})$/))) {
    local = `${m[1]}-${m[2]}-${m[3]}T23:59:59`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(body)) {
    local = `${body}T23:59:59`;
  } else if ((m = body.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/))) {
    local = `${m[1]}${m[2] ?? ":00"}`;
  } else {
    throw new Error(
      `Invalid until value: "${raw}" (use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS)`
    );
  }

  if (isUtc && timeZone && timeZone !== "UTC") {
    // convertToTimezone returns an offset-qualified ISO string; JSCalendar
    // wants the bare LocalDateTime, so drop the offset.
    return convertToTimezone(local, "UTC", timeZone).slice(0, 19);
  }
  return local;
}

/** Weekday code ("mo") of a floating LocalDateTime's date part. */
function weekdayOf(localDateTime: string): string | undefined {
  const date = localDateTime.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return undefined;
  return WEEKDAY_CODES[new Date(ms).getUTCDay()];
}

interface RuleParts {
  frequency: Frequency;
  interval?: number;
  count?: number;
  until?: string;
  byDay?: NDay[];
  byMonthDay?: number[];
  byMonth?: string[];
  bySetPosition?: number[];
  firstDayOfWeek?: string;
}

/** Assemble a RecurrenceRule with a stable key order, so equal specs serialise identically. */
function assembleRule(parts: RuleParts): RecurrenceRule {
  const rule: RecurrenceRule = {
    "@type": "RecurrenceRule",
    frequency: parts.frequency,
    interval: parts.interval ?? 1,
  };
  if (parts.count !== undefined) rule.count = parts.count;
  if (parts.until !== undefined) rule.until = parts.until;
  if (parts.byDay) rule.byDay = parts.byDay;
  if (parts.byMonthDay) rule.byMonthDay = parts.byMonthDay;
  if (parts.byMonth) rule.byMonth = parts.byMonth;
  if (parts.bySetPosition) rule.bySetPosition = parts.bySetPosition;
  if (parts.firstDayOfWeek) rule.firstDayOfWeek = parts.firstDayOfWeek;
  return rule;
}

/**
 * Parse an RFC 5545 RRULE body into a JSCalendar RecurrenceRule.
 *
 * `timeZone` is the event's timezone: a Z-suffixed UNTIL is an absolute UTC
 * instant in RFC 5545, but JSCalendar's `until` is a LocalDateTime in the
 * event's timezone, so it is converted.
 */
export function parseRrule(rrule: string, timeZone: string): RecurrenceRule {
  const fields = new Map<string, string>();
  for (const chunk of rrule.split(";")) {
    const part = chunk.trim();
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) throw new Error(`Invalid RRULE part: "${part}" (expected KEY=VALUE)`);
    fields.set(part.slice(0, eq).trim().toUpperCase(), part.slice(eq + 1).trim());
  }

  const freq = fields.get("FREQ");
  if (!freq) throw new Error(`Invalid RRULE: missing FREQ in "${rrule}"`);
  const parts: RuleParts = { frequency: asFrequency(freq, "RRULE FREQ") };

  if (fields.has("UNTIL") && fields.has("COUNT")) {
    throw new Error("Invalid RRULE: UNTIL and COUNT cannot both be set");
  }

  const interval = fields.get("INTERVAL");
  if (interval !== undefined) parts.interval = parseIntervalValue(interval);

  const count = fields.get("COUNT");
  if (count !== undefined) parts.count = parseCountValue(count);

  const until = fields.get("UNTIL");
  if (until !== undefined) parts.until = normalizeUntil(until, timeZone);

  const byDay = fields.get("BYDAY");
  if (byDay !== undefined) parts.byDay = parseNDayList(byDay);

  const byMonthDay = fields.get("BYMONTHDAY");
  if (byMonthDay !== undefined) {
    parts.byMonthDay = parseIntList(byMonthDay, "BYMONTHDAY");
  }

  const byMonth = fields.get("BYMONTH");
  if (byMonth !== undefined) {
    parts.byMonth = parseIntList(byMonth, "BYMONTH").map((n) => String(n));
  }

  const bySetPos = fields.get("BYSETPOS");
  if (bySetPos !== undefined) {
    parts.bySetPosition = parseIntList(bySetPos, "BYSETPOS");
  }

  const wkst = fields.get("WKST");
  if (wkst !== undefined) parts.firstDayOfWeek = parseNDay(wkst).day;

  return assembleRule(parts);
}

/**
 * Build the JSCalendar `recurrenceRules` array from the recurrence CLI flags.
 *
 * Returns undefined when neither `--rrule` nor `--repeat` was given, so a
 * non-recurring create sends no recurrence field at all.
 */
export function buildRecurrenceRules(
  spec: RecurrenceSpec
): RecurrenceRule[] | undefined {
  const rrule = spec.rrule?.trim();
  const repeat = spec.repeat?.trim();

  if (rrule && repeat) {
    throw new Error(
      "Cannot combine --rrule with --repeat — use one or the other"
    );
  }
  if (spec.until !== undefined && spec.count !== undefined) {
    throw new Error(
      "Cannot combine --until with --count — RFC 5545 forbids both"
    );
  }
  if (!rrule && !repeat) return undefined;

  if (rrule) {
    const rule = parseRrule(rrule, spec.timeZone ?? "UTC");
    // Explicit flags refine the RRULE.
    if (spec.interval !== undefined) rule.interval = parseIntervalValue(spec.interval);
    if (spec.count !== undefined) {
      if (rule.until !== undefined) {
        throw new Error(
          "Cannot combine --until with --count — RFC 5545 forbids both"
        );
      }
      rule.count = parseCountValue(spec.count);
    }
    if (spec.until !== undefined) {
      if (rule.count !== undefined) {
        throw new Error(
          "Cannot combine --until with --count — RFC 5545 forbids both"
        );
      }
      rule.until = normalizeUntil(spec.until, spec.timeZone);
    }
    return [rule];
  }

  // --repeat sugar: "weekly", "weekly:MO,WE", "monthly:15", "weekdays"
  const colon = repeat!.indexOf(":");
  const head = (colon < 0 ? repeat! : repeat!.slice(0, colon)).trim().toLowerCase();
  const tail = colon < 0 ? "" : repeat!.slice(colon + 1).trim();

  let parts: RuleParts;
  if (head === "weekdays") {
    if (tail) {
      throw new Error(`Invalid --repeat: "${repeat}" (weekdays takes no argument)`);
    }
    parts = {
      frequency: "weekly",
      byDay: parseNDayList("MO,TU,WE,TH,FR"),
    };
  } else {
    const frequency = asFrequency(head, "--repeat frequency");
    parts = { frequency };
    if (frequency === "weekly") {
      if (tail) {
        parts.byDay = parseNDayList(tail);
      } else {
        const day = spec.start ? weekdayOf(spec.start) : undefined;
        if (day) parts.byDay = [{ "@type": "NDay", day }];
      }
    } else if (tail) {
      if (frequency === "monthly") {
        parts.byMonthDay = parseIntList(tail, "--repeat monthly day");
      } else {
        throw new Error(
          `Invalid --repeat: "${repeat}" (${frequency} takes no argument)`
        );
      }
    }
  }

  if (spec.interval !== undefined) parts.interval = parseIntervalValue(spec.interval);
  if (spec.count !== undefined) parts.count = parseCountValue(spec.count);
  if (spec.until !== undefined) parts.until = normalizeUntil(spec.until, spec.timeZone);

  return [assembleRule(parts)];
}

/**
 * Result of {@link applyExclusions} — which mechanism actually removed the
 * excepted occurrences, so the caller can report it rather than guess.
 */
export interface ExclusionOutcome {
  /**
   * How the occurrences were removed. Morgen rejects `recurrenceOverrides`
   * outright (400 whitelistValidation, verified live 2026-08-10), so deleting
   * each occurrence is the only mechanism that works; `none` means the
   * re-read found nothing to remove.
   */
  mechanism: "delete" | "none";
  /** Occurrence keys the user asked to skip. */
  requested: string[];
  /** Keys found on the re-read and therefore removable. */
  survived: string[];
  /** Event ids deleted, in `survived` order. */
  deleted: string[];
}

/** Time-of-day ("HH:MM:SS") of a LocalDateTime, defaulting seconds to 00. */
function timeOfDay(localDateTime: string): string {
  const t = localDateTime.trim();
  const m = t.match(/T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return "00:00:00";
  return `${m[1]}:${m[2]}:${m[3] ?? "00"}`;
}

/**
 * Build the RFC 8984 `recurrenceOverrides` map that skips the given dates.
 *
 * Keys are occurrence LocalDateTimes — the excepted date plus the time-of-day
 * taken from the event's `--start` — each mapping to `{excluded: true}`.
 * Morgen does not document this field, so a create that carries it must still
 * be verified with {@link applyExclusions}.
 */
export function buildRecurrenceOverrides(
  exceptDates: string | undefined,
  startLocalDateTime: string
): Record<string, { excluded: true }> | undefined {
  if (!exceptDates) return undefined;
  const dates = exceptDates.split(",").map((s) => s.trim()).filter(Boolean);
  if (dates.length === 0) return undefined;

  const time = timeOfDay(startLocalDateTime);
  const startDate = startLocalDateTime.slice(0, 10);
  const overrides: Record<string, { excluded: true }> = {};
  for (const date of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Invalid --except date: "${date}" (use YYYY-MM-DD)`);
    }
    // The series' first occurrence shares its id with the master row, so a
    // fallback delete of it would take the whole series with it. Refuse rather
    // than risk that: the user wants a later --start.
    if (date === startDate) {
      throw new Error(
        `Invalid --except date: "${date}" is the series start — ` +
          `set --start to the first occurrence you actually want instead`
      );
    }
    overrides[`${date}T${time}`] = { excluded: true };
  }
  return overrides;
}

const WEEKDAY_NAMES: Record<string, string> = {
  su: "Sunday",
  mo: "Monday",
  tu: "Tuesday",
  we: "Wednesday",
  th: "Thursday",
  fr: "Friday",
  sa: "Saturday",
};

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const FREQUENCY_NOUNS: Record<Frequency, [string, string]> = {
  daily: ["day", "days"],
  weekly: ["week", "weeks"],
  monthly: ["month", "months"],
  yearly: ["year", "years"],
};

/** Generic marker used whenever a rule cannot be phrased. */
const RECURRING_FALLBACK = "recurring";

/** "2026-11-30T23:59:59" → "30 Nov"; undefined when unparseable. */
function shortDate(localDateTime: string): string | undefined {
  const m = localDateTime.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return undefined;
  const month = MONTH_ABBR[parseInt(m[2]!, 10) - 1];
  if (!month) return undefined;
  return `${parseInt(m[3]!, 10)} ${month}`;
}

/** "2nd Monday", "last Friday", or plain "Monday". */
function phraseNDay(nday: NDay): string | undefined {
  const name = WEEKDAY_NAMES[String(nday.day).toLowerCase()];
  if (!name) return undefined;
  const nth = nday.nthOfPeriod;
  if (nth === undefined) return name;
  if (nth === -1) return `last ${name}`;
  if (nth < 0) return `${-nth}th-last ${name}`;
  const suffix = nth % 10 === 1 && nth % 100 !== 11
    ? "st"
    : nth % 10 === 2 && nth % 100 !== 12
    ? "nd"
    : nth % 10 === 3 && nth % 100 !== 13
    ? "rd"
    : "th";
  return `${nth}${suffix} ${name}`;
}

/**
 * Render a recurrence rule as a short human phrase — "every Monday until
 * 30 Nov", "every 2 weeks", "every day, 10 times".
 *
 * Only the first rule is described; Morgen series in practice carry one. Any
 * rule this cannot phrase (no frequency, an unknown frequency, an empty list,
 * a malformed entry) degrades to the generic marker "recurring" rather than
 * throwing or returning an empty string, because the caller uses the result as
 * a display badge on a listing row.
 */
export function describeRecurrence(rules: RecurrenceRule[]): string {
  try {
    const rule = Array.isArray(rules) ? rules[0] : undefined;
    if (!rule) return RECURRING_FALLBACK;

    const freq = String(rule.frequency ?? "").toLowerCase();
    if (!(FREQUENCIES as readonly string[]).includes(freq)) {
      return RECURRING_FALLBACK;
    }
    const [singular, plural] = FREQUENCY_NOUNS[freq as Frequency];

    const rawInterval = rule.interval;
    const interval =
      typeof rawInterval === "number" && Number.isFinite(rawInterval) && rawInterval >= 1
        ? Math.trunc(rawInterval)
        : 1;

    const days = Array.isArray(rule.byDay)
      ? rule.byDay.map(phraseNDay).filter((d): d is string => d !== undefined)
      : [];
    const dayList = days.join(", ");

    let phrase: string;
    if (interval === 1) {
      phrase = dayList ? `every ${dayList}` : `every ${singular}`;
    } else {
      phrase = `every ${interval} ${plural}`;
      if (dayList) phrase += ` on ${dayList}`;
    }

    if (typeof rule.until === "string") {
      const until = shortDate(rule.until);
      if (until) phrase += ` until ${until}`;
    }

    const count = rule.count;
    if (typeof count === "number" && Number.isFinite(count) && count >= 1) {
      phrase += `, ${Math.trunc(count)} times`;
    }

    return phrase;
  } catch {
    return RECURRING_FALLBACK;
  }
}

/** True when `event` is an occurrence of the series mastered by `masterId`. */
function belongsToSeries(event: MorgenEvent, masterId: string): boolean {
  const decoded = decodeEventId(masterId);
  const candidates = [
    event.masterEventId,
    event.masterBaseEventId,
    event.baseEventId,
    event.id,
  ];
  return candidates.some(
    (c) => c !== undefined && (c === masterId || (decoded && c === decoded.eventId))
  );
}

/**
 * Verify that the excepted occurrences really are gone, and remove any that
 * survived.
 *
 * `recurrenceOverrides` is RFC 8984 but undocumented by Morgen, so depending on
 * the backing provider it may be honoured, rejected, or silently dropped. This
 * re-reads the series window and, for every requested key still present,
 * deletes that single occurrence with `?seriesUpdateMode=single` — the only
 * documented way to remove one instance of a series.
 */
export async function applyExclusions(
  masterId: string,
  keys: string[],
  window: ListEventsOptions
): Promise<ExclusionOutcome> {
  const outcome: ExclusionOutcome = {
    mechanism: "none",
    requested: keys,
    survived: [],
    deleted: [],
  };
  if (keys.length === 0) return outcome;

  const events = await listEvents(window);
  // The master row matches belongsToSeries via its own id, but deleting it with
  // seriesUpdateMode=single is not an occurrence delete — on some providers it
  // removes the whole series. Only rows that identify as an occurrence are
  // eligible for the fallback delete.
  const occurrences = events.filter(
    (e) =>
      belongsToSeries(e, masterId) &&
      e.id !== masterId &&
      (e.recurrenceId !== undefined || e.masterEventId !== undefined)
  );

  const survivors: { key: string; id: string }[] = [];
  for (const key of keys) {
    const date = key.slice(0, 10);
    const hit = occurrences.find(
      (e) => (e.recurrenceId ?? e.start ?? "").slice(0, 10) === date
    );
    if (hit) survivors.push({ key, id: hit.id });
  }

  if (survivors.length === 0) return outcome;

  outcome.mechanism = "delete";
  for (const survivor of survivors) {
    await deleteEvent(survivor.id, "single");
    outcome.survived.push(survivor.key);
    outcome.deleted.push(survivor.id);
  }
  return outcome;
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

/** Scope of an update or delete against a recurring series. */
export type SeriesUpdateMode = "single" | "future" | "all";

const SERIES_UPDATE_MODES = ["single", "future", "all"] as const;

/** Validate a `--series` value; throws naming the flag and the offender. */
export function parseSeriesMode(
  raw: string | undefined
): SeriesUpdateMode | undefined {
  if (raw === undefined) return undefined;
  const mode = raw.trim();
  if (!(SERIES_UPDATE_MODES as readonly string[]).includes(mode)) {
    throw new Error(
      `Invalid --series value: "${raw}" (use single, future or all)`
    );
  }
  return mode as SeriesUpdateMode;
}

/**
 * Update an event, optionally scoping the update to part of a series.
 *
 * `seriesUpdateMode` is sent as a QUERY-STRING parameter — putting it in the
 * JSON request body returns HTTP 400.
 */
export async function updateEvent(
  input: Record<string, unknown>,
  seriesUpdateMode?: SeriesUpdateMode
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
  await morgenFetch<void>("/events/update", {
    method: "POST",
    body,
    ...(seriesUpdateMode ? { params: { seriesUpdateMode } } : {}),
  });
}

/**
 * Delete an event, optionally scoping the delete to part of a series.
 *
 * `seriesUpdateMode` is sent as a QUERY-STRING parameter: the documented delete
 * body accepts exactly `{id, accountId, calendarId}` and returns HTTP 400 for
 * any other property, so it must never be merged into the body.
 */
export async function deleteEvent(
  id: string,
  seriesUpdateMode?: SeriesUpdateMode
): Promise<void> {
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
    ...(seriesUpdateMode ? { params: { seriesUpdateMode } } : {}),
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
    const last = merged[merged.length - 1];
    if (last !== undefined && interval[0] <= last[1]) {
      last[1] = Math.max(last[1], interval[1]);
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
