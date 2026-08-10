import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  listCalendars,
  listEvents,
  findFreeSlots,
  resetCalendarCache,
  buildAlerts,
  parseAlertOffset,
  parseRrule,
  buildRecurrenceRules,
  buildRecurrenceOverrides,
  applyExclusions,
  describeRecurrence,
} from "../calendars";
import type { RecurrenceRule } from "../types";

describe("buildAlerts / parseAlertOffset", () => {
  it("parses unit tokens into negative ISO 8601 offsets", () => {
    expect(parseAlertOffset("30m")).toBe("-PT30M");
    expect(parseAlertOffset("2h")).toBe("-PT2H");
    expect(parseAlertOffset("1d")).toBe("-P1D");
    expect(parseAlertOffset("15")).toBe("-PT15M"); // bare number defaults to minutes
  });

  it("treats 0 / at-time as an offset at the event start", () => {
    expect(parseAlertOffset("0")).toBe("PT0S");
    expect(parseAlertOffset("at-time")).toBe("PT0S");
  });

  it("throws on invalid lead-time tokens", () => {
    expect(() => parseAlertOffset("soon")).toThrow();
    expect(() => parseAlertOffset("30x")).toThrow();
  });

  it("builds a JSCalendar alerts map from a comma-separated spec", () => {
    const alerts = buildAlerts("30m,10m") as Record<string, any>;
    const entries = Object.values(alerts);
    expect(entries).toHaveLength(2);
    expect(entries[0]["@type"]).toBe("Alert");
    expect(entries[0].action).toBe("display");
    expect(entries[0].trigger["@type"]).toBe("OffsetTrigger");
    expect(entries[0].trigger.offset).toBe("-PT30M");
    expect(entries[0].trigger.relativeTo).toBe("start");
    expect(entries[1].trigger.offset).toBe("-PT10M");
  });

  it("returns undefined for empty/missing specs", () => {
    expect(buildAlerts(undefined)).toBeUndefined();
    expect(buildAlerts("")).toBeUndefined();
    expect(buildAlerts(" , ")).toBeUndefined();
  });
});

