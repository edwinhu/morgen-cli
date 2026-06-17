/**
 * Timezone conversion utilities
 *
 * Pure functions for converting floating local times between timezones.
 * Uses built-in Intl APIs — zero dependencies.
 */

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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a floating local time string to UTC milliseconds,
 * interpreting it as wall-clock time in the given timezone.
 */
function floatingLocalToUtcMs(floatingLocal: string, tz: string): number {
  // Parse components from the string
  const [datePart, timePart] = floatingLocal.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, second] = (timePart || "00:00:00").split(":").map(Number);

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

  const utcMins =
    Number(utcParts.year) * 525960 +
    Number(utcParts.month) * 43800 +
    Number(utcParts.day) * 1440 +
    Number(utcParts.hour) * 60 +
    Number(utcParts.minute);

  const tzMins =
    Number(tzParts.year) * 525960 +
    Number(tzParts.month) * 43800 +
    Number(tzParts.day) * 1440 +
    Number(tzParts.hour) * 60 +
    Number(tzParts.minute);

  return tzMins - utcMins;
}

interface DateParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function getDateParts(date: Date, tz: string): DateParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = fmt.formatToParts(date);
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
