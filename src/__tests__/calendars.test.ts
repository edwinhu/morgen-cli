import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  listCalendars,
  listEvents,
  findFreeSlots,
  resetCalendarCache,
  buildAlerts,
  parseAlertOffset,
} from "../calendars";

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
    expect(cals[0].name).toBe("Work");
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
    expect(events[0].title).toBe("Standup");
    expect(events[0].calendarName).toBe("Work");
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
    expect(slots[0].duration).toBe("1h");
    expect(slots[1].duration).toBe("1h");
    expect(slots[2].duration).toBe("1h");
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
    expect(slots[0].duration).toBe("1h");     // 08:00-09:00
    expect(slots[1].duration).toBe("4h");     // 10:00-14:00 (lunch doesn't block)
    expect(slots[2].duration).toBe("1h");     // 15:00-16:00
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
    expect(slots[0].start).toBe("2026-06-18T11:00:00-04:00");
    expect(slots[0].end).toBe("2026-06-18T11:30:00-04:00");
    expect(slots[1].start).toBe("2026-06-18T12:30:00-04:00");
    expect(slots[1].end).toBe("2026-06-18T14:00:00-04:00");
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
    expect(slots[0].duration).toBe("1h10m");
  });
});
