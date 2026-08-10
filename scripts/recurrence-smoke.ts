#!/usr/bin/env bun
/**
 * Live smoke test for recurring-event support.
 *
 * Creates a throwaway weekly series with one excluded occurrence on a writable
 * calendar, reads the window back, prints exactly which occurrences exist and
 * removes the excepted occurrence, then deletes the series with
 * `?seriesUpdateMode=all` and confirms it is gone.
 *
 * This is the only proof that the backing provider (Google / o365) actually
 * honours `recurrenceRules` — the automated suite
 * proves only what leaves the CLI. Run it by hand:
 *
 *   bun scripts/recurrence-smoke.ts --dry-run   # prints payloads, no network
 *   bun scripts/recurrence-smoke.ts             # live round-trip, self-cleaning
 *
 * `--dry-run` performs no network I/O whatsoever and prints the exact request
 * payloads it would send, as a single JSON document on stdout.
 */

import {
  applyExclusions,
  buildRecurrenceOverrides,
  buildRecurrenceRules,
  createEvent,
  decodeEventId,
  deleteEvent,
  listCalendars,
  listEvents,
} from "../src/calendars";
import type { MorgenEvent } from "../src/types";

// Far-future, unmistakably disposable defaults.
const DEFAULT_START = "2030-03-04T09:00:00"; // a Monday
const DEFAULT_TITLE = "morgen-cli SMOKE TEST — DELETE ME";
const DEFAULT_TZ = "America/New_York";
const DURATION = "PT1H";
const COUNT = 4;
/** Which occurrence (0-based) to skip — the third of four. */
const EXCEPT_INDEX = 2;

interface Options {
  dryRun: boolean;
  start: string;
  title: string;
  timeZone: string;
  calendarId?: string;
}

function parseOptions(argv: string[]): Options {
  const opts: Options = {
    dryRun: false,
    start: DEFAULT_START,
    title: DEFAULT_TITLE,
    timeZone: DEFAULT_TZ,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--start":
        opts.start = argv[++i] ?? opts.start;
        break;
      case "--title":
        opts.title = argv[++i] ?? opts.title;
        break;
      case "--tz":
        opts.timeZone = argv[++i] ?? opts.timeZone;
        break;
      case "--calendar-id":
        opts.calendarId = argv[++i];
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return opts;
}

/** Add `weeks` weeks to the date half of a floating LocalDateTime. */
function addWeeks(localDateTime: string, weeks: number): string {
  const [date, time] = localDateTime.split("T");
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  const shifted = d.toISOString().slice(0, 10);
  return time ? `${shifted}T${time}` : shifted;
}

/** A request the script would issue, in the shape `--dry-run` prints. */
interface PlannedRequest {
  method: string;
  path: string;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  note?: string;
}

function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));

  const exceptDate = addWeeks(opts.start, EXCEPT_INDEX).slice(0, 10);
  const recurrenceRules = buildRecurrenceRules({
    repeat: "weekly",
    interval: 1,
    count: COUNT,
    start: opts.start,
    timeZone: opts.timeZone,
  })!;
  const recurrenceOverrides = buildRecurrenceOverrides(exceptDate, opts.start)!;
  const exclusionKeys = Object.keys(recurrenceOverrides).sort();

  // Window covering every occurrence of the series, inclusive.
  const window = {
    start: opts.start.slice(0, 10),
    end: addWeeks(opts.start, COUNT - 1).slice(0, 10),
  };

  return opts.dryRun
    ? dryRun(opts, recurrenceRules, recurrenceOverrides, exclusionKeys, window)
    : live(opts, recurrenceRules, recurrenceOverrides, exclusionKeys, window);
}

/**
 * Print the exact payloads the live path would send. Issues no request of any
 * kind, so the ids the live run would learn from the API appear as placeholders.
 */
