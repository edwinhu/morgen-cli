import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  listCalendars,
  listEvents,
  findFreeSlots,
  resetCalendarCache,
} from "../calendars";

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
