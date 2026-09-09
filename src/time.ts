/**
 * Timezone conversion utilities
 *
 * Pure functions for converting floating local times between timezones.
 * Uses built-in Intl APIs — zero dependencies.
 */

/**
 * Pad a minute-precision local datetime to the 19 characters the Morgen API
 * demands ("start must be longer than or equal to 19 characters"). Only an
 * exact `YYYY-MM-DDTHH:MM` is touched — date-only values are the documented
 * all-day form, and anything carrying an offset or `Z` is left for the API to
 * accept or reject on its own terms.
 */
export function normalizeLocalDateTime(value: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
}

/**
 * Convert a floating local time from one timezone to another,
 * returning ISO 8601 with UTC offset (e.g., "2026-02-12T05:00:00-05:00").
 *
 * If targetTz is falsy, returns the original string unchanged.
 */
export function convertToTimezone(
  floatingLocal: string,
  sourceTz: string,
  targetTz: string,
): string {
  if (!targetTz) return floatingLocal;

  // Interpret the floating local time in the source timezone
  // by constructing a Date that represents that wall-clock time in sourceTz
  const utcMs = floatingLocalToUtcMs(floatingLocal, sourceTz);

  // Format in the target timezone
  const date = new Date(utcMs);
  const parts = getDateParts(date, targetTz);
  const offset = getUtcOffset(date, targetTz);

  return (
    `${parts.year}-${parts.month}-${parts.day}` +
    `T${parts.hour}:${parts.minute}:${parts.second}` +
    `${formatOffset(offset)}`
  );
}

/**
 * Format a floating local time as HH:mm in the target timezone.
 * If targetTz is falsy, extracts HH:mm from the original string.
 */
export function formatTimeForDisplay(
  floatingLocal: string,
  sourceTz: string,
  targetTz: string,
): string {
  if (!targetTz) {
    return floatingLocal.split("T")[1]?.slice(0, 5) || floatingLocal;
  }

  const utcMs = floatingLocalToUtcMs(floatingLocal, sourceTz);
  const parts = getDateParts(new Date(utcMs), targetTz);
  return `${parts.hour}:${parts.minute}`;
}

/**
 * Resolve a user-supplied datetime string to absolute UTC milliseconds.
 *
 * - If the string carries an explicit UTC offset or trailing 'Z', it is an
 *   absolute instant and used as-is.
 * - Otherwise it is a floating wall-clock time, interpreted in `tz`
 *   (or as UTC when no `tz` is given).
 * - A date-only string (no "T") is expanded to start- or end-of-day per
 *   `endOfDay`.
 *
 * This is what makes `--timezone` affect the *interpretation* of the
 * free-finder window, not just output formatting.
 */
export function resolveToUtcMs(
  input: string,
  tz?: string,
  endOfDay = false,
): number {
  const tIdx = input.indexOf("T");
  const timePart = tIdx >= 0 ? input.slice(tIdx + 1) : "";
  const hasOffset = /[zZ]$/.test(timePart) || /[+-]\d{2}:?\d{2}$/.test(timePart);
  if (hasOffset) return new Date(input).getTime();

  let s = input;
  if (tIdx < 0) s = s + (endOfDay ? "T23:59:59" : "T00:00:00");

  if (tz) return floatingLocalToUtcMs(s, tz);
  return new Date(s + "Z").getTime();
}

/**
 * Resolve the single zone a read command displays in: an explicit zone when one
 * is given, otherwise the machine's IANA zone, otherwise "UTC".
 */
export function resolveDisplayTimeZone(explicit?: string): string {
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * Render absolute UTC milliseconds as ISO 8601 with a numeric UTC offset in `tz`
 * (e.g. utcMsToZoned(0, "America/New_York") === "1969-12-31T19:00:00-05:00").
 */
export function utcMsToZoned(ms: number, tz: string): string {
  const date = new Date(ms);
  const parts = getDateParts(date, tz);
  const offset = getUtcOffset(date, tz);

  return (
    `${parts.year}-${parts.month}-${parts.day}` +
    `T${parts.hour}:${parts.minute}:${parts.second}` +
    `${formatOffset(offset)}`
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a floating local time string to UTC milliseconds,
 * interpreting it as wall-clock time in the given timezone.
 */
function floatingLocalToUtcMs(floatingLocal: string, tz: string): number {
  // Parse components from the string
  const [datePart = "", timePart] = floatingLocal.split("T");
  const [year = NaN, month = NaN, day = NaN] = datePart.split("-").map(Number);
  const [hour = NaN, minute = NaN, second] = (timePart || "00:00:00").split(":").map(Number);

  // Create a Date in UTC, then adjust for the source timezone offset
  // First guess: create a UTC date with these components
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, second || 0);

  // Get the offset of the source timezone at this UTC instant
  const offsetMs = getUtcOffset(new Date(guessUtc), tz) * 60000;

  // The actual UTC time is: guessUtc - offsetMs
  // (if tz is UTC-5, the wall clock is 5h behind UTC, so UTC = wall + 5h)
  const adjustedUtc = guessUtc - offsetMs;

  // Verify: the offset might differ at the adjusted time (DST edge)
  const verifyOffset = getUtcOffset(new Date(adjustedUtc), tz) * 60000;
  if (verifyOffset !== offsetMs) {
    return guessUtc - verifyOffset;
  }

  return adjustedUtc;
}

/**
 * Get the UTC offset in minutes for a timezone at a given instant.
 * Positive = east of UTC (e.g., +60 for CET), negative = west (e.g., -300 for EST).
 */
function getUtcOffset(date: Date, tz: string): number {
  // Format in UTC and in the target timezone, then compute difference
  const utcParts = getDateParts(date, "UTC");
  const tzParts = getDateParts(date, tz);

  // Calendar fields carry no fixed minutes-per-month/year, so compare real
  // instants rather than weighting the fields.
  const toMins = (p: DateParts) =>
    Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
    ) / 60000;

  return toMins(tzParts) - toMins(utcParts);
}

interface DateParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

/**
 * Formatter options are a fixed literal, so a zone name is the whole cache key.
 * A read command touches at most two zones ("UTC" plus the display zone), where
 * an uncached `getDateParts` would build one formatter per event row.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    formatterCache.set(tz, fmt);
  }
  return fmt;
}

function getDateParts(date: Date, tz: string): DateParts {
  const parts = getFormatter(tz).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "00";

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") === "24" ? "00" : get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  return `${sign}${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}