async function dryRun(
  opts: Options,
  recurrenceRules: unknown[],
  recurrenceOverrides: Record<string, { excluded: true }>,
  exclusionKeys: string[],
  window: { start: string; end: string }
): Promise<void> {
  const calendarId = opts.calendarId ?? "<calendarId from /calendars/list>";
  const accountId = "<accountId from /calendars/list>";
  const eventId = "<id from /events/create>";

  const requests: PlannedRequest[] = [
    {
      method: "GET",
      path: "/calendars/list",
      note: opts.calendarId
        ? "resolve --calendar-id"
        : "pick the first writable calendar",
    },
    {
      method: "POST",
      path: "/events/create",
      body: {
        accountId,
        calendarId,
        title: opts.title,
        start: opts.start,
        duration: DURATION,
        timeZone: opts.timeZone,
        showWithoutTime: false,
        description: "Disposable smoke test for morgen-cli recurrence support.",
        recurrenceRules,
      },
    },
    {
      method: "GET",
      path: "/events/list",
      params: {
        accountId,
        calendarIds: calendarId,
        start: window.start,
        end: window.end,
      },
      note: `read the series back and delete ${exclusionKeys.join(", ")} (POST /events/delete?seriesUpdateMode=single, body {id, accountId, calendarId}) — recurrenceOverrides is rejected by Morgen with 400 whitelistValidation, so deletion is the only exclusion mechanism`,
    },
    {
      method: "POST",
      path: "/events/delete",
      params: { seriesUpdateMode: "all" },
      body: { id: eventId, accountId, calendarId },
      note: "tear down the whole series; seriesUpdateMode is a query parameter, never a body property",
    },
    {
      method: "GET",
      path: "/events/list",
      params: {
        accountId,
        calendarIds: calendarId,
        start: window.start,
        end: window.end,
      },
      note: "confirm the series is gone",
    },
  ];

  console.log(
    JSON.stringify(
      {
        dryRun: true,
        title: opts.title,
        start: opts.start,
        timeZone: opts.timeZone,
        window,
        excluded: exclusionKeys,
        requests,
      },
      null,
      2
    )
  );
}

/** Occurrence LocalDateTime of an event as returned by /events/list. */
function occurrenceKey(event: MorgenEvent): string {
  return event.recurrenceId ?? event.start ?? "";
}

async function live(
  opts: Options,
  recurrenceRules: unknown[],
  recurrenceOverrides: Record<string, { excluded: true }>,
  exclusionKeys: string[],
  window: { start: string; end: string }
): Promise<void> {
  const calendars = await listCalendars();
  const cal = opts.calendarId
    ? calendars.find((c) => c.id === opts.calendarId)
    : calendars.find((c) => c.myRights?.mayWrite || c.myRights?.mayWriteAll);
  if (!cal) {
    throw new Error("No writable calendar found. Use --calendar-id.");
  }
  console.log(`calendar: ${cal.name} (${cal.id})`);
  console.log(`series:   ${opts.title} @ ${opts.start} ${opts.timeZone}`);
  console.log(`excluded: ${exclusionKeys.join(", ")}`);

  const id = await createEvent({
    accountId: cal.accountId,
    calendarId: cal.id,
    title: opts.title,
    start: opts.start,
    duration: DURATION,
    timeZone: opts.timeZone,
    showWithoutTime: false,
    description: "Disposable smoke test for morgen-cli recurrence support.",
    recurrenceRules: recurrenceRules as never,
  });
  console.log(`created:  ${id}`);

  try {
    const outcome = await applyExclusions(id, exclusionKeys, {
      ...window,
      calendarIds: [cal.id],
    });
    console.log(
      outcome.mechanism === "delete"
        ? `exclusion: deleted ${outcome.deleted.length} occurrence(s): ${outcome.deleted.join(", ")}`
        : "exclusion: nothing to delete — the excepted occurrence was not in the window"
    );

    const after = await listEvents({ ...window, calendarIds: [cal.id] });
    const mine = after.filter((e) => e.title === opts.title);
    console.log(`occurrences after exclusion (${mine.length}):`);
    for (const e of mine) console.log(`  - ${occurrenceKey(e)}`);
  } finally {
    await deleteEvent(id, "all");
    console.log(`deleted:  ${id} (seriesUpdateMode=all)`);
  }

  const final = await listEvents({ ...window, calendarIds: [cal.id] });
  const leftovers = final.filter((e) => e.title === opts.title);
  if (leftovers.length > 0) {
    console.log(`LEFTOVERS (${leftovers.length}) — delete these by hand:`);
    for (const e of leftovers) {
      const decoded = decodeEventId(e.id);
      console.log(`  - ${occurrenceKey(e)}  ${e.id}${decoded ? "" : " (undecodable id)"}`);
    }
    throw new Error("series was not fully removed");
  }
  console.log("confirmed: no occurrences remain");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
