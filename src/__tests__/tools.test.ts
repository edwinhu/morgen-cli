import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TOOL_DEFINITIONS, executeTool, resetCalendarCache } from "../tools";

describe("TOOL_DEFINITIONS", () => {
  it("exports tool definitions in OpenAI function calling format", () => {
    expect(TOOL_DEFINITIONS.length).toBeGreaterThan(0);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.type).toBe("function");
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters.type).toBe("object");
    }
  });

  it("includes calendar, event, and task tools", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.function.name);
    expect(names).toContain("calendarRead");
    expect(names).toContain("calendarList");
    expect(names).toContain("eventCreate");
    expect(names).toContain("eventUpdate");
    expect(names).toContain("eventDelete");
    expect(names).toContain("taskList");
    expect(names).toContain("taskCreate");
    expect(names).toContain("taskUpdate");
    expect(names).toContain("taskClose");
    expect(names).toContain("taskReopen");
    expect(names).toContain("taskDelete");
  });

  it("calendarRead requires start and end parameters", () => {
    const calRead = TOOL_DEFINITIONS.find(
      (t) => t.function.name === "calendarRead"
    )!;
    expect(calRead.function.parameters.required).toEqual(["start", "end"]);
  });
});

describe("executeTool", () => {
  const originalFetch = globalThis.fetch;
  let lastRequest: { url: string; init?: RequestInit } | null = null;

  beforeEach(() => {
    lastRequest = null;
    process.env.MORGEN_API_KEY = "test-api-key";
    resetCalendarCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.MORGEN_API_KEY;
  });

  function mockFetch(responseBody: unknown, status = 200) {
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      lastRequest = { url: String(input), init };
      return new Response(JSON.stringify(responseBody), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  }

  it("returns error for unknown tool", async () => {
    const result = await executeTool("unknownTool", "{}");
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("not available");
  });

  it("calendarList calls /v3/calendars/list", async () => {
    mockFetch({
      data: {
        calendars: [
          {
            "@type": "Calendar",
            id: "cal-1",
            accountId: "acc-1",
            integrationId: "google",
            name: "Work Calendar",
            color: "#4285f4",
            myRights: { mayRead: true, mayWrite: true },
          },
        ],
      },
    });

    const result = await executeTool("calendarList", "{}");
    const parsed = JSON.parse(result);

    expect(lastRequest!.url).toContain("/v3/calendars/list");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Work Calendar");
    expect(parsed[0].canWrite).toBe(true);
  });

  it("calendarRead fetches events across all accounts", async () => {
    let fetchCount = 0;

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      fetchCount++;
      const url = String(input);

      if (url.includes("/calendars/list")) {
        return new Response(
          JSON.stringify({
            data: {
              calendars: [
                { id: "cal-1", accountId: "acc-1", integrationId: "google", name: "Work" },
                { id: "cal-2", accountId: "acc-1", integrationId: "google", name: "Personal" },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.includes("/events/list")) {
        return new Response(
          JSON.stringify({
            data: {
              events: [
                {
                  "@type": "Event",
                  id: "ev-1",
                  calendarId: "cal-1",
                  title: "Team Standup",
                  start: "2026-02-07T09:00:00Z",
                  duration: "PT30M",
                  timeZone: "America/New_York",
                  showWithoutTime: false,
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await executeTool(
      "calendarRead",
      '{"start":"2026-02-07T00:00:00","end":"2026-02-08T00:00:00"}'
    );
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe("Team Standup");
    expect(parsed[0].calendar).toBe("Work");
    // Calendars list + 1 events query (both cals same account)
    expect(fetchCount).toBe(2);
  });

  it("calendarRead caches calendar list across calls", async () => {
    let calendarListCalls = 0;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/calendars/list")) {
        calendarListCalls++;
        return new Response(
          JSON.stringify({
            data: { calendars: [{ id: "cal-1", accountId: "acc-1", name: "Main" }] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ data: { events: [] } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    await executeTool("calendarRead", '{"start":"2026-02-07","end":"2026-02-08"}');
    await executeTool("calendarRead", '{"start":"2026-02-08","end":"2026-02-09"}');

    expect(calendarListCalls).toBe(1);
  });

  it("eventDelete calls /v3/events/delete with id", async () => {
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      lastRequest = { url: String(input), init };
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const result = await executeTool("eventDelete", '{"id":"ev-123"}');
    const parsed = JSON.parse(result);

    expect(lastRequest!.url).toContain("/v3/events/delete");
    expect(parsed.success).toBe(true);
  });

  it("executeTool handles API errors", async () => {
    mockFetch({ error: "not found" }, 404);

    try {
      await executeTool("calendarList", "{}");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeDefined();
    }
  });

  it("taskList calls /v3/tasks/list and formats results", async () => {
    mockFetch({
      data: {
        tasks: [
          {
            "@type": "Task",
            id: "task-1",
            accountId: "acc-1",
            integrationId: "morgen",
            taskListId: "tl-1",
            title: "Buy groceries",
            due: "2026-02-10T09:00:00",
            progress: "needs-action",
            priority: 3,
          },
        ],
        labelDefs: [],
        spaces: [],
      },
    });

    const result = await executeTool("taskList", "{}");
    const parsed = JSON.parse(result);

    expect(lastRequest!.url).toContain("/v3/tasks/list");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe("Buy groceries");
    expect(parsed[0].due).toBe("2026-02-10T09:00:00");
    expect(parsed[0].priority).toBe(3);
    expect(parsed[0].progress).toBe("needs-action");
  });

  it("taskCreate calls /v3/tasks/create with title", async () => {
    mockFetch({ data: { id: "new-task-id" } });

    const result = await executeTool(
      "taskCreate",
      '{"title":"Test task","description":"A test","priority":2}'
    );
    const parsed = JSON.parse(result);

    expect(lastRequest!.url).toContain("/v3/tasks/create");
    expect(parsed.success).toBe(true);
    expect(parsed.id).toBe("new-task-id");

    const body = JSON.parse(lastRequest!.init?.body as string);
    expect(body.title).toBe("Test task");
    expect(body.description).toBe("A test");
    expect(body.priority).toBe(2);
  });

  it("taskClose calls /v3/tasks/close with id", async () => {
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      lastRequest = { url: String(input), init };
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const result = await executeTool("taskClose", '{"id":"task-123"}');
    const parsed = JSON.parse(result);

    expect(lastRequest!.url).toContain("/v3/tasks/close");
    expect(parsed.success).toBe(true);
  });

  it("eventCreate creates event with correct fields", async () => {
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input);

      if (url.includes("/calendars/list")) {
        return new Response(
          JSON.stringify({
            data: {
              calendars: [
                {
                  id: "cal-1",
                  accountId: "acc-1",
                  integrationId: "google",
                  name: "Work",
                  myRights: { mayRead: true, mayWriteAll: true },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.includes("/events/create")) {
        lastRequest = { url, init };
        return new Response(
          JSON.stringify({ data: { event: { id: "ev-new" } } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await executeTool(
      "eventCreate",
      '{"summary":"Work on PR","start":"2026-02-10T10:00:00","end":"2026-02-10T11:00:00","timeZone":"America/New_York","alerts":"30m,10m"}'
    );
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.id).toBe("ev-new");

    const body = JSON.parse(lastRequest!.init?.body as string);
    expect(body.title).toBe("Work on PR");
    expect(body.accountId).toBe("acc-1");
    expect(body.calendarId).toBe("cal-1");

    // Alerts should be mapped into the JSCalendar alerts map on the request body
    const alertEntries = Object.values(body.alerts as Record<string, any>);
    expect(alertEntries).toHaveLength(2);
    expect(alertEntries[0].trigger.offset).toBe("-PT30M");
    expect(alertEntries[0].trigger["@type"]).toBe("OffsetTrigger");
    expect(alertEntries[1].trigger.offset).toBe("-PT10M");
  });

  it("taskDelete calls /v3/tasks/delete with id and cascades linked events", async () => {
    const { resetCalendarCache } = await import("../calendars");
    resetCalendarCache();
    const urls: string[] = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input);
      urls.push(url);
      lastRequest = { url, init };
      if (url.includes("/v3/tasks?")) {
        return new Response(JSON.stringify({
          data: { task: { id: "task-456", title: "T", created: "2026-05-20T10:00:00Z" }, labelDefs: [] }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/v3/calendars/list")) {
        return new Response(JSON.stringify({
          data: { calendars: [
            { id: "cal-1", accountId: "acct-1", name: "Cal", myRights: { mayWriteAll: true } },
          ] }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/v3/events/list")) {
        return new Response(JSON.stringify({ data: { events: [] } }), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const result = await executeTool("taskDelete", '{"id":"task-456"}');
    const parsed = JSON.parse(result);

    expect(urls.some((u) => u.includes("/v3/tasks/delete"))).toBe(true);
    expect(parsed.success).toBe(true);
    expect(parsed.deletedEventIds).toEqual([]);
    resetCalendarCache();
  });
});