describe("calendars module", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.MORGEN_API_KEY = "test-api-key";
    resetCalendarCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.MORGEN_API_KEY;
  });

  const mockCalendars = [
    {
      "@type": "Calendar",
      id: "cal-work",
      accountId: "acc-1",
      integrationId: "google",
      name: "Work",
      myRights: { mayRead: true, mayWrite: true, mayAdmin: false, mayRSVP: true },
    },
    {
      "@type": "Calendar",
      id: "cal-personal",
      accountId: "acc-1",
      integrationId: "google",
      name: "Personal",
      myRights: { mayRead: true, mayWrite: true, mayAdmin: false, mayRSVP: true },
    },
    {
      "@type": "Calendar",
      id: "cal-family",
      accountId: "acc-1",
      integrationId: "google",
      name: "Family",
      myRights: { mayRead: true, mayWrite: false, mayAdmin: false, mayRSVP: false },
    },
  ];

  function mockFetchWithCalendarsAndEvents(
    events: Record<string, unknown>[] = []
  ) {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/calendars/list")) {
        return new Response(
          JSON.stringify({ data: { calendars: mockCalendars } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/events/list")) {
        return new Response(
          JSON.stringify({ data: { events } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
  }

  it("listCalendars returns calendars from API", async () => {
    mockFetchWithCalendarsAndEvents();
    const cals = await listCalendars();
    expect(cals).toHaveLength(3);
    expect(cals[0]?.name).toBe("Work");
  });

  it("listCalendars caches across calls", async () => {
    let callCount = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/calendars/list")) {
        callCount++;
        return new Response(
          JSON.stringify({ data: { calendars: mockCalendars } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ data: { events: [] } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    await listCalendars();
    await listCalendars();
    expect(callCount).toBe(1);
  });

  it("listEvents filters by calendarIds", async () => {
    let requestedCalendarIds = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/calendars/list")) {
        return new Response(
          JSON.stringify({ data: { calendars: mockCalendars } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/events/list")) {
        const u = new URL(url);
        requestedCalendarIds = u.searchParams.get("calendarIds") || "";
        return new Response(
          JSON.stringify({ data: { events: [] } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await listEvents({
      start: "2026-02-10",
      end: "2026-02-11",
      calendarIds: ["cal-work"],
    });

    // Should only include cal-work, not cal-personal or cal-family
    expect(requestedCalendarIds).toBe("cal-work");
  });

  it("listEvents adds calendarName to results", async () => {
    mockFetchWithCalendarsAndEvents([
      {
        "@type": "Event",
        id: "ev-1",
        calendarId: "cal-work",
        title: "Standup",
        start: "2026-02-10T09:00:00Z",
        duration: "PT30M",
        timeZone: "America/New_York",
        showWithoutTime: false,
      },
    ]);

    const events = await listEvents({
      start: "2026-02-10",
      end: "2026-02-11",
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe("Standup");
    expect(events[0]?.calendarName).toBe("Work");
  });

  it("findFreeSlots returns gaps between events", async () => {
    mockFetchWithCalendarsAndEvents([
      {
        "@type": "Event",
        id: "ev-1",
        calendarId: "cal-work",
        title: "Meeting 1",
        start: "2026-02-10T09:00:00Z",
        duration: "PT1H",
        timeZone: "America/New_York",
        showWithoutTime: false,
      },
      {
        "@type": "Event",
        id: "ev-2",
        calendarId: "cal-work",
        title: "Meeting 2",
        start: "2026-02-10T11:00:00Z",
        duration: "PT1H",
        timeZone: "America/New_York",
        showWithoutTime: false,
      },
    ]);

    const slots = await findFreeSlots({
      start: "2026-02-10T08:00:00Z",
      end: "2026-02-10T13:00:00Z",
      minMinutes: 30,
    });

    // Free: 08:00-09:00, 10:00-11:00, 12:00-13:00
    expect(slots).toHaveLength(3);
    expect(slots[0]?.duration).toBe("1h");
    expect(slots[1]?.duration).toBe("1h");
    expect(slots[2]?.duration).toBe("1h");
  });

  it("findFreeSlots skips all-day events", async () => {
    mockFetchWithCalendarsAndEvents([
      {
        "@type": "Event",
        id: "ev-allday",
        calendarId: "cal-work",
        title: "Holiday",
        start: "2026-02-10",
        duration: "P1D",
        timeZone: "America/New_York",
        showWithoutTime: true,
      },
      {
        "@type": "Event",
        id: "ev-timed",
        calendarId: "cal-work",
        title: "Call",
        start: "2026-02-10T10:00:00Z",
        duration: "PT30M",
        timeZone: "America/New_York",
        showWithoutTime: false,
      },
    ]);

    const slots = await findFreeSlots({
      start: "2026-02-10T09:00:00Z",
      end: "2026-02-10T12:00:00Z",
      minMinutes: 30,
    });

    // Only timed event blocks: free 09:00-10:00, free 10:30-12:00
    expect(slots).toHaveLength(2);
  });

  it("findFreeSlots skips events with freeBusyStatus 'free'", async () => {
    mockFetchWithCalendarsAndEvents([
      {
        "@type": "Event",
        id: "ev-busy",
        calendarId: "cal-work",
        title: "Real Meeting",
        start: "2026-02-10T09:00:00Z",
        duration: "PT1H",
        timeZone: "America/New_York",
        showWithoutTime: false,
        freeBusyStatus: "busy",
      },
      {
        "@type": "Event",
        id: "ev-free",
        calendarId: "cal-work",
        title: "Lunch (free)",
        start: "2026-02-10T12:00:00Z",
        duration: "PT1H",
        timeZone: "America/New_York",
        showWithoutTime: false,
        freeBusyStatus: "free",
      },
      {
        "@type": "Event",
        id: "ev-tentative",
        calendarId: "cal-work",
        title: "Maybe Meeting",
        start: "2026-02-10T14:00:00Z",
        duration: "PT1H",
        timeZone: "America/New_York",
        showWithoutTime: false,
        freeBusyStatus: "tentative",
      },
    ]);

    const slots = await findFreeSlots({
      start: "2026-02-10T08:00:00Z",
      end: "2026-02-10T16:00:00Z",
      minMinutes: 30,
    });

    // busy event at 9-10 blocks, free event at 12-13 does NOT block, tentative at 14-15 blocks
    // Free: 08-09 (1h), 10-14 (4h, lunch is free so doesn't block), 15-16 (1h)
    expect(slots).toHaveLength(3);
    expect(slots[0]?.duration).toBe("1h");     // 08:00-09:00
    expect(slots[1]?.duration).toBe("4h");     // 10:00-14:00 (lunch doesn't block)
    expect(slots[2]?.duration).toBe("1h");     // 15:00-16:00
  });

  it("findFreeSlots treats events without freeBusyStatus as busy", async () => {
    mockFetchWithCalendarsAndEvents([
      {
        "@type": "Event",
        id: "ev-no-status",
        calendarId: "cal-work",
        title: "Legacy Event",
        start: "2026-02-10T10:00:00Z",
        duration: "PT1H",
        timeZone: "America/New_York",
        showWithoutTime: false,
        // No freeBusyStatus field
      },
    ]);

    const slots = await findFreeSlots({
      start: "2026-02-10T09:00:00Z",
      end: "2026-02-10T12:00:00Z",
      minMinutes: 30,
    });

    // Event without status blocks: free 09-10 and 11-12
    expect(slots).toHaveLength(2);
  });

  // Regression: 2026-06-18 "Edwin Hu / Bobby Bishop" near double-book.
  // Real Morgen booking shape: end:null, but duration IS present ("PT30M"),
  // start carries a UTC offset, and the caller passes a naive --timezone
  // window. Two bugs combined: (1) the free-finder parsed the naive window with
  // machine-local Date(), and (2) the fetch window ignored the timezone — so
  // the ET bookings sat outside a mis-parsed range and were reported free.
  // The window must be interpreted in --timezone and end derived from duration.
  it("findFreeSlots blocks null-end bookings using duration in the requested timezone", async () => {
    mockFetchWithCalendarsAndEvents([
      {
        "@type": "Event",
        id: "ev-bishara",
        calendarId: "cal-work",
        title: "Edwin Hu / Philip Bishara",
        start: "2026-06-18T11:30:00-04:00", // 11:30 ET
        end: null,
        duration: "PT30M",
        timeZone: "America/New_York",
        showWithoutTime: false,
        freeBusyStatus: "busy",
      },
      {
        "@type": "Event",
        id: "ev-bobby-bishop",
        calendarId: "cal-work",
        title: "Edwin Hu / Bobby Bishop",
        start: "2026-06-18T12:00:00-04:00", // 12:00 ET
        end: null,
        duration: "PT30M",
        timeZone: "America/New_York",
        showWithoutTime: false,
        freeBusyStatus: "busy",
      },
    ]);

    // Naive wall-clock window in America/New_York (as the CLI passes it).
    const slots = await findFreeSlots({
      start: "2026-06-18T11:00:00",
      end: "2026-06-18T14:00:00",
      minMinutes: 30,
      timeZone: "America/New_York",
    });

    // Neither 11:30 (Bishara) nor 12:00 (Bishop) may fall inside a free slot.
    const bookings = ["2026-06-18T15:30:00Z", "2026-06-18T16:00:00Z"].map((s) =>
      new Date(s).getTime()
    );
    for (const slot of slots) {
      const startMs = new Date(slot.start).getTime();
      const endMs = new Date(slot.end).getTime();
      for (const b of bookings) {
        expect(b >= startMs && b < endMs).toBe(false);
      }
    }

    // Expected free (ET): 11:00-11:30 before, 12:30-14:00 after the merged
    // 11:30-12:30 busy block (each booking is PT30M).
    expect(slots).toHaveLength(2);
    expect(slots[0]?.start).toBe("2026-06-18T11:00:00-04:00");
    expect(slots[0]?.end).toBe("2026-06-18T11:30:00-04:00");
    expect(slots[1]?.start).toBe("2026-06-18T12:30:00-04:00");
    expect(slots[1]?.end).toBe("2026-06-18T14:00:00-04:00");
  });

  it("findFreeSlots respects minMinutes filter", async () => {
    mockFetchWithCalendarsAndEvents([
      {
        "@type": "Event",
        id: "ev-1",
        calendarId: "cal-work",
        title: "Short gap before",
        start: "2026-02-10T09:50:00Z",
        duration: "PT1H",
        timeZone: "America/New_York",
        showWithoutTime: false,
      },
    ]);

    const slots = await findFreeSlots({
      start: "2026-02-10T09:00:00Z",
      end: "2026-02-10T12:00:00Z",
      minMinutes: 60,
    });

    // Gap before event: 50 mins (too short for 60 min minimum)
    // Gap after event: 10:50-12:00 = 70 mins (passes)
    expect(slots).toHaveLength(1);
    expect(slots[0]?.duration).toBe("1h10m");
  });
});

describe("buildRecurrenceRules / parseRrule", () => {
  const START = "2026-08-24T13:30:00"; // a Monday
  const TZ = "America/New_York";
  const base = { start: START, timeZone: TZ };

  it("buildRecurrenceRules returns undefined when no recurrence is requested", () => {
    expect(buildRecurrenceRules({ ...base })).toBeUndefined();
  });

  it("buildRecurrenceRules expands the plain --repeat sugar forms", () => {
    expect(buildRecurrenceRules({ ...base, repeat: "daily" })).toEqual([
      { "@type": "RecurrenceRule", frequency: "daily", interval: 1 },
    ]);
    expect(buildRecurrenceRules({ ...base, repeat: "monthly" })).toEqual([
      { "@type": "RecurrenceRule", frequency: "monthly", interval: 1 },
    ]);
    expect(buildRecurrenceRules({ ...base, repeat: "yearly" })).toEqual([
      { "@type": "RecurrenceRule", frequency: "yearly", interval: 1 },
    ]);
    expect(buildRecurrenceRules({ ...base, repeat: "weekdays" })).toEqual([
      {
        "@type": "RecurrenceRule",
        frequency: "weekly",
        interval: 1,
        byDay: [
          { "@type": "NDay", day: "mo" },
          { "@type": "NDay", day: "tu" },
          { "@type": "NDay", day: "we" },
          { "@type": "NDay", day: "th" },
          { "@type": "NDay", day: "fr" },
        ],
      },
    ]);
  });

  it("buildRecurrenceRules defaults bare weekly byDay from the --start weekday", () => {
    expect(buildRecurrenceRules({ ...base, repeat: "weekly" })).toEqual([
      {
        "@type": "RecurrenceRule",
        frequency: "weekly",
        interval: 1,
        byDay: [{ "@type": "NDay", day: "mo" }],
      },
    ]);
    // Sunday start
    expect(
      buildRecurrenceRules({ ...base, start: "2026-08-23T09:00:00", repeat: "weekly" })
    ).toEqual([
      {
        "@type": "RecurrenceRule",
        frequency: "weekly",
        interval: 1,
        byDay: [{ "@type": "NDay", day: "su" }],
      },
    ]);
  });

  it("buildRecurrenceRules handles the weekly:MO,WE and monthly:15 sugar forms", () => {
    expect(buildRecurrenceRules({ ...base, repeat: "weekly:MO,WE" })).toEqual([
      {
        "@type": "RecurrenceRule",
        frequency: "weekly",
        interval: 1,
        byDay: [
          { "@type": "NDay", day: "mo" },
          { "@type": "NDay", day: "we" },
        ],
      },
    ]);
    expect(buildRecurrenceRules({ ...base, repeat: "monthly:15" })).toEqual([
      {
        "@type": "RecurrenceRule",
        frequency: "monthly",
        interval: 1,
        byMonthDay: [15],
      },
    ]);
  });

  it("buildRecurrenceRules applies --interval, --count and --until to a --repeat spec", () => {
    expect(
      buildRecurrenceRules({ ...base, repeat: "daily", interval: "3", count: "10" })
    ).toEqual([
      { "@type": "RecurrenceRule", frequency: "daily", interval: 3, count: 10 },
    ]);
    // a bare date expands to end-of-day, and is already local — no conversion
    expect(
      buildRecurrenceRules({ ...base, repeat: "daily", until: "2026-11-30" })
    ).toEqual([
      {
        "@type": "RecurrenceRule",
        frequency: "daily",
        interval: 1,
        until: "2026-11-30T23:59:59",
      },
    ]);
    // a full LocalDateTime passes through untouched
    expect(
      buildRecurrenceRules({ ...base, repeat: "daily", until: "2026-11-30T08:00:00" })
    ).toEqual([
      {
        "@type": "RecurrenceRule",
        frequency: "daily",
        interval: 1,
        until: "2026-11-30T08:00:00",
      },
    ]);
  });

  it("buildRecurrenceRules maps every RRULE row of the mapping table to JSCalendar", () => {
    // FREQ=WEEKLY -> lowercased frequency; INTERVAL / COUNT -> numbers
    expect(parseRrule("FREQ=WEEKLY;INTERVAL=2;COUNT=10", "UTC")).toEqual({
      "@type": "RecurrenceRule",
      frequency: "weekly",
      interval: 2,
      count: 10,
    });
    // UNTIL (basic RFC 5545 form) -> LocalDateTime
    expect(parseRrule("FREQ=WEEKLY;UNTIL=20261130T235959Z", "UTC")).toEqual({
      "@type": "RecurrenceRule",
      frequency: "weekly",
      interval: 1,
      until: "2026-11-30T23:59:59",
    });
    // BYDAY=MO,WE -> NDay objects
    expect(parseRrule("FREQ=WEEKLY;BYDAY=MO,WE", "UTC")).toEqual({
      "@type": "RecurrenceRule",
      frequency: "weekly",
      interval: 1,
      byDay: [
        { "@type": "NDay", day: "mo" },
        { "@type": "NDay", day: "we" },
      ],
    });
    // BYDAY=2MO -> nthOfPeriod
    expect(parseRrule("FREQ=MONTHLY;BYDAY=2MO", "UTC")).toEqual({
      "@type": "RecurrenceRule",
      frequency: "monthly",
      interval: 1,
      byDay: [{ "@type": "NDay", day: "mo", nthOfPeriod: 2 }],
    });
    expect(parseRrule("FREQ=MONTHLY;BYDAY=-1FR", "UTC")).toEqual({
      "@type": "RecurrenceRule",
      frequency: "monthly",
      interval: 1,
      byDay: [{ "@type": "NDay", day: "fr", nthOfPeriod: -1 }],
    });
    // BYMONTHDAY -> numbers
    expect(parseRrule("FREQ=MONTHLY;BYMONTHDAY=15", "UTC").byMonthDay).toEqual([15]);
    // BYMONTH -> strings
    expect(parseRrule("FREQ=YEARLY;BYMONTH=3", "UTC").byMonth).toEqual(["3"]);
    // BYSETPOS -> numbers
    expect(parseRrule("FREQ=MONTHLY;BYSETPOS=-1", "UTC").bySetPosition).toEqual([-1]);
    // WKST -> firstDayOfWeek, lowercased
    expect(parseRrule("FREQ=WEEKLY;WKST=SU", "UTC").firstDayOfWeek).toBe("su");
    // FREQ=DAILY / MONTHLY / YEARLY all lowercase
    expect(parseRrule("FREQ=DAILY", "UTC").frequency).toBe("daily");
    expect(parseRrule("FREQ=MONTHLY", "UTC").frequency).toBe("monthly");
    expect(parseRrule("FREQ=YEARLY", "UTC").frequency).toBe("yearly");
    // reachable through buildRecurrenceRules too
    expect(
      buildRecurrenceRules({ ...base, rrule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO" })
    ).toEqual([
      {
        "@type": "RecurrenceRule",
        frequency: "weekly",
        interval: 1,
        byDay: [{ "@type": "NDay", day: "mo" }],
      },
    ]);
  });

  it("buildRecurrenceRules converts a Z-suffixed UNTIL into the event timezone", () => {
    const rules = buildRecurrenceRules({
      ...base,
      rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261130T235959Z",
    })!;
    expect(rules[0]!.until).toBe("2026-11-30T18:59:59"); // 23:59:59Z in America/New_York
    // extended form is accepted identically
    expect(
      parseRrule("FREQ=WEEKLY;UNTIL=2026-11-30T23:59:59Z", "America/New_York").until
    ).toBe("2026-11-30T18:59:59");
    // a floating (non-Z) UNTIL is already local and is not shifted
    expect(parseRrule("FREQ=WEEKLY;UNTIL=20261130T235959", "America/New_York").until).toBe(
      "2026-11-30T23:59:59"
    );
  });

  it("buildRecurrenceRules rejects --rrule together with --repeat", () => {
    expect(() =>
      buildRecurrenceRules({ ...base, rrule: "FREQ=WEEKLY", repeat: "weekly" })
    ).toThrow(/--rrule[\s\S]*--repeat/);
  });

  it("buildRecurrenceRules rejects --until together with --count", () => {
    expect(() =>
      buildRecurrenceRules({ ...base, repeat: "daily", until: "2026-11-30", count: "5" })
    ).toThrow(/--until[\s\S]*--count/);
    expect(() =>
      parseRrule("FREQ=WEEKLY;UNTIL=20261130T235959Z;COUNT=5", "UTC")
    ).toThrow(/UNTIL[\s\S]*COUNT/);
  });

  it("buildRecurrenceRules rejects an unknown frequency", () => {
    expect(() => buildRecurrenceRules({ ...base, repeat: "fortnightly" })).toThrow(
      /fortnightly/
    );
    expect(() => parseRrule("FREQ=HOURLY", "UTC")).toThrow(/HOURLY/i);
    expect(() => parseRrule("INTERVAL=2", "UTC")).toThrow(/FREQ/i);
  });

  it("buildRecurrenceRules rejects an unknown weekday token", () => {
    expect(() => buildRecurrenceRules({ ...base, repeat: "weekly:MO,XX" })).toThrow(/XX/i);
    expect(() => parseRrule("FREQ=WEEKLY;BYDAY=MO,XX", "UTC")).toThrow(/XX/i);
  });

  it("buildRecurrenceRules rejects an interval below 1", () => {
    expect(() =>
      buildRecurrenceRules({ ...base, repeat: "daily", interval: "0" })
    ).toThrow(/interval/i);
    expect(() =>
      buildRecurrenceRules({ ...base, repeat: "daily", interval: "-2" })
    ).toThrow(/interval/i);
    expect(() => parseRrule("FREQ=DAILY;INTERVAL=0", "UTC")).toThrow(/interval/i);
  });
});

describe("buildRecurrenceOverrides", () => {
  it("keys each excepted date with the time-of-day from --start", () => {
    expect(
      buildRecurrenceOverrides("2026-09-07,2026-10-12", "2026-08-24T13:30:00")
    ).toEqual({
      "2026-09-07T13:30:00": { excluded: true },
      "2026-10-12T13:30:00": { excluded: true },
    });
  });

  it("returns undefined when no dates are given", () => {
    expect(buildRecurrenceOverrides(undefined, "2026-08-24T13:30:00")).toBeUndefined();
    expect(buildRecurrenceOverrides(" , ", "2026-08-24T13:30:00")).toBeUndefined();
  });

  it("rejects a malformed excepted date", () => {
    expect(() =>
      buildRecurrenceOverrides("2026-09-07,Sept 12", "2026-08-24T13:30:00")
    ).toThrow(/Sept 12/);
  });
});

describe("applyExclusions", () => {
  const originalFetch = globalThis.fetch;

  const eventId = (calendarId: string, id: string, accountId: string) =>
    Buffer.from(JSON.stringify([calendarId, id, accountId]), "utf8").toString("base64");

  const MASTER = eventId("cal-work", "master-1", "acc-1");
  const KEYS = ["2026-09-07T13:30:00", "2026-10-12T13:30:00"];
  const WINDOW = { start: "2026-09-07", end: "2026-10-12", calendarIds: ["cal-work"] };

  const calendars = [
    {
      "@type": "Calendar",
      id: "cal-work",
      accountId: "acc-1",
      integrationId: "google",
      name: "Work",
      myRights: { mayRead: true, mayWrite: true, mayAdmin: false, mayRSVP: true },
    },
  ];

  const occurrence = (date: string, id: string) => ({
    "@type": "Event",
    id: eventId("cal-work", id, "acc-1"),
    calendarId: "cal-work",
    accountId: "acc-1",
    title: "Securities Regulation",
    start: `${date}T13:30:00`,
    duration: "PT2H",
    timeZone: "America/New_York",
    recurrenceId: `${date}T13:30:00`,
    masterEventId: MASTER,
  });

  interface Seen {
    url: string;
    method: string;
    body: unknown;
  }

  function mockApi(events: Record<string, unknown>[]): Seen[] {
    const seen: Seen[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.includes("/calendars/list")) {
        return new Response(JSON.stringify({ data: { calendars } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/events/list")) {
        return new Response(JSON.stringify({ data: { events } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/events/delete")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
    return seen;
  }

  beforeEach(() => {
    process.env.MORGEN_API_KEY = "test-api-key";
    resetCalendarCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.MORGEN_API_KEY;
  });

  it("applyExclusions issues no delete when the occurrences are already absent", async () => {
    // The re-read shows the series without the excepted occurrences, so there
    // is nothing to remove and no delete may be issued.
    const seen = mockApi([occurrence("2026-09-14", "occ-0914")]);

    const result = await applyExclusions(MASTER, KEYS, WINDOW);

    expect(result.mechanism).toBe("none");
    expect(result.survived).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(seen.filter((r) => r.url.includes("/events/delete"))).toEqual([]);
  });

  it("applyExclusions deletes each excepted occurrence found in the window", async () => {
    const seen = mockApi([
      occurrence("2026-09-07", "occ-0907"),
      occurrence("2026-09-14", "occ-0914"),
      occurrence("2026-10-12", "occ-1012"),
    ]);

    const result = await applyExclusions(MASTER, KEYS, WINDOW);

    expect(result.mechanism).toBe("delete");
    expect(result.survived).toEqual(KEYS);

    const deletes = seen.filter((r) => r.url.includes("/events/delete"));
    expect(deletes).toHaveLength(2);
    expect(result.deleted).toEqual([
      eventId("cal-work", "occ-0907", "acc-1"),
      eventId("cal-work", "occ-1012", "acc-1"),
    ]);

    for (const del of deletes) {
      expect(del.method).toBe("POST");
      // seriesUpdateMode rides the QUERY STRING — never the JSON body.
      expect(new URL(del.url).searchParams.get("seriesUpdateMode")).toBe("single");
      const body = del.body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["accountId", "calendarId", "id"]);
      expect(body.accountId).toBe("acc-1");
      expect(body.calendarId).toBe("cal-work");
    }
    expect((deletes[0]!.body as Record<string, unknown>).id).toBe(
      eventId("cal-work", "occ-0907", "acc-1")
    );
    expect((deletes[1]!.body as Record<string, unknown>).id).toBe(
      eventId("cal-work", "occ-1012", "acc-1")
    );

    // The occurrence that was not excepted is untouched.
    const untouched = eventId("cal-work", "occ-0914", "acc-1");
    expect(deletes.some((d) => (d.body as Record<string, unknown>).id === untouched)).toBe(
      false
    );
  });
});

describe("describeRecurrence", () => {
  it("phrases a weekly rule with byDay", () => {
    expect(
      describeRecurrence([
        {
          "@type": "RecurrenceRule",
          frequency: "weekly",
          interval: 1,
          byDay: [{ "@type": "NDay", day: "mo" }],
        },
      ])
    ).toBe("every Monday");
  });

  it("phrases an interval greater than 1", () => {
    expect(
      describeRecurrence([
        { "@type": "RecurrenceRule", frequency: "weekly", interval: 2 },
      ])
    ).toBe("every 2 weeks");
  });

  it("appends until as a short date", () => {
    expect(
      describeRecurrence([
        {
          "@type": "RecurrenceRule",
          frequency: "weekly",
          interval: 1,
          until: "2026-11-30T23:59:59",
          byDay: [{ "@type": "NDay", day: "mo" }],
        },
      ])
    ).toBe("every Monday until 30 Nov");
  });

  it("appends a count as a repetition total", () => {
    expect(
      describeRecurrence([
        { "@type": "RecurrenceRule", frequency: "daily", interval: 1, count: 10 },
      ])
    ).toBe("every day, 10 times");
  });

  it("falls back to a generic marker for an undescribable rule", () => {
    // No frequency at all, a frequency outside the four, an empty list and a
    // malformed entry must all yield the generic marker — never a crash and
    // never an empty string.
    expect(describeRecurrence([])).toBe("recurring");
    expect(
      describeRecurrence([{ "@type": "RecurrenceRule" } as unknown as RecurrenceRule])
    ).toBe("recurring");
    expect(
      describeRecurrence([
        { "@type": "RecurrenceRule", frequency: "hourly" } as unknown as RecurrenceRule,
      ])
    ).toBe("recurring");
    expect(
      describeRecurrence(undefined as unknown as RecurrenceRule[])
    ).toBe("recurring");
  });
});
